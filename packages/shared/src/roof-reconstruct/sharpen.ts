// Sharpening of Google's height map before the plane search (off by default).
//
// Measured against EagleView's faces rendered on the height map's grid (18 dev houses, registered to 2.5 cm), the map
// is not a blurred copy of the roof: convex creases keep a short roll-off (ridges and hips as a 0.1-0.15 m Gaussian),
// concave ones are filled in (valley centres twice as much as ridges are cut; the lower side of a wall raised by 0.49 /
// 0.39 / 0.21 of the step 0.3 / 0.5 / 0.7 m out; eaves bleed 0.2 m outward), and small low-contrast faces are smoothed
// as by a 0.3-0.4 m Gaussian; no linear kernel reproduces all of it, so no linear deconvolution undoes it. A roof is
// piecewise planar: locally the lowest of its planes where it is convex, the highest where it is concave. Here every
// pixel where the heights curve (the Laplacian of the lightly smoothed heights past `curvature`) takes, among the planes
// of the nearly planar windows within `reachM`, the lowest one at most `tolM` below it (`round`, convex) or the highest
// one at most `tolM` above it (`unfill`, concave). A plane below a convex pixel or above a concave one is never taken,
// so a small bump (a dormer) is never flattened into the face round it, as a filter preferring the most planar window
// would (that one erased small gables). What `round` does by default (cleanWindows off): a big crest is held by its own
// window (planar within planarRmsM), while the crests and edges of small bumps, whose windows all reach into curved
// pixels, are raised by 2-8 cm towards the plane of a window above them; the plane search then finds the bump's faces
// more often (synthetic 3 m2 gable dormer: 6 of 12 seeds against none). `unfill` measured worse (it leaves part-filled
// ramps by tall walls that read as valleys) and is off. Pixels change only by more than `minChangeM`, never within
// `edgeM` of the roof's edge (the outline and the eaves stay as they are) and never on tree crowns. Pure and
// deterministic; O(curved pixels x reach^2) plus a few passes over the crop.
import type { Grid, Mask } from './raster.ts';
import { dilate, erode } from './raster.ts';

export type SharpenParams = {
  /** Off by default: the reconstruction reads the heights as they came. */
  enabled: boolean;
  /** Convex pixels (ridges, hips) take the lowest nearby plane above them. */
  round: boolean;
  /** Concave pixels (valleys, wall feet) take the highest nearby plane below them. */
  unfill: boolean;
  /** Half-size of the windows whose planes are offered, metres (0.25: 5 x 5 pixels at 0.1 m, 3 x 3 at 0.25 m). */
  windowM: number;
  /** A window is planar when its plane fits within this rms, metres. */
  planarRmsM: number;
  /** Windows are looked for this far round a pixel, metres. */
  reachM: number;
  /** Gaussian sigma of the smoothing before the curvature test, metres. */
  smoothM: number;
  /** A pixel curves when the Laplacian of the smoothed heights is past this, 1/m. */
  curvature: number;
  /** A plane on the wrong side of a pixel is still offered within this, metres. */
  tolM: number;
  /** The most a concave pixel is lowered, and the most a convex one is raised, metres. */
  fillMaxM: number;
  roundMaxM: number;
  /** A pixel changes only by more than this, metres. */
  minChangeM: number;
  /** No pixel within this of the roof's edge changes, metres. */
  edgeM: number;
  /**
   * Only windows clear of every curved pixel offer a plane: a crest then comes back to its faces' planes in full. Off
   * (the default): windows reaching into the rounding offer their tilted planes too, so a crest is raised part of the
   * way, and the faces of a small bump (a dormer), all of whose windows are near curved pixels, are raised as well.
   * Measured on the 18 dev answer keys with the evidence rule on, off is the better (panel 14.5 / 19.9 / 17.3 against
   * 17.0 / 23.1 / 18.3), and on the synthetic dormer only off finds the dormer.
   */
  cleanWindows: boolean;
};

export const DEFAULT_SHARPEN: SharpenParams = {
  enabled: false,
  round: true,
  unfill: false,
  windowM: 0.25,
  planarRmsM: 0.015,
  reachM: 1.0,
  smoothM: 0.2,
  curvature: 0.3,
  tolM: 0.02,
  fillMaxM: 0.6,
  roundMaxM: 0.15,
  minChangeM: 0.02,
  edgeM: 0.4,
  cleanWindows: false,
};

/** Sums of `a` over every (2r+1)^2 window (zero outside the grid), from a summed-area table. */
function boxSums(g: Grid, a: Float64Array, r: number): Float64Array {
  const { w, h } = g;
  const W = w + 1;
  const t = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += a[y * w + x]!;
      t[(y + 1) * W + x + 1] = t[y * W + x + 1]! + row;
    }
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      out[y * w + x] = t[y1 * W + x1]! - t[y0 * W + x1]! - t[y1 * W + x0]! + t[y0 * W + x0]!;
    }
  }
  return out;
}

/** Separable Gaussian blur (sigma in pixels, truncated at 4 sigma), zero outside the grid. */
function gauss(g: Grid, a: Float64Array, sigma: number): Float64Array {
  const { w, h } = g;
  const R = Math.max(1, Math.ceil(4 * sigma));
  const k = new Float64Array(2 * R + 1);
  let sum = 0;
  for (let i = -R; i <= R; i++) sum += k[i + R] = Math.exp((-0.5 * i * i) / (sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  const tmp = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let i = -R; i <= R; i++) {
        const xx = x + i;
        if (xx >= 0 && xx < w) v += k[i + R]! * a[y * w + xx]!;
      }
      tmp[y * w + x] = v;
    }
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let i = -R; i <= R; i++) {
        const yy = y + i;
        if (yy >= 0 && yy < h) v += k[i + R]! * tmp[yy * w + x]!;
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/**
 * The heights sharpened on the roof (`roof` 1; `tree` crowns and missing heights left alone): a new array, the input
 * untouched. `maxSlope` (rise over run) bounds the planes offered, as the plane search's steepest roof does.
 */
export function sharpenHeights(g: Grid, s: number, dsm: Float32Array, roof: Mask, tree: Mask | null, prm: SharpenParams, maxSlope = 1.5): Float32Array<ArrayBuffer> {
  const { w, h } = g;
  const n = w * h;
  const out = new Float32Array(dsm);
  if (!prm.enabled || !(prm.round || prm.unfill) || n === 0) return out;
  const valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) valid[i] = roof[i] === 1 && tree?.[i] !== 1 && Number.isFinite(dsm[i]!) ? 1 : 0;
  // Window planes: least squares over each window's valid pixels, from summed moments (x east, y north, metres).
  const r = Math.max(1, Math.round(prm.windowM / s));
  const k2 = (2 * r + 1) * (2 * r + 1);
  const ww = new Float64Array(n);
  const wx = new Float64Array(n);
  const wy = new Float64Array(n);
  const wz = new Float64Array(n);
  const wxx = new Float64Array(n);
  const wyy = new Float64Array(n);
  const wxy = new Float64Array(n);
  const wxz = new Float64Array(n);
  const wyz = new Float64Array(n);
  const wzz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (valid[i] !== 1) continue;
    const x = (i % w) * s;
    const y = -Math.floor(i / w) * s;
    const z = dsm[i]!;
    ww[i] = 1;
    wx[i] = x;
    wy[i] = y;
    wz[i] = z;
    wxx[i] = x * x;
    wyy[i] = y * y;
    wxy[i] = x * y;
    wxz[i] = x * z;
    wyz[i] = y * z;
    wzz[i] = z * z;
  }
  const S = boxSums(g, ww, r);
  const Sx = boxSums(g, wx, r);
  const Sy = boxSums(g, wy, r);
  const Sz = boxSums(g, wz, r);
  const Sxx = boxSums(g, wxx, r);
  const Syy = boxSums(g, wyy, r);
  const Sxy = boxSums(g, wxy, r);
  const Sxz = boxSums(g, wxz, r);
  const Syz = boxSums(g, wyz, r);
  const Szz = boxSums(g, wzz, r);
  const mx = new Float64Array(n);
  const my = new Float64Array(n);
  const mz = new Float64Array(n);
  const pa = new Float64Array(n);
  const pb = new Float64Array(n);
  const planar = new Uint8Array(n);
  const rms2 = prm.planarRmsM * prm.planarRmsM;
  for (let i = 0; i < n; i++) {
    const c = S[i]!;
    // Only windows with (nearly) every pixel on the roof: a window cut by the edge or a crown is no evidence.
    if (valid[i] !== 1 || c < 0.95 * k2) continue;
    const x = Sx[i]! / c;
    const y = Sy[i]! / c;
    const z = Sz[i]! / c;
    const cxx = Sxx[i]! / c - x * x;
    const cyy = Syy[i]! / c - y * y;
    const cxy = Sxy[i]! / c - x * y;
    const cxz = Sxz[i]! / c - x * z;
    const cyz = Syz[i]! / c - y * z;
    const czz = Szz[i]! / c - z * z;
    const det = cxx * cyy - cxy * cxy;
    if (!(det > 1e-12)) continue;
    const a = (cxz * cyy - cyz * cxy) / det;
    const b = (cyz * cxx - cxz * cxy) / det;
    const rss = czz - a * cxz - b * cyz;
    if (!(rss < rms2) || Math.hypot(a, b) > maxSlope) continue;
    mx[i] = x;
    my[i] = y;
    mz[i] = z;
    pa[i] = a;
    pb[i] = b;
    planar[i] = 1;
  }
  // Curvature: the Laplacian of the heights smoothed over the valid pixels (normalised Gaussian), 1/m.
  const zw = new Float64Array(n);
  for (let i = 0; i < n; i++) if (valid[i] === 1) zw[i] = dsm[i]!;
  const sigma = prm.smoothM / s;
  const num = gauss(g, zw, sigma);
  const den = gauss(g, ww, sigma);
  const sm = new Float64Array(n);
  for (let i = 0; i < n; i++) sm[i] = valid[i] === 1 ? num[i]! / Math.max(den[i]!, 1e-6) : 0;
  const lapOf = new Float64Array(n).fill(Number.NaN);
  const curved = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (valid[i] !== 1 || valid[i - 1] !== 1 || valid[i + 1] !== 1 || valid[i - w] !== 1 || valid[i + w] !== 1) continue;
      lapOf[i] = (sm[i - 1]! + sm[i + 1]! + sm[i - w]! + sm[i + w]! - 4 * sm[i]!) / (s * s);
      if (Math.abs(lapOf[i]!) > prm.curvature) curved[i] = 1;
    }
  }
  // Only windows clear of every curved pixel offer a plane: a window reaching into a rounded crest is still planar
  // within planarRmsM but tilted towards the rounding, and as the lowest plane above the crest it would win.
  if (prm.cleanWindows) {
    const near = dilate(g, curved, r);
    for (let i = 0; i < n; i++) if (near[i] === 1) planar[i] = 0;
  }
  // No change near the roof's edge (the outline and the eaves stay put).
  const inside = erode(g, roof, Math.max(1, Math.round(prm.edgeM / s)));
  const R = Math.max(1, Math.round(prm.reachM / s));
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (inside[i] !== 1 || !Number.isFinite(lapOf[i]!)) continue;
      const lap = lapOf[i]!;
      const concave = prm.unfill && lap > prm.curvature;
      const convex = prm.round && lap < -prm.curvature;
      if (!concave && !convex) continue;
      const z = dsm[i]!;
      const px = x * s;
      const py = -y * s;
      let best = concave ? -Infinity : Infinity;
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || dx * dx + dy * dy > R * R) continue;
          const q = yy * w + xx;
          if (planar[q] !== 1) continue;
          const v = mz[q]! + pa[q]! * (px - mx[q]!) + pb[q]! * (py - my[q]!);
          if (concave) {
            if (v <= z + prm.tolM && v >= z - prm.fillMaxM && v > best) best = v;
          } else if (v >= z - prm.tolM && v <= z + prm.roundMaxM && v < best) best = v;
        }
      }
      if (Number.isFinite(best) && Math.abs(best - z) > prm.minChangeM) out[i] = best;
    }
  }
  return out;
}
