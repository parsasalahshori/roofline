// Evidence for a face, read off the height map instead of off its size: what its boundary is made of (the roof's edge,
// a crease the heights really show, a step, or nothing at all), how its own plane compares with its neighbours' planes
// over its pixels, and what stands across each boundary. A real small face (a dormer's cheek, a small gable, a hip end)
// is bounded by creases and steps the height map shows; a junk face (a strip of a bowed slope, a rounded ridge, a
// gutter) is bounded by nothing: the heights run smoothly through its boundary into a neighbour facing the same way.
import { adjacency, type Faces, interiorFit, pixelX, pixelY, type Plane, type PlaneParams, planeAngleDeg, planeZ, slopeOf } from './planes.ts';
import { dilate, type Grid, type Mask } from './raster.ts';

/** What stands across one boundary of a face: the neighbour, and what the heights do across the boundary. */
export type FaceRelation = {
  /** The neighbour's label. */
  m: number;
  /** Length of the shared boundary, metres (pixel cracks). */
  lenM: number;
  /** The cracks with a height profile on both sides (the faces at least profileM deep there), as a share. */
  seen: number;
  /**
   * The change of slope across the boundary in the height map itself (rise per metre; median over the cracks with a
   * profile), walking from this face into the neighbour: negative at a convex crease (a ridge, a hip), positive at a
   * concave one (a valley). Near 0: the heights run straight through.
   */
  kink: number;
  /** The height the neighbour's side stands above this face's side at the boundary, metres (both sides carried to it). */
  step: number;
  /** Angle between the two planes, and between their downhill directions (0 when either is flat), degrees. */
  deg: number;
  arc: number;
  /** The neighbour's pitch (x/12) and area (m2). */
  pitchX12: number;
  areaM2: number;
};

export type FaceMeasure = {
  areaM2: number;
  /** 2 area / boundary of the pixel region, metres. */
  widthM: number;
  pitchX12: number;
  /** Downhill direction, degrees clockwise from north. */
  facing: number;
  /** Share of the boundary on the roof's edge. */
  edgeShare: number;
  /** Share of the face's interior on one plane (interiorFit); null when the face has too few interior pixels. */
  planeShare: number | null;
  /** 80th percentile of the face's pixels' distance from its own plane, metres. */
  ownDev: number;
  /** The same from the neighbour's plane that explains the face best (and that neighbour), or Infinity without one. */
  nbDev: number;
  nb: number;
  /** Share of the face's pixels more than aboveM over (under) the plane of the neighbour sharing most boundary. */
  above: number;
  below: number;
  /** Share of the face's pixels within a metre of a tree crown. */
  treeShare: number;
  relations: FaceRelation[];
};

export type EvidenceProbe = {
  /** A height profile across a boundary reads the heights from nearM to farM in from the boundary pixel, metres. */
  nearM: number;
  farM: number;
  /** ...or to this depth on a narrow face. */
  farNarrowM: number;
  aboveM: number;
};

export const DEFAULT_EVIDENCE_PROBE: EvidenceProbe = { nearM: 0.1, farM: 0.5, farNarrowM: 0.3, aboveM: 0.1 };

function azimuthOf(p: Plane): number {
  return (((Math.atan2(-p.a, -p.b) * 180) / Math.PI) % 360 + 360) % 360;
}

function arcDeg(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function median(v: number[]): number {
  if (v.length === 0) return 0;
  v.sort((x, y) => x - y);
  const h = v.length >> 1;
  return v.length % 2 === 1 ? v[h]! : (v[h - 1]! + v[h]!) / 2;
}

/**
 * Every face measured (see FaceMeasure). `only` limits the costly parts (the interior fit, the deviations) to the faces
 * it names; the relations are measured for every face in one pass over the boundaries.
 */
export function measureFaces(
  g: Grid,
  s: number,
  dsm: Float32Array,
  faces: Faces,
  prm: PlaneParams,
  tree: Mask | null = null,
  only: ((k: number) => boolean) | null = null,
  probe: EvidenceProbe = DEFAULT_EVIDENCE_PROBE,
): FaceMeasure[] {
  const { w, h } = g;
  const { labels, planes } = faces;
  const n = planes.length;
  const adj = adjacency(g, labels, n);
  const n1 = Math.max(1, Math.round(probe.nearM / s));
  const n2 = Math.max(n1 + 2, Math.round(probe.farM / s));
  const n2b = Math.max(n1 + 2, Math.round(probe.farNarrowM / s));
  // Per ordered pair (a < b): the kink and the step (b over a) at every crack with a profile.
  const kinks = new Map<number, number[]>();
  const steps = new Map<number, number[]>();
  const z = (i: number): number => dsm[i]!;
  // The slope towards the boundary on the side of pixel i (label k), walking by `d` pixels at a time away from it, and
  // the height carried to the crack; null when the face is not deep enough there or the heights are missing.
  const side = (i: number, k: number, d: number, col: number, dc: number): { slope: number; at: number } | null => {
    for (const far of n2 === n2b ? [n2] : [n2, n2b]) {
      const cFar = col + dc * far;
      if (cFar < 0 || cFar >= w) continue;
      const iFar = i + d * far;
      const iNear = i + d * n1;
      if (iFar < 0 || iFar >= labels.length || labels[iFar] !== k || labels[iNear] !== k) continue;
      const zf = z(iFar);
      const zn = z(iNear);
      if (!Number.isFinite(zf) || !Number.isFinite(zn)) continue;
      // Slope walking towards the boundary (from far to near).
      const slope = (zn - zf) / ((far - n1) * s);
      return { slope, at: zn + slope * (n1 + 0.5) * s };
    }
    return null;
  };
  const crack = (i: number, j: number, d: number, dc: number): void => {
    const a = labels[i]!;
    const b = labels[j]!;
    if (a < 0 || b < 0 || a === b) return;
    const ci = i % w;
    const cj = j % w;
    // Side of i walks back (-d), side of j walks on (+d).
    const si = side(i, a, -d, ci, -dc);
    const sj = side(j, b, d, cj, dc);
    if (si === null || sj === null) return;
    // Walking from i into j: slope before the boundary is si.slope, after it -sj.slope.
    const kink = -sj.slope - si.slope;
    const stepJoverI = sj.at - si.at;
    const key = a < b ? a * 100000 + b : b * 100000 + a;
    let kk = kinks.get(key);
    let ss = steps.get(key);
    if (kk === undefined) {
      kk = [];
      ss = [];
      kinks.set(key, kk);
      steps.set(key, ss);
    }
    kk.push(kink);
    ss!.push(a < b ? stepJoverI : -stepJoverI);
  };
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      if (c < w - 1) crack(i, i + 1, 1, 1);
      if (r < h - 1) crack(i, i + w, w, 0);
    }
  }
  const rel: FaceRelation[][] = Array.from({ length: n }, () => []);
  const boundary = adj.edge.slice();
  const az = planes.map(azimuthOf);
  const pitched = planes.map((p) => slopeOf(p) * 12 >= 1);
  for (const [key, cracks] of adj.shared) {
    const a = Math.floor(key / 100000);
    const b = key % 100000;
    boundary[a]! += cracks;
    boundary[b]! += cracks;
    const kk = kinks.get(key) ?? [];
    const ss = steps.get(key) ?? [];
    const kink = median(kk);
    const step = median(ss);
    const deg = planeAngleDeg(planes[a]!, planes[b]!);
    const arc = pitched[a]! && pitched[b]! ? arcDeg(az[a]!, az[b]!) : 0;
    const seen = cracks > 0 ? kk.length / cracks : 0;
    rel[a]!.push({ m: b, lenM: cracks * s, seen, kink, step, deg, arc, pitchX12: slopeOf(planes[b]!) * 12, areaM2: adj.area[b]! * s * s });
    rel[b]!.push({ m: a, lenM: cracks * s, seen, kink, step: -step, deg, arc, pitchX12: slopeOf(planes[a]!) * 12, areaM2: adj.area[a]! * s * s });
  }
  // Pixels of each face that is measured in full.
  const want = (k: number): boolean => only === null || only(k);
  const pixelsOf: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < labels.length; i++) {
    const k = labels[i]!;
    if (k >= 0 && want(k)) pixelsOf[k]!.push(i);
  }
  const nearTree = tree === null ? null : dilate(g, tree, Math.max(1, Math.round(1 / s)));
  const p80 = (v: number[]): number => (v.length === 0 ? Infinity : v.sort((x, y) => x - y)[Math.floor(v.length * 0.8)]!);
  return planes.map((p, k) => {
    const areaPx = adj.area[k]!;
    const relations = rel[k]!.sort((x, y) => y.lenM - x.lenM || x.m - y.m);
    const base = {
      areaM2: areaPx * s * s,
      widthM: boundary[k]! > 0 ? (2 * areaPx * s) / boundary[k]! : 0,
      pitchX12: slopeOf(p) * 12,
      facing: az[k]!,
      edgeShare: boundary[k]! > 0 ? adj.edge[k]! / boundary[k]! : 0,
      relations,
    };
    if (!want(k)) return { ...base, planeShare: null, ownDev: Infinity, nbDev: Infinity, nb: -1, above: 0, below: 0, treeShare: 0 };
    const px = pixelsOf[k]!;
    const own: number[] = [];
    const near = relations.filter((q) => q.lenM >= 0.5).map((q) => q.m);
    const devs: number[][] = near.map(() => []);
    const main = relations.length > 0 ? relations[0]!.m : -1;
    let above = 0;
    let below = 0;
    let trees = 0;
    let finite = 0;
    for (const i of px) {
      if (nearTree?.[i] === 1) trees++;
      const zz = dsm[i]!;
      if (!Number.isFinite(zz)) continue;
      finite++;
      const x = pixelX(g, s, i);
      const y = pixelY(g, s, i);
      own.push(Math.abs(zz - planeZ(p, x, y)));
      for (let q = 0; q < near.length; q++) devs[q]!.push(Math.abs(zz - planeZ(planes[near[q]!]!, x, y)));
      if (main >= 0) {
        const dz = zz - planeZ(planes[main]!, x, y);
        if (dz > probe.aboveM) above++;
        else if (dz < -probe.aboveM) below++;
      }
    }
    let nbDev = Infinity;
    let nb = -1;
    for (let q = 0; q < near.length; q++) {
      const d = p80(devs[q]!);
      if (d < nbDev) {
        nbDev = d;
        nb = near[q]!;
      }
    }
    const fit = interiorFit(g, s, dsm, labels, k, p, prm);
    return {
      ...base,
      planeShare: fit === null ? null : fit.share,
      ownDev: p80(own),
      nbDev,
      nb,
      above: finite > 0 ? above / finite : 0,
      below: finite > 0 ? below / finite : 0,
      treeShare: px.length > 0 ? trees / px.length : 0,
    };
  });
}
