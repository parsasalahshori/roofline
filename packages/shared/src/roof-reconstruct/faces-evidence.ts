// Evidence for a face, read off the height map instead of off its size: what its boundary is made of (the roof's edge,
// a crease the heights really show, a step, or nothing at all), how its own plane compares with its neighbours' planes
// over its pixels, and what stands across each boundary. A real small face (a dormer's cheek, a small gable, a hip end)
// is bounded by creases and steps the height map shows; a junk face (a strip of a bowed slope, a rounded ridge, a
// gutter) is bounded by nothing: the heights run smoothly through its boundary into a neighbour facing the same way.
import { adjacency, compact, type Faces, interiorFit, pixelX, pixelY, type Plane, type PlaneParams, planeAngleDeg, planeZ, slopeOf, splitParts } from './planes.ts';
import { dilate, type Grid, type Mask, squaredDistance } from './raster.ts';

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
  /**
   * 80th percentile of this face's pixels' distance from the neighbour's plane, metres (how well the neighbour's plane
   * carried on over this face explains it); absent for a boundary under half a metre or a face not measured in full.
   */
  dev?: number;
};

export type FaceMeasure = {
  areaM2: number;
  /** 2 area / boundary of the pixel region, metres (low for a face that runs diagonally: its boundary is a staircase). */
  widthM: number;
  /** The diameter of the largest disc inside the face, metres: a strip's width whatever its length or direction (0 unless every face is measured in full). */
  thickM: number;
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

/** The pixels within a metre of a tree crown. */
export function nearTreesOf(g: Grid, s: number, tree: Mask): Mask {
  return dilate(g, tree, Math.max(1, Math.round(1 / s)));
}

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
  /** `tree` grown by a metre, when the caller has it already (it is the same for every call on one crop). */
  nearTrees: Mask | null = null,
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
  const nearTree = nearTrees ?? (tree === null ? null : nearTreesOf(g, s, tree));
  const treePx = new Array<number>(n).fill(0);
  if (nearTree !== null) for (let i = 0; i < labels.length; i++) if (labels[i]! >= 0 && nearTree[i] === 1) treePx[labels[i]!]!++;
  // Thickness: each pixel's distance to the nearest boundary pixel (of any face: the nearest is its own face's).
  const onBoundary = (i: number): boolean => {
    const k = labels[i]!;
    if (k < 0) return true;
    const c = i % w;
    const r = (i - c) / w;
    return c === 0 || r === 0 || c === w - 1 || r === h - 1 || labels[i - 1] !== k || labels[i + 1] !== k || labels[i - w] !== k || labels[i + w] !== k;
  };
  // (Only when faces are measured in full: no rule reads it, and it is a distance transform of the whole crop.)
  const deep = new Array<number>(n).fill(0);
  if (only === null) {
    const d2 = squaredDistance(g, onBoundary);
    for (let i = 0; i < labels.length; i++) {
      const k = labels[i]!;
      if (k >= 0 && d2[i]! > deep[k]!) deep[k] = d2[i]!;
    }
  }
  const p80 = (v: number[]): number => (v.length === 0 ? Infinity : v.sort((x, y) => x - y)[Math.floor(v.length * 0.8)]!);
  return planes.map((p, k) => {
    const areaPx = adj.area[k]!;
    const relations = rel[k]!.sort((x, y) => y.lenM - x.lenM || x.m - y.m);
    const base = {
      areaM2: areaPx * s * s,
      widthM: boundary[k]! > 0 ? (2 * areaPx * s) / boundary[k]! : 0,
      thickM: only === null ? 2 * (Math.sqrt(deep[k]!) + 0.5) * s : 0,
      pitchX12: slopeOf(p) * 12,
      facing: az[k]!,
      edgeShare: boundary[k]! > 0 ? adj.edge[k]! / boundary[k]! : 0,
      treeShare: areaPx > 0 ? treePx[k]! / areaPx : 0,
      relations,
    };
    if (!want(k)) return { ...base, planeShare: null, ownDev: Infinity, nbDev: Infinity, nb: -1, above: 0, below: 0 };
    const px = pixelsOf[k]!;
    const own: number[] = [];
    const near = relations.filter((q) => q.lenM >= 0.5).map((q) => q.m);
    const devs: number[][] = near.map(() => []);
    const main = relations.length > 0 ? relations[0]!.m : -1;
    let above = 0;
    let below = 0;
    let finite = 0;
    for (const i of px) {
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
      relations.find((x) => x.m === near[q])!.dev = d;
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
    };
  });
}

export type EvidenceParams = {
  /**
   * Off (the default): the faces are cleaned by the size rules alone, as before. On, a face that is real on its
   * evidence is passed over by them. Meant to go on together with PlaneParams.cleanupRoundsPerFace 1 and splitOnce.
   */
  enabled: boolean;
  /**
   * A fragment: a narrow face (under fragWidthM wide on average: the width a height map smears a ridge, an eave or a
   * wall over) beside a bigger face that faces the same way (downhill directions within fragArcDeg, planes within
   * fragDeg) with no step in the heights between them (under fragStepM, read on at least fragSharedM of boundary). It
   * is the rounded top or the smeared foot of that face, not a face: the two become one, and no boundary moves (a
   * dissolve would hand its pixels to whichever plane passes nearest, the face across the ridge as often as not).
   */
  fragWidthM: number;
  fragArcDeg: number;
  fragDeg: number;
  fragStepM: number;
  fragSharedM: number;
  /** Two faces on one plane (within sameDeg, the same way, no step between them) are one face whatever their width. 0: off. */
  sameDeg: number;
  /**
   * Whether a fragment is joined to its face (true), or only left to the size rules as before (false): either way a
   * fragment is not real on its evidence, whatever it meets on its other side (a strip along a ridge meets the face
   * across the ridge at a convex crease, at about its own pitch).
   */
  joinFragments: boolean;
  /**
   * A ridge or hip of its own: a boundary of at least creaseM where the height map itself turns over (its slope
   * falls by creaseKink, rise per metre, from one side to the other, read on creaseSeen of the boundary or more),
   * shared with a face turned away by creaseArcDeg or more at about the same pitch (within creasePitchX12). A gable
   * dormer's two faces have one between them, a hip end has one with each neighbour, a small gable with its other
   * half. A strip of a bowed slope, a rounded ridge, a gutter or a wall's smear has none: what it meets at a convex
   * crease, if anything, faces its own way or is far steeper or shallower. Such a face is real: no size rule
   * dissolves it (buildFaces steps 2 to 5, the thin-face rules), unless treeShare of it lies within a metre of a
   * crown (a crown is a little hip roof to a height map).
   */
  creaseM: number;
  creaseKink: number;
  creaseSeen: number;
  creaseArcDeg: number;
  creasePitchX12: number;
  /**
   * A facing of its own: a pitched face (ownPitchX12 or more) none of whose pitched neighbours (2/12 or more, sharing
   * fragSharedM of boundary) faces within ownArcDeg of its way. It is the only face on its side of whatever it stands
   * on (a hip end, a bay's facet, the one face of a dormer the plane search read right): dissolved, its pixels can
   * only go to faces that look another way. Real like a face with a ridge of its own; 0: off.
   */
  ownArcDeg: number;
  ownPitchX12: number;
  treeShare: number;
  /**
   * A face that stays only for its evidence (a size rule would have dissolved it) stays when its polygon is at least
   * this wide on average (2 area / perimeter, metres). 0.9: the benchmark's thin-face width, so no such face is ever
   * a thin face; 0: whatever its width (a dormer's cheek is often narrower: EagleView's own faces are, one in three).
   */
  thinM: number;
};

export const DEFAULT_EVIDENCE: EvidenceParams = {
  enabled: false,
  fragWidthM: 1,
  fragArcDeg: 30,
  fragDeg: 20,
  fragStepM: 0.25,
  fragSharedM: 1,
  sameDeg: 0,
  joinFragments: false,
  creaseM: 1,
  creaseKink: 0.15,
  creaseSeen: 0.2,
  creaseArcDeg: 60,
  creasePitchX12: 4,
  ownArcDeg: 60,
  ownPitchX12: 3,
  treeShare: 0.2,
  thinM: 0.9,
};

/**
 * The face that face m (one of measureFaces' records) is a fragment of (EvidenceParams.fragWidthM): the eligible
 * neighbour it shares most boundary with, or null. `taken(k)`: neighbour k is not available.
 */
export function fragmentOf(m: FaceMeasure, prm: EvidenceParams, taken: (k: number) => boolean = () => false): FaceRelation | null {
  const narrow = m.widthM < prm.fragWidthM;
  for (const q of m.relations) {
    if (q.lenM < prm.fragSharedM || q.areaM2 < m.areaM2 || taken(q.m)) continue;
    if (q.arc >= prm.fragArcDeg || q.deg >= (narrow ? prm.fragDeg : prm.sameDeg)) continue;
    if (q.seen * q.lenM < prm.fragSharedM || Math.abs(q.step) >= prm.fragStepM) continue;
    // Relations come longest first: the first eligible one is the face it is most attached to.
    return q;
  }
  return null;
}

/**
 * The fragments (EvidenceParams.fragWidthM) joined to the faces they are part of, or null when there is none. Each
 * joins the eligible neighbour it shares most boundary with; a face that takes a fragment in is not itself joined to
 * another in the same call.
 */
export function mergeFragments(g: Grid, s: number, dsm: Float32Array, faces: Faces, planePrm: PlaneParams, prm: EvidenceParams, debug?: (msg: string) => void): Faces | null {
  const n = faces.planes.length;
  if (n < 2) return null;
  const m = measureFaces(g, s, dsm, faces, planePrm, null, () => false);
  const order = [...Array(n).keys()].sort((x, y) => m[x]!.areaM2 - m[y]!.areaM2 || x - y);
  const into = new Array<number>(n).fill(-1);
  const isTarget = new Uint8Array(n);
  let any = false;
  for (const f of order) {
    if (isTarget[f] === 1) continue;
    const pick = fragmentOf(m[f]!, prm, (k) => into[k]! >= 0);
    if (pick === null) continue;
    into[f] = pick.m;
    isTarget[pick.m] = 1;
    any = true;
    if (debug !== undefined) {
      let sx = 0;
      let sy = 0;
      let c = 0;
      for (let i = 0; i < faces.labels.length; i++) {
        if (faces.labels[i] !== f) continue;
        sx += pixelX(g, s, i);
        sy += pixelY(g, s, i);
        c++;
      }
      debug(`faces: fragment (${pick.deg.toFixed(1)} deg and ${pick.arc.toFixed(0)} deg of facing from its neighbour, ${m[f]!.widthM.toFixed(2)} m wide) face at ${(sx / Math.max(1, c)).toFixed(1)},${(sy / Math.max(1, c)).toFixed(1)}: ${m[f]!.areaM2.toFixed(1)} m2, ${m[f]!.pitchX12.toFixed(1)}/12 facing ${m[f]!.facing.toFixed(0)}`);
    }
  }
  if (!any) return null;
  const labels = faces.labels.slice();
  for (let i = 0; i < labels.length; i++) {
    const k = labels[i]!;
    if (k >= 0 && into[k]! >= 0) labels[i] = into[k]!;
  }
  return splitParts(g, compact(labels, faces.planes));
}

/** The length of face m's longest ridge or hip of its own (EvidenceParams.creaseM), metres; 0 without one. */
export function ownCreaseM(m: FaceMeasure, prm: EvidenceParams): number {
  let best = 0;
  for (const q of m.relations) {
    if (q.kink > -prm.creaseKink || q.seen < prm.creaseSeen) continue;
    if (q.arc < prm.creaseArcDeg || Math.abs(q.pitchX12 - m.pitchX12) > prm.creasePitchX12) continue;
    if (q.lenM > best) best = q.lenM;
  }
  return best;
}

/** Whether face m has a facing of its own (EvidenceParams.ownArcDeg). */
export function ownFacingOf(m: FaceMeasure, prm: EvidenceParams): boolean {
  if (!(prm.ownArcDeg > 0) || m.pitchX12 < prm.ownPitchX12) return false;
  let pitched = 0;
  for (const q of m.relations) {
    if (q.lenM < prm.fragSharedM || q.pitchX12 < 2) continue;
    if (q.arc < prm.ownArcDeg) return false;
    pitched++;
  }
  return pitched > 0;
}

/**
 * 1 for every face that is real on its evidence (a ridge or hip of its own, or a facing of its own; no fragment; away
 * from trees), 0 for the others. `nearTrees`: measureFaces' argument.
 */
export function realFaces(
  g: Grid,
  s: number,
  dsm: Float32Array,
  faces: Faces,
  planePrm: PlaneParams,
  tree: Mask | null,
  prm: EvidenceParams,
  nearTrees: Mask | null = null,
): Uint8Array {
  const out = new Uint8Array(faces.planes.length);
  if (faces.planes.length < 2) return out;
  measureFaces(g, s, dsm, faces, planePrm, tree, () => false, DEFAULT_EVIDENCE_PROBE, nearTrees).forEach((m, k) => {
    if (m.treeShare >= prm.treeShare) return;
    if ((ownCreaseM(m, prm) >= prm.creaseM || ownFacingOf(m, prm)) && fragmentOf(m, prm) === null) out[k] = 1;
  });
  return out;
}
