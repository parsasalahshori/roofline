import jpeg from 'jpeg-js';
import { type Camera, frontWalls, project, type Vec, type Wall } from './windows-geometry.ts';

/*
 * Does the outline's front wall line up with the house in the street photo? No AI: classic image edges. The front
 * wall (its two ground corners and two eave corners, from the outline and the wall height) is drawn into the photo with
 * the pinhole camera; points along its two vertical corners and its eave line are checked against the photo's Sobel
 * edges (a strong edge, running the same way, within a few pixels). A small search over the camera heading (Street
 * View headings can be a few degrees off) and the eave height finds the best line-up. A person can also drag the four
 * corners onto the house; the camera heading, its distance and the wall height are then fitted to those corners.
 *
 * jpeg-js decodes the photo: pure JavaScript (no native build, no network), small, and enough for a 640 x 640 JPEG in
 * a few tens of milliseconds. It runs on bytes Google returned, behind a size limit and a resolution cap.
 */

/** Heading corrections searched, degrees, and the step. */
const HEADING_SEARCH_DEG = 6;
const HEADING_STEP_DEG = 0.5;
/** Eave height factors searched (±25%) and the step. */
const HEIGHT_SEARCH = 0.25;
const HEIGHT_STEP = 0.025;
/** A sample is on an edge when a strong one runs the same way (gradient within 35 degrees of the wall line's normal) within 3 px. */
const SEARCH_PX = 3;
const ORIENTATION_COS = Math.cos((35 * Math.PI) / 180);
/** Strong edge: at or above this share of the photo's gradient magnitudes (the top 10%), and at least MIN_STRONG. */
const STRONG_PERCENTILE = 0.9;
const MIN_STRONG = 40;
/** Samples every this many pixels along a wall line, leaving out this share at each end (corners are cluttered). */
const SAMPLE_STEP_PX = 3;
const END_TRIM = 0.1;
const MIN_SAMPLES_PER_LINE = 6;
/**
 * The line-up is 'good' at or above this share of wall-line samples on a matching edge. By chance (a strong edge in
 * 10% of pixels, a third of them running the right way, 7 pixels searched) about 0.2 of samples hit; a wall that
 * truly lines up scores well above half on the synthetic renders and on the street photos the check was tuned on.
 */
export const FIT_GOOD_SCORE = 0.5;
/**
 * Blurred or blank: the wall's region in the photo has little edge energy. Google blurs a house on request with a
 * heavy blur; its region's mean gradient then falls far below the rest of the photo's. Below this ratio of the region's
 * mean gradient to the whole photo's, or below MIN_REGION_ENERGY absolutely, the line-up is 'unknown'.
 */
export const BLUR_ENERGY_RATIO = 0.35;
const MIN_REGION_ENERGY = 8;
/** Below this share of the drawn wall inside the photo, nothing can be told. */
const MIN_INSIDE_SHARE = 0.4;

export type Gray = { w: number; h: number; data: Float32Array };
export type Edges = { w: number; h: number; gx: Float32Array; gy: Float32Array; mag: Float32Array; strong: number; meanMag: number };

/** The photo as grey levels 0..255; null when it is not a JPEG it can read. */
export function decodeGray(bytes: Uint8Array): Gray | null {
  try {
    const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: false, maxResolutionInMP: 4, maxMemoryUsageInMB: 64 });
    const n = img.width * img.height;
    const ch = img.data.length / n >= 4 ? 4 : 3;
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) data[i] = 0.299 * img.data[i * ch]! + 0.587 * img.data[i * ch + 1]! + 0.114 * img.data[i * ch + 2]!;
    return { w: img.width, h: img.height, data };
  } catch {
    return null;
  }
}

/** Sobel gradients, their magnitude, the strong-edge level and the mean magnitude. */
export function sobel(g: Gray): Edges {
  const { w, h, data } = g;
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = data[i - w - 1]!, b = data[i - w]!, c = data[i - w + 1]!;
      const d = data[i - 1]!, f = data[i + 1]!;
      const p = data[i + w - 1]!, q = data[i + w]!, r = data[i + w + 1]!;
      const sx = c + 2 * f + r - a - 2 * d - p;
      const sy = p + 2 * q + r - a - 2 * b - c;
      gx[i] = sx;
      gy[i] = sy;
      mag[i] = Math.hypot(sx, sy);
    }
  }
  const sorted = Float32Array.from(mag).sort();
  const strong = Math.max(MIN_STRONG, sorted[Math.floor(sorted.length * STRONG_PERCENTILE)] ?? 0);
  let sum = 0;
  for (const m of mag) sum += m;
  return { w, h, gx, gy, mag, strong, meanMag: sum / mag.length };
}

/** The main front wall: the one that shows widest to the camera (length times how squarely it faces it). */
export function mainWall(walls: readonly Wall[], cam: Vec): Wall | null {
  const front = frontWalls(walls, cam);
  let best: Wall | null = null;
  let bestScore = -Infinity;
  for (const w of front) {
    const m: Vec = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
    const d = Math.hypot(cam[0] - m[0], cam[1] - m[1]) || 1;
    const score = (w.lengthM * (w.normal[0] * (cam[0] - m[0]) + w.normal[1] * (cam[1] - m[1]))) / d;
    if (score > bestScore) {
      bestScore = score;
      best = w;
    }
  }
  return best;
}

/** Bottom-left, bottom-right, top-right, top-left, in pixels. */
export type Quad = [Vec, Vec, Vec, Vec];

/** The wall's ground and eave corners in the photo (left and right as the photo shows them); null if behind the camera. */
export function wallQuad(cam: Camera, wall: Wall, eaveM: number): Quad | null {
  const a0 = project(cam, [wall.a[0], wall.a[1], 0]);
  const b0 = project(cam, [wall.b[0], wall.b[1], 0]);
  const a1 = project(cam, [wall.a[0], wall.a[1], eaveM]);
  const b1 = project(cam, [wall.b[0], wall.b[1], eaveM]);
  if (a0 === null || b0 === null || a1 === null || b1 === null) return null;
  return a0[0] <= b0[0] ? [a0, b0, b1, a1] : [b0, a0, a1, b1];
}

/** The share of samples along a line from p to q that sit on a matching strong edge; null when too few are in the photo. */
function lineScore(e: Edges, p: Vec, q: Vec): { hits: number; n: number } {
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  if (len < 1) return { hits: 0, n: 0 };
  const ux = (q[0] - p[0]) / len;
  const uy = (q[1] - p[1]) / len;
  const nx = -uy;
  const ny = ux;
  let hits = 0;
  let n = 0;
  for (let t = len * END_TRIM; t <= len * (1 - END_TRIM); t += SAMPLE_STEP_PX) {
    const sx = p[0] + ux * t;
    const sy = p[1] + uy * t;
    if (sx < 1 || sy < 1 || sx >= e.w - 1 || sy >= e.h - 1) continue;
    n++;
    for (let k = -SEARCH_PX; k <= SEARCH_PX; k++) {
      const x = Math.round(sx + nx * k);
      const y = Math.round(sy + ny * k);
      if (x < 1 || y < 1 || x >= e.w - 1 || y >= e.h - 1) continue;
      const i = y * e.w + x;
      const m = e.mag[i]!;
      if (m < e.strong) continue;
      if (Math.abs((e.gx[i]! * nx + e.gy[i]! * ny) / m) >= ORIENTATION_COS) {
        hits++;
        break;
      }
    }
  }
  return { hits, n };
}

/** How well a drawn wall lines up: the mean, over its two vertical corners and its eave line, of each line's share on an edge. */
export function quadScore(e: Edges, quad: Quad): { score: number | null; insideShare: number } {
  const lines: [Vec, Vec][] = [
    [quad[0], quad[3]],
    [quad[1], quad[2]],
    [quad[3], quad[2]],
  ];
  const scores: number[] = [];
  let inside = 0;
  let total = 0;
  for (const [p, q] of lines) {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    total += Math.max(0, Math.floor((len * (1 - 2 * END_TRIM)) / SAMPLE_STEP_PX) + 1);
    const s = lineScore(e, p, q);
    inside += s.n;
    if (s.n >= MIN_SAMPLES_PER_LINE) scores.push(s.hits / s.n);
  }
  return { score: scores.length >= 2 ? scores.reduce((t, v) => t + v, 0) / scores.length : null, insideShare: total > 0 ? inside / total : 0 };
}

/** The mean gradient inside a quad's bounding box (clipped to the photo); 0 when it is outside. */
function regionEnergy(e: Edges, quad: Quad): number {
  const x0 = Math.max(1, Math.floor(Math.min(...quad.map((p) => p[0]))));
  const x1 = Math.min(e.w - 2, Math.ceil(Math.max(...quad.map((p) => p[0]))));
  const y0 = Math.max(1, Math.floor(Math.min(...quad.map((p) => p[1]))));
  const y1 = Math.min(e.h - 2, Math.ceil(Math.max(...quad.map((p) => p[1]))));
  if (x1 <= x0 || y1 <= y0) return 0;
  let sum = 0;
  let n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    sum += e.mag[y * e.w + x]!;
    n++;
  }
  return sum / n;
}

export type LineUp = {
  fit: 'good' | 'off' | 'unknown';
  fitScore: number | null;
  headingCorrectionDeg: number;
  /** The best-fitting eave height, metres (null unless the fit is good). */
  eaveM: number | null;
  /** The drawn wall at the fit used (the corrected one when good), pixels. */
  quad: Quad | null;
  /** The drawn wall before any correction, pixels. */
  quadBefore: Quad | null;
  /** The wall region's edge energy against the photo's (low: blurred). */
  energyRatio: number | null;
  blurred: boolean;
};

/**
 * The line-up of `wall` (eave at `eaveM`) on a photo taken by `cam`: the best heading correction (±6 degrees) and
 * eave height (±25%), its score, and 'good' / 'off' / 'unknown' (wall mostly out of the photo, or a blurred / blank
 * region).
 */
export function lineUp(edges: Edges, cam: Camera, wall: Wall, eaveM: number): LineUp {
  const before = wallQuad(cam, wall, eaveM);
  const none: LineUp = { fit: 'unknown', fitScore: null, headingCorrectionDeg: 0, eaveM: null, quad: before, quadBefore: before, energyRatio: null, blurred: false };
  if (before === null) return none;
  const energy = regionEnergy(edges, before);
  const energyRatio = edges.meanMag > 0 ? energy / edges.meanMag : 0;
  const blurred = energy < MIN_REGION_ENERGY || energyRatio < BLUR_ENERGY_RATIO;
  if (blurred) return { ...none, energyRatio: round3(energyRatio), blurred: true };
  let best: { rank: number; score: number; dh: number; f: number; quad: Quad } | null = null;
  for (let dh = -HEADING_SEARCH_DEG; dh <= HEADING_SEARCH_DEG + 1e-9; dh += HEADING_STEP_DEG) {
    for (let f = 1 - HEIGHT_SEARCH; f <= 1 + HEIGHT_SEARCH + 1e-9; f += HEIGHT_STEP) {
      const quad = wallQuad({ ...cam, heading: cam.heading + dh }, wall, eaveM * f);
      if (quad === null) continue;
      const { score, insideShare } = quadScore(edges, quad);
      if (score === null || insideShare < MIN_INSIDE_SHARE) continue;
      // Ties go to the smaller correction.
      const rank = score - 0.004 * Math.abs(dh) - 0.05 * Math.abs(f - 1);
      if (best === null || rank > best.rank) best = { rank, score, dh, f, quad };
    }
  }
  if (best === null) return { ...none, energyRatio: round3(energyRatio) };
  const good = best.score >= FIT_GOOD_SCORE;
  return {
    fit: good ? 'good' : 'off',
    fitScore: round3(best.score),
    headingCorrectionDeg: good ? Math.round(best.dh * 10) / 10 : 0,
    eaveM: good ? eaveM * best.f : null,
    quad: good ? best.quad : before,
    quadBefore: before,
    energyRatio: round3(energyRatio),
    blurred: false,
  };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** The camera after a person's (or the line-up's) correction: turned by `dh` degrees and moved along its line to the wall. */
export function correctedCamera(cam: Camera, wall: Wall, dh: number, distanceScale: number): Camera {
  const m: Vec = [(wall.a[0] + wall.b[0]) / 2, (wall.a[1] + wall.b[1]) / 2];
  return { ...cam, heading: cam.heading + dh, pos: [m[0] + (cam.pos[0] - m[0]) * distanceScale, m[1] + (cam.pos[1] - m[1]) * distanceScale] };
}

export type CornerFit = { headingCorrectionDeg: number; distanceScale: number; eaveM: number; errorPx: number };

/**
 * The camera heading, its distance to the wall and the wall height that put the drawn wall's corners where a person
 * dragged them (`quad`, pixels): a coarse grid over heading (±15 degrees) and distance (x0.6 to x1.6), the eave height
 * solved per pair from the top corners, then a finer grid round the best. Mean corner error in pixels.
 */
export function fitCorners(cam: Camera, wall: Wall, quad: Quad): CornerFit {
  const err = (dh: number, s: number, eave: number): number => {
    const q = wallQuad(correctedCamera(cam, wall, dh, s), wall, eave);
    if (q === null) return Infinity;
    let t = 0;
    for (let i = 0; i < 4; i++) t += Math.hypot(q[i]![0] - quad[i]![0], q[i]![1] - quad[i]![1]);
    return t / 4;
  };
  const bestEave = (dh: number, s: number): { eave: number; e: number } => {
    let lo = 1.5;
    let hi = 15;
    // The error is unimodal in the eave height: golden-section search.
    for (let k = 0; k < 40; k++) {
      const m1 = lo + (hi - lo) * 0.382;
      const m2 = lo + (hi - lo) * 0.618;
      if (err(dh, s, m1) <= err(dh, s, m2)) hi = m2;
      else lo = m1;
    }
    const eave = (lo + hi) / 2;
    return { eave, e: err(dh, s, eave) };
  };
  let best = { dh: 0, s: 1, eave: 3, e: Infinity };
  const search = (dhs: number[], ss: number[]) => {
    for (const dh of dhs) for (const s of ss) {
      const r = bestEave(dh, s);
      if (r.e < best.e) best = { dh, s, eave: r.eave, e: r.e };
    }
  };
  const range = (from: number, to: number, step: number) => Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => from + i * step);
  search(range(-15, 15, 1), range(0.6, 1.6, 0.05));
  const { dh, s } = best;
  search(range(dh - 1, dh + 1, 0.1), range(Math.max(0.5, s - 0.05), s + 0.05, 0.005));
  return { headingCorrectionDeg: Math.round(best.dh * 10) / 10, distanceScale: Math.round(best.s * 1000) / 1000, eaveM: best.eave, errorPx: Math.round(best.e * 10) / 10 };
}
