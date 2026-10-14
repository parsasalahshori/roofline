// Real roof geometry from a height map (Google Solar's Data Layers: a digital surface model and a roof mask, 0.1 m or
// 0.25 m a pixel). Pure and deterministic (a seeded random number generator); the server runs it, the web never does.
//
// 1. The roof: the mask's part under (or nearest) the point, small gaps closed and holes filled.
// 2. Planes: sequential RANSAC with local candidates (10 cm tolerance, at most 24/12, at least 2 m2), every roof
//    pixel then given to the plane it fits best by a flood from the planes' own pixels; touching faces whose planes
//    agree are merged, small pieces in the roof's middle are dissolved into their neighbours (planes.ts).
// 3. The outline: the roof's pixel boundary, simplified and squared to the house (outline.ts).
// 4. Topology: corners where faces meet, creases as straight plane intersections between corners, steps where the
//    planes are far apart in height, eaves and rakes along the outline (topology.ts).
import type { LngLat } from '../roof.ts';
import type { Roof3d, Roof3dLineKind } from '../roof-3d.ts';
import { dist, pointInRing, signedArea, type XY } from './geom.ts';
import { DEFAULT_OUTLINE_PARAMS, maskBoundary, type OutlineParams, squareOutline } from './outline.ts';
import { buildFaces, DEFAULT_PLANE_PARAMS, findPlanes, type Plane, type PlaneParams, refitFaces } from './planes.ts';
import { close, components, countSet, fillHoles, largestComponent, open3, seededRandom, squaredDistance } from './raster.ts';
import { buildTopology, DEFAULT_TOPOLOGY_PARAMS, type TopologyParams } from './topology.ts';

export { lngLatToUtm, utmToLngLat, utmZoneOfEpsg, type UtmZone } from './utm.ts';
export type { XY } from './geom.ts';
export type { Plane } from './planes.ts';

/** A height map and roof mask on one grid: row-major, row 0 at the top (north), `pixelSizeM` metres a pixel. */
export type RoofRaster = {
  width: number;
  height: number;
  pixelSizeM: number;
  /** Heights, metres; NaN where there is no data. */
  dsm: Float32Array;
  /** Non-zero where Google sees roof. */
  mask: Uint8Array;
};

export type ReconstructOptions = {
  seed?: number;
  /** The roof must come within this many metres of the point. */
  maxPointDistM?: number;
  /** A roof smaller than this (square metres) is not a building worth measuring. */
  minRoofM2?: number;
  planes?: Partial<PlaneParams>;
  outline?: Partial<OutlineParams>;
  topology?: Partial<TopologyParams>;
  /** Development only: told what the topology decided. */
  debug?: (msg: string) => void;
};

/** Raster-local metres: x east from the raster's left edge, y north from its top edge (so y <= 0). */
export type LocalFace = {
  ring: XY[];
  plane: Plane;
  pitchX12: number;
  azimuthDeg: number;
  planAreaM2: number;
  slopedAreaM2: number;
  flat: boolean;
  label: XY;
};
export type LocalLine = { kind: Roof3dLineKind; a: XY; b: XY; faces: number[]; lengthM: number; riseM: number };
/** `clipped`: the roof runs off the height map's edge, so part of it is missing. */
export type LocalRoof = { outline: XY[]; faces: LocalFace[]; lines: LocalLine[]; pixelSizeM: number; maskAreaM2: number; clipped: boolean };

const FLAT_X12 = 2;
const SQ_FT_PER_SQ_M = 10.7639104167;
const FT_PER_M = 3.280839895;

/** Compass direction a plane faces (downhill), degrees: 0 north, 90 east. */
export function azimuthOf(p: Plane): number {
  const deg = (Math.atan2(-p.a, -p.b) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/**
 * The roof under (or nearest) `point` (pixel column and row, fractional), reconstructed. Null when no roof part comes
 * within maxPointDistM of the point, the roof is too small, or no plane is found.
 */
export function reconstructRoof(raster: RoofRaster, point: { col: number; row: number }, opts: ReconstructOptions = {}): LocalRoof | null {
  const { width: W, height: H, pixelSizeM: s } = raster;
  if (!(W > 2 && H > 2 && s > 0) || raster.dsm.length !== W * H || raster.mask.length !== W * H) return null;
  const planePrm: PlaneParams = { ...DEFAULT_PLANE_PARAMS, ...opts.planes };
  const outlinePrm: OutlineParams = { ...DEFAULT_OUTLINE_PARAMS, ...opts.outline };
  const topoPrm: TopologyParams = { ...DEFAULT_TOPOLOGY_PARAMS, ...opts.topology };
  const rng = seededRandom(opts.seed ?? 7);

  // 1. The mask's part under the point, or the nearest one within reach.
  const full = { w: W, h: H };
  const { labels } = components(full, (i) => raster.mask[i] !== 0);
  const pc = Math.min(W - 1, Math.max(0, Math.floor(point.col)));
  const pr = Math.min(H - 1, Math.max(0, Math.floor(point.row)));
  let part = labels[pr * W + pc]!;
  if (part === 0) {
    let best = (opts.maxPointDistM ?? 12) / s;
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === 0) continue;
      const c = i % W;
      const r = (i - c) / W;
      const d = Math.hypot(c + 0.5 - point.col, r + 0.5 - point.row);
      if (d < best) {
        best = d;
        part = labels[i]!;
      }
    }
  }
  if (part === 0) return null;
  let c0 = W;
  let r0 = H;
  let c1 = -1;
  let r1 = -1;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== part) continue;
    const c = i % W;
    const r = (i - c) / W;
    c0 = Math.min(c0, c);
    c1 = Math.max(c1, c);
    r0 = Math.min(r0, r);
    r1 = Math.max(r1, r);
  }
  const clipped = c0 <= 1 || r0 <= 1 || c1 >= W - 2 || r1 >= H - 2;
  const closeR = Math.max(1, Math.round(0.3 / s));
  const pad = closeR + 3;
  c0 = Math.max(0, c0 - pad);
  r0 = Math.max(0, r0 - pad);
  c1 = Math.min(W - 1, c1 + pad);
  r1 = Math.min(H - 1, r1 + pad);
  const g = { w: c1 - c0 + 1, h: r1 - r0 + 1 };
  const dsm = new Float32Array(g.w * g.h);
  let roof: Uint8Array = new Uint8Array(g.w * g.h);
  for (let r = 0; r < g.h; r++) {
    for (let c = 0; c < g.w; c++) {
      const src = (r + r0) * W + c + c0;
      const z = raster.dsm[src]!;
      dsm[r * g.w + c] = Number.isFinite(z) && z > -1000 && z < 10000 ? z : Number.NaN;
      roof[r * g.w + c] = labels[src] === part ? 1 : 0;
    }
  }
  roof = fillHoles(g, largestComponent(g, open3(g, fillHoles(g, close(g, roof, closeR)))));
  const roofPx = countSet(roof);
  if (roofPx * s * s < (opts.minRoofM2 ?? 15)) return null;

  // 2. Planes and faces.
  const found = findPlanes(g, s, dsm, roof, rng, planePrm);
  if (found.length === 0) return null;
  const faces = buildFaces(g, s, dsm, roof, found, planePrm);
  if (faces.planes.length === 0) return null;
  const planes = refitFaces(g, s, dsm, faces, planePrm.tolM);

  // 3. The outline, squared.
  const boundary = maskBoundary(g, roof, s);
  const outline = squareOutline(boundary, outlinePrm);
  if (outline.length < 3) return null;

  // 4. Topology.
  const topo = buildTopology(g, s, faces.labels, planes, outline, dsm, topoPrm, opts.debug);

  // Face areas: the polygons' (they tile the outline), shared out so they add up to the outline's area.
  const outlineArea = signedArea(outline);
  const pixelCount = new Array<number>(planes.length).fill(0);
  for (let i = 0; i < faces.labels.length; i++) if (faces.labels[i]! >= 0) pixelCount[faces.labels[i]!]!++;
  const raw = topo.faces.map((f, k) => (f.areaM2 > 0 ? f.areaM2 : pixelCount[k]! * s * s));
  const rawSum = raw.reduce((t, a) => t + a, 0);
  const scale = rawSum > 0 ? outlineArea / rawSum : 1;

  // Shift from the crop back to the whole raster.
  const ox = c0 * s;
  const oy = -r0 * s;
  const shift = (p: XY): XY => ({ x: p.x + ox, y: p.y + oy });
  const localFaces: LocalFace[] = planes.map((p0, k) => {
    // The plane in whole-raster coordinates: z = a (x - ox) + b (y - oy) + c.
    const plane: Plane = { a: p0.a, b: p0.b, c: p0.c - p0.a * ox - p0.b * oy };
    const slope = Math.hypot(plane.a, plane.b);
    const plan = raw[k]! * scale;
    return {
      ring: topo.faces[k]!.ring.map(shift),
      plane,
      pitchX12: slope * 12,
      azimuthDeg: azimuthOf(plane),
      planAreaM2: plan,
      slopedAreaM2: plan * Math.sqrt(1 + slope * slope),
      flat: slope * 12 < FLAT_X12,
      label: shift(labelPoint(g, s, faces.labels, k, topo.faces[k]!.ring)),
    };
  });
  // Largest first (ties: west to east, then north to south), with the lines' face numbers following.
  const order = localFaces.map((_, k) => k).sort((a, b) => {
    const fa = localFaces[a]!;
    const fb = localFaces[b]!;
    return fb.planAreaM2 - fa.planAreaM2 || fa.label.x - fb.label.x || fb.label.y - fa.label.y;
  });
  const newIndex = new Array<number>(order.length);
  order.forEach((k, i) => (newIndex[k] = i));
  return {
    outline: outline.map(shift),
    faces: order.map((k) => localFaces[k]!),
    lines: topo.lines.map((l) => ({ ...l, a: shift(l.a), b: shift(l.b), faces: l.faces.map((f) => newIndex[f]!) })),
    pixelSizeM: s,
    maskAreaM2: roofPx * s * s,
    clipped,
  };
}

/** A point well inside face k: its polygon's centroid when inside it, else the face pixel farthest from the face's edge. */
function labelPoint(g: { w: number; h: number }, s: number, labels: Int32Array, k: number, ring: readonly XY[]): XY {
  if (ring.length >= 3) {
    let a = 0;
    let cx = 0;
    let cy = 0;
    const o = ring[0]!;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!;
      const q = ring[(i + 1) % ring.length]!;
      const cr = (p.x - o.x) * (q.y - o.y) - (q.x - o.x) * (p.y - o.y);
      a += cr;
      cx += (p.x - o.x + q.x - o.x) * cr;
      cy += (p.y - o.y + q.y - o.y) * cr;
    }
    if (Math.abs(a) > 1e-9) {
      const c = { x: o.x + cx / (3 * a), y: o.y + cy / (3 * a) };
      let edge = Infinity;
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i]!;
        const q = ring[(i + 1) % ring.length]!;
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((c.x - p.x) * dx + (c.y - p.y) * dy) / len2)) : 0;
        edge = Math.min(edge, dist(c, { x: p.x + t * dx, y: p.y + t * dy }));
      }
      if (pointInRing(c, ring) && edge > 0.6) return c;
    }
  }
  const d = squaredDistance(g, (i) => labels[i] !== k, true);
  let best = -1;
  let at = 0;
  for (let i = 0; i < d.length; i++) {
    if (labels[i] === k && d[i]! > best) {
      best = d[i]!;
      at = i;
    }
  }
  return { x: ((at % g.w) + 0.5) * s, y: -(Math.floor(at / g.w) + 0.5) * s };
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * The reconstruction in [lng, lat] as it is stored and drawn: `toLngLat` maps raster-local metres (x east from the
 * left edge, y north from the top edge) to [lng, lat]. Areas in square feet, lengths in feet; faces largest first.
 */
export function toRoof3d(
  local: LocalRoof,
  toLngLat: (x: number, y: number) => LngLat,
  meta: { imageryQuality: string | null; imageryDate: string | null },
): Roof3d {
  const ll = (p: XY): LngLat => {
    const [lng, lat] = toLngLat(p.x, p.y);
    return [round(lng, 8), round(lat, 8)];
  };
  return {
    version: 1,
    outline: local.outline.map(ll),
    faces: local.faces.map((f) => ({
      ring: f.ring.map(ll),
      pitchX12: round(f.pitchX12, 2),
      azimuthDeg: round(f.azimuthDeg, 1),
      planAreaSqFt: round(f.planAreaM2 * SQ_FT_PER_SQ_M, 1),
      slopedAreaSqFt: round(f.slopedAreaM2 * SQ_FT_PER_SQ_M, 1),
      flat: f.flat,
      labelAt: ll(f.label),
    })),
    lines: local.lines.map((l) => ({
      kind: l.kind,
      coords: [ll(l.a), ll(l.b)],
      lengthFt: round(l.lengthM * FT_PER_M, 1),
      riseFt: round(l.riseM * FT_PER_M, 2),
      faces: l.faces,
    })),
    pixelSizeM: local.pixelSizeM,
    imageryQuality: meta.imageryQuality,
    imageryDate: meta.imageryDate,
  };
}
