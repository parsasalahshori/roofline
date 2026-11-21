// Refinement by the height map's own verdict (analysis by synthesis): after the faces and their topology are settled,
// every change to the roof model is asked one question: does the model with the change explain the heights better
// for what it costs? The currency is the robust residual per pixel (Cauchy loss, scale `lossM`), not a face's size.
//
// - Merge: two touching faces are one face when one plane over both raises the robust residual by less than
//   `mergePerPx` per pixel of the smaller face, and the smaller face lies on that plane within the bow (`mergeMedM`).
//   Measured on the benchmark's dev houses (EagleView faces as the answer key, 662 touching pairs): this separates two
//   pieces of one slope from two faces meeting in a crease with AUC 0.985; the threshold is the residual a
//   photogrammetric height map's bow leaves on one plane over a whole slope (an RMS of about 0.15 m), and
//   leave-one-house-out picks the same value on every house. Never across a wall (the planes `stepM` apart at the
//   shared boundary), never between two pitched faces falling different ways, never merging away a face that stands on
//   evidence of its own, and every original piece of a merged face must still lie on its plane within the bow.
// - judgeChange: the same two tests asked of any proposed change (a split, a new face, a drop), so every move is judged
//   in one currency and no move can undo another.
import { compact, type Faces, type Plane, pixelX, pixelY, planeZ, slopeOf } from './planes.ts';
import type { Grid, Mask } from './raster.ts';

export type RefineParams = {
  /** Off by default. */
  enabled: boolean;
  /** Scale of the robust (Cauchy) loss on a pixel's height residual, metres. */
  lossM: number;
  /** Merge two faces when one plane over both costs less than this more per pixel of the smaller face (m2). 0: no merges. */
  mergePerPx: number;
  /**
   * And only when the smaller face's pixels lie on the plane over both within this (median absolute residual, metres):
   * the bow a photogrammetric height map puts in one slope. Without it a face its own plane already fits poorly (its
   * blurred edges, a crown's fringe) pays little for being moved onto a neighbour's plane (the robust loss saturates).
   */
  mergeMedM: number;
  /** Faces sharing less boundary than this (metres) are not merge candidates. */
  mergeMinSharedM: number;
  /** Two faces whose planes are this far apart in height along their shared boundary (median, metres) meet in a wall. */
  stepM: number;
  /**
   * Two faces both steeper than `pitchedX12` (x/12) whose downhill directions differ by more than `mergeMaxAzDeg` never
   * merge: pieces of one slope fall the same way, faces meeting in a hip or valley fall 90 degrees apart (45 is midway).
   */
  pitchedX12: number;
  mergeMaxAzDeg: number;
  /** A face standing on evidence of its own (a ridge or hip of its own, a facing no neighbour shares) is never merged away. */
  keepOwned: boolean;
};

export const DEFAULT_REFINE: RefineParams = {
  enabled: false,
  lossM: 0.1,
  mergePerPx: 0.0115,
  mergeMedM: 0.15,
  mergeMinSharedM: 0.5,
  stepM: 0.4,
  pitchedX12: 2,
  mergeMaxAzDeg: 45,
  keepOwned: true,
};

/** One face's pixels (finite heights, off tree crowns), centred coordinates for a well-conditioned fit. */
type FacePx = { x: Float64Array; y: Float64Array; z: Float64Array; n: number };

/** Cauchy loss and the IRLS weight. */
function rho(r: number, c: number): number {
  const u = r / c;
  return 0.5 * c * c * Math.log1p(u * u);
}

/**
 * The plane minimising the Cauchy loss over the pixels of `parts` (IRLS from `p0`), and that loss. Deterministic: a fixed
 * number of rounds, sums in pixel order.
 */
export function robustPlane(parts: readonly FacePx[], p0: Plane, c: number, rounds = 6): { plane: Plane; cost: number; n: number } {
  let n = 0;
  let mx = 0;
  let my = 0;
  for (const f of parts) {
    for (let k = 0; k < f.n; k++) {
      mx += f.x[k]!;
      my += f.y[k]!;
    }
    n += f.n;
  }
  if (n < 3) return { plane: p0, cost: 0, n };
  mx /= n;
  my /= n;
  // z = a (x - mx) + b (y - my) + d
  let a = p0.a;
  let b = p0.b;
  let d = planeZ(p0, mx, my);
  for (let it = 0; it < rounds; it++) {
    let sw = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    let sz = 0;
    let sxz = 0;
    let syz = 0;
    for (const f of parts) {
      for (let k = 0; k < f.n; k++) {
        const x = f.x[k]! - mx;
        const y = f.y[k]! - my;
        const z = f.z[k]!;
        const r = z - (a * x + b * y + d);
        const u = r / c;
        const w = 1 / (1 + u * u);
        sw += w;
        sx += w * x;
        sy += w * y;
        sxx += w * x * x;
        sxy += w * x * y;
        syy += w * y * y;
        sz += w * z;
        sxz += w * x * z;
        syz += w * y * z;
      }
    }
    // Normal equations [sxx sxy sx; sxy syy sy; sx sy sw] [a b d] = [sxz syz sz]
    const m00 = sxx;
    const m01 = sxy;
    const m02 = sx;
    const m11 = syy;
    const m12 = sy;
    const m22 = sw;
    const det = m00 * (m11 * m22 - m12 * m12) - m01 * (m01 * m22 - m12 * m02) + m02 * (m01 * m12 - m11 * m02);
    if (!(Math.abs(det) > 1e-12)) break;
    const na = (sxz * (m11 * m22 - m12 * m12) - m01 * (syz * m22 - m12 * sz) + m02 * (syz * m12 - m11 * sz)) / det;
    const nb = (m00 * (syz * m22 - m12 * sz) - sxz * (m01 * m22 - m12 * m02) + m02 * (m01 * sz - syz * m02)) / det;
    const nd = (m00 * (m11 * sz - syz * m12) - m01 * (m01 * sz - syz * m02) + sxz * (m01 * m12 - m11 * m02)) / det;
    a = na;
    b = nb;
    d = nd;
  }
  let cost = 0;
  for (const f of parts) for (let k = 0; k < f.n; k++) cost += rho(f.z[k]! - (a * (f.x[k]! - mx) + b * (f.y[k]! - my) + d), c);
  return { plane: { a, b, c: d - a * mx - b * my }, cost, n };
}

/** The pixels of each face (finite height, not under a crown). */
function facePixels(g: Grid, s: number, dsm: Float32Array, labels: Int32Array, n: number, tree: Mask | null): FacePx[] {
  const count = new Int32Array(n);
  for (let i = 0; i < labels.length; i++) {
    const k = labels[i]!;
    if (k >= 0 && Number.isFinite(dsm[i]!) && tree?.[i] !== 1) count[k]!++;
  }
  const out: FacePx[] = Array.from({ length: n }, (_, k) => ({ x: new Float64Array(count[k]!), y: new Float64Array(count[k]!), z: new Float64Array(count[k]!), n: 0 }));
  for (let i = 0; i < labels.length; i++) {
    const k = labels[i]!;
    if (k < 0 || !Number.isFinite(dsm[i]!) || tree?.[i] === 1) continue;
    const f = out[k]!;
    f.x[f.n] = pixelX(g, s, i);
    f.y[f.n] = pixelY(g, s, i);
    f.z[f.n] = dsm[i]!;
    f.n++;
  }
  return out;
}

/** Shared boundary between touching faces: crack count and the midpoints of the cracks (for the wall test). */
function sharedCracks(g: Grid, s: number, labels: Int32Array): Map<number, { cracks: number; mids: number[] }> {
  const out = new Map<number, { cracks: number; mids: number[] }>();
  const { w, h } = g;
  const add = (p: number, q: number, x: number, y: number) => {
    const lo = Math.min(p, q);
    const hi = Math.max(p, q);
    const key = lo * 65536 + hi;
    let e = out.get(key);
    if (e === undefined) {
      e = { cracks: 0, mids: [] };
      out.set(key, e);
    }
    e.cracks++;
    e.mids.push(x, y);
  };
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      const k = labels[i]!;
      if (k < 0) continue;
      if (c + 1 < w) {
        const m = labels[i + 1]!;
        if (m >= 0 && m !== k) add(k, m, (c + 1) * s, -(r + 0.5) * s);
      }
      if (r + 1 < h) {
        const m = labels[i + w]!;
        if (m >= 0 && m !== k) add(k, m, (c + 0.5) * s, -(r + 1) * s);
      }
    }
  }
  return out;
}

function azimuthDeg(p: Plane): number {
  return ((Math.atan2(-p.a, -p.b) * 180) / Math.PI + 360) % 360;
}

function median(v: number[]): number {
  if (v.length === 0) return 0;
  const t = [...v].sort((a, b) => a - b);
  const m = t.length >> 1;
  return t.length % 2 === 1 ? t[m]! : (t[m - 1]! + t[m]!) / 2;
}

export type RefineReport = { merged: number };

/** What the merge may not touch: `fixed` faces never merge; an `owned` face (evidence of its own) is never merged away. */
export type MergeGuards = { fixed: (k: number) => boolean; owned?: (k: number) => boolean };

/**
 * Touching faces merged where one plane explains both nearly as well as two (see the file's head), lowest cost first,
 * the costs of the merged face's pairs worked out again after each merge. `fixed` faces (fitted primitives: their
 * planes are not fitted on their heights) never merge. An `owned` face (one standing on evidence of its own: a ridge
 * or hip of its own, or a facing no neighbour shares) is never the one merged away, though it may take a fragment in.
 * A merged face is held to what its pieces were: every original face in it must lie on the merged plane within the bow
 * and pay less than `mergePerPx` per pixel over its own plane, so a slope that has taken one bowed piece in cannot
 * drift onto the next, real, face. Returns null when nothing merges.
 */
export function mergeByEnergy(
  g: Grid,
  s: number,
  dsm: Float32Array,
  faces: Faces,
  planes: readonly Plane[],
  tree: Mask | null,
  guards: MergeGuards,
  prm: RefineParams,
  debug?: (msg: string) => void,
): { faces: Faces; report: RefineReport } | null {
  if (!(prm.mergePerPx > 0)) return null;
  const n = planes.length;
  if (n < 2) return null;
  const c = prm.lossM;
  const px = facePixels(g, s, dsm, faces.labels, n, tree);
  // Each original face's own robust plane and cost; each group (rooted at a face) its members, plane, cost and size.
  const own = px.map((p, k) => robustPlane([p], planes[k]!, c));
  const members: number[][] = px.map((_, k) => [k]);
  const fit = own.map((f) => ({ ...f }));
  const owned = (k: number) => members[k]!.some((m) => guards.owned?.(m) === true);
  const isFixed = (k: number) => members[k]!.some((m) => guards.fixed(m));
  const into = new Int32Array(n).fill(-1);
  const root = (k: number): number => {
    while (into[k]! >= 0) k = into[k]!;
    return k;
  };
  const shared = sharedCracks(g, s, faces.labels);
  const keyOf = (a: number, b: number) => Math.min(a, b) * 65536 + Math.max(a, b);
  const pitched = prm.pitchedX12 / 12;
  // The cost of merging groups a and b (per pixel of the smaller), or null when they may not merge.
  const pairCost = (a: number, b: number, e: { cracks: number; mids: number[] }, why?: (r: string, v?: number) => void): { perPx: number; plane: Plane; cost: number } | null => {
    const no = (r: string, v?: number) => {
      why?.(r, v);
      return null;
    };
    if (e.cracks * s < prm.mergeMinSharedM) return no('shared');
    if (isFixed(a) || isFixed(b)) return no('fixed');
    const fa = fit[a]!;
    const fb = fit[b]!;
    if (fa.n < 10 || fb.n < 10) return no('few');
    // The smaller group is the one merged away: never one holding a face with evidence of its own.
    if (owned(fa.n < fb.n ? a : b)) return no('owned');
    const pa = fa.plane;
    const pb = fb.plane;
    // Never between two pitched faces that fall different ways.
    if (slopeOf(pa) >= pitched && slopeOf(pb) >= pitched) {
      const d = Math.abs(((azimuthDeg(pa) - azimuthDeg(pb) + 540) % 360) - 180);
      if (d > prm.mergeMaxAzDeg) return no('facing', d);
    }
    // Never across a wall.
    const gaps: number[] = [];
    for (let k = 0; k < e.mids.length; k += 2) gaps.push(Math.abs(planeZ(pa, e.mids[k]!, e.mids[k + 1]!) - planeZ(pb, e.mids[k]!, e.mids[k + 1]!)));
    if (median(gaps) > prm.stepM) return no('wall', median(gaps));
    const parts = [...members[a]!, ...members[b]!];
    const m = robustPlane(
      parts.map((k) => px[k]!),
      fa.n >= fb.n ? pa : pb,
      c,
    );
    const perPx = (m.cost - fa.cost - fb.cost) / Math.min(fa.n, fb.n);
    if (!(perPx < prm.mergePerPx)) return no('cost', perPx);
    // Every original face in the merged one lies on its plane within the bow, at little cost over its own plane.
    for (const k of parts) {
      const f = px[k]!;
      if (f.n === 0) continue;
      const res: number[] = [];
      let cost = 0;
      for (let q = 0; q < f.n; q++) {
        const r = f.z[q]! - planeZ(m.plane, f.x[q]!, f.y[q]!);
        res.push(Math.abs(r));
        cost += rho(r, c);
      }
      if (prm.mergeMedM > 0 && !(median(res) < prm.mergeMedM)) return no(k === (fa.n < fb.n ? a : b) || parts.length === 2 ? 'bow' : 'bow-member', median(res));
      if (!((cost - own[k]!.cost) / f.n < prm.mergePerPx)) return no('member-cost', (cost - own[k]!.cost) / f.n);
    }
    return { perPx, plane: m.plane, cost: m.cost };
  };
  let merged = 0;
  for (;;) {
    let best: { a: number; b: number; perPx: number; plane: Plane; cost: number } | null = null;
    // Deterministic order: keys ascending.
    const keys = [...shared.keys()].sort((x, y) => x - y);
    for (const key of keys) {
      const a = Math.floor(key / 65536);
      const b = key % 65536;
      const pc = pairCost(a, b, shared.get(key)!);
      if (pc === null) continue;
      if (best === null || pc.perPx < best.perPx) best = { a, b, ...pc };
    }
    if (best === null) {
      if (debug !== undefined) {
        for (const key of keys) {
          const a = Math.floor(key / 65536);
          const b = key % 65536;
          pairCost(a, b, shared.get(key)!, (r, v) => debug(`refine: refused ${JSON.stringify({ a, b, ma: members[a], mb: members[b], why: r, v: v ?? null })}`));
        }
      }
      break;
    }
    const { a, b } = best;
    if (debug !== undefined) {
      const cen = (k: number) => {
        let sx = 0;
        let sy = 0;
        let m = 0;
        for (const q of members[k]!) {
          const f = px[q]!;
          for (let i = 0; i < f.n; i++) {
            sx += f.x[i]!;
            sy += f.y[i]!;
          }
          m += f.n;
        }
        return `${(sx / Math.max(1, m)).toFixed(2)},${(sy / Math.max(1, m)).toFixed(2)},${m}`;
      };
      debug(`refine: merge ${JSON.stringify({ a, b, perPx: best.perPx, ca: cen(a), cb: cen(b), pa: slopeOf(fit[a]!.plane) * 12, pb: slopeOf(fit[b]!.plane) * 12, aza: azimuthDeg(fit[a]!.plane), azb: azimuthDeg(fit[b]!.plane), ma: members[a], mb: members[b] })}`);
    }
    // b joins a.
    into[b] = a;
    members[a] = [...members[a]!, ...members[b]!];
    members[b] = [];
    fit[a] = { plane: best.plane, cost: best.cost, n: fit[a]!.n + fit[b]!.n };
    merged++;
    // Re-key b's boundaries onto a.
    const next = new Map<number, { cracks: number; mids: number[] }>();
    for (const [key, e] of shared) {
      const x = root(Math.floor(key / 65536));
      const y = root(key % 65536);
      if (x === y) continue;
      const k2 = keyOf(x, y);
      const have = next.get(k2);
      if (have === undefined) next.set(k2, { cracks: e.cracks, mids: e.mids.slice() });
      else {
        have.cracks += e.cracks;
        for (const v of e.mids) have.mids.push(v);
      }
    }
    shared.clear();
    for (const [k2, e] of next) shared.set(k2, e);
  }
  if (merged === 0) return null;
  const labels = new Int32Array(faces.labels.length);
  for (let i = 0; i < labels.length; i++) labels[i] = faces.labels[i]! < 0 ? -1 : root(faces.labels[i]!);
  // Merged faces start from the plane fitted over all their pieces; the others keep theirs (identity kept for fixed planes).
  const outPlanes = faces.planes.map((p, k) => (into[k]! < 0 && members[k]!.length > 1 ? fit[k]!.plane : p));
  return { faces: compact(labels, outPlanes), report: { merged } };
}

/** The height map's verdict on a proposed change to the faces (judgeChange). */
export type ChangeVerdict = {
  /** Pixels whose plane the change alters (finite height, off tree crowns, on a face before and after). */
  pixels: number;
  /** Robust residual (Cauchy, lossM) summed over those pixels with the faces before and after the change, m2. */
  before: number;
  after: number;
  /** Faces the change adds and removes: a face whose plane is new, a face whose plane is gone (a refit plane is new). */
  added: number;
  removed: number;
  /** The pixel count the change is judged per: its smallest added or removed face (on the pixels it alters). */
  refPixels: number;
  /** (before - after) / refPixels: positive when the change explains the heights better. */
  gainPerPx: number;
  /**
   * Median |residual| of the smallest added face's pixels on the planes they had before (a split, a new face), or of the
   * smallest removed face's pixels on the planes they have after (a merge, a drop), metres.
   */
  medianM: number;
  accept: boolean;
  /** Why: 'adds-pays' / 'adds-small-gain' / 'adds-within-bow' / 'removes-cheap' / 'removes-costly' / 'removes-off-plane' / 'same-count'. */
  why: string;
};

function samePlane(p: Plane, q: Plane): boolean {
  return p === q || (Math.abs(p.a - q.a) < 1e-12 && Math.abs(p.b - q.b) < 1e-12 && Math.abs(p.c - q.c) < 1e-9);
}

/**
 * Judges a proposed change to the faces by the height map alone, in the merge rule's currency (see the file's head),
 * so every track's change is asked the same question and the moves cannot undo one another:
 * - a change that ADDS faces (a split, a dormer, a hip end) is accepted when it lowers the robust residual by at least
 *   `mergePerPx` per pixel of its smallest new face AND that face's pixels lay off the plane(s) they had by more than
 *   the bow (median |residual| at least `mergeMedM`): exactly when the merge rule would not join it back;
 * - a change that REMOVES faces (a merge, a drop) is accepted when it raises the residual by less than `mergePerPx` per
 *   pixel of the smallest removed face AND that face's pixels lie on their new plane within the bow;
 * - a change that keeps the count (a face re-cut, a plane moved) is accepted when it lowers the residual at all.
 * `before` and `after` are label images on the same grid (-1: no face) with the plane of each label; untouched faces may
 * keep their Plane objects or equal values. With `refit` (default) each added face's plane is first refit robustly on
 * its own pixels (from the plane given), so a proposal is judged on its partition, not on how its planes were drawn.
 */
export function judgeChange(
  g: Grid,
  s: number,
  dsm: Float32Array,
  tree: Mask | null,
  before: { labels: Int32Array; planes: readonly Plane[] },
  after: { labels: Int32Array; planes: readonly Plane[] },
  opts: Partial<RefineParams> & { refit?: boolean } = {},
): ChangeVerdict {
  const prm: RefineParams = { ...DEFAULT_REFINE, ...opts };
  const c = prm.lossM;
  const nb = before.planes.length;
  const na = after.planes.length;
  // Added faces: planes of `after` found nowhere in `before`; removed: planes of `before` found nowhere in `after`.
  const isAdded = after.planes.map((p) => !before.planes.some((q) => samePlane(p, q)));
  const isRemoved = before.planes.map((p) => !after.planes.some((q) => samePlane(p, q)));
  const planesA = after.planes.slice();
  if (opts.refit !== false) {
    const groups = new Map<number, FacePx>();
    const count = new Int32Array(na);
    for (let i = 0; i < after.labels.length; i++) {
      const k = after.labels[i]!;
      if (k >= 0 && isAdded[k] && Number.isFinite(dsm[i]!) && tree?.[i] !== 1) count[k]!++;
    }
    for (let k = 0; k < na; k++) if (isAdded[k] && count[k]! >= 10) groups.set(k, { x: new Float64Array(count[k]!), y: new Float64Array(count[k]!), z: new Float64Array(count[k]!), n: 0 });
    for (let i = 0; i < after.labels.length; i++) {
      const k = after.labels[i]!;
      const f = k >= 0 ? groups.get(k) : undefined;
      if (f === undefined || !Number.isFinite(dsm[i]!) || tree?.[i] === 1) continue;
      f.x[f.n] = pixelX(g, s, i);
      f.y[f.n] = pixelY(g, s, i);
      f.z[f.n] = dsm[i]!;
      f.n++;
    }
    for (const [k, f] of groups) planesA[k] = robustPlane([f], after.planes[k]!, c).plane;
  }
  let pixels = 0;
  let costB = 0;
  let costA = 0;
  const addedPx = new Int32Array(na);
  const removedPx = new Int32Array(nb);
  // Residuals of each added face's pixels on their old planes, and of each removed face's pixels on their new planes.
  const addedRes: number[][] = Array.from({ length: na }, () => []);
  const removedRes: number[][] = Array.from({ length: nb }, () => []);
  for (let i = 0; i < before.labels.length; i++) {
    const kb = before.labels[i]!;
    const ka = after.labels[i]!;
    if (kb < 0 || ka < 0) continue;
    const z = dsm[i]!;
    if (!Number.isFinite(z) || tree?.[i] === 1) continue;
    const pb = before.planes[kb]!;
    const pa = planesA[ka]!;
    if (!isAdded[ka] && !isRemoved[kb] && samePlane(pb, pa)) continue;
    const x = pixelX(g, s, i);
    const y = pixelY(g, s, i);
    const rb = z - planeZ(pb, x, y);
    const ra = z - planeZ(pa, x, y);
    pixels++;
    costB += rho(rb, c);
    costA += rho(ra, c);
    if (isAdded[ka]) {
      addedPx[ka]!++;
      addedRes[ka]!.push(Math.abs(rb));
    }
    if (isRemoved[kb]) {
      removedPx[kb]!++;
      removedRes[kb]!.push(Math.abs(ra));
    }
  }
  const added = isAdded.filter((v, k) => v && addedPx[k]! > 0).length;
  const removed = isRemoved.filter((v, k) => v && removedPx[k]! > 0).length;
  // The smallest added and removed faces (on the pixels the change alters).
  let minAdd = -1;
  for (let k = 0; k < na; k++) if (isAdded[k] && addedPx[k]! > 0 && (minAdd < 0 || addedPx[k]! < addedPx[minAdd]!)) minAdd = k;
  let minRem = -1;
  for (let k = 0; k < nb; k++) if (isRemoved[k] && removedPx[k]! > 0 && (minRem < 0 || removedPx[k]! < removedPx[minRem]!)) minRem = k;
  const refPixels = Math.min(minAdd >= 0 ? addedPx[minAdd]! : Infinity, minRem >= 0 ? removedPx[minRem]! : Infinity);
  const gainPerPx = pixels > 0 && Number.isFinite(refPixels) ? (costB - costA) / refPixels : 0;
  const base = { pixels, before: costB, after: costA, added, removed, refPixels: Number.isFinite(refPixels) ? refPixels : 0, gainPerPx };
  if (pixels === 0) return { ...base, medianM: 0, accept: false, why: 'same-count' };
  if (added > removed) {
    const med = median(addedRes[minAdd]!);
    if (!(gainPerPx >= prm.mergePerPx)) return { ...base, medianM: med, accept: false, why: 'adds-small-gain' };
    if (!(med >= prm.mergeMedM)) return { ...base, medianM: med, accept: false, why: 'adds-within-bow' };
    return { ...base, medianM: med, accept: true, why: 'adds-pays' };
  }
  if (added < removed) {
    const med = median(removedRes[minRem]!);
    if (!(-gainPerPx < prm.mergePerPx)) return { ...base, medianM: med, accept: false, why: 'removes-costly' };
    if (!(med < prm.mergeMedM)) return { ...base, medianM: med, accept: false, why: 'removes-off-plane' };
    return { ...base, medianM: med, accept: true, why: 'removes-cheap' };
  }
  return { ...base, medianM: 0, accept: costA < costB, why: 'same-count' };
}
