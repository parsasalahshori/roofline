// Face cleanup on the finished faces (after topology has drawn their polygons): a per-face support score, and the
// faces too weak to stand: thin strips with no plane of their own, and faces steeper than a roof plane may be without
// strong evidence. They are dissolved into their neighbours (whose planes are refitted on the union) by the caller.
import type { XY } from './geom.ts';
import { adjacency, interiorFit, type Plane, type PlaneParams, planeAngleDeg, slopeOf } from './planes.ts';
import { type Grid, squaredDistance } from './raster.ts';

export type FaceCleanupParams = {
  /** Off: only the old rule (polygons under the smallest face size) runs. */
  enabled: boolean;
  /**
   * A face whose polygon is narrower than this on average (2 area / perimeter, metres) is a thin face. 0.9 m (3 ft) is
   * the benchmark's thin-face width: under it a face is a strip along an eave, a crease or a crown's shadow, while
   * real narrow roof faces (a dormer's cheek, a bay's hip) are rarely under 1 m.
   */
  thinWidthM: number;
  /** ...and only up to this plan area, square metres (12 m2 = 130 sq ft; the chamfer and explained limits). */
  thinMaxM2: number;
  /**
   * A thin face stays only with plane evidence of its own: this share of its interior on one plane (interiorFit) and a
   * normal more than distinctDeg from every neighbour's. 0.88 is the steep-face keep share of the plane search.
   */
  keepShare: number;
  distinctDeg: number;
  /**
   * Steeper than this (x/12) is not a roof plane unless the plane search was allowed steeper faces (Google's segments
   * show one) AND the face is no thin face AND keepShare of its interior lies on its plane.
   */
  steepX12: number;
  /**
   * A thin face without plane support goes only when this share of its boundary is the roof's edge (an eave or rake
   * strip: a gutter, a wall, a crown over the eave). Inside the roof a thin face between creases is usually a real
   * narrow face whose plane the steep, rippled height map supports poorly. A strip with one long side on the edge has
   * about 0.45 of its boundary there (L of 2L + 2w); 0.25 asks for at least half of that side, so a crease strip that
   * only touches the edge at one end stays.
   */
  edgeShare: number;
};

export const DEFAULT_FACE_CLEANUP: FaceCleanupParams = {
  enabled: true,
  thinWidthM: 0.9,
  thinMaxM2: 12,
  keepShare: 0.88,
  distinctDeg: 8,
  steepX12: 18,
  edgeShare: 0.25,
};

/** Why a face was dissolved: machine-readable, counted by the caller's debug output and tests. */
export type WeakReason = 'thin-coplanar' | 'thin-edge' | 'steep-unsupported';

export type FaceSupport = {
  /** Polygon width (2 area / perimeter) and plan area. */
  widthM: number;
  areaM2: number;
  pitchX12: number;
  /** Share of the face's interior pixels on its own plane (interiorFit); null when the face has too few. */
  planeShare: number | null;
  /** Smallest angle between this face's plane and a neighbour's (sharing half a metre or more), degrees. */
  minNeighbourDeg: number;
  /** Share of the face's pixel boundary on the roof's edge. */
  edgeShare: number;
  /** See thickness(); null when not computed (not a candidate). */
  thicknessM: number | null;
};

function ringWidth(ring: readonly XY[]): { area: number; width: number } {
  let a = 0;
  let per = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p.x * q.y - q.x * p.y;
    per += Math.hypot(q.x - p.x, q.y - p.y);
  }
  const area = Math.abs(a) / 2;
  return { area, width: per > 0 ? (2 * area) / per : 0 };
}

/**
 * The face's thickness: twice the largest distance from one of its pixels to the nearest pixel not in it, metres (the
 * diameter of the largest disc inside it). A strip 0.8 m wide is 0.8 m thick however long; a triangular hip end of
 * the same plan area and the same 2 area / perimeter is about twice as thick.
 */
export function thickness(g: Grid, s: number, labels: Int32Array, k: number): number {
  let c0 = g.w;
  let r0 = g.h;
  let c1 = -1;
  let r1 = -1;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== k) continue;
    const c = i % g.w;
    const r = (i - c) / g.w;
    if (c < c0) c0 = c;
    if (c > c1) c1 = c;
    if (r < r0) r0 = r;
    if (r > r1) r1 = r;
  }
  if (c1 < 0) return 0;
  const sub = { w: c1 - c0 + 1, h: r1 - r0 + 1 };
  const d = squaredDistance(sub, (j) => labels[(r0 + Math.floor(j / sub.w)) * g.w + c0 + (j % sub.w)] !== k, true);
  let best = 0;
  for (let j = 0; j < d.length; j++) if (d[j]! > best) best = d[j]!;
  // A pixel next to the boundary is at distance 1 (its centre is half a pixel from the edge): thickness 2 (d - 0.5).
  return Math.max(0, 2 * (Math.sqrt(best) - 0.5)) * s;
}

/** Support of every face (see FaceSupport). `rings` are the faces' polygons, in the same order as `planes`. */
export function faceSupport(
  g: Grid,
  s: number,
  dsm: Float32Array,
  labels: Int32Array,
  planes: readonly Plane[],
  rings: readonly (readonly XY[])[],
  prm: PlaneParams,
  /** Only faces this says need it get the (costly) interior plane fit; the others report planeShare null. */
  needsFit: (f: Omit<FaceSupport, 'planeShare' | 'thicknessM'>) => boolean = () => true,
): FaceSupport[] {
  const n = planes.length;
  const adj = adjacency(g, labels, n);
  const near: number[][] = Array.from({ length: n }, () => []);
  const boundary = adj.edge.slice();
  for (const [key, cracks] of adj.shared) {
    const a = Math.floor(key / 100000);
    const b = key % 100000;
    boundary[a]! += cracks;
    boundary[b]! += cracks;
    if (cracks * s < 0.5) continue;
    near[a]!.push(b);
    near[b]!.push(a);
  }
  return planes.map((p, k) => {
    const { area, width } = rings[k] !== undefined && rings[k]!.length >= 3 ? ringWidth(rings[k]!) : { area: adj.area[k]! * s * s, width: 0 };
    const minNeighbourDeg = near[k]!.length === 0 ? 180 : Math.min(...near[k]!.map((m) => planeAngleDeg(p, planes[m]!)));
    const base = { widthM: width, areaM2: area, pitchX12: slopeOf(p) * 12, minNeighbourDeg, edgeShare: boundary[k]! > 0 ? adj.edge[k]! / boundary[k]! : 0 };
    const need = needsFit(base);
    const fit = need ? interiorFit(g, s, dsm, labels, k, p, prm) : null;
    return { ...base, planeShare: fit === null ? null : fit.share, thicknessM: need ? thickness(g, s, labels, k) : null };
  });
}

/**
 * The faces too weak to stand, with why: a thin face (thinWidthM, under thinMaxM2) whose plane is within distinctDeg
 * of a neighbour's (one face cut in two), or without keepShare of its interior on its plane (a gutter, a wall, a crown);
 * any face steeper than steepX12 without that support or that is thin. A face with no neighbour is never weak (it is
 * the roof), and at least one face always stays.
 */
/** Whether a face is a candidate at all (and so needs its interior fit). */
export function weakCandidate(f: Omit<FaceSupport, 'planeShare' | 'thicknessM'>, prm: FaceCleanupParams = DEFAULT_FACE_CLEANUP): boolean {
  return f.minNeighbourDeg < 180 && (f.pitchX12 > prm.steepX12 || (f.widthM < prm.thinWidthM && f.areaM2 < prm.thinMaxM2));
}

export function weakFaces(support: readonly FaceSupport[], prm: FaceCleanupParams = DEFAULT_FACE_CLEANUP): Map<number, WeakReason> {
  const out = new Map<number, WeakReason>();
  support.forEach((f, k) => {
    if (f.minNeighbourDeg >= 180) return;
    const strong = f.planeShare !== null && f.planeShare >= prm.keepShare;
    const thin = f.widthM < prm.thinWidthM && f.areaM2 < prm.thinMaxM2;
    if (f.pitchX12 > prm.steepX12 && (thin || !strong)) out.set(k, 'steep-unsupported');
    else if (thin && f.minNeighbourDeg <= prm.distinctDeg) out.set(k, 'thin-coplanar');
    else if (thin && f.edgeShare >= prm.edgeShare) out.set(k, 'thin-edge');
  });
  if (out.size >= support.length) {
    // Never everything: keep the biggest.
    let big = 0;
    support.forEach((f, k) => {
      if (f.areaM2 > support[big]!.areaM2) big = k;
    });
    out.delete(big);
  }
  return out;
}
