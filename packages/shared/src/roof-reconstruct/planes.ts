// Roof planes from a height map: sequential RANSAC with local candidates, every roof pixel given to a plane by a
// residual-ordered flood, near-coplanar neighbours merged, small interior pieces dissolved into their neighbours.
import { components, countSet, dilate, erode, type Grid, type Mask, MinHeap, open } from './raster.ts';

/** z = a * x + b * y + c, in metres; x east, y north. */
export type Plane = { a: number; b: number; c: number };

export type PlaneParams = {
  /** A point lies on a plane when within this height of it, metres. */
  tolM: number;
  /** A plane needs at least this much area of points on it, square metres. */
  minPlaneM2: number;
  /** Steeper (x/12) is a wall or a tree, not a roof plane (18/12 unless Google's own segments show a steeper roof). */
  maxPitchX12: number;
  maxPlanes: number;
  /** RANSAC candidates per plane, and how many of the best are checked for their connected patch. */
  candidates: number;
  topK: number;
  /** Points each candidate is scored on (a sample of the free points). */
  sampleSize: number;
  /**
   * Candidates on a lattice over the free pixels and scored on an evenly spread sample (true), instead of random draws
   * (false, the earlier behaviour): the planes, and so the measurement, then do not depend on the random seed.
   */
  lattice: boolean;
  /** Half-size of the window a local candidate plane is fitted on, metres. */
  windowM: number;
  /** Touching planes whose normals are within this angle and whose heights agree within mergeStepM are one face. */
  mergeAngleDeg: number;
  mergeStepM: number;
  /**
   * Touching faces within this angle (degrees) whose joint plane fits within mergeFitM (80% of pixels) are one face.
   * Off (0) by default: on 54 real roofs it merged more real faces than terraces.
   */
  mergeLooseDeg: number;
  mergeFitM: number;
  /** A face smaller than this (square metres) that is mostly inside the roof is merged into its neighbours. */
  smallFaceM2: number;
  /** Any face smaller than this (about 25 sq ft) is merged into its neighbours. */
  tinyFaceM2: number;
  /** A face whose heights its neighbours' planes explain within this (metres, over 80% of it) is dissolved... */
  explainedM: number;
  /** ...when smaller than this (square metres) and than explainedShare of its largest neighbour. */
  explainedMaxM2: number;
  explainedShare: number;
  /** A chamfer or riser (buildFaces, step 4) is at most this big, square metres. */
  chamferMaxM2: number;
  /** Faces under explainedSmallM2 (square metres) are explained within explainedSmallM (metres). */
  explainedSmallM: number;
  explainedSmallM2: number;
  /** A face narrower than this on average (2 area / perimeter, metres) and under sliverM2 is a sliver. */
  sliverWidthM: number;
  sliverM2: number;
  /** A face under steepM2, at least steepX12 and steeper than its main neighbour by steeperX12, by the edge or trees. */
  steepM2: number;
  steepX12: number;
  steeperX12: number;
  /**
   * When no plane of minPlaneM2 is left at tolM, the search goes on with this many times tolM, measured square to
   * the plane: on a steep roof a height map's error grows with the slope (a 10 cm shift sideways is 10 cm of height
   * on a 12/12 face), so steep faces fall apart into scraps at tolM and are taken over by shallower neighbours.
   */
  rescueTolX: number;
  /**
   * A small face (under smallFaceM2, at least tinyFaceM2) that is a real plane of its own stays: its pixels away from
   * its boundary on one plane (smallKeepShare of them, see interiorFit) whose normal is more than smallKeepDeg from
   * every neighbour's (a dormer, a bay, a porch roof).
   */
  smallKeepDeg: number;
  smallKeepShare: number;
  /** Such a real plane is explained away (buildFaces, step 3) only within this, metres. */
  explainedRealM: number;
  /** ...and is no sliver (buildFaces, step 5) when at least this wide on average, metres. */
  sliverKeepWidthM: number;
  /** A steep face by the edge (buildFaces, step 5) stays when steepKeepShare of its interior lies on one plane. */
  steepKeepShare: number;
  /** interiorFit: pixels this far in from a face's boundary, on its plane within this (square to the plane), metres. */
  interiorEdgeM: number;
  interiorTolM: number;
};

export const DEFAULT_PLANE_PARAMS: PlaneParams = {
  tolM: 0.1,
  minPlaneM2: 2,
  maxPitchX12: 18,
  maxPlanes: 40,
  candidates: 320,
  topK: 12,
  sampleSize: 6000,
  lattice: true,
  windowM: 0.6,
  mergeAngleDeg: 4,
  mergeStepM: 0.35,
  mergeLooseDeg: 0,
  mergeFitM: 0.22,
  smallFaceM2: 4,
  tinyFaceM2: 2.35,
  explainedM: 0.3,
  explainedSmallM: 0.45,
  explainedSmallM2: 8,
  explainedMaxM2: 12,
  explainedShare: 0.6,
  chamferMaxM2: 12,
  sliverWidthM: 0.8,
  sliverM2: 8,
  steepM2: 15,
  steepX12: 8,
  steeperX12: 3,
  rescueTolX: 2,
  smallKeepDeg: 8,
  smallKeepShare: 0.8,
  explainedRealM: 0.15,
  sliverKeepWidthM: 0.5,
  steepKeepShare: 0.88,
  interiorEdgeM: 0.3,
  interiorTolM: 0.1,
};

/** Pixel centre coordinates in metres: x east from the grid's left edge, y north from its top edge (so y <= 0). */
export function pixelX(g: Grid, s: number, i: number): number {
  return ((i % g.w) + 0.5) * s;
}
export function pixelY(g: Grid, s: number, i: number): number {
  return -(Math.floor(i / g.w) + 0.5) * s;
}

export function planeZ(p: Plane, x: number, y: number): number {
  return p.a * x + p.b * y + p.c;
}

/** Least-squares plane through the pixels listed (centred for conditioning); null when they do not span a plane. */
export function fitPlane(g: Grid, s: number, dsm: Float32Array, idx: ArrayLike<number>, n = idx.length): Plane | null {
  if (n < 3) return null;
  let mx = 0;
  let my = 0;
  let mz = 0;
  let m = 0;
  for (let k = 0; k < n; k++) {
    const i = idx[k]!;
    const z = dsm[i]!;
    if (!Number.isFinite(z)) continue;
    mx += pixelX(g, s, i);
    my += pixelY(g, s, i);
    mz += z;
    m++;
  }
  if (m < 3) return null;
  mx /= m;
  my /= m;
  mz /= m;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxz = 0;
  let syz = 0;
  for (let k = 0; k < n; k++) {
    const i = idx[k]!;
    const z = dsm[i]!;
    if (!Number.isFinite(z)) continue;
    const x = pixelX(g, s, i) - mx;
    const y = pixelY(g, s, i) - my;
    const dz = z - mz;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sxz += x * dz;
    syz += y * dz;
  }
  const det = sxx * syy - sxy * sxy;
  if (!(Math.abs(det) > 1e-12 * Math.max(1, sxx * syy))) return null;
  const a = (sxz * syy - syz * sxy) / det;
  const b = (syz * sxx - sxz * sxy) / det;
  return { a, b, c: mz - a * mx - b * my };
}

export function slopeOf(p: Plane): number {
  return Math.hypot(p.a, p.b);
}

/** Angle between two planes' normals, degrees. */
export function planeAngleDeg(p: Plane, q: Plane): number {
  const n1 = [-p.a, -p.b, 1];
  const n2 = [-q.a, -q.b, 1];
  const dot = n1[0]! * n2[0]! + n1[1]! * n2[1]! + 1;
  const cos = dot / (Math.hypot(n1[0]!, n1[1]!, 1) * Math.hypot(n2[0]!, n2[1]!, 1));
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

function residual(g: Grid, s: number, dsm: Float32Array, p: Plane, i: number): number {
  const z = dsm[i]!;
  return Number.isFinite(z) ? Math.abs(z - planeZ(p, pixelX(g, s, i), pixelY(g, s, i))) : Infinity;
}

/** A height tolerance for plane p: `tol`, or (square) `tol` measured square to the plane, so more on steeper planes. */
function tolFor(p: Plane, tol: number, square: boolean): number {
  return square ? tol * Math.sqrt(1 + p.a * p.a + p.b * p.b) : tol;
}

/**
 * The plane's connected patch of free pixels round `starts`: a breadth-first walk through the pixels within `tol` of
 * the plane whose four neighbours are within it too (so a one-pixel thread along a crease does not join two faces),
 * grown back by a pixel. Only the patch is visited, never the whole grid.
 */
function patchFrom(g: Grid, s: number, dsm: Float32Array, free: Mask, p: Plane, tol0: number, square: boolean, starts: ArrayLike<number>): { patch: Mask; size: number } {
  const { w } = g;
  const tol = tolFor(p, tol0, square);
  const n = free.length;
  const state = new Int8Array(n);
  const on = (i: number): boolean => {
    if (state[i] === 0) state[i] = free[i] === 1 && residual(g, s, dsm, p, i) < tol ? 1 : 2;
    return state[i] === 1;
  };
  const inner = (i: number): boolean => {
    const c = i % w;
    return on(i) && c > 0 && on(i - 1) && c < w - 1 && on(i + 1) && i >= w && on(i - w) && i + w < n && on(i + w);
  };
  const patch = new Uint8Array(n);
  const queue: number[] = [];
  for (let k = 0; k < starts.length; k++) {
    const i = starts[k]!;
    if (patch[i] === 0 && inner(i)) {
      patch[i] = 1;
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    const c = i % w;
    for (const j of [c > 0 ? i - 1 : -1, c < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (j < 0 || j >= n || patch[j] === 1 || !inner(j)) continue;
      patch[j] = 1;
      queue.push(j);
    }
  }
  let size = queue.length;
  for (const i of queue) {
    const c = i % w;
    for (const j of [c > 0 ? i - 1 : -1, c < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (j < 0 || j >= n || patch[j] === 1 || !on(j)) continue;
      patch[j] = 1;
      size++;
    }
  }
  return { patch, size };
}

/**
 * Candidate seeds on a square lattice over the free pixels (`list`, raster order): the lattice step is chosen so about
 * `want` free pixels fall on it, so the search is as dense as `want` random draws but the same every run and for any
 * seed. The step shrinks as the free pixels run out, so the small faces left at the end are still visited. Lattice
 * points sit in the middle of each step (a step-k lattice offset by k/2), away from the raster's edge.
 */
export function latticeSeeds(g: Grid, list: Int32Array, want: number): Int32Array {
  const step = Math.max(1, Math.round(Math.sqrt(list.length / Math.max(1, want))));
  const off = Math.floor(step / 2);
  const out: number[] = [];
  for (let k = 0; k < list.length; k++) {
    const i = list[k]!;
    const c = i % g.w;
    const r = (i - c) / g.w;
    if (c % step === off && r % step === off) out.push(i);
  }
  return Int32Array.from(out);
}

function indicesOf(m: Mask): Int32Array {
  const out = new Int32Array(countSet(m));
  let k = 0;
  for (let i = 0; i < m.length; i++) if (m[i] === 1) out[k++] = i;
  return out;
}

export type FoundPlane = { plane: Plane; patch: Mask };

/**
 * Planes one at a time (sequential RANSAC) over the free roof pixels. Each candidate is a least-squares plane fitted on
 * a small window round a random free pixel (so small faces are found too), scored on a sample of the free pixels; the
 * best few are checked for their largest connected patch, and the biggest wins. A plane keeps only that patch (so two
 * separate faces never share a plane), is refitted on it, and its patch (and a pixel round it) stops being free.
 * When what is left has no patch of minPlaneM2, the search goes on once more with rescueTolX times the tolerance,
 * measured square to the plane (steep faces in a height map are rougher), then stops: trees, edges, clutter.
 */
export function findPlanes(g: Grid, s: number, dsm: Float32Array, roof: Mask, rng: () => number, prm: PlaneParams, tree: Mask | null = null): FoundPlane[] {
  const { w, h } = g;
  const free = erode(g, roof, Math.max(1, Math.round(0.2 / s)));
  // No plane is fitted on missing heights or on tree crowns.
  for (let i = 0; i < free.length; i++) if (!Number.isFinite(dsm[i]!) || tree?.[i] === 1) free[i] = 0;
  const minPx = prm.minPlaneM2 / (s * s);
  const maxSlope = prm.maxPitchX12 / 12;
  const R = Math.max(2, Math.round(prm.windowM / s));
  const out: FoundPlane[] = [];
  const win = new Int32Array((2 * R + 1) * (2 * R + 1));
  let tol = prm.tolM;
  let square = false;
  // After the first pass, the rescue pass (once).
  const rescue = (): boolean => {
    if (square || !(prm.rescueTolX > 0)) return false;
    tol = prm.tolM * prm.rescueTolX;
    square = true;
    return true;
  };
  while (out.length < prm.maxPlanes) {
    const list = indicesOf(free);
    if (list.length < minPx) break;
    const sample = new Int32Array(Math.min(prm.sampleSize, list.length));
    const seeds = prm.lattice ? latticeSeeds(g, list, prm.candidates) : null;
    if (prm.lattice) {
      // Evenly spread over the free pixels (in raster order), not drawn: the score does not hang on a random draw.
      for (let k = 0; k < sample.length; k++) sample[k] = list[Math.floor(((k + 0.5) * list.length) / sample.length)]!;
    } else {
      for (let k = 0; k < sample.length; k++) sample[k] = list[Math.floor(rng() * list.length)]!;
    }
    const top: { plane: Plane; score: number; seed: number }[] = [];
    const nCand = seeds !== null ? seeds.length : prm.candidates;
    for (let t = 0; t < nCand; t++) {
      const seed = seeds !== null ? seeds[t]! : list[Math.floor(rng() * list.length)]!;
      const c0 = seed % w;
      const r0 = (seed - c0) / w;
      let n = 0;
      for (let r = Math.max(0, r0 - R); r <= Math.min(h - 1, r0 + R); r++) {
        for (let c = Math.max(0, c0 - R); c <= Math.min(w - 1, c0 + R); c++) {
          const i = r * w + c;
          if (free[i] === 1) win[n++] = i;
        }
      }
      // A window cut by the roof's edge or a used plane is not a good place to guess a plane from.
      if (n < 0.5 * (2 * R + 1) * (2 * R + 1)) continue;
      const plane = fitPlane(g, s, dsm, win, n);
      if (plane === null || slopeOf(plane) > maxSlope) continue;
      // A window across a crease fits badly: skip it.
      let rss = 0;
      for (let k = 0; k < n; k++) rss += residual(g, s, dsm, plane, win[k]!) ** 2;
      const tolP = tolFor(plane, tol, square);
      if (Math.sqrt(rss / n) > tolP * 0.6) continue;
      let score = 0;
      for (let k = 0; k < sample.length; k++) if (residual(g, s, dsm, plane, sample[k]!) < tolP) score++;
      if (top.length < prm.topK || score > top[top.length - 1]!.score) {
        top.push({ plane, score, seed });
        // Ties go to the lower pixel index: the order never depends on how the candidates were visited.
        top.sort((x, y) => y.score - x.score || x.seed - y.seed);
        if (top.length > prm.topK) top.pop();
      }
    }
    if (top.length === 0) {
      if (rescue()) continue;
      break;
    }
    let best: { plane: Plane; patch: Mask; size: number } | null = null;
    for (const cand of top) {
      const { patch, size } = patchFrom(g, s, dsm, free, cand.plane, tol, square, [cand.seed]);
      if (best === null || size > best.size) best = { plane: cand.plane, patch, size };
    }
    if (best === null || best.size < minPx) {
      if (rescue()) continue;
      break;
    }
    // Refit on the patch, then take the patch again with the better plane.
    let plane = best.plane;
    let patch = best.patch;
    for (let it = 0; it < 3; it++) {
      const refit = fitPlane(g, s, dsm, indicesOf(patch));
      if (refit === null || slopeOf(refit) > maxSlope) break;
      const again = patchFrom(g, s, dsm, free, refit, tol, square, indicesOf(patch));
      if (again.size < minPx) break;
      plane = refit;
      patch = again.patch;
    }
    out.push({ plane, patch });
    // The patch and a pixel round it are used.
    for (let i = 0; i < patch.length; i++) {
      if (patch[i] !== 1) continue;
      free[i] = 0;
      const c = i % w;
      if (c > 0) free[i - 1] = 0;
      if (c < w - 1) free[i + 1] = 0;
      if (i >= w) free[i - w] = 0;
      if (i + w < free.length) free[i + w] = 0;
    }
  }
  return out;
}

/**
 * Every roof pixel to a plane: a flood from the seeds (label image, -1 = none) through the roof, always taking next the
 * free pixel that fits a neighbouring label's plane best. Boundaries settle where the planes' fits cross (along the
 * crease between them); clutter (trees, chimneys) goes to whichever face reaches it best. Only pixels where `fill` is
 * set (default: the whole roof) are given out; labels of other pixels stay as they are.
 */
export function floodAssign(
  g: Grid,
  s: number,
  dsm: Float32Array,
  roof: Mask,
  planes: readonly Plane[],
  seeds: Int32Array,
  fill: Mask | null = null,
  tree: Mask | null = null,
): Int32Array {
  const { w, h } = g;
  const labels = seeds.slice();
  const heap = new MinHeap(4096);
  // A pixel no plane explains (a tree crown, a chimney, no data), or under a tree, costs the same for every plane: such pixels are
  // shared out by distance from the faces round them, not by whichever plane happens to rise towards them.
  const cost = (i: number, k: number) => {
    if (tree?.[i] === 1) return UNEXPLAINED_M;
    const r = residual(g, s, dsm, planes[k]!, i);
    return Number.isFinite(r) ? Math.min(r, UNEXPLAINED_M) : UNEXPLAINED_M;
  };
  const open = (i: number) => roof[i] === 1 && labels[i]! < 0 && (fill === null || fill[i] === 1);
  const pushAround = (i: number, k: number) => {
    const c = i % w;
    const r = (i - c) / w;
    if (c > 0 && open(i - 1)) heap.push(cost(i - 1, k), i - 1, k);
    if (c < w - 1 && open(i + 1)) heap.push(cost(i + 1, k), i + 1, k);
    if (r > 0 && open(i - w)) heap.push(cost(i - w, k), i - w, k);
    if (r < h - 1 && open(i + w)) heap.push(cost(i + w, k), i + w, k);
  };
  for (let i = 0; i < labels.length; i++) if (labels[i]! >= 0) pushAround(i, labels[i]!);
  while (heap.size > 0) {
    const [i, k] = heap.pop();
    if (labels[i]! >= 0) continue;
    labels[i] = k;
    pushAround(i, k);
  }
  return labels;
}

/** Per label: pixel count, cracks shared with each other label, and cracks on the roof's edge. */
export function adjacency(g: Grid, labels: Int32Array, n: number): { area: number[]; shared: Map<number, number>; edge: number[] } {
  const { w, h } = g;
  const area = new Array<number>(n).fill(0);
  const edge = new Array<number>(n).fill(0);
  const shared = new Map<number, number>();
  const add = (a: number, b: number) => {
    if (a === b) return;
    if (a < 0 || b < 0) {
      const k = a < 0 ? b : a;
      if (k >= 0) edge[k]!++;
      return;
    }
    const key = a < b ? a * 100000 + b : b * 100000 + a;
    shared.set(key, (shared.get(key) ?? 0) + 1);
  };
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      const a = labels[i]!;
      if (a >= 0) {
        area[a]!++;
        if (c === 0) add(a, -1);
        if (r === 0) add(a, -1);
        if (c === w - 1) add(a, -1);
        if (r === h - 1) add(a, -1);
      }
      if (c < w - 1) add(a, labels[i + 1]!);
      if (r < h - 1) add(a, labels[i + w]!);
    }
  }
  return { area, shared, edge };
}

export type Faces = { labels: Int32Array; planes: Plane[] };

/** Residuals above this (metres) mean the pixel is not on that plane at all. */
const UNEXPLAINED_M = 0.5;

/** Renumbers labels 0..n-1 in order of first appearance, dropping planes no pixel uses. */
function compact(labels: Int32Array, planes: readonly Plane[]): Faces {
  const map = new Map<number, number>();
  const out = new Int32Array(labels.length);
  const kept: Plane[] = [];
  for (let i = 0; i < labels.length; i++) {
    const k = labels[i]!;
    if (k < 0) {
      out[i] = -1;
      continue;
    }
    let m = map.get(k);
    if (m === undefined) {
      m = kept.length;
      map.set(k, m);
      kept.push(planes[k]!);
    }
    out[i] = m;
  }
  return { labels: out, planes: kept };
}

/** Each label split into its 4-connected parts (each part its own face, same plane). */
function splitParts(g: Grid, f: Faces): Faces {
  const out = new Int32Array(f.labels.length).fill(-1);
  const planes: Plane[] = [];
  const seen = new Int32Array(f.labels.length).fill(-1);
  const { w, h } = g;
  const queue = new Int32Array(f.labels.length);
  for (let s0 = 0; s0 < f.labels.length; s0++) {
    const k = f.labels[s0]!;
    if (k < 0 || seen[s0]! >= 0) continue;
    const id = planes.length;
    planes.push(f.planes[k]!);
    let head = 0;
    let tail = 0;
    queue[tail++] = s0;
    seen[s0] = id;
    while (head < tail) {
      const p = queue[head++]!;
      out[p] = id;
      const c = p % w;
      const r = (p - c) / w;
      const nb = [c > 0 ? p - 1 : -1, c < w - 1 ? p + 1 : -1, r > 0 ? p - w : -1, r < h - 1 ? p + w : -1];
      for (const q of nb) {
        if (q >= 0 && seen[q]! < 0 && f.labels[q] === k) {
          seen[q] = id;
          queue[tail++] = q;
        }
      }
    }
  }
  return { labels: out, planes };
}

/** Mean height gap between two planes over the pixels on their shared boundary. */
function boundaryGap(g: Grid, s: number, labels: Int32Array, a: number, b: number, pa: Plane, pb: Plane): number {
  const { w, h } = g;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== a) continue;
    const c = i % w;
    const r = (i - c) / w;
    const touches = (c > 0 && labels[i - 1] === b) || (c < w - 1 && labels[i + 1] === b) || (r > 0 && labels[i - w] === b) || (r < h - 1 && labels[i + w] === b);
    if (!touches) continue;
    const x = pixelX(g, s, i);
    const y = pixelY(g, s, i);
    sum += Math.abs(planeZ(pa, x, y) - planeZ(pb, x, y));
    n++;
  }
  return n > 0 ? sum / n : Infinity;
}

/**
 * Refits each face's plane on its own pixels that sit on it (within tol, away from its boundary), twice: the plane
 * a face reports is fitted on that face only.
 */
export function refitFaces(g: Grid, s: number, dsm: Float32Array, f: Faces, tol: number, maxPitchX12 = Infinity): Plane[] {
  const inner = Math.max(1, Math.round(0.2 / s));
  return f.planes.map((p0, k) => {
    const mine = new Uint8Array(f.labels.length);
    for (let i = 0; i < mine.length; i++) if (f.labels[i] === k) mine[i] = 1;
    const core = erode({ w: g.w, h: g.h }, mine, inner);
    const src = countSet(core) >= 30 ? core : mine;
    let p = p0;
    for (let it = 0; it < 2; it++) {
      const idx: number[] = [];
      for (let i = 0; i < src.length; i++) if (src[i] === 1 && residual(g, s, dsm, p, i) < tol) idx.push(i);
      if (idx.length < 30) break;
      const q = fitPlane(g, s, dsm, idx);
      if (q === null || slopeOf(q) * 12 > maxPitchX12) break;
      p = q;
    }
    return p;
  });
}

/**
 * The faces: the RANSAC planes' pixels flooded over the whole roof, then cleaned until nothing changes: touching faces
 * whose planes are within mergeAngleDeg and agree in height at their boundary become one (refitted); faces under
 * tinyFaceM2, and faces under smallFaceM2 that touch the roof's edge for less than a quarter of their boundary, are
 * dissolved (their pixels flood from the faces round them). Every face ends up one 4-connected piece.
 */
export function buildFaces(
  g: Grid,
  s: number,
  dsm: Float32Array,
  roof: Mask,
  found: readonly FoundPlane[],
  prm: PlaneParams,
  tree: Mask | null = null,
): Faces {
  const n0 = found.length;
  let planes = found.map((f) => f.plane);
  // Seeds: each patch eroded a little, away from the contested creases.
  const seeds = new Int32Array(roof.length).fill(-1);
  const shrink = Math.max(1, Math.round(0.2 / s));
  for (let k = 0; k < n0; k++) {
    const core = erode(g, found[k]!.patch, shrink);
    const use = countSet(core) >= 20 ? core : found[k]!.patch;
    for (let i = 0; i < use.length; i++) if (use[i] === 1 && seeds[i]! < 0) seeds[i] = k;
  }
  let faces = splitParts(g, compact(floodAssign(g, s, dsm, roof, planes, seeds, null, tree), planes));
  const px2 = s * s;
  for (let round = 0; round < 12; round++) {
    // 0. A face in two parts joined by a narrow neck becomes two faces (each then checked like any other).
    const split = splitNecks(g, s, dsm, faces, prm);
    if (split.planes.length !== faces.planes.length) {
      faces = split;
      continue;
    }
    let changed = false;
    planes = faces.planes;
    const n = planes.length;
    const adj = adjacency(g, faces.labels, n);
    // 1. Merge neighbours that are one face: near-coplanar planes agreeing in height at their boundary, or (for a
    //    face broken up by terraces in the height map) a pair whose joint plane fits about as well as each alone.
    const pixelsOf: number[][] = Array.from({ length: n }, () => []);
    for (let i = 0; i < faces.labels.length; i++) if (faces.labels[i]! >= 0) pixelsOf[faces.labels[i]!]!.push(i);
    const p80 = (p: Plane, idx: readonly number[]) => {
      const r = idx.map((i) => residual(g, s, dsm, p, i)).filter(Number.isFinite).sort((x, y) => x - y);
      return r.length > 0 ? r[Math.floor(r.length * 0.8)]! : Infinity;
    };
    const own = planes.map((p, k) => p80(p, pixelsOf[k]!));
    const pairs: { a: number; b: number; ang: number }[] = [];
    for (const [key, cracks] of adj.shared) {
      const a = Math.floor(key / 100000);
      const b = key % 100000;
      if (cracks * s < 0.5) continue;
      const ang = planeAngleDeg(planes[a]!, planes[b]!);
      if (ang < prm.mergeLooseDeg) pairs.push({ a, b, ang });
    }
    pairs.sort((x, y) => x.ang - y.ang || x.a - y.a || x.b - y.b);
    const merged = new Set<number>();
    const labels = faces.labels.slice();
    for (const { a, b, ang } of pairs) {
      if (merged.has(a) || merged.has(b)) continue;
      const idx = [...pixelsOf[a]!, ...pixelsOf[b]!];
      const strict = ang < prm.mergeAngleDeg && boundaryGap(g, s, faces.labels, a, b, planes[a]!, planes[b]!) <= prm.mergeStepM;
      const p = fitPlane(g, s, dsm, idx);
      if (p === null) continue;
      if (!strict) {
        const joint = p80(p, idx);
        if (!(joint <= prm.mergeFitM && joint <= Math.max(own[a]!, own[b]!) + 0.05)) continue;
      }
      for (const i of idx) labels[i] = a;
      planes[a] = p;
      merged.add(a);
      merged.add(b);
      changed = true;
    }
    if (changed) {
      faces = splitParts(g, compact(labels, planes));
      continue;
    }
    // 2. Dissolve small faces into their neighbours.
    const gone = new Set<number>();
    const order = [...Array(n).keys()].sort((x, y) => adj.area[x]! - adj.area[y]! || x - y);
    for (const k of order) {
      const m2 = adj.area[k]! * px2;
      let boundary = adj.edge[k]!;
      for (const [key, cracks] of adj.shared) if (Math.floor(key / 100000) === k || key % 100000 === k) boundary += cracks;
      const onEdge = boundary > 0 ? adj.edge[k]! / boundary : 0;
      const small = m2 < prm.tinyFaceM2 || (m2 < prm.smallFaceM2 && onEdge < 0.25);
      if (!small || gone.size >= n - 1) continue;
      if (m2 >= prm.tinyFaceM2 && prm.smallKeepDeg > 0 && realPlane(g, s, dsm, faces, k, neighbours(adj, s, k), prm)) continue;
      gone.add(k);
    }
    if (gone.size > 0) {
      faces = dissolve(g, s, dsm, roof, faces, gone, tree);
      continue;
    }
    // 3. Dissolve a face its neighbours already explain: a rounded hip, ridge or apex, or a terrace in the height
    //    map, where the neighbours' planes (one of them, or the envelope of them) lie within explainedM of the
    //    heights over most of the face. One at a time, the best explained first.
    const worst = explainedFace(g, s, dsm, faces, adj, prm);
    if (worst >= 0) {
      faces = dissolve(g, s, dsm, roof, faces, new Set([worst]), tree);
      continue;
    }
    // 4. Dissolve a chamfer: a shallower face between two neighbours that meet in a convex crease (a hip or ridge the
    //    height map has rounded off), facing between them; or a riser: a small strip far steeper than a neighbour
    //    facing the same way (a terrace in the height map). Flat faces stay (a deck on a hip roof is real).
    const chamfer = chamferFace(g, s, faces, adj, prm);
    if (chamfer >= 0) {
      faces = dissolve(g, s, dsm, roof, faces, new Set([chamfer]), tree);
      continue;
    }
    // 5. Dissolve a sliver: a thin strip, or a small face much steeper than its main neighbour on the roof's edge, by
    //    trees or on rough heights (a gutter, a wall, a crown leaning over the eave).
    const sliver = sliverFace(g, s, dsm, faces, adj, prm, tree);
    if (sliver < 0) break;
    faces = dissolve(g, s, dsm, roof, faces, new Set([sliver]), tree);
  }
  return faces;
}

/**
 * Faces made of two parts joined only by a narrow neck (two triangles of one plane touching at a corner, say) split
 * into their parts: an opening of the face by 0.4 m that leaves two or more parts of minPlaneM2 or more; each pixel
 * goes to the nearest part.
 */
function splitNecks(g: Grid, s: number, dsm: Float32Array, faces: Faces, prm: PlaneParams): Faces {
  const r = Math.max(1, Math.round(0.4 / s));
  const minPx = prm.minPlaneM2 / (s * s);
  const labels = faces.labels.slice();
  const planes = [...faces.planes];
  const n = planes.length;
  // Each face's pixel count and box: the opening runs on the box only.
  const count = new Array<number>(n).fill(0);
  const box = Array.from({ length: n }, () => ({ c0: g.w, r0: g.h, c1: -1, r1: -1 }));
  for (let i = 0; i < labels.length; i++) {
    const k = labels[i]!;
    if (k < 0) continue;
    count[k]!++;
    const c = i % g.w;
    const rr = (i - c) / g.w;
    const b = box[k]!;
    if (c < b.c0) b.c0 = c;
    if (c > b.c1) b.c1 = c;
    if (rr < b.r0) b.r0 = rr;
    if (rr > b.r1) b.r1 = rr;
  }
  let changed = false;
  for (let k = 0; k < n; k++) {
    if (count[k]! < 2 * minPx) continue;
    const pad = r + 1;
    const c0 = Math.max(0, box[k]!.c0 - pad);
    const r0 = Math.max(0, box[k]!.r0 - pad);
    const sub = { w: Math.min(g.w - 1, box[k]!.c1 + pad) - c0 + 1, h: Math.min(g.h - 1, box[k]!.r1 + pad) - r0 + 1 };
    const full = (j: number) => (r0 + Math.floor(j / sub.w)) * g.w + c0 + (j % sub.w);
    const mine = new Uint8Array(sub.w * sub.h);
    for (let j = 0; j < mine.length; j++) if (labels[full(j)] === k) mine[j] = 1;
    const opened = open(sub, mine, r);
    const { labels: parts, sizes } = components(sub, (j) => opened[j] === 1);
    if (sizes.length < 3) continue;
    // Parts big enough, and really on the plane (most of their pixels within tol of it): not clutter at the edge.
    const onPlane = new Array<number>(sizes.length).fill(0);
    for (let j = 0; j < parts.length; j++) if (parts[j]! > 0 && residual(g, s, dsm, planes[k]!, full(j)) < prm.tolM) onPlane[parts[j]!]!++;
    const big = sizes
      .map((sz, id) => ({ sz, id }))
      .filter((p) => p.id > 0 && p.sz * s * s >= prm.smallFaceM2 && onPlane[p.id]! >= 0.8 * p.sz)
      .sort((a, b) => b.sz - a.sz || a.id - b.id);
    if (big.length < 2) continue;
    // Multi-source breadth-first growth of the big parts through the face.
    const owner = new Int32Array(mine.length).fill(-1);
    const queue = new Int32Array(mine.length);
    let tail = 0;
    const idOf = new Map<number, number>();
    big.forEach((p, j) => idOf.set(p.id, j === 0 ? k : planes.length + j - 1));
    for (let j = 1; j < big.length; j++) planes.push(planes[k]!);
    for (let j = 0; j < mine.length; j++) {
      const lab = idOf.get(parts[j]!);
      if (lab !== undefined && mine[j] === 1) {
        owner[j] = lab;
        queue[tail++] = j;
      }
    }
    let head = 0;
    while (head < tail) {
      const p = queue[head++]!;
      const c = p % sub.w;
      for (const q of [c > 0 ? p - 1 : -1, c < sub.w - 1 ? p + 1 : -1, p - sub.w, p + sub.w]) {
        if (q < 0 || q >= mine.length || mine[q] !== 1 || owner[q]! >= 0) continue;
        owner[q] = owner[p]!;
        queue[tail++] = q;
      }
    }
    for (let j = 0; j < mine.length; j++) if (mine[j] === 1 && owner[j]! >= 0) labels[full(j)] = owner[j]!;
    changed = true;
  }
  return changed ? splitParts(g, compact(labels, planes)) : faces;
}

/** The faces sharing at least half a metre of boundary with face k. */
function neighbours(adj: ReturnType<typeof adjacency>, s: number, k: number): number[] {
  const out: number[] = [];
  for (const [key, cracks] of adj.shared) {
    if (cracks * s < 0.5) continue;
    const a = Math.floor(key / 100000);
    const b = key % 100000;
    if (a === k) out.push(b);
    else if (b === k) out.push(a);
  }
  return out;
}

/**
 * How well face k's pixels away from its boundary (interiorEdgeM in: creases are rounded and eaves meet walls in a
 * height map) lie on one plane: that plane (refitted on its own inliers from p0), and the share of the pixels within
 * interiorTolM of it, measured square to it. Null when the face has too few such pixels.
 */
export function interiorFit(g: Grid, s: number, dsm: Float32Array, labels: Int32Array, k: number, p0: Plane, prm: PlaneParams): { plane: Plane; share: number } | null {
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
  if (c1 < 0) return null;
  const sub = { w: c1 - c0 + 1, h: r1 - r0 + 1 };
  const full = (j: number) => (r0 + Math.floor(j / sub.w)) * g.w + c0 + (j % sub.w);
  const mine = new Uint8Array(sub.w * sub.h);
  let total = 0;
  for (let j = 0; j < mine.length; j++) {
    if (labels[full(j)] === k) {
      mine[j] = 1;
      total++;
    }
  }
  // A narrow face keeps a core with half the margin.
  let idx: number[] = [];
  for (const edgeM of [prm.interiorEdgeM, prm.interiorEdgeM / 2]) {
    const core = erode(sub, mine, Math.max(1, Math.round(edgeM / s)));
    idx = [];
    for (let j = 0; j < core.length; j++) if (core[j] === 1 && Number.isFinite(dsm[full(j)]!)) idx.push(full(j));
    if (idx.length >= Math.max(30, 0.2 * total)) break;
  }
  if (idx.length < 30) return null;
  let p = p0;
  for (let it = 0; it < 3; it++) {
    const t = tolFor(p, prm.interiorTolM, true) * (it === 0 ? 2 : 1);
    const on = idx.filter((i) => residual(g, s, dsm, p, i) < t);
    if (on.length < 20) break;
    const q = fitPlane(g, s, dsm, on);
    if (q === null) break;
    p = q;
  }
  const t = tolFor(p, prm.interiorTolM, true);
  let inliers = 0;
  for (const i of idx) if (residual(g, s, dsm, p, i) < t) inliers++;
  return { plane: p, share: inliers / idx.length };
}

/** Whether face k is a real plane of its own (see PlaneParams.smallKeepDeg) next to the faces `near`. */
function realPlane(g: Grid, s: number, dsm: Float32Array, faces: Faces, k: number, near: readonly number[], prm: PlaneParams): boolean {
  if (near.length === 0) return false;
  const fit = interiorFit(g, s, dsm, faces.labels, k, faces.planes[k]!, prm);
  return fit !== null && fit.share >= prm.smallKeepShare && near.every((m) => planeAngleDeg(fit.plane, faces.planes[m]!) > prm.smallKeepDeg);
}

/** The faces in `gone` dissolved: their pixels flood from the faces round them. */
export function dissolve(g: Grid, s: number, dsm: Float32Array, roof: Mask, faces: Faces, gone: ReadonlySet<number>, tree: Mask | null): Faces {
  const seeds = faces.labels.slice();
  const fill = new Uint8Array(roof.length);
  for (let i = 0; i < seeds.length; i++) {
    if (gone.has(seeds[i]!)) {
      seeds[i] = -1;
      fill[i] = 1;
    }
  }
  return splitParts(g, compact(floodAssign(g, s, dsm, roof, faces.planes, seeds, fill, tree), faces.planes));
}

/** The face its neighbours explain best (see buildFaces, step 3), or -1 when none qualifies. */
function explainedFace(g: Grid, s: number, dsm: Float32Array, faces: Faces, adj: ReturnType<typeof adjacency>, prm: PlaneParams): number {
  const n = faces.planes.length;
  if (n < 2) return -1;
  const near: number[][] = Array.from({ length: n }, () => []);
  for (const [key, cracks] of adj.shared) {
    if (cracks * s < 0.5) continue;
    const a = Math.floor(key / 100000);
    const b = key % 100000;
    near[a]!.push(b);
    near[b]!.push(a);
  }
  const px2 = s * s;
  const devs: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < faces.labels.length; i++) {
    const k = faces.labels[i]!;
    if (k < 0 || near[k]!.length === 0) continue;
    const z = dsm[i]!;
    if (!Number.isFinite(z)) continue;
    const x = pixelX(g, s, i);
    const y = pixelY(g, s, i);
    let best = Infinity;
    let lo = Infinity;
    let hi = -Infinity;
    for (const m of near[k]!) {
      const h = planeZ(faces.planes[m]!, x, y);
      best = Math.min(best, Math.abs(z - h));
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    devs[k]!.push(Math.min(best, Math.abs(z - lo), Math.abs(z - hi)));
  }
  let pick = -1;
  let pickDev = 0;
  for (let k = 0; k < n; k++) {
    const m2 = adj.area[k]! * px2;
    if (m2 > prm.explainedMaxM2 || devs[k]!.length < 10) continue;
    const biggest = Math.max(...near[k]!.map((m) => adj.area[m]!));
    if (adj.area[k]! > prm.explainedShare * biggest) continue;
    const d = devs[k]!.sort((a, b) => a - b)[Math.floor(devs[k]!.length * 0.8)]!;
    // Small faces get more room: terraces in the height map are a few tens of centimetres tall.
    const limit = m2 < prm.explainedSmallM2 ? prm.explainedSmallM : prm.explainedM;
    if (d < limit && d - limit < pickDev) {
      // A real plane of its own (a dormer's face) is explained only when its neighbours' planes are really on it.
      if (prm.smallKeepDeg > 0 && d >= prm.explainedRealM && realPlane(g, s, dsm, faces, k, near[k]!, prm)) continue;
      pickDev = d - limit;
      pick = k;
    }
  }
  return pick;
}

function azimuth(p: Plane): number {
  return (((Math.atan2(-p.a, -p.b) * 180) / Math.PI) % 360 + 360) % 360;
}

function arc(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** The smallest chamfer or riser face (see buildFaces, step 4), or -1. */
function chamferFace(g: Grid, s: number, faces: Faces, adj: ReturnType<typeof adjacency>, prm: PlaneParams): number {
  const n = faces.planes.length;
  const near: number[][] = Array.from({ length: n }, () => []);
  for (const [key, cracks] of adj.shared) {
    if (cracks * s < 0.5) continue;
    const a = Math.floor(key / 100000);
    const b = key % 100000;
    near[a]!.push(b);
    near[b]!.push(a);
  }
  const cx = new Array<number>(n).fill(0);
  const cy = new Array<number>(n).fill(0);
  for (let i = 0; i < faces.labels.length; i++) {
    const k = faces.labels[i]!;
    if (k < 0) continue;
    cx[k]! += pixelX(g, s, i);
    cy[k]! += pixelY(g, s, i);
  }
  for (let k = 0; k < n; k++) {
    cx[k]! /= Math.max(1, adj.area[k]!);
    cy[k]! /= Math.max(1, adj.area[k]!);
  }
  const P = faces.planes;
  const slope = (k: number) => Math.hypot(P[k]!.a, P[k]!.b);
  const convex = (a: number, b: number) =>
    planeZ(P[a]!, cx[a]!, cy[a]!) < planeZ(P[b]!, cx[a]!, cy[a]!) && planeZ(P[b]!, cx[b]!, cy[b]!) < planeZ(P[a]!, cx[b]!, cy[b]!);
  let pick = -1;
  for (let f = 0; f < n; f++) {
    if (slope(f) * 12 < 2 || adj.area[f]! * s * s > prm.chamferMaxM2) continue;
    if (pick >= 0 && adj.area[f]! >= adj.area[pick]!) continue;
    const nb = near[f]!;
    // A riser: a small strip much steeper than a neighbour facing the same way (a terrace in the height map).
    const riser = nb.some(
      (m) => arc(azimuth(P[m]!), azimuth(P[f]!)) < 25 && slope(f) - slope(m) > 4 / 12 && adj.area[f]! < 0.5 * adj.area[m]! && adj.area[f]! * s * s < 15,
    );
    if (riser) {
      pick = f;
      continue;
    }
    let found = false;
    for (let i = 0; i < nb.length && !found; i++) {
      for (let j = i + 1; j < nb.length && !found; j++) {
        const a = nb[i]!;
        const b = nb[j]!;
        if (adj.area[f]! >= adj.area[a]! || adj.area[f]! >= adj.area[b]!) continue;
        if (slope(f) >= Math.min(slope(a), slope(b))) continue;
        const between = arc(azimuth(P[a]!), azimuth(P[f]!)) + arc(azimuth(P[f]!), azimuth(P[b]!)) <= arc(azimuth(P[a]!), azimuth(P[b]!)) + 5;
        if (between && convex(a, b)) found = true;
      }
    }
    if (found) pick = f;
  }
  return pick;
}

/**
 * The smallest sliver (see buildFaces, step 5), or -1: a face thinner on average than sliverWidthM and under sliverM2;
 * or a face under steepM2, at least steepX12, steeper by steeperX12 than the neighbour it shares most boundary with,
 * that lies along the roof's edge (15% of its boundary), next to tree crowns (a fifth of it within a metre of one),
 * or on rough heights (a fifth of its pixels more than 12 cm off its own plane).
 */
function sliverFace(g: Grid, s: number, dsm: Float32Array, faces: Faces, adj: ReturnType<typeof adjacency>, prm: PlaneParams, tree: Mask | null): number {
  const n = faces.planes.length;
  if (n < 2) return -1;
  const shared: Map<number, number>[] = Array.from({ length: n }, () => new Map());
  const boundary = adj.edge.slice();
  for (const [key, cracks] of adj.shared) {
    const a = Math.floor(key / 100000);
    const b = key % 100000;
    shared[a]!.set(b, cracks);
    shared[b]!.set(a, cracks);
    boundary[a]! += cracks;
    boundary[b]! += cracks;
  }
  const nearTree = tree === null ? null : dilate(g, tree, Math.max(1, Math.round(1 / s)));
  const treeCount = new Array<number>(n).fill(0);
  const rough = new Array<number>(n).fill(0);
  for (let i = 0; i < faces.labels.length; i++) {
    const k = faces.labels[i]!;
    if (k < 0) continue;
    if (nearTree?.[i] === 1) treeCount[k]!++;
    if (residual(g, s, dsm, faces.planes[k]!, i) > 0.12) rough[k]!++;
  }
  const px2 = s * s;
  let pick = -1;
  for (let f = 0; f < n; f++) {
    const area = adj.area[f]!;
    if (area === 0 || shared[f]!.size === 0) continue;
    if (pick >= 0 && area >= adj.area[pick]!) continue;
    const m2 = area * px2;
    const width = (2 * area * s) / Math.max(1, boundary[f]!);
    // Steeper than any roof plane may be (a wall or a crown that merged into a face).
    if (Math.hypot(faces.planes[f]!.a, faces.planes[f]!.b) * 12 > prm.maxPitchX12 + 0.5) {
      pick = f;
      continue;
    }
    if (width < prm.sliverWidthM && m2 < prm.sliverM2) {
      // A narrow face that is a real plane of its own (a dormer's face) is not a sliver.
      const real = width >= prm.sliverKeepWidthM && prm.smallKeepDeg > 0 && realPlane(g, s, dsm, faces, f, [...shared[f]!.keys()], prm);
      if (!real) {
        pick = f;
        continue;
      }
    }
    const slope = Math.hypot(faces.planes[f]!.a, faces.planes[f]!.b) * 12;
    if (m2 >= prm.steepM2 || slope < prm.steepX12) continue;
    let main = -1;
    for (const [m, cracks] of shared[f]!) if (main < 0 || cracks > shared[f]!.get(main)! || (cracks === shared[f]!.get(main)! && m < main)) main = m;
    const mainSlope = Math.hypot(faces.planes[main]!.a, faces.planes[main]!.b) * 12;
    if (slope - mainSlope < prm.steeperX12) continue;
    const onEdge = adj.edge[f]! / Math.max(1, boundary[f]!) >= 0.15;
    const byTrees = treeCount[f]! >= 0.2 * area;
    const isRough = rough[f]! >= 0.2 * area;
    if (!(onEdge || byTrees || isRough)) continue;
    // ...unless (away from trees) it is a clean plane of its own: a steep dormer or gable face by the eave.
    if (!byTrees && prm.steepKeepShare > 0 && width >= prm.sliverWidthM) {
      const fit = interiorFit(g, s, dsm, faces.labels, f, faces.planes[f]!, prm);
      if (fit !== null && fit.share >= prm.steepKeepShare) continue;
    }
    pick = f;
  }
  return pick;
}
