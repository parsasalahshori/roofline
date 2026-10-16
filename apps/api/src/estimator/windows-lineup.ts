import jpeg from 'jpeg-js';
import { type Camera, frontWalls, project, type Vec, type Wall } from './windows-geometry.ts';

/*
 * Does the outline's front wall line up with the house in the street photo? No AI: classic image edges. The front
 * wall (its two ground corners and two eave corners, from the outline and the wall height) is drawn into the photo with
 * the pinhole camera; points along its two vertical corners, its eave line and its ground line are checked against the
 * photo's Sobel edges (a strong edge, running the same way, within a few pixels), and lines inside the wall that could
 * pass for an eave (garage-door panels, window heads) count against it. A search over the camera heading, pitch and
 * roll (Street View's can each be a few degrees off) and the eave height finds the best line-up. A person can also
 * drag the four corners onto the house; the camera heading, its distance and the wall height are then fitted to them.
 *
 * jpeg-js decodes the photo: pure JavaScript (no native build, no network), small, and enough for a 640 x 640 JPEG in
 * a few tens of milliseconds. It runs on bytes Google returned, behind a size limit and a resolution cap.
 */

/**
 * The camera pose searched, jointly: heading (±6 degrees: Street View headings can be a few degrees off), pitch (±6:
 * the car-mounted camera's pitch reference sits a few degrees off, about 3.5 on live photos), roll (±2: the car on a
 * cambered road) and the eave height (±25%). Coarse to fine: a grid (COARSE_*) scored by chamfer distance to the
 * photo's thinned edges of the matching direction (smooth, so a pose between grid points still scores), the best
 * distinct local peaks refined by a pattern search down to REFINE_MIN_STEP degrees with a tighter and tighter chamfer
 * radius (sub-pixel: many samples along each line average out the pixel grid), and only then the strict checks on the
 * refined poses.
 */
const HEADING_SEARCH_DEG = 6;
const PITCH_SEARCH_DEG = 6;
const ROLL_SEARCH_DEG = 2;
const HEIGHT_SEARCH = 0.25;
const COARSE_ANGLE_STEP = 1;
const COARSE_HEIGHT_STEP = 0.05;
/** The chamfer radius (pixels) at each refinement stage, with its angle step (degrees; the height step is ANGLE_TO_HEIGHT of it). */
const COARSE_RADIUS_PX = 10;
const REFINE_STAGES: { radiusPx: number; step: number }[] = [
  { radiusPx: 8, step: 0.5 },
  { radiusPx: 5, step: 0.25 },
  { radiusPx: 3, step: 0.12 },
  { radiusPx: 2, step: 0.06 },
  { radiusPx: 2, step: 0.03 },
];
const ANGLE_TO_HEIGHT = 0.05;
/** How many distinct coarse peaks are refined (the best, and the rivals it must beat). */
const PEAKS = 10;
/** At most this many steps per refinement stage. */
const REFINE_ROUNDS = 12;
/** A best pose within this of a search limit (degrees) is at the edge of the search. */
const LIMIT_MARGIN_DEG = 0.1;
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
 * The line-up's checks (strict: a wrong 'good' sizes every marked window wrong, so when in doubt it says 'unknown').
 * By chance (a strong edge in 10% of pixels, a third of them running the right way, 7 pixels searched) about 0.2 of a
 * line's samples hit. Tuned on synthetic renders (clean walls; walls with garage-door panels, porch posts and window
 * heads) and on the live Street View fronts of 214 Shane Dr, Centerton, AR and 5437 Summer Pl, Jonesboro, AR, where
 * the old three-line score (0.68, 0.63) said 'good' on a wall drawn over the garage door and the driveway.
 * - FIT_GOOD_SCORE: the mean support 'good' needs at least.
 * - FIT_OFF_SCORE: below this mean support (four lines, less the interior penalty) the wall plainly does not line up.
 * - CORNER_MIN / EAVE_MIN / GROUND_MIN: each line's own support; a wall is only confirmed on all four. A house corner
 *   is a long unbroken vertical edge: the real corners on the live photos scored 0.67 and 0.96 (811 Allyson Ave,
 *   Bryant, AR and 214 Shane Dr), the chance verticals 5437 Summer Pl's old line-up sat on 0.52 and 0.54.
 * - INTERIOR_*: a horizontal line inside the wall standing INTERIOR_FREE or more above the wall's texture (see
 *   interiorPeak) is penalised in the search, and fails the check when within EAVE_MARGIN of the eave's own support above the texture
 *   (EAVE_MARGIN_AGREED when Google's heights put the eave where it is).
 * - EAVE_THIRD_MIN: each third of the eave line on an edge (a garage door's top runs along part of a wall only).
 * - WIDTH_SEARCH / WIDTH_TOLERANCE: the photo's strongest vertical edge near each corner (searched over WIDTH_SEARCH
 *   of the width) must be within WIDTH_TOLERANCE of the drawn corner, so the photo's wall is as wide as the outline's.
 * - EXTEND / BEYOND_MAX: an eave line that runs on at the same height past BOTH corners is a longer line (a fence, a
 *   gutter run, a garage door's top over a wider drawn wall), not this wall's eave.
 * - RIVAL_*: uniqueness. The best line-up must beat the best line-up at a clearly different pose by RIVAL_MARGIN:
 *   edges that fit two places fit neither for sure. A pose is clearly different when the drawn wall's corners or its
 *   ground line land RIVAL_DEG or more of view away on the photo (one of its vertical corners moved sideways, or its
 *   ground line moved up or down, that far): the wall elsewhere along the street, or the whole wall slid up onto a
 *   curb, a fence top or a garage door's top now that pitch is free. The eave moving alone is not a rival (the eave's
 *   own checks and the interior lines judge that). A wall slid up or down keeps its corners on the same vertical edges
 *   and (the eave height being searched too) its eave on the same eave, so only its ground line tells the two apart:
 *   such a rival counts when its ground line is also within RIVAL_GROUND_MARGIN of the best one's (two ground lines
 *   about as good: the wall's foot is not known). The rival is the best of the other refined peaks, each refined to
 *   its own top the same way as the best: a rival judged only at a grid point could score below its peak and let an
 *   ambiguous photo through, and with pitch and roll free there are more places a wall can fit by chance.
 * - EAVE_TOLERANCE: with Google's heights, the eave height read from the photo within this share of them.
 */
export const FIT_GOOD_SCORE = 0.5;
export const FIT_OFF_SCORE = 0.32;
const CORNER_MIN = 0.6;
const EAVE_MIN = 0.5;
const GROUND_MIN = 0.4;
const INTERIOR_FROM = 0.12;
const INTERIOR_STEP_PX = 4;
const INTERIOR_FREE = 0.35;
const INTERIOR_PENALTY = 0.5;
const EAVE_MARGIN = 0.15;
const EAVE_MARGIN_AGREED = 0.1;
const EAVE_THIRD_MIN = 0.3;
const WIDTH_SEARCH = 0.15;
const WIDTH_TOLERANCE = 0.06;
const EXTEND = 0.25;
const BEYOND_MAX = 0.6;
export const EAVE_TOLERANCE = 0.15;
const RIVAL_DEG = 2;
const RIVAL_MARGIN = 0.1;
const RIVAL_GROUND_MARGIN = 0.25;
/**
 * Blurred or blank: the wall's region in the photo has little edge energy. Google blurs a house on request with a
 * heavy blur; its region's (median cell) gradient then falls far below the rest of the photo's. Below this ratio of the
 * region's energy to the whole photo's mean gradient, or below MIN_REGION_ENERGY absolutely, the line-up is 'unknown'
 * and the photo is flagged blurred. Tuned on three Street View fronts (5107 Cayman Pl, Jonesboro, AR is blurred:
 * about 0.2; two sharp brick and siding fronts: about 1).
 */
export const BLUR_ENERGY_RATIO = 0.35;
const MIN_REGION_ENERGY = 12;
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

/** Samples along a line from p to q (trimmed `trim` at each end): how many sit on a matching strong edge, of how many in the photo, and which. */
function lineSamples(e: Edges, p: Vec, q: Vec, trim = END_TRIM): { hits: number; n: number; hit: boolean[] } {
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  if (len < 1) return { hits: 0, n: 0, hit: [] };
  const ux = (q[0] - p[0]) / len;
  const uy = (q[1] - p[1]) / len;
  const nx = -uy;
  const ny = ux;
  let hits = 0;
  let n = 0;
  const hit: boolean[] = [];
  for (let t = len * trim; t <= len * (1 - trim); t += SAMPLE_STEP_PX) {
    const sx = p[0] + ux * t;
    const sy = p[1] + uy * t;
    if (sx < 1 || sy < 1 || sx >= e.w - 1 || sy >= e.h - 1) continue;
    n++;
    let on = false;
    for (let k = -SEARCH_PX; k <= SEARCH_PX; k++) {
      const x = Math.round(sx + nx * k);
      const y = Math.round(sy + ny * k);
      if (x < 1 || y < 1 || x >= e.w - 1 || y >= e.h - 1) continue;
      const i = y * e.w + x;
      const m = e.mag[i]!;
      if (m < e.strong) continue;
      if (Math.abs((e.gx[i]! * nx + e.gy[i]! * ny) / m) >= ORIENTATION_COS) {
        on = true;
        break;
      }
    }
    if (on) hits++;
    hit.push(on);
  }
  return { hits, n, hit };
}

/** A line's share of samples on an edge; null when too few of its samples are in the photo. */
function lineShare(e: Edges, p: Vec, q: Vec, trim = END_TRIM): number | null {
  const s = lineSamples(e, p, q, trim);
  return s.n >= MIN_SAMPLES_PER_LINE ? s.hits / s.n : null;
}

const lerp = (a: Vec, b: Vec, t: number): Vec => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/**
 * The strongest horizontal line inside a drawn wall, above the wall's own texture: horizontal lines are scanned every
 * INTERIOR_STEP_PX between INTERIOR_FROM and 1 - INTERIOR_FROM of its height, and the best one's support less the
 * lower-quartile support of them all (brick, siding and noise put some support on every line; a garage-door panel
 * line, a window head or a porch beam stands out of it; panel lines can be so close together that half the lines touch
 * one, hence the quartile, not the median).
 */
function interiorPeak(e: Edges, quad: Quad): { peak: number; base: number } {
  const [bl, br, tr, tl] = quad;
  const tall = Math.max(Math.hypot(tl[0] - bl[0], tl[1] - bl[1]), Math.hypot(tr[0] - br[0], tr[1] - br[1]));
  const k = Math.max(6, Math.round((tall * (1 - 2 * INTERIOR_FROM)) / INTERIOR_STEP_PX));
  const shares: number[] = [];
  for (let i = 0; i <= k; i++) {
    const t = INTERIOR_FROM + ((1 - 2 * INTERIOR_FROM) * i) / k;
    const v = lineShare(e, lerp(bl, tl, t), lerp(br, tr, t));
    if (v !== null) shares.push(v);
  }
  if (shares.length < 3) return { peak: 0, base: 0 };
  const sorted = [...shares].sort((a, b) => a - b);
  const base = sorted[Math.floor(sorted.length / 4)]!;
  return { peak: sorted.at(-1)! - base, base };
}

/** Each of a drawn wall's four lines on the photo's edges (null: not enough of it in the photo). */
export type LineSupport = { left: number | null; right: number | null; eave: number | null; ground: number | null };

/**
 * How a drawn wall sits on the photo's edges: each of its four lines (two vertical corners, the eave and the ground
 * line), the strongest horizontal line inside it (garage-door panels, window heads and porch beams make lines there
 * that can pass for an eave), and the share of the drawn wall inside the photo. `score` is the mean of the four lines
 * less the interior penalty (and `texture`, the support any line inside it gets by chance); null when fewer than three lines are in the photo.
 */
export function quadScore(e: Edges, quad: Quad): { score: number | null; lines: LineSupport; interior: number; texture: number; insideShare: number } {
  const [bl, br, tr, tl] = quad;
  const pairs: [keyof LineSupport, Vec, Vec][] = [
    ['left', bl, tl],
    ['right', br, tr],
    ['eave', tl, tr],
    ['ground', bl, br],
  ];
  const lines: LineSupport = { left: null, right: null, eave: null, ground: null };
  let inside = 0;
  let total = 0;
  for (const [k, p, q] of pairs) {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    total += Math.max(0, Math.floor((len * (1 - 2 * END_TRIM)) / SAMPLE_STEP_PX) + 1);
    const s = lineSamples(e, p, q);
    inside += s.n;
    lines[k] = s.n >= MIN_SAMPLES_PER_LINE ? s.hits / s.n : null;
  }
  const { peak: interior, base: texture } = interiorPeak(e, quad);
  const vals = Object.values(lines).filter((v): v is number => v !== null);
  const score = vals.length >= 3 ? vals.reduce((a, b) => a + b, 0) / 4 - INTERIOR_PENALTY * Math.max(0, interior - INTERIOR_FREE) : null;
  return { score, lines, interior, texture, insideShare: total > 0 ? inside / total : 0 };
}

/** Cells the wall's region is cut into for its edge energy, pixels. */
const ENERGY_CELL_PX = 16;

/**
 * The wall region's edge energy: the median, over ENERGY_CELL_PX cells of the quad's bounding box (clipped to the
 * photo), of each cell's mean gradient. A median, not a mean: a blurred house next to a sharp shrub or tree still reads
 * as blurred. 0 when the region is outside the photo.
 */
function regionEnergy(e: Edges, quad: Quad): number {
  const x0 = Math.max(1, Math.floor(Math.min(...quad.map((p) => p[0]))));
  const x1 = Math.min(e.w - 2, Math.ceil(Math.max(...quad.map((p) => p[0]))));
  const y0 = Math.max(1, Math.floor(Math.min(...quad.map((p) => p[1]))));
  const y1 = Math.min(e.h - 2, Math.ceil(Math.max(...quad.map((p) => p[1]))));
  if (x1 - x0 < 2 || y1 - y0 < 2) return 0;
  const cells: number[] = [];
  for (let cy = y0; cy < y1; cy += ENERGY_CELL_PX) {
    for (let cx = x0; cx < x1; cx += ENERGY_CELL_PX) {
      let sum = 0;
      let n = 0;
      for (let y = cy; y < Math.min(y1, cy + ENERGY_CELL_PX); y++) for (let x = cx; x < Math.min(x1, cx + ENERGY_CELL_PX); x++) {
        sum += e.mag[y * e.w + x]!;
        n++;
      }
      if (n > 0) cells.push(sum / n);
    }
  }
  cells.sort((a, b) => a - b);
  return cells[Math.floor(cells.length / 2)] ?? 0;
}

/** Edge directions the chamfer maps are kept for: 12 bins of 15 degrees (a gradient's direction, either way round). */
const DIR_BINS = 12;
const DIR_BIN_DEG = 180 / DIR_BINS;
/** A thinned edge pixel seeds a direction's map when its gradient is within this of the direction (with the bin's own half width, about the 35 degrees of the strict check). */
const DIR_TOLERANCE_DEG = 30;

/** Per photo: its thinned strong edges and, per direction bin, the distance (px) to the nearest such edge (built when asked). */
const chamferCache = new WeakMap<Edges, { thin: Uint8Array; theta: Float32Array; maps: (Float32Array | undefined)[] }>();

/** The strong edges thinned to their ridge (non-maximum suppression along the gradient), and each pixel's gradient direction, 0..180. */
function thinEdges(e: Edges): { thin: Uint8Array; theta: Float32Array } {
  const { w, h, gx, gy, mag } = e;
  const thin = new Uint8Array(w * h);
  const theta = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i]!;
      if (m < e.strong) continue;
      let t = (Math.atan2(gy[i]!, gx[i]!) * 180) / Math.PI;
      if (t < 0) t += 180;
      if (t >= 180) t -= 180;
      theta[i] = t;
      // The neighbours along the gradient (quantised to 0, 45, 90, 135 degrees)
      const q = Math.round(t / 45) % 4;
      const o = q === 0 ? 1 : q === 1 ? w + 1 : q === 2 ? w : w - 1;
      if (m >= mag[i - o]! && m > mag[i + o]!) thin[i] = 1;
    }
  }
  return { thin, theta };
}

/** Exact Euclidean distance transform (Felzenszwalb and Huttenlocher), in place on squared distances, one row or column. */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let sx = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (sx <= z[k]!) {
      k--;
      sx = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = sx;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    d[q] = (q - v[k]!) * (q - v[k]!) + f[v[k]!]!;
  }
}

/** The distance (px) from each pixel to the nearest thinned edge running in direction bin `b`. */
function directionMap(e: Edges, b: number): Float32Array {
  let c = chamferCache.get(e);
  if (c === undefined) {
    c = { ...thinEdges(e), maps: [] };
    chamferCache.set(e, c);
  }
  const have = c.maps[b];
  if (have !== undefined) return have;
  const { w, h } = e;
  const BIG = 1e10;
  const centre = b * DIR_BIN_DEG;
  const sq = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let diff = 0;
    if (c.thin[i] === 1) {
      diff = Math.abs(c.theta[i]! - centre);
      if (diff > 90) diff = 180 - diff;
    }
    sq[i] = c.thin[i] === 1 && diff <= DIR_TOLERANCE_DEG ? 0 : BIG;
  }
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = sq[y * w + x]!;
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) sq[y * w + x] = d[y]!;
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = sq[y * w + x]!;
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]!);
  }
  c.maps[b] = out;
  return out;
}

/** A line's chamfer support: the mean over its samples of 1 - distance / radius to the nearest edge running its way (0 beyond the radius). */
function chamferLine(e: Edges, p: Vec, q: Vec, radiusPx: number): { sum: number; n: number; total: number } {
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  if (len < 1) return { sum: 0, n: 0, total: 0 };
  const ux = (q[0] - p[0]) / len;
  const uy = (q[1] - p[1]) / len;
  // The gradient on the line's edge runs along its normal (-uy, ux), either way round.
  let t = (Math.atan2(ux, -uy) * 180) / Math.PI;
  t = ((t % 180) + 180) % 180;
  const map = directionMap(e, Math.round(t / DIR_BIN_DEG) % DIR_BINS);
  let sum = 0;
  let n = 0;
  let total = 0;
  for (let s = len * END_TRIM; s <= len * (1 - END_TRIM); s += SAMPLE_STEP_PX) {
    total++;
    const x = Math.round(p[0] + ux * s);
    const y = Math.round(p[1] + uy * s);
    if (x < 1 || y < 1 || x >= e.w - 1 || y >= e.h - 1) continue;
    n++;
    const dist = map[y * e.w + x]!;
    if (dist < radiusPx) sum += 1 - dist / radiusPx;
  }
  return { sum, n, total };
}

/** A drawn wall's chamfer score: the mean of its four lines' supports (null with fewer than three lines in the photo, or too little of it inside). */
function chamferScore(e: Edges, quad: Quad, radiusPx: number): number | null {
  const [bl, br, tr, tl] = quad;
  let total = 0;
  let inside = 0;
  let sum = 0;
  let lines = 0;
  for (const [p, q] of [[bl, tl], [br, tr], [tl, tr], [bl, br]] as [Vec, Vec][]) {
    const c = chamferLine(e, p, q, radiusPx);
    total += c.total;
    inside += c.n;
    if (c.n >= MIN_SAMPLES_PER_LINE) {
      sum += c.sum / c.n;
      lines++;
    }
  }
  if (lines < 3 || total === 0 || inside / total < MIN_INSIDE_SHARE) return null;
  return sum / 4;
}

/** A camera pose tried: heading, pitch and roll corrections (degrees) and the eave height factor. */
export type Pose = { dh: number; dp: number; dr: number; f: number };

/** The camera at a pose (corrections added to the photo's own heading, pitch and roll). */
export function posedCamera(cam: Camera, p: Pose): Camera {
  return { ...cam, heading: cam.heading + p.dh, pitch: cam.pitch + p.dp, roll: (cam.roll ?? 0) + p.dr };
}

const POSE_LIMITS: Record<keyof Pose, [number, number]> = {
  dh: [-HEADING_SEARCH_DEG, HEADING_SEARCH_DEG],
  dp: [-PITCH_SEARCH_DEG, PITCH_SEARCH_DEG],
  dr: [-ROLL_SEARCH_DEG, ROLL_SEARCH_DEG],
  f: [1 - HEIGHT_SEARCH, 1 + HEIGHT_SEARCH],
};

/**
 * The best distinct poses for a wall on a photo: a coarse grid over heading, pitch, roll and eave height scored by
 * chamfer, its local peaks (no grid neighbour higher), the PEAKS best of them each refined by a pattern search (each
 * coordinate stepped both ways while it improves, then the step halved and the chamfer radius tightened).
 */
function searchPoses(e: Edges, cam: Camera, wall: Wall, eaveM: number): Pose[] {
  const range = (lim: number, step: number) => Array.from({ length: Math.round((2 * lim) / step) + 1 }, (_, i) => -lim + i * step);
  const dhs = range(HEADING_SEARCH_DEG, COARSE_ANGLE_STEP);
  const dps = range(PITCH_SEARCH_DEG, COARSE_ANGLE_STEP);
  const drs = range(ROLL_SEARCH_DEG, COARSE_ANGLE_STEP);
  const fs = range(HEIGHT_SEARCH, COARSE_HEIGHT_STEP).map((v) => 1 + v);
  const dims = [dhs.length, dps.length, drs.length, fs.length] as const;
  const at = (a: number, b: number, c: number, d: number) => ((a * dims[1] + b) * dims[2] + c) * dims[3] + d;
  const grid = new Float64Array(dims[0] * dims[1] * dims[2] * dims[3]).fill(-Infinity);
  const scoreAt = (p: Pose, radiusPx: number): number => {
    const quad = wallQuad(posedCamera(cam, p), wall, eaveM * p.f);
    if (quad === null) return -Infinity;
    return chamferScore(e, quad, radiusPx) ?? -Infinity;
  };
  for (let a = 0; a < dims[0]; a++) for (let b = 0; b < dims[1]; b++) for (let c = 0; c < dims[2]; c++) for (let d = 0; d < dims[3]; d++) {
    grid[at(a, b, c, d)] = scoreAt({ dh: dhs[a]!, dp: dps[b]!, dr: drs[c]!, f: fs[d]! }, COARSE_RADIUS_PX);
  }
  const peaks: { score: number; pose: Pose }[] = [];
  for (let a = 0; a < dims[0]; a++) for (let b = 0; b < dims[1]; b++) for (let c = 0; c < dims[2]; c++) for (let d = 0; d < dims[3]; d++) {
    const v = grid[at(a, b, c, d)]!;
    if (!(v > 0)) continue;
    let peak = true;
    for (let i = -1; i <= 1 && peak; i++) for (let j = -1; j <= 1 && peak; j++) for (let k = -1; k <= 1 && peak; k++) for (let l = -1; l <= 1 && peak; l++) {
      if (i === 0 && j === 0 && k === 0 && l === 0) continue;
      const A = a + i, B = b + j, C = c + k, D = d + l;
      if (A < 0 || B < 0 || C < 0 || D < 0 || A >= dims[0] || B >= dims[1] || C >= dims[2] || D >= dims[3]) continue;
      const u = grid[at(A, B, C, D)]!;
      // Plateaus: the first in index order is the peak.
      if (u > v || (u === v && at(A, B, C, D) < at(a, b, c, d))) peak = false;
    }
    if (peak) peaks.push({ score: v, pose: { dh: dhs[a]!, dp: dps[b]!, dr: drs[c]!, f: fs[d]! } });
  }
  peaks.sort((x, y) => y.score - x.score);
  // The moves of the pattern search: each coordinate alone, and each pair together (pitch, roll, heading and the eave
  // height are coupled: the score's ridges run diagonally, where single-coordinate steps stall).
  const keys = ['dh', 'dp', 'dr', 'f'] as const;
  const moves: number[][] = [];
  for (let i = 0; i < 4; i++) for (const a of [1, -1]) moves.push(keys.map((_, k) => (k === i ? a : 0)));
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) for (const a of [1, -1]) for (const b of [1, -1]) moves.push(keys.map((_, k) => (k === i ? a : k === j ? b : 0)));
  const clamp = (k: keyof Pose, v: number) => Math.min(POSE_LIMITS[k][1], Math.max(POSE_LIMITS[k][0], v));
  return peaks.slice(0, PEAKS).map(({ pose }) => {
    let p = { ...pose };
    for (const { radiusPx, step } of REFINE_STAGES) {
      let best = scoreAt(p, radiusPx);
      for (let round = 0; round < REFINE_ROUNDS; round++) {
        let next: { p: Pose; s: number } | null = null;
        for (const m of moves) {
          const q: Pose = { dh: clamp('dh', p.dh + m[0]! * step), dp: clamp('dp', p.dp + m[1]! * step), dr: clamp('dr', p.dr + m[2]! * step), f: clamp('f', p.f + m[3]! * step * ANGLE_TO_HEIGHT) };
          const sc = scoreAt(q, radiusPx);
          if (sc > (next?.s ?? best) + 1e-9) next = { p: q, s: sc };
        }
        if (next === null) break;
        p = next.p;
        best = next.s;
      }
    }
    return p;
  });
}

/**
 * How far apart two drawn walls are on the photo, pixels: `sideways`, the larger of its vertical corners' moves (at
 * their middles); `upDown`, its ground line's move up or down (at its middle). The eave alone moving counts in neither.
 */
function poseShiftPx(a: Quad, b: Quad): { sideways: number; upDown: number } {
  const midX = (q: Quad, i: 0 | 1) => (q[i][0] + q[3 - i]![0]) / 2;
  const groundY = (q: Quad) => (q[0][1] + q[1][1]) / 2;
  return { sideways: Math.max(Math.abs(midX(a, 0) - midX(b, 0)), Math.abs(midX(a, 1) - midX(b, 1))), upDown: Math.abs(groundY(a) - groundY(b)) };
}

/** Why a line-up is not 'good' (each a check it failed), for the logs and tests. */
export type LineUpCheck =
  | 'outside' // too little of the drawn wall is in the photo
  | 'blurred' // the wall's region has almost no edges (blurred or blank)
  | 'weak' // the drawn wall's lines sit on few edges overall ('off')
  | 'score' // the mean support is under FIT_GOOD_SCORE
  | 'left-corner'
  | 'right-corner'
  | 'eave'
  | 'ground'
  | 'eave-lookalike' // a line inside the wall is about as strong as the eave (garage-door panels, window heads)
  | 'eave-short' // the eave line is on an edge along only part of the wall
  | 'width' // the corners on the photo are not where the outline's wall length puts them
  | 'wider-line' // the eave line runs on well past both corners: the drawn wall is part of something wider
  | 'ambiguous' // a clearly different line-up fits nearly as well
  | 'height' // the eave height read from the photo disagrees with Google's heights
  | 'limit'; // the best heading, pitch or roll is at the edge of the search

export type LineUp = {
  fit: 'good' | 'off' | 'unknown';
  fitScore: number | null;
  headingCorrectionDeg: number;
  /** The pitch and roll corrections found, degrees (0 unless the fit is good). */
  pitchCorrectionDeg: number;
  rollCorrectionDeg: number;
  /** The best-fitting eave height, metres (null unless the fit is good). */
  eaveM: number | null;
  /** The drawn wall at the fit used (the corrected one when good), pixels. */
  quad: Quad | null;
  /** The drawn wall before any correction, pixels. */
  quadBefore: Quad | null;
  /** The wall region's edge energy against the photo's (low: blurred). */
  energyRatio: number | null;
  blurred: boolean;
  /** The checks the best line-up failed (empty when good). */
  failed: LineUpCheck[];
  /** The best line-up's support on each line, and the strongest interior horizontal (null: no line-up found). */
  lines: LineSupport | null;
  interior: number | null;
  /** The best pose the search found, whatever the fit (for the logs and checks; null: none found). */
  bestPose: Pose | null;
};

/**
 * How far the photo's vertical edge nearest each drawn corner is from it, as a share of the drawn wall's width, and how
 * well it is supported: the column (between eave and ground) with the most edge support within WIDTH_SEARCH of the corner.
 */
function cornerShift(e: Edges, quad: Quad, side: 'left' | 'right'): { shift: number; support: number } {
  const [bl, br, tr, tl] = quad;
  const [p, q] = side === 'left' ? [bl, tl] : [br, tr];
  const width = Math.hypot(br[0] - bl[0], br[1] - bl[1]);
  const ux = (br[0] - bl[0]) / (width || 1);
  const uy = (br[1] - bl[1]) / (width || 1);
  let best = { shift: 0, support: -1 };
  const steps = Math.ceil((WIDTH_SEARCH * width) / 2);
  for (let k = -steps; k <= steps; k++) {
    const d = k * 2;
    const s = lineShare(e, [p[0] + ux * d, p[1] + uy * d], [q[0] + ux * d, q[1] + uy * d]) ?? 0;
    // Ties go to the drawn place.
    if (s > best.support + 1e-9 || (Math.abs(s - best.support) < 1e-9 && Math.abs(d) < Math.abs(best.shift * width))) best = { shift: d / (width || 1), support: s };
  }
  return best;
}

/** The share of the eave line's samples on an edge in each third of it (the eave must run along the whole wall). */
function eaveThirds(e: Edges, quad: Quad): number[] {
  const [, , tr, tl] = quad;
  return [0, 1, 2].map((k) => lineShare(e, lerp(tl, tr, k / 3), lerp(tl, tr, (k + 1) / 3), 0) ?? 0);
}

/** The eave line's support past each corner (EXTEND of the wall's width beyond it, at the same height). */
function eaveBeyond(e: Edges, quad: Quad): { left: number; right: number } {
  const [, , tr, tl] = quad;
  const dx = tr[0] - tl[0];
  const dy = tr[1] - tl[1];
  const gap = 0.04;
  return {
    left: lineShare(e, [tl[0] - dx * (EXTEND + gap), tl[1] - dy * (EXTEND + gap)], [tl[0] - dx * gap, tl[1] - dy * gap], 0) ?? 0,
    right: lineShare(e, [tr[0] + dx * gap, tr[1] + dy * gap], [tr[0] + dx * (EXTEND + gap), tr[1] + dy * (EXTEND + gap)], 0) ?? 0,
  };
}

/**
 * The line-up of `wall` (eave at `eaveM`) on a photo taken by `cam`: the best camera pose (heading ±6 degrees, pitch
 * ±6, roll ±2) and eave height (±25%), its score, and 'good' / 'off' / 'unknown'. Strict: 'good' only when every
 * check passes on the best line-up: both vertical corners, the eave and the ground line each on edges; no line inside
 * the wall as strong as the eave; the eave on an edge along its whole length and not running on past both corners; the
 * photo's corners where the outline's wall length puts them; no clearly different pose nearly as good; and (with
 * Google's heights) the eave height within EAVE_TOLERANCE of them. 'off' when the drawn wall sits on few edges at all
 * or on neither vertical corner; 'unknown' otherwise (can't confirm), when the wall is mostly out of the photo, or
 * blurred / blank.
 */
export function lineUp(edges: Edges, cam: Camera, wall: Wall, eaveM: number, opts: { heightKnown?: boolean } = {}): LineUp {
  const before = wallQuad(cam, wall, eaveM);
  const none: LineUp = {
    fit: 'unknown',
    fitScore: null,
    headingCorrectionDeg: 0,
    pitchCorrectionDeg: 0,
    rollCorrectionDeg: 0,
    eaveM: null,
    quad: before,
    quadBefore: before,
    energyRatio: null,
    blurred: false,
    failed: ['outside'],
    lines: null,
    interior: null,
    bestPose: null,
  };
  if (before === null) return none;
  const energy = regionEnergy(edges, before);
  const energyRatio = edges.meanMag > 0 ? energy / edges.meanMag : 0;
  const blurred = energy < MIN_REGION_ENERGY || energyRatio < BLUR_ENERGY_RATIO;
  if (blurred) return { ...none, energyRatio: round3(energyRatio), blurred: true, failed: ['blurred'] };

  type Fit = { rank: number; score: number; pose: Pose; quad: Quad; lines: LineSupport; interior: number; texture: number };
  const fits: Fit[] = [];
  for (const pose of searchPoses(edges, cam, wall, eaveM)) {
    const quad = wallQuad(posedCamera(cam, pose), wall, eaveM * pose.f);
    if (quad === null) continue;
    const { score, lines, interior, texture, insideShare } = quadScore(edges, quad);
    if (score === null || insideShare < MIN_INSIDE_SHARE) continue;
    // Ranked on the four lines alone (the interior lines are a check, not something to steer by: with roll and pitch
    // free, tilting the drawn wall off a garage door's panel lines would otherwise pay); ties go to the smaller correction.
    const lineMean = score + INTERIOR_PENALTY * Math.max(0, interior - INTERIOR_FREE);
    const rank = lineMean - 0.004 * (Math.abs(pose.dh) + Math.abs(pose.dp) + 2 * Math.abs(pose.dr)) - 0.05 * Math.abs(pose.f - 1);
    fits.push({ rank, score, pose, quad, lines, interior, texture });
  }
  if (fits.length === 0) return { ...none, energyRatio: round3(energyRatio) };
  const best = fits.reduce((a, b) => (b.rank > a.rank ? b : a));

  const failed: LineUpCheck[] = [];
  const { lines, interior, quad, pose } = best;
  if (best.score < FIT_OFF_SCORE) failed.push('weak');
  else if (best.score < FIT_GOOD_SCORE) failed.push('score');
  if ((lines.left ?? 0) < CORNER_MIN) failed.push('left-corner');
  if ((lines.right ?? 0) < CORNER_MIN) failed.push('right-corner');
  if ((lines.eave ?? 0) < EAVE_MIN) failed.push('eave');
  if ((lines.ground ?? 0) < GROUND_MIN) failed.push('ground');
  // A line inside the wall about as strong as the eave could be taken for it; with Google's heights agreeing with the
  // eave's height it only has to stand clearly below the eave (EAVE_MARGIN_AGREED).
  const heightAgrees = opts.heightKnown === true && Math.abs(pose.f - 1) <= EAVE_TOLERANCE + 1e-9;
  if (interior > Math.max(INTERIOR_FREE, (lines.eave ?? 0) - best.texture - (heightAgrees ? EAVE_MARGIN_AGREED : EAVE_MARGIN))) failed.push('eave-lookalike');
  if (Math.min(...eaveThirds(edges, quad)) < EAVE_THIRD_MIN) failed.push('eave-short');
  const left = cornerShift(edges, quad, 'left');
  const right = cornerShift(edges, quad, 'right');
  // Each corner where it is drawn, and the wall as wide on the photo as the outline's wall (shifts are shares of the width)
  if (Math.abs(left.shift) > WIDTH_TOLERANCE || Math.abs(right.shift) > WIDTH_TOLERANCE || Math.abs(right.shift - left.shift) > WIDTH_TOLERANCE) failed.push('width');
  const beyond = eaveBeyond(edges, quad);
  if (Math.min(beyond.left, beyond.right) >= BEYOND_MAX) failed.push('wider-line');
  // Uniqueness: the best line-up must beat the best one at a clearly different pose (see RIVAL_*).
  const rivalPx = (cam.widthPx / 2 / Math.tan((cam.fov * Math.PI) / 360)) * Math.tan((RIVAL_DEG * Math.PI) / 180);
  const rival = fits
    .filter((f) => {
      if (f === best) return false;
      const shift = poseShiftPx(f.quad, quad);
      if (shift.sideways >= rivalPx) return true;
      // Slid up or down along its own corners: the corners cannot tell the two apart, the ground line must.
      return shift.upDown >= rivalPx && (f.lines.ground ?? 0) > (lines.ground ?? 0) - RIVAL_GROUND_MARGIN;
    })
    .reduce((m, f) => Math.max(m, f.score), -Infinity);
  if (rival > best.score - RIVAL_MARGIN) failed.push('ambiguous');
  if (opts.heightKnown === true && Math.abs(pose.f - 1) > EAVE_TOLERANCE + 1e-9) failed.push('height');
  // At the edge of the search the best pose may lie beyond it: what was found is a compromise, not a line-up.
  if ((['dh', 'dp', 'dr'] as const).some((k) => Math.abs(pose[k]) >= POSE_LIMITS[k][1] - LIMIT_MARGIN_DEG)) failed.push('limit');

  const good = failed.length === 0;
  // 'off': plainly not on the house (few edges at all, or neither vertical corner on one); else 'unknown': can't confirm.
  const off = failed.includes('weak') || (failed.includes('left-corner') && failed.includes('right-corner'));
  const round2 = (v: number | null) => (v === null ? null : round3(v));
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    fit: good ? 'good' : off ? 'off' : 'unknown',
    fitScore: round3(best.score),
    headingCorrectionDeg: good ? r2(pose.dh) : 0,
    pitchCorrectionDeg: good ? r2(pose.dp) : 0,
    rollCorrectionDeg: good ? r2(pose.dr) : 0,
    eaveM: good ? eaveM * pose.f : null,
    quad: good ? best.quad : before,
    quadBefore: before,
    energyRatio: round3(energyRatio),
    blurred: false,
    failed,
    lines: { left: round2(lines.left), right: round2(lines.right), eave: round2(lines.eave), ground: round2(lines.ground) },
    interior: round3(interior),
    bestPose: pose,
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
