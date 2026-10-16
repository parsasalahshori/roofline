// Sizing a window from the printable measuring sheet (window-photo-cv.ts): the pure arithmetic, shared by the browser
// engine and the server's re-check, so both get the same answer from the same points.
// - A least-squares homography from every matched sheet point (inches on the sheet <-> photo pixels), with a robust
//   start (RANSAC on 4-point samples), Levenberg-Marquardt on the reprojection error, outlier trimming and the RMS.
// - The camera's pose from that homography and the focal length (principal point at the photo's centre): distance to
//   the glass and viewing angle.
// - Plane offset: the frame being measured sits in front of (+) or behind (-) the glass the sheet is taped to. Each
//   window corner's ray is intersected with the parallel plane at that offset (exact for oblique views), and the
//   difference from the same rays on the glass plane corrects the homography's answer.
// - Uncertainty: first-order propagation of the homography's covariance, the corners' pixel noise, the offset and the
//   focal length into width and height.
import type { Pt, Quad } from './window-photo-math.ts';

/** Fewer matched points than this and the sheet is not trusted (two markers' corners). */
export const SHEET_MIN_POINTS = 8;
/** Server bound on the homography's RMS reprojection error, photo pixels: a flat, sharp sheet is well under 1 px. */
export const SHEET_MAX_RMS_PX = 2.5;
/** Most matched points accepted from a browser (the sheet has 48 marker corners; this leaves room for denser sheets). */
export const SHEET_MAX_POINTS = 2000;
/** Plane offsets accepted, inches (frame in front of + / behind - the glass). */
export const SHEET_MAX_OFFSET_IN = 6;
/** The papers the sheet prints on, inches (portrait). */
export const SHEET_PAPER_IN = { letter: { widthIn: 8.5, heightIn: 11 }, a4: { widthIn: 210 / 25.4, heightIn: 297 / 25.4 } } as const;
/** Phone ultra-wide lenses are under this 35 mm-equivalent focal length; their residual distortion is not modelled. */
export const ULTRA_WIDE_FOCAL_35MM = 20;
/** Viewing angles above this get a warning; above STEEP_CHECK_DEG the window is marked 'check'. */
export const STEEP_WARN_DEG = 35;
export const STEEP_CHECK_DEG = 50;

type M3 = number[]; // 3x3 row-major

export type HomographyFit = {
  /** Sheet inches -> photo pixels, row-major 3x3 (h33 = 1). */
  H: M3;
  rmsPx: number;
  inliers: boolean[];
  inlierCount: number;
  /** Covariance-propagation helper: parameters (normalized) and their covariance. */
  covariance: number[][] | null;
  norm: { src: M3; dstInv: M3; params: number[] };
};

// ---------------------------------------------------------------------------------------------------------------
// Small linear algebra

function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-14) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = c + 1; r < n; r++) {
      const f = M[r]![c]! / M[c]![c]!;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!;
    for (let k = r + 1; k < n; k++) s -= M[r]![k]! * x[k]!;
    x[r] = s / M[r]![r]!;
  }
  return x;
}

function invertMatrix(A: number[][]): number[][] | null {
  const n = A.length;
  const out: number[][] = [];
  for (let j = 0; j < n; j++) {
    const e = new Array<number>(n).fill(0);
    e[j] = 1;
    const col = solveLinear(A, e);
    if (col === null) return null;
    out.push(col);
  }
  // out holds columns; transpose.
  return A.map((_, i) => out.map((col) => col[i]!));
}

/** Eigenvector of the smallest eigenvalue of a symmetric matrix (cyclic Jacobi). */
function smallestEigenvector(S: number[][]): number[] {
  const n = S.length;
  const a = S.map((r) => [...r]);
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p]![q]! * a[p]![q]!;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p]![q]!;
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k]![p]!;
          const akq = a[k]![q]!;
          a[k]![p] = c * akp - s * akq;
          a[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p]![k]!;
          const aqk = a[q]![k]!;
          a[p]![k] = c * apk - s * aqk;
          a[q]![k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k]![p]!;
          const vkq = v[k]![q]!;
          v[k]![p] = c * vkp - s * vkq;
          v[k]![q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < n; i++) if (a[i]![i]! < a[best]![best]!) best = i;
  return v.map((row) => row[best]!);
}

const mul3 = (A: M3, B: M3): M3 => {
  const C = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j]! += A[i * 3 + k]! * B[k * 3 + j]!;
  return C;
};

export function invert3(m: M3): M3 | null {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

export function applyH(H: M3, p: Pt): Pt {
  const w = H[6]! * p[0] + H[7]! * p[1] + H[8]!;
  return [(H[0]! * p[0] + H[1]! * p[1] + H[2]!) / w, (H[3]! * p[0] + H[4]! * p[1] + H[5]!) / w];
}

/** Similarity that moves the points' centroid to 0 and their mean distance to sqrt(2) (Hartley normalization). */
function normalizer(pts: Pt[]): M3 {
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p[0];
    cy += p[1];
  }
  cx /= pts.length;
  cy /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p[0] - cx, p[1] - cy);
  d /= pts.length;
  const s = d > 0 ? Math.SQRT2 / d : 1;
  return [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
}

/** Normalized DLT from n >= 4 correspondences (src, dst already normalized). Null when degenerate. */
function dlt(src: Pt[], dst: Pt[]): M3 | null {
  const AtA = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  const add = (row: number[]) => {
    for (let i = 0; i < 9; i++) {
      const ri = row[i]!;
      if (ri === 0) continue;
      for (let j = 0; j < 9; j++) AtA[i]![j]! += ri * row[j]!;
    }
  };
  for (let k = 0; k < src.length; k++) {
    const [x, y] = src[k]!;
    const [u, v] = dst[k]!;
    add([x, y, 1, 0, 0, 0, -u * x, -u * y, -u]);
    add([0, 0, 0, x, y, 1, -v * x, -v * y, -v]);
  }
  const h = smallestEigenvector(AtA);
  if (Math.abs(h[8]!) < 1e-12) return null;
  const H = h.map((x) => x / h[8]!);
  return H.every(Number.isFinite) ? H : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Least-squares homography

type Normalized = { src: Pt[]; dst: Pt[]; Ts: M3; Td: M3; TdInv: M3; scaleD: number };

function normalizeAll(src: Pt[], dst: Pt[]): Normalized | null {
  const Ts = normalizer(src);
  const Td = normalizer(dst);
  const TdInv = invert3(Td);
  if (TdInv === null) return null;
  return { src: src.map((p) => applyH(Ts, p)), dst: dst.map((p) => applyH(Td, p)), Ts, Td, TdInv, scaleD: Td[0]! };
}

/** Levenberg-Marquardt on the 8 parameters of a normalized homography (h33 = 1), minimizing reprojection error. */
function refineLM(Hn: M3, src: Pt[], dst: Pt[], use: boolean[]): { H: M3; JtJ: number[][]; sse: number; n: number } {
  let h = Hn.slice(0, 8);
  const residuals = (p: number[]) => {
    let sse = 0;
    for (let k = 0; k < src.length; k++) {
      if (!use[k]) continue;
      const [x, y] = src[k]!;
      const w = p[6]! * x + p[7]! * y + 1;
      const ex = (p[0]! * x + p[1]! * y + p[2]!) / w - dst[k]![0];
      const ey = (p[3]! * x + p[4]! * y + p[5]!) / w - dst[k]![1];
      sse += ex * ex + ey * ey;
    }
    return sse;
  };
  const normal = (p: number[]) => {
    const JtJ = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
    const Jtr = new Array<number>(8).fill(0);
    for (let k = 0; k < src.length; k++) {
      if (!use[k]) continue;
      const [x, y] = src[k]!;
      const w = p[6]! * x + p[7]! * y + 1;
      const u = (p[0]! * x + p[1]! * y + p[2]!) / w;
      const v = (p[3]! * x + p[4]! * y + p[5]!) / w;
      const ex = u - dst[k]![0];
      const ey = v - dst[k]![1];
      const jx = [x / w, y / w, 1 / w, 0, 0, 0, (-u * x) / w, (-u * y) / w];
      const jy = [0, 0, 0, x / w, y / w, 1 / w, (-v * x) / w, (-v * y) / w];
      for (let i = 0; i < 8; i++) {
        Jtr[i]! += jx[i]! * ex + jy[i]! * ey;
        for (let j = 0; j < 8; j++) JtJ[i]![j]! += jx[i]! * jx[j]! + jy[i]! * jy[j]!;
      }
    }
    return { JtJ, Jtr };
  };
  let sse = residuals(h);
  let lambda = 1e-3;
  for (let it = 0; it < 50; it++) {
    const { JtJ, Jtr } = normal(h);
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const A = JtJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-15 : v)));
      const step = solveLinear(A, Jtr.map((g) => -g));
      if (step === null) {
        lambda *= 10;
        continue;
      }
      const next = h.map((v, i) => v + step[i]!);
      const nsse = residuals(next);
      if (nsse < sse) {
        const rel = (sse - nsse) / Math.max(sse, 1e-30);
        h = next;
        sse = nsse;
        lambda = Math.max(lambda / 10, 1e-12);
        improved = true;
        if (rel < 1e-12) it = 1000;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  const n = use.filter(Boolean).length;
  return { H: [...h, 1], JtJ: normal(h).JtJ, sse, n };
}

/** A tiny deterministic PRNG for RANSAC (same points, same answer: the server's re-check must agree). */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Least-squares homography from sheet points (inches) to photo points (pixels), robust to a few wrong matches.
 * Null with fewer than 4 usable points or degenerate geometry.
 */
export function fitSheetHomography(sheetPts: Pt[], imagePts: Pt[], opts: { inlierPx?: number } = {}): HomographyFit | null {
  const n = Math.min(sheetPts.length, imagePts.length);
  if (n < 4) return null;
  const src = sheetPts.slice(0, n);
  const dst = imagePts.slice(0, n);
  const N = normalizeAll(src, dst);
  if (N === null) return null;
  const thrPx = opts.inlierPx ?? 4;
  const thrN = thrPx * N.scaleD;
  const errN = (H: M3, k: number) => {
    const q = applyH(H, N.src[k]!);
    return Math.hypot(q[0] - N.dst[k]![0], q[1] - N.dst[k]![1]);
  };
  // Start: all points (fine when there are no outliers), then RANSAC if that leaves some points far off.
  let best = dlt(N.src, N.dst);
  let bestCount = best === null ? 0 : N.src.filter((_, k) => errN(best!, k) < thrN).length;
  if (bestCount < n) {
    const rnd = lcg(n * 7919 + 17);
    for (let it = 0; it < 300 && bestCount < n; it++) {
      const idx = new Set<number>();
      while (idx.size < 4) idx.add(Math.floor(rnd() * n));
      const ids = [...idx];
      const H = dlt(ids.map((k) => N.src[k]!), ids.map((k) => N.dst[k]!));
      if (H === null) continue;
      let c = 0;
      for (let k = 0; k < n; k++) if (errN(H, k) < thrN) c++;
      if (c > bestCount) {
        best = H;
        bestCount = c;
      }
    }
  }
  if (best === null || bestCount < 4) return null;
  let use = N.src.map((_, k) => errN(best!, k) < thrN);
  let fit = refineLM(best, N.src, N.dst, use);
  // Trim: points further than max(3.5 robust sigma, 0.75 px) from the fitted plane are dropped, twice.
  for (let round = 0; round < 3; round++) {
    const errs = N.src.map((_, k) => errN(fit.H, k));
    const inl = errs.filter((_, k) => use[k]).sort((a, b) => a - b);
    const med = inl[Math.floor(inl.length / 2)] ?? 0;
    const sigma = 1.4826 * med;
    const limit = Math.max(3.5 * sigma, 0.75 * N.scaleD, 1e-12);
    const next = errs.map((e) => e < Math.min(limit, thrN * 2));
    if (next.filter(Boolean).length < 4) break;
    if (next.every((v, k) => v === use[k])) break;
    use = next;
    fit = refineLM(fit.H, N.src, N.dst, use);
  }
  const H = mul3(N.TdInv, mul3(fit.H, N.Ts));
  const s = H[8]!;
  const Hs = H.map((v) => v / s);
  if (!Hs.every(Number.isFinite)) return null;
  const dof = 2 * fit.n - 8;
  const rmsN = Math.sqrt(fit.sse / Math.max(fit.n, 1));
  let covariance: number[][] | null = null;
  if (dof > 0) {
    const inv = invertMatrix(fit.JtJ);
    const sigma2 = fit.sse / dof;
    covariance = inv === null ? null : inv.map((row) => row.map((v) => v * sigma2));
  }
  return {
    H: Hs,
    rmsPx: rmsN / N.scaleD,
    inliers: use,
    inlierCount: fit.n,
    covariance,
    norm: { src: N.Ts, dstInv: N.TdInv, params: fit.H.slice(0, 8) },
  };
}

/** The pixel homography from (possibly perturbed) normalized parameters. */
function denormalize(norm: HomographyFit['norm'], params: number[]): M3 {
  const H = mul3(norm.dstInv, mul3([...params, 1], norm.src));
  return H.map((v) => v / H[8]!);
}

/** A fitted sheet plane: the homography for sheet A, its parameters' covariance and how to rebuild H from them. */
export type PlaneFit = {
  H: M3;
  rmsPx: number;
  inlierCount: number;
  inliers: boolean[];
  params: number[];
  covariance: number[][] | null;
  toH: (params: number[]) => M3;
  model: 'homography' | 'pose';
};

function homographyPlane(f: HomographyFit): PlaneFit {
  return { H: f.H, rmsPx: f.rmsPx, inlierCount: f.inlierCount, inliers: f.inliers, params: f.norm.params, covariance: f.covariance, toH: (p) => denormalize(f.norm, p), model: 'homography' };
}

function rodrigues(r: number[]): number[] {
  const th = Math.hypot(r[0]!, r[1]!, r[2]!);
  if (th < 1e-12) return [1, -r[2]!, r[1]!, r[2]!, 1, -r[0]!, -r[1]!, r[0]!, 1];
  const [x, y, z] = [r[0]! / th, r[1]! / th, r[2]! / th];
  const c = Math.cos(th);
  const sn = Math.sin(th);
  const C = 1 - c;
  return [c + x * x * C, x * y * C - z * sn, x * z * C + y * sn, y * x * C + z * sn, c + y * y * C, y * z * C - x * sn, z * x * C - y * sn, z * y * C + x * sn, c + z * z * C];
}

function rotToVec(R: number[]): number[] {
  const tr = R[0]! + R[4]! + R[8]!;
  const th = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
  if (th < 1e-9) return [0, 0, 0];
  const k = th / (2 * Math.sin(th));
  return [(R[7]! - R[5]!) * k, (R[2]! - R[6]!) * k, (R[3]! - R[1]!) * k];
}

/**
 * The sheet plane fitted as a camera pose with the KNOWN focal length (6 dof: rotation and translation; plus 3 for a
 * second sheet's place on the same glass: its turn and shift relative to sheet A), by Levenberg-Marquardt on the
 * reprojection error. Fewer free parameters than a homography (8), so a curled sheet or a few noisy points cannot
 * invent perspective that then grows across a window several times the sheet's size.
 */
export function fitSheetPose(sheetPts: Pt[], imagePts: Pt[], o: { focalPx: number; cx: number; cy: number; sheetIndex?: number[]; inlierPx?: number }): PlaneFit | null {
  const n = Math.min(sheetPts.length, imagePts.length);
  const idx = o.sheetIndex ?? new Array<number>(n).fill(0);
  const ids = (s: number) => [...Array(n).keys()].filter((i) => (idx[i] ?? 0) === s);
  let a = ids(0);
  let b = ids(1);
  // Sheet A is the one with points (when only B was seen, B plays A).
  let swap = false;
  if (a.length < 4 && b.length >= 4) {
    [a, b] = [b, a];
    swap = true;
  }
  if (a.length < 4) return null;
  const fa = fitSheetHomography(a.map((i) => sheetPts[i]!), a.map((i) => imagePts[i]!), { inlierPx: o.inlierPx });
  if (fa === null) return null;
  const pa = poseFromHomography(fa.H, o.focalPx, o.cx, o.cy);
  if (pa === null) return null;
  const two = b.length >= 4;
  const params = [...rotToVec(pa.R), ...pa.t];
  const isB = new Array<boolean>(n).fill(false);
  for (const i of b) isB[i] = true;
  let use = new Array<boolean>(n).fill(false);
  a.forEach((i, k) => (use[i] = fa.inliers[k]!));
  if (two) {
    const fb = fitSheetHomography(b.map((i) => sheetPts[i]!), b.map((i) => imagePts[i]!), { inlierPx: o.inlierPx });
    const pb = fb === null ? null : poseFromHomography(fb.H, o.focalPx, o.cx, o.cy);
    if (fb === null || pb === null) return null;
    // B in A's frame: R_A^T R_B (an in-plane turn) and R_A^T (t_B - t_A).
    const RA = pa.R;
    const RtA = (v: number[]) => [RA[0]! * v[0]! + RA[3]! * v[1]! + RA[6]! * v[2]!, RA[1]! * v[0]! + RA[4]! * v[1]! + RA[7]! * v[2]!, RA[2]! * v[0]! + RA[5]! * v[1]! + RA[8]! * v[2]!];
    const r1b = RtA([pb.R[0]!, pb.R[3]!, pb.R[6]!]);
    const d = RtA([pb.t[0] - pa.t[0], pb.t[1] - pa.t[1], pb.t[2] - pa.t[2]]);
    params.push(Math.atan2(r1b[1]!, r1b[0]!), d[0]!, d[1]!);
    b.forEach((i, k) => (use[i] = fb.inliers[k]!));
  }
  void swap;
  const f = o.focalPx;
  const project = (p: number[], i: number): Pt => {
    const R = rodrigues(p);
    let [x, y] = sheetPts[i]!;
    if (two && isB[i]) {
      const c = Math.cos(p[6]!);
      const sn = Math.sin(p[6]!);
      [x, y] = [c * x - sn * y + p[7]!, sn * x + c * y + p[8]!];
    }
    const X = R[0]! * x + R[1]! * y + p[3]!;
    const Y = R[3]! * x + R[4]! * y + p[4]!;
    const Z = R[6]! * x + R[7]! * y + p[5]!;
    return [o.cx + (f * X) / Z, o.cy + (f * Y) / Z];
  };
  const P = params.length;
  const lm = (p0: number[], use: boolean[]) => {
    let p = p0.slice();
    const res = (q: number[]) => {
      const r: number[] = [];
      for (let i = 0; i < n; i++) {
        if (!use[i]) continue;
        const pr = project(q, i);
        r.push(pr[0] - imagePts[i]![0], pr[1] - imagePts[i]![1]);
      }
      return r;
    };
    const sse = (r: number[]) => r.reduce((acc, v) => acc + v * v, 0);
    let r = res(p);
    let e = sse(r);
    let lambda = 1e-3;
    let JtJ: number[][] = [];
    const jac = (q: number[]) => {
      const cols: number[][] = [];
      for (let k = 0; k < P; k++) {
        const h = k < 3 || k === 6 ? 1e-7 : 1e-6 * Math.max(1, Math.abs(q[k]!));
        const up = q.slice();
        const dn = q.slice();
        up[k]! += h;
        dn[k]! -= h;
        const ru = res(up);
        const rd = res(dn);
        cols.push(ru.map((v, i) => (v - rd[i]!) / (2 * h)));
      }
      return cols;
    };
    for (let it = 0; it < 60; it++) {
      const J = jac(p);
      JtJ = Array.from({ length: P }, (_, i) => Array.from({ length: P }, (_, j) => J[i]!.reduce((acc, v, k) => acc + v * J[j]![k]!, 0)));
      const g = J.map((col) => col.reduce((acc, v, k) => acc + v * r[k]!, 0));
      let improved = false;
      for (let t = 0; t < 10; t++) {
        const A = JtJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v)));
        const step = solveLinear(A, g.map((v) => -v));
        if (step === null) {
          lambda *= 10;
          continue;
        }
        const q = p.map((v, i) => v + step[i]!);
        const rq = res(q);
        const eq = sse(rq);
        if (eq < e) {
          const rel = (e - eq) / Math.max(e, 1e-30);
          p = q;
          r = rq;
          e = eq;
          lambda = Math.max(lambda / 10, 1e-12);
          improved = true;
          if (rel < 1e-12) it = 1000;
          break;
        }
        lambda *= 10;
      }
      if (!improved) break;
    }
    return { p, e, JtJ, m: r.length / 2 };
  };
  let fit = lm(params, use);
  for (let round = 0; round < 3; round++) {
    const errs = [...Array(n).keys()].map((i) => {
      const pr = project(fit.p, i);
      return Math.hypot(pr[0] - imagePts[i]![0], pr[1] - imagePts[i]![1]);
    });
    const inl = errs.filter((_, i) => use[i]).sort((x, y) => x - y);
    const med = inl[Math.floor(inl.length / 2)] ?? 0;
    const limit = Math.max(3.5 * 1.4826 * med, 0.75);
    const next = errs.map((e2) => e2 < Math.min(limit, 2 * (o.inlierPx ?? 4)));
    if (next.filter(Boolean).length < 4 || next.every((v, i) => v === use[i])) break;
    use = next;
    fit = lm(fit.p, use);
  }
  const toH = (p: number[]): M3 => {
    const R = rodrigues(p);
    const K: M3 = [f, 0, o.cx, 0, f, o.cy, 0, 0, 1];
    const H = mul3(K, [R[0]!, R[1]!, p[3]!, R[3]!, R[4]!, p[4]!, R[6]!, R[7]!, p[5]!]);
    return H.map((v) => v / H[8]!);
  };
  const dof = 2 * fit.m - P;
  const inv = dof > 0 ? invertMatrix(fit.JtJ) : null;
  const sigma2 = dof > 0 ? fit.e / dof : 0;
  return {
    H: toH(fit.p),
    rmsPx: Math.sqrt(fit.e / Math.max(fit.m, 1)),
    inlierCount: fit.m,
    inliers: use,
    params: fit.p,
    covariance: inv === null ? null : inv.map((row) => row.map((v) => v * sigma2)),
    toH,
    model: 'pose',
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Pose and plane offset

export type SheetPose = {
  /** World (sheet inches, z toward the far side of the glass) -> camera: X_cam = R X + t. */
  R: number[];
  t: [number, number, number];
  /** Camera centre in sheet coordinates (its z is negative: in front of the glass). */
  centre: [number, number, number];
};

/** Camera pose from the sheet homography and the intrinsics (square pixels, principal point at the photo centre). */
export function poseFromHomography(H: M3, focalPx: number, cx: number, cy: number): SheetPose | null {
  const Kinv: M3 = [1 / focalPx, 0, -cx / focalPx, 0, 1 / focalPx, -cy / focalPx, 0, 0, 1];
  const M = mul3(Kinv, H);
  const m1: [number, number, number] = [M[0]!, M[3]!, M[6]!];
  const m2: [number, number, number] = [M[1]!, M[4]!, M[7]!];
  const m3: [number, number, number] = [M[2]!, M[5]!, M[8]!];
  const n1 = Math.hypot(...m1);
  const n2 = Math.hypot(...m2);
  if (!(n1 > 0) || !(n2 > 0)) return null;
  let lambda = 2 / (n1 + n2);
  if (m3[2] * lambda < 0) lambda = -lambda; // the sheet is in front of the camera
  const p = m1.map((v) => (v * lambda) / (Math.abs(lambda) * n1)) as [number, number, number];
  const q = m2.map((v) => (v * lambda) / (Math.abs(lambda) * n2)) as [number, number, number];
  // Nearest orthonormal pair, symmetric in r1 and r2: from the bisector and the difference of the two columns.
  const a = norm3(add3(p, q));
  const b = norm3(sub3(p, q));
  if (a === null || b === null) return null;
  const r1 = scale3(add3(a, b), Math.SQRT1_2);
  const r2 = scale3(sub3(a, b), Math.SQRT1_2);
  const r3 = cross3(r1, r2);
  const t = scale3(m3, lambda) as [number, number, number];
  const R = [r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]];
  // centre = -R^T t
  const centre: [number, number, number] = [
    -(R[0]! * t[0] + R[3]! * t[1] + R[6]! * t[2]),
    -(R[1]! * t[0] + R[4]! * t[1] + R[7]! * t[2]),
    -(R[2]! * t[0] + R[5]! * t[1] + R[8]! * t[2]),
  ];
  if (!centre.every(Number.isFinite)) return null;
  return { R, t, centre };
}

type V3 = [number, number, number];
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function norm3(a: V3): V3 | null {
  const l = Math.hypot(...a);
  return l > 0 ? scale3(a, 1 / l) : null;
}

/** The ray through photo pixel p, in sheet coordinates: from the camera centre along `dir`. */
function rayOf(pose: SheetPose, focalPx: number, cx: number, cy: number, p: Pt): V3 {
  const d: V3 = [(p[0] - cx) / focalPx, (p[1] - cy) / focalPx, 1];
  const R = pose.R;
  return [R[0]! * d[0] + R[3]! * d[1] + R[6]! * d[2], R[1]! * d[0] + R[4]! * d[1] + R[7]! * d[2], R[2]! * d[0] + R[5]! * d[1] + R[8]! * d[2]];
}

/** Where the ray through pixel p meets the plane parallel to the sheet, `offsetIn` toward the camera. */
function onPlane(pose: SheetPose, focalPx: number, cx: number, cy: number, p: Pt, offsetIn: number): Pt | null {
  const C = pose.centre;
  const z0 = offsetIn * Math.sign(C[2] || -1);
  const d = rayOf(pose, focalPx, cx, cy, p);
  if (Math.abs(d[2]) < 1e-12) return null;
  const lambda = (z0 - C[2]) / d[2];
  if (!(lambda > 0)) return null;
  return [C[0] + lambda * d[0], C[1] + lambda * d[1]];
}

// ---------------------------------------------------------------------------------------------------------------
// The measurement

export type SheetMeasureInput = {
  widthPx: number;
  heightPx: number;
  focalPx: number;
  imagePoints: Pt[];
  sheetPointsIn: Pt[];
  windowQuad: Quad;
  planeOffsetIn: number;
  /** One-sigma pixel noise of each window corner (snapQuad's cornerSigmaPx); 1.5 px when not given. */
  cornerSigmaPx?: number | [number, number, number, number];
  /** One-sigma doubt in the offset the person entered, inches (0.25 when not given). */
  offsetSigmaIn?: number;
  /** Two sheets: which sheet each point is on (0 = A, 1 = B). Fitted as one plane (pose model). */
  sheetIndex?: number[];
  /** The printed scale read off the ruler (1 = 100%): the sheet's inches are multiplied by it. */
  printScale?: number;
  /** 'pose' (default): the plane as a camera pose with the known focal length; 'homography': a free 8-dof fit. */
  planeModel?: 'pose' | 'homography';
};

export type SheetMeasurement = {
  widthIn: number;
  heightIn: number;
  uncertaintyIn: { width: number; height: number };
  distanceIn: number;
  viewAngleDeg: number;
  warnings: string[];
  rmsPx: number;
  inlierCount: number;
  /** Pixels per inch on the glass at the window's centre (how big the sheet is in the photo). */
  pxPerIn: number;
  /** The 35 mm-equivalent focal length these pixels imply. */
  focal35mm: number;
};

export const SHEET_WARNINGS = {
  ultraWide: 'Use the main (1x) camera: the ultra-wide lens bends straight lines.',
  steep: 'Stand more square to the window: the photo is at a steep angle.',
  tooSteep: 'Retake this photo standing in front of the window: the angle is too steep to measure well.',
  far: 'Step closer: the sheet is small in this photo.',
  close: 'Step back so the whole window and the sheet are in the photo with some room around them.',
  notFlat: 'Tape the sheet flat to the glass: it is curled or creased.',
  fewPoints: 'Most of the sheet is hidden or blurred: keep the whole sheet in view and hold the phone still.',
  bigWindow: 'The window is much bigger than the sheet: take a second photo and compare.',
} as const;

const dist2 = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function quadSizeIn(q: Pt[]): { w: number; h: number } {
  return { w: (dist2(q[0]!, q[1]!) + dist2(q[3]!, q[2]!)) / 2, h: (dist2(q[0]!, q[3]!) + dist2(q[1]!, q[2]!)) / 2 };
}

/** The window's corners on the frame's plane, inches: the homography on the glass plus the exact offset correction. */
function cornersOnFrame(H: M3, pose: SheetPose | null, focalPx: number, cx: number, cy: number, quad: Quad, offsetIn: number): Pt[] | null {
  const Hinv = invert3(H);
  if (Hinv === null) return null;
  const out: Pt[] = [];
  for (const p of quad) {
    const g = applyH(Hinv, p);
    if (!Number.isFinite(g[0]) || !Number.isFinite(g[1])) return null;
    if (offsetIn === 0 || pose === null) {
      out.push(g);
      continue;
    }
    const a = onPlane(pose, focalPx, cx, cy, p, 0);
    const b = onPlane(pose, focalPx, cx, cy, p, offsetIn);
    if (a === null || b === null) return null;
    out.push([g[0] + b[0] - a[0], g[1] + b[1] - a[1]]);
  }
  return out;
}

function sizeWith(H: M3, focalPx: number, cx: number, cy: number, quad: Quad, offsetIn: number): { w: number; h: number } | null {
  const pose = poseFromHomography(H, focalPx, cx, cy);
  const c = cornersOnFrame(H, pose, focalPx, cx, cy, quad, offsetIn);
  return c === null ? null : quadSizeIn(c);
}

/**
 * A window's size from the sheet's matched points, its four corners (photo pixels, TL TR BR BL), the focal length in
 * pixels and the frame's offset from the glass. Null when the points cannot carry a plane (fewer than
 * SHEET_MIN_POINTS inliers, degenerate) or the corners do not land in front of the camera.
 */
export function measureWithSheet(input: SheetMeasureInput): SheetMeasurement | null {
  const { widthPx, heightPx, focalPx, windowQuad, planeOffsetIn } = input;
  if (!(focalPx > 0) || !(widthPx > 0) || !(heightPx > 0) || !Number.isFinite(planeOffsetIn)) return null;
  if (input.imagePoints.length !== input.sheetPointsIn.length || input.imagePoints.length < SHEET_MIN_POINTS) return null;
  const cx = widthPx / 2;
  const cy = heightPx / 2;
  const ps = input.printScale ?? 1;
  if (!(ps > 0.5 && ps < 1.5)) return null;
  const sheetPts: Pt[] = ps === 1 ? input.sheetPointsIn : input.sheetPointsIn.map(([x, y]) => [x * ps, y * ps]);
  const inlierPx = Math.max(4, 0.0015 * Math.max(widthPx, heightPx));
  const twoSheets = input.sheetIndex !== undefined && input.sheetIndex.some((v) => v === 1) && input.sheetIndex.some((v) => v === 0);
  const model = twoSheets ? 'pose' : (input.planeModel ?? 'pose');
  let fit: PlaneFit | null;
  if (model === 'pose') fit = fitSheetPose(sheetPts, input.imagePoints, { focalPx, cx, cy, sheetIndex: input.sheetIndex, inlierPx });
  else {
    const h = fitSheetHomography(sheetPts, input.imagePoints, { inlierPx });
    fit = h === null ? null : homographyPlane(h);
  }
  if (fit === null || fit.inlierCount < SHEET_MIN_POINTS) return null;
  const pose = poseFromHomography(fit.H, focalPx, cx, cy);
  if (pose === null) return null;
  const corners = cornersOnFrame(fit.H, pose, focalPx, cx, cy, windowQuad, planeOffsetIn);
  if (corners === null) return null;
  const size = quadSizeIn(corners);
  if (!Number.isFinite(size.w) || !Number.isFinite(size.h) || size.w <= 0 || size.h <= 0) return null;

  // Geometry for the person: distance to the glass, angle off square at the window's centre, pixels per inch.
  const centrePx: Pt = [(windowQuad[0][0] + windowQuad[1][0] + windowQuad[2][0] + windowQuad[3][0]) / 4, (windowQuad[0][1] + windowQuad[1][1] + windowQuad[2][1] + windowQuad[3][1]) / 4];
  const ray = rayOf(pose, focalPx, cx, cy, centrePx);
  const viewAngleDeg = (Math.acos(Math.min(1, Math.abs(ray[2]) / Math.hypot(...ray))) * 180) / Math.PI;
  const distanceIn = Math.abs(pose.centre[2]);
  const Hinv = invert3(fit.H)!;
  const g = applyH(Hinv, centrePx);
  const gx = applyH(fit.H, [g[0] + 0.5, g[1]]);
  const gy = applyH(fit.H, [g[0], g[1] + 0.5]);
  const gx0 = applyH(fit.H, [g[0] - 0.5, g[1]]);
  const gy0 = applyH(fit.H, [g[0], g[1] - 0.5]);
  const pxPerIn = Math.sqrt(dist2(gx, gx0) * dist2(gy, gy0));
  const focal35mm = (focalPx * 36) / Math.max(widthPx, heightPx);

  // Uncertainty, first order: d(size)/d(each source) by central differences, then root-sum-square.
  const base = (H: M3, q: Quad, off: number, f: number) => sizeWith(H, f, cx, cy, q, off);
  const varW: number[] = [];
  const varH: number[] = [];
  const addVar = (dw: number, dh: number) => {
    varW.push(dw * dw);
    varH.push(dh * dh);
  };
  // (a) the homography's parameters.
  if (fit.covariance !== null) {
    const P = fit.params;
    const grads: { w: number; h: number }[] = [];
    for (let i = 0; i < P.length; i++) {
      const eps = 1e-6 * Math.max(1, Math.abs(P[i]!));
      const up = P.slice();
      const dn = P.slice();
      up[i]! += eps;
      dn[i]! -= eps;
      const a = base(fit.toH(up), windowQuad, planeOffsetIn, focalPx);
      const b = base(fit.toH(dn), windowQuad, planeOffsetIn, focalPx);
      grads.push(a === null || b === null ? { w: 0, h: 0 } : { w: (a.w - b.w) / (2 * eps), h: (a.h - b.h) / (2 * eps) });
    }
    let vw = 0;
    let vh = 0;
    for (let i = 0; i < P.length; i++) {
      for (let j = 0; j < P.length; j++) {
        vw += grads[i]!.w * fit.covariance[i]![j]! * grads[j]!.w;
        vh += grads[i]!.h * fit.covariance[i]![j]! * grads[j]!.h;
      }
    }
    varW.push(Math.max(0, vw));
    varH.push(Math.max(0, vh));
  }
  // (b) each corner's pixel noise.
  const cs = input.cornerSigmaPx ?? 1.5;
  const sig = typeof cs === 'number' ? [cs, cs, cs, cs] : cs;
  for (let k = 0; k < 4; k++) {
    for (let axis = 0; axis < 2; axis++) {
      const e = 0.5;
      const up = windowQuad.map((p) => [...p]) as Quad;
      const dn = windowQuad.map((p) => [...p]) as Quad;
      up[k]![axis]! += e;
      dn[k]![axis]! -= e;
      const a = base(fit.H, up, planeOffsetIn, focalPx);
      const b = base(fit.H, dn, planeOffsetIn, focalPx);
      if (a !== null && b !== null) addVar(((a.w - b.w) / (2 * e)) * sig[k]!, ((a.h - b.h) / (2 * e)) * sig[k]!);
    }
  }
  // (c) the offset the person entered, (d) the focal length (EXIF focal lengths are rounded; 3%).
  const so = input.offsetSigmaIn ?? 0.25;
  {
    const a = base(fit.H, windowQuad, planeOffsetIn + so, focalPx);
    const b = base(fit.H, windowQuad, planeOffsetIn - so, focalPx);
    if (a !== null && b !== null) addVar((a.w - b.w) / 2, (a.h - b.h) / 2);
    const fa = base(fit.H, windowQuad, planeOffsetIn, focalPx * 1.03);
    const fb = base(fit.H, windowQuad, planeOffsetIn, focalPx / 1.03);
    if (fa !== null && fb !== null) addVar((fa.w - fb.w) / 2, (fa.h - fb.h) / 2);
  }
  // (e) a floor for what the model leaves out (print scale after the ruler check, residual lens distortion): 0.1%.
  addVar(0.001 * size.w, 0.001 * size.h);
  const uncertaintyIn = { width: Math.sqrt(varW.reduce((a, b) => a + b, 0)), height: Math.sqrt(varH.reduce((a, b) => a + b, 0)) };

  const warnings: string[] = [];
  if (focal35mm < ULTRA_WIDE_FOCAL_35MM) warnings.push(SHEET_WARNINGS.ultraWide);
  if (viewAngleDeg > STEEP_CHECK_DEG) warnings.push(SHEET_WARNINGS.tooSteep);
  else if (viewAngleDeg > STEEP_WARN_DEG) warnings.push(SHEET_WARNINGS.steep);
  if (pxPerIn < 8) warnings.push(SHEET_WARNINGS.far);
  if (distanceIn < 24) warnings.push(SHEET_WARNINGS.close);
  if (fit.rmsPx > 1.5) warnings.push(SHEET_WARNINGS.notFlat);
  if (fit.inlierCount < 16) warnings.push(SHEET_WARNINGS.fewPoints);
  if (Math.max(size.w, size.h) > 12 * 11) warnings.push(SHEET_WARNINGS.bigWindow);

  return { widthIn: size.w, heightIn: size.h, uncertaintyIn, distanceIn, viewAngleDeg, warnings, rmsPx: fit.rmsPx, inlierCount: fit.inlierCount, pxPerIn, focal35mm };
}

/** Several photos of one window: the median size and the spread (largest minus smallest) between them. */
export function combineSheetMeasurements(ms: { widthIn: number; heightIn: number }[]): { widthIn: number; heightIn: number; spreadIn: { width: number; height: number } } | null {
  const ok = ms.filter((m) => Number.isFinite(m.widthIn) && Number.isFinite(m.heightIn));
  if (ok.length === 0) return null;
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };
  const ws = ok.map((m) => m.widthIn);
  const hs = ok.map((m) => m.heightIn);
  return { widthIn: median(ws), heightIn: median(hs), spreadIn: { width: Math.max(...ws) - Math.min(...ws), height: Math.max(...hs) - Math.min(...hs) } };
}
