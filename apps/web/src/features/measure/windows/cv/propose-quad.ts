// The window's outline proposed around the measuring sheet, with no corners from the person.
// The sheet is taped on the glass, so the window's frame is a rectangle on (a plane parallel to) the glass that
// encloses the sheet. The photo is resampled onto the glass's plane through the sheet's homography (there the frame's
// sides are straight, parallel pairs at right angles, only turned by however the sheet was taped), the turn is read
// from the gradients, and every edge line left, right, above and below the sheet is a candidate. Rectangles of one
// line per side are scored by the edge evidence along their whole sides (strength and how much of each side is
// covered) and the same boundary all round (polarity, inside:outside contrast). The nested near-ties (trim, frame,
// sash, glass) are told apart by the target; the chosen one and a couple of other whole rectangles are handed to
// snapQuad as rough corners: the same edge fitting, outline ranking and confidence as when the person drops them.
// Synthetic bench (60 windows x 3 photos, window wholly in the photo): the right outline first in 96% / 93% (seeds
// 1 / 2), among the top 3 in 99% / 95%.
import { applyH, fitSheetHomography, invert3, type Pt, type Quad, type RgbaImage, type SheetDetection, type WindowMeasureTarget } from '@roofline/shared';
import { type Gray, sample, toGray } from './gray.ts';
import { snapQuadSync, type SnapResult } from './snap-quad.ts';

/** Rectified resolution, pixels per inch on the glass (a rough outline: snapQuad does the subpixel work). */
const RECT_PPI = 4;
/** The largest window side searched, inches, beyond the sheet. */
const REACH_IN = 110;
/** A window side is at least this far outside the sheet's paper, inches (tape, a hand's width). */
const CLEAR_IN = 0.4;
/** Other whole rectangles snapped and offered after the chosen one. */
const ALTERNATIVES = 2;
/** Line candidates per side: the strongest, and the nearest to the sheet. */
const STRONGEST = 5;
const NEAREST = 8;
/** Below this mean edge cover over the four sides there is no outline to propose. */
const MIN_COVER = 0.55;

type Rect = { w: number; h: number; d: Float32Array; ok: Uint8Array };

/** Box-shrunk grey (sampling a 12 MP photo at a few pixels per inch must average, not alias). */
function shrinkGray(g: Gray, f: number): Gray {
  if (f <= 1) return g;
  const w = Math.floor(g.w / f);
  const h = Math.floor(g.h / f);
  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let yy = 0; yy < f; yy++) {
        const row = (y * f + yy) * g.w + x * f;
        for (let xx = 0; xx < f; xx++) s += g.d[row + xx]!;
      }
      d[y * w + x] = s / (f * f);
    }
  return { w, h, d };
}

/** The photo resampled on the glass: pixel (i, j) is plane point origin + (i, j) / ppi turned by `rot` (radians). */
function rectify(g: Gray, k: number, H: number[], origin: Pt, w: number, h: number, ppi: number, rot: number, about: Pt): Rect {
  const d = new Float32Array(w * h);
  const ok = new Uint8Array(w * h);
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      // Aligned frame -> sheet frame (turned about the sheet's centre).
      const u = origin[0] + i / ppi - about[0];
      const v = origin[1] + j / ppi - about[1];
      const p = applyH(H, [about[0] + c * u - s * v, about[1] + s * u + c * v]);
      const val = sample(g, p[0] / k, p[1] / k);
      if (Number.isNaN(val)) continue;
      d[j * w + i] = val;
      ok[j * w + i] = 1;
    }
  return { w, h, d, ok };
}

/** Central-difference gradients, zero where either neighbour is off the photo. */
function gradients(r: Rect): { gx: Float32Array; gy: Float32Array } {
  const { w, h, d, ok } = r;
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let j = 1; j < h - 1; j++)
    for (let i = 1; i < w - 1; i++) {
      const q = j * w + i;
      if (ok[q - 1] && ok[q + 1]) gx[q] = (d[q + 1]! - d[q - 1]!) / 2;
      if (ok[q - w] && ok[q + w]) gy[q] = (d[q + w]! - d[q - w]!) / 2;
    }
  return { gx, gy };
}

/**
 * The turn (radians, within ±12°) that lines the long straight edges up with the axes, outside the sheet: for each
 * trial angle the gradients are projected across lines at that angle and summed per line; long straight edges add up
 * (a sharp profile), texture cancels. Coarse 1° steps, then 0.1° around the best.
 */
function dominantTurn(gx: Float32Array, gy: Float32Array, w: number, h: number, sheetBox: [number, number, number, number]): number {
  const [x0, y0, x1, y1] = sheetBox;
  const idx: number[] = [];
  let mags = 0;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      if (i >= x0 - 2 && i <= x1 + 2 && j >= y0 - 2 && j <= y1 + 2) continue;
      const q = j * w + i;
      const m = Math.abs(gx[q]!) + Math.abs(gy[q]!);
      if (m < 2) continue;
      idx.push(q);
      mags += m;
    }
  if (idx.length === 0 || mags === 0) return 0;
  const n = Math.ceil(Math.hypot(w, h)) + 2;
  const accV = new Float64Array(2 * n);
  const accH = new Float64Array(2 * n);
  const sharp = (deg: number) => {
    const t = (deg * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    accV.fill(0);
    accH.fill(0);
    for (const q of idx) {
      const i = q % w;
      const j = (q - i) / w;
      const a = gx[q]!;
      const b = gy[q]!;
      // Vertical lines at angle t: normal (c, s); horizontal: normal (-s, c).
      accV[Math.round(i * c + j * s) + n]! += a * c + b * s;
      accH[Math.round(-i * s + j * c) + n]! += -a * s + b * c;
    }
    let e = 0;
    for (let k = 0; k < 2 * n; k++) e += accV[k]! * accV[k]! + accH[k]! * accH[k]!;
    return e;
  };
  let best = 0;
  let bestE = -1;
  for (let d = -12; d <= 12; d += 1) {
    const e = sharp(d);
    if (e > bestE) {
      bestE = e;
      best = d;
    }
  }
  const coarse = best;
  for (let d = coarse - 0.9; d <= coarse + 0.91; d += 0.1) {
    const e = sharp(d);
    if (e > bestE) {
      bestE = e;
      best = d;
    }
  }
  return (best * Math.PI) / 180;
}

type Line = { at: number; sign: 1 | -1; score: number };

/**
 * Local maxima of a signed profile inside [lo, hi], both polarities: the strongest few and the nearest to the sheet
 * (`from`) among the clear ones. Siding and brick make many strong lines beyond the trim; the frame's own edge can
 * be faint but is nearer the sheet than any of them.
 */
function peaks(p: Float64Array, lo: number, hi: number, from: number): Line[] {
  const all: Line[] = [];
  for (const sign of [1, -1] as const)
    for (let i = Math.max(1, lo); i <= Math.min(p.length - 2, hi); i++) {
      const v = sign * p[i]!;
      if (!(v > 0)) continue;
      let max = true;
      for (let k = -3; k <= 3 && max; k++) if (k !== 0 && i + k >= 0 && i + k < p.length && sign * p[i + k]! > v) max = false;
      if (max) all.push({ at: i, sign, score: v });
    }
  if (all.length === 0) return [];
  const top = Math.max(...all.map((l) => l.score));
  const strong = [...all].sort((a, b) => b.score - a.score).slice(0, STRONGEST);
  const near = all.filter((l) => l.score >= 0.12 * top).sort((a, b) => Math.abs(a.at - from) - Math.abs(b.at - from)).slice(0, NEAREST);
  return [...new Set([...strong, ...near])];
}

/**
 * Rectangles around the sheet as rough corners, photo pixels (TL, TR, BR, BL): the one for the target first, then a
 * few other whole rectangles; null when nothing rectangular and well-supported encloses the sheet.
 */
export function proposeRough(img: RgbaImage, sheet: Pick<SheetDetection, 'paper' | 'imagePoints' | 'sheetPointsIn' | 'sheetIndex'>, target?: WindowMeasureTarget): Quad[] | null {
  const idx = sheet.sheetIndex;
  const keep = sheet.imagePoints.map((_, i) => idx === undefined || idx[i] === 0);
  const fit = fitSheetHomography(sheet.sheetPointsIn.filter((_, i) => keep[i]), sheet.imagePoints.filter((_, i) => keep[i]));
  if (fit === null) return null;
  const H = fit.H as number[];
  const Hinv = invert3(fit.H);
  if (Hinv === null) return null;
  // Everything the sheet(s) cover on the plane (sheet B's points too, through sheet A's plane), plus the paper's margin.
  const onPlane = sheet.imagePoints.map((p) => applyH(Hinv, p));
  const xs = onPlane.map((p) => p[0]);
  const ys = onPlane.map((p) => p[1]);
  const box: [number, number, number, number] = [Math.min(...xs) - 0.6 - CLEAR_IN, Math.min(...ys) - 0.6 - CLEAR_IN, Math.max(...xs) + 0.6 + CLEAR_IN, Math.max(...ys) + 0.6 + CLEAR_IN];
  const about: Pt = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
  // Where the photo reaches on the plane (its corners, clipped to the search reach).
  const corners = [
    [0, 0],
    [img.width, 0],
    [img.width, img.height],
    [0, img.height],
  ].map((p) => {
    // A photo corner beyond the plane's horizon maps behind the camera: clip it to the reach.
    const w = Hinv[6]! * p[0]! + Hinv[7]! * p[1]! + Hinv[8]!;
    const q = applyH(Hinv, p as Pt);
    return w > 0 ? q : null;
  });
  let ux0 = about[0] - REACH_IN;
  let ux1 = about[0] + REACH_IN;
  let vy0 = about[1] - REACH_IN;
  let vy1 = about[1] + REACH_IN;
  const seen = corners.filter((q): q is Pt => q !== null);
  if (seen.length === 4) {
    // 1.2 x: the turn below can bring a little more of the photo into the aligned frame.
    const pad = 0.1 * Math.max(...seen.map((q) => Math.hypot(q[0] - about[0], q[1] - about[1])));
    ux0 = Math.max(ux0, Math.min(...seen.map((q) => q[0])) - pad);
    ux1 = Math.min(ux1, Math.max(...seen.map((q) => q[0])) + pad);
    vy0 = Math.max(vy0, Math.min(...seen.map((q) => q[1])) - pad);
    vy1 = Math.min(vy1, Math.max(...seen.map((q) => q[1])) + pad);
  }
  if (!(ux1 - ux0 > box[2] - box[0] + 2) || !(vy1 - vy0 > box[3] - box[1] + 2)) return null;

  // Pixels per inch of the photo at the sheet: shrink so the plane is sampled at about 2 photo pixels per sample.
  const a = applyH(H, [about[0] - 0.5, about[1]]);
  const b = applyH(H, [about[0] + 0.5, about[1]]);
  const photoPpi = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ppi = Math.min(RECT_PPI, Math.max(1.5, photoPpi / 1.5));
  const k = Math.max(1, Math.floor(photoPpi / ppi / 2));
  const g = shrinkGray(toGray(img), k);
  const W = Math.round((ux1 - ux0) * ppi);
  const Hh = Math.round((vy1 - vy0) * ppi);
  if (W * Hh > 4_000_000 || W < 20 || Hh < 20) return null;
  const toPix = (u: number, v: number): Pt => [(u - ux0) * ppi, (v - vy0) * ppi];
  const sb0 = toPix(box[0], box[1]);
  const sb1 = toPix(box[2], box[3]);
  const sheetBox: [number, number, number, number] = [sb0[0], sb0[1], sb1[0], sb1[1]];

  // The turn between the sheet and the window, from a first look; then the plane again, lined up with the window.
  const first = rectify(g, k, H, [ux0, vy0], W, Hh, ppi, 0, about);
  const g0 = gradients(first);
  const rot = dominantTurn(g0.gx, g0.gy, W, Hh, sheetBox);
  const r = Math.abs(rot) < 0.002 ? first : rectify(g, k, H, [ux0, vy0], W, Hh, ppi, rot, about);
  const { gx, gy } = r === first ? g0 : gradients(r);

  // Edge profiles across the sheet's span: a window side passes the whole sheet.
  const [bx0, by0, bx1, by1] = sheetBox.map((v) => Math.round(v)) as [number, number, number, number];
  const col = new Float64Array(W);
  const row = new Float64Array(Hh);
  for (let i = 0; i < W; i++) {
    let s = 0;
    for (let j = Math.max(0, by0); j <= Math.min(Hh - 1, by1); j++) s += gx[j * W + i]!;
    col[i] = s / Math.max(1, by1 - by0 + 1);
  }
  for (let j = 0; j < Hh; j++) {
    let s = 0;
    for (let i = Math.max(0, bx0); i <= Math.min(W - 1, bx1); i++) s += gy[j * W + i]!;
    row[j] = s / Math.max(1, bx1 - bx0 + 1);
  }
  const left = peaks(col, 1, bx0 - 1, bx0);
  const right = peaks(col, bx1 + 1, W - 2, bx1);
  const top = peaks(row, 1, by0 - 1, by0);
  const bottom = peaks(row, by1 + 1, Hh - 2, by1);
  if (left.length === 0 || right.length === 0 || top.length === 0 || bottom.length === 0) return null;

  // Prefix sums along columns (gx) and rows (gy) for each side's support over any span; "cover" counts samples where
  // the edge is clearly there with the side's polarity.
  const mags: number[] = [];
  for (let q = 0; q < W * Hh; q += 7) mags.push(Math.abs(gx[q]!), Math.abs(gy[q]!));
  mags.sort((x, y) => x - y);
  const thr = Math.max(2, mags[Math.floor(mags.length * 0.9)]! * 0.5);
  const colSum = new Float64Array(W * (Hh + 1));
  const colPos = new Float64Array(W * (Hh + 1));
  const colNeg = new Float64Array(W * (Hh + 1));
  for (let i = 0; i < W; i++)
    for (let j = 0; j < Hh; j++) {
      // The strongest of 3 neighbouring columns (the side may lean a pixel over its length).
      let v = gx[j * W + i]!;
      for (const di of [-1, 1]) {
        const ii = i + di;
        if (ii < 0 || ii >= W) continue;
        const u = gx[j * W + ii]!;
        if (Math.abs(u) > Math.abs(v)) v = u;
      }
      const o = i * (Hh + 1) + j + 1;
      colSum[o] = colSum[o - 1]! + v;
      colPos[o] = colPos[o - 1]! + (v > thr ? 1 : 0);
      colNeg[o] = colNeg[o - 1]! + (v < -thr ? 1 : 0);
    }
  const rowSum = new Float64Array(Hh * (W + 1));
  const rowPos = new Float64Array(Hh * (W + 1));
  const rowNeg = new Float64Array(Hh * (W + 1));
  for (let j = 0; j < Hh; j++)
    for (let i = 0; i < W; i++) {
      let v = gy[j * W + i]!;
      for (const dj of [-1, 1]) {
        const jj = j + dj;
        if (jj < 0 || jj >= Hh) continue;
        const u = gy[jj * W + i]!;
        if (Math.abs(u) > Math.abs(v)) v = u;
      }
      const o = j * (W + 1) + i + 1;
      rowSum[o] = rowSum[o - 1]! + v;
      rowPos[o] = rowPos[o - 1]! + (v > thr ? 1 : 0);
      rowNeg[o] = rowNeg[o - 1]! + (v < -thr ? 1 : 0);
    }
  const colSide = (i: number, j0: number, j1: number, sign: 1 | -1) => {
    const n = Math.max(1, j1 - j0);
    const base = i * (Hh + 1);
    const mean = (sign * (colSum[base + j1]! - colSum[base + j0]!)) / n;
    const cover = ((sign > 0 ? colPos : colNeg)[base + j1]! - (sign > 0 ? colPos : colNeg)[base + j0]!) / n;
    return { mean, cover };
  };
  const rowSide = (j: number, i0: number, i1: number, sign: 1 | -1) => {
    const n = Math.max(1, i1 - i0);
    const base = j * (W + 1);
    const mean = (sign * (rowSum[base + i1]! - rowSum[base + i0]!)) / n;
    const cover = ((sign > 0 ? rowPos : rowNeg)[base + i1]! - (sign > 0 ? rowPos : rowNeg)[base + i0]!) / n;
    return { mean, cover };
  };
  // Mean grey just inside and just outside a side (for the same-boundary check).
  const grey = (i: number, j: number) => (i >= 0 && j >= 0 && i < W && j < Hh && r.ok[j * W + i] ? r.d[j * W + i]! : Number.NaN);
  const across = (vertical: boolean, at: number, from: number, to: number, outward: 1 | -1) => {
    let ins = 0;
    let outs = 0;
    let n = 0;
    for (let t = 0.2; t <= 0.81; t += 0.1) {
      const m = Math.round(from + (to - from) * t);
      const gi = vertical ? grey(at - 2 * outward, m) : grey(m, at - 2 * outward);
      const go = vertical ? grey(at + 2 * outward, m) : grey(m, at + 2 * outward);
      if (Number.isNaN(gi) || Number.isNaN(go)) continue;
      ins += gi;
      outs += go;
      n++;
    }
    return n === 0 ? 0 : Math.log((ins / n + 8) / (outs / n + 8));
  };

  type R = { score: number; l: number; rr: number; t: number; b: number; cover: number };
  const rects: R[] = [];
  let best: R | null = null;
  for (const L of left)
    for (const R of right) {
      // Same boundary: going outward, the step has the same sign on both sides (left's outward is -x).
      if (L.sign !== -R.sign) continue;
      for (const T of top)
        for (const B of bottom) {
          if (T.sign !== -B.sign) continue;
          const sides = [rowSide(T.at, L.at, R.at, T.sign), colSide(R.at, T.at, B.at, R.sign), rowSide(B.at, L.at, R.at, B.sign), colSide(L.at, T.at, B.at, L.sign)];
          const cover = sides.reduce((a2, s) => a2 + Math.min(1, s.cover), 0) / 4;
          const minCover = Math.min(...sides.map((s) => s.cover));
          if (minCover < 0.3) continue;
          const strength = sides.reduce((a2, s) => a2 + Math.min(1, Math.max(0, s.mean) / (2 * thr)), 0) / 4;
          const lr = [across(false, T.at, L.at, R.at, -1), across(true, R.at, T.at, B.at, 1), across(false, B.at, L.at, R.at, 1), across(true, L.at, T.at, B.at, -1)];
          const lm = lr.reduce((a2, v) => a2 + v, 0) / 4;
          const ratio = Math.min(3, Math.sqrt(lr.reduce((a2, v) => a2 + (v - lm) ** 2, 0) / 4) / 0.05);
          const score = 2 * cover + strength - 0.5 * ratio;
          const rc = { score, l: L.at, rr: R.at, t: T.at, b: B.at, cover };
          rects.push(rc);
          if (best === null || score > best.score) best = rc;
        }
    }
  if (best === null || best.cover < MIN_COVER) return null;
  // A frame is several nested rectangles (trim, frame, sash, glass) scoring about the same. Among the near-ties that
  // nest (every side on another line), the target decides: the frame is the outermost close tie, the trim the
  // outermost and the glass the innermost of a wider tie.
  const tiesWithin = (eps: number): R[] => {
    const ties: R[] = [];
    for (const rc of [...rects].sort((x, y) => y.score - x.score)) {
      if (rc.score < best!.score - eps) break;
      if (rc.cover < 0.8 || !ties.every((d) => Math.abs(d.l - rc.l) > 2 && Math.abs(d.rr - rc.rr) > 2 && Math.abs(d.t - rc.t) > 2 && Math.abs(d.b - rc.b) > 2)) continue;
      ties.push(rc);
    }
    return ties.length === 0 ? [best!] : ties;
  };
  const area = (x: R) => (x.rr - x.l) * (x.b - x.t);
  // How busy the photo is just outside a rectangle (siding, brick, shrubs: the wall), mean gradient per sample.
  const busyOutside = (x: R): number => {
    let sum = 0;
    let n = 0;
    const o0 = Math.round(0.5 * ppi);
    const o1 = Math.round(1.75 * ppi);
    const add = (i: number, j: number) => {
      if (i < 1 || j < 1 || i >= W - 1 || j >= Hh - 1 || !r.ok[j * W + i]) return;
      sum += Math.abs(gx[j * W + i]!) + Math.abs(gy[j * W + i]!);
      n++;
    };
    for (let o = o0; o <= o1; o++) {
      for (let i = Math.round(x.l + 0.1 * (x.rr - x.l)); i <= x.rr - 0.1 * (x.rr - x.l); i++) {
        add(i, x.t - o);
        add(i, x.b + o);
      }
      for (let j = Math.round(x.t + 0.1 * (x.b - x.t)); j <= x.b - 0.1 * (x.b - x.t); j++) {
        add(x.l - o, j);
        add(x.rr + o, j);
      }
    }
    return n === 0 ? 0 : sum / n;
  };
  // A frame is several nested rectangles (trim, frame, sash, glass) scoring about the same. Among the close ties
  // that nest: the trim is the outermost, the glass the innermost, and the frame's outer edge the one with plain trim
  // just outside it (outside the trim is the wall; just outside the sash or glass edges is the next edge of the frame).
  const ties = tiesWithin(0.1);
  const chosen =
    target === 'outside-trim'
      ? ties.reduce((x, y) => (area(y) > area(x) ? y : x))
      : target === 'glass'
        ? ties.reduce((x, y) => (area(y) < area(x) ? y : x))
        : ties.reduce((x, y) => (busyOutside(y) < busyOutside(x) ? y : x));

  // Back to the photo: aligned plane pixels -> sheet inches (turned back) -> photo pixels, ordered TL TR BR BL.
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const toPhoto = (i: number, j: number): Pt => {
    const u = ux0 + i / ppi - about[0];
    const v = vy0 + j / ppi - about[1];
    return applyH(H, [about[0] + c * u - s * v, about[1] + s * u + c * v]);
  };
  const asQuad = (x: R) => orderQuad([toPhoto(x.l, x.t), toPhoto(x.rr, x.t), toPhoto(x.rr, x.b), toPhoto(x.l, x.b)]);
  // The chosen one first, then the next best whole other rectangles (another layer, or the frame when the chosen one
  // is the trim), so the outline picker can offer them.
  const others: R[] = [chosen];
  for (const rc of [...rects].sort((x, y) => y.score - x.score)) {
    if (others.length >= 1 + ALTERNATIVES || rc.score < best.score - 0.6) break;
    if (rc.cover < MIN_COVER || !others.every((d) => Math.abs(d.l - rc.l) > 2 || Math.abs(d.rr - rc.rr) > 2 || Math.abs(d.t - rc.t) > 2 || Math.abs(d.b - rc.b) > 2)) continue;
    if (!others.every((d) => Math.abs(d.l - rc.l) > 2 && Math.abs(d.rr - rc.rr) > 2 && Math.abs(d.t - rc.t) > 2 && Math.abs(d.b - rc.b) > 2)) continue;
    others.push(rc);
  }
  return others.map(asQuad);
}

/** Four points as TL, TR, BR, BL in the photo. */
function orderQuad(q: Pt[]): Quad {
  const cx = q.reduce((a, p) => a + p[0], 0) / 4;
  const cy = q.reduce((a, p) => a + p[1], 0) / 4;
  const byAngle = [...q].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  // Clockwise from the top-left (smallest x + y).
  let start = 0;
  for (let i = 1; i < 4; i++) if (byAngle[i]![0] + byAngle[i]![1] < byAngle[start]![0] + byAngle[start]![1]) start = i;
  return [0, 1, 2, 3].map((k) => byAngle[(start + k) % 4]!) as Quad;
}

/**
 * The proposed outline, fitted to the frame's edges and ranked like a snap (its candidates are the other layers);
 * null when there is no confident rectangle around the sheet.
 */
export function proposeQuadSync(img: RgbaImage, sheet: SheetDetection, target?: WindowMeasureTarget): SnapResult | null {
  const roughs = proposeRough(img, sheet, target);
  if (roughs === null || roughs.length === 0) return null;
  const opts = { sheet, ...(target !== undefined && { target }) };
  const s = snapQuadSync(img, roughs[0]!, opts);
  // A fit that found no whole rectangle (some sides left where they were) is not a proposal.
  if (s.candidates === undefined || s.candidates.length === 0 || !holdsSheet(s.quad, sheet.imagePoints)) return null;
  // The other rectangles, fitted the same way, join the ranked outlines after the chosen one's own alternatives' best.
  const same = (a: Quad, b: Quad) => a.every((p, k) => Math.hypot(p[0] - b[k]![0], p[1] - b[k]![1]) < 3);
  const list = [...s.candidates];
  for (const r of roughs.slice(1)) {
    const o = snapQuadSync(img, r, opts);
    const top = o.candidates?.[0];
    if (top === undefined || !holdsSheet(top.quad, sheet.imagePoints) || list.some((c) => same(c.quad, top.quad))) continue;
    // After the chosen outline (and its nearest alternative): the screen shows three.
    list.splice(Math.min(list.length, 1 + (list.length > 1 ? 1 : 0)), 0, { ...top, score: Math.min(top.score, list[0]!.score) });
  }
  return { ...s, candidates: list.slice(0, 5) };
}

/** Whether every point is inside the quad (the outline must hold the sheet). */
function holdsSheet(q: Quad, pts: Pt[]): boolean {
  const inside = (p: Pt) => {
    let sgn = 0;
    for (let k = 0; k < 4; k++) {
      const a = q[k]!;
      const b = q[(k + 1) % 4]!;
      const cr = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
      if (cr === 0) continue;
      if (sgn === 0) sgn = Math.sign(cr);
      else if (Math.sign(cr) !== sgn) return false;
    }
    return true;
  };
  return pts.every(inside);
}
