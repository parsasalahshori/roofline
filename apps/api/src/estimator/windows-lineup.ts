import jpeg from 'jpeg-js';
import { type Camera, frontWalls, project, type Vec, type Wall } from './windows-geometry.ts';

/*
 * Does the outline's front wall line up with the house in the street photo? No AI: classic image edges. The front
 * wall (its two ground corners and two eave corners, from the outline and the wall height) is drawn into the photo with
 * the pinhole camera; points along its two vertical corners, its eave line and its ground line are checked against the
 * photo's Sobel edges (a strong edge, running the same way, within a few pixels), and lines inside the wall that could
 * pass for an eave (garage-door panels, window heads) count against it. A small search over the camera heading (Street
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
 * - RIVAL_*: the best line-up must beat every one RIVAL_HEADING_DEG or more of heading away (the wall elsewhere along
 *   the street) by RIVAL_MARGIN: edges that fit two places fit neither for sure. (Up and down, the eave's own check
 *   and the interior lines do this job.)
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
const RIVAL_HEADING_DEG = 2;
const RIVAL_MARGIN = 0.1;
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
  | 'height'; // the eave height read from the photo disagrees with Google's heights

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
  /** The checks the best line-up failed (empty when good). */
  failed: LineUpCheck[];
  /** The best line-up's support on each line, and the strongest interior horizontal (null: no line-up found). */
  lines: LineSupport | null;
  interior: number | null;
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
 * The line-up of `wall` (eave at `eaveM`) on a photo taken by `cam`: the best heading correction (±6 degrees) and
 * eave height (±25%), its score, and 'good' / 'off' / 'unknown'. Strict: 'good' only when every check passes on the
 * best line-up: both vertical corners, the eave and the ground line each on edges; no line inside the wall as strong
 * as the eave; the eave on an edge along its whole length and not running on past both corners; the photo's corners
 * where the outline's wall length puts them; and (with Google's heights) the eave height within EAVE_TOLERANCE of
 * them. 'off' when the drawn wall sits on few edges at all or on neither vertical corner; 'unknown' otherwise (can't confirm), when the wall is
 * mostly out of the photo, or blurred / blank.
 */
export function lineUp(edges: Edges, cam: Camera, wall: Wall, eaveM: number, opts: { heightKnown?: boolean } = {}): LineUp {
  const before = wallQuad(cam, wall, eaveM);
  const none: LineUp = { fit: 'unknown', fitScore: null, headingCorrectionDeg: 0, eaveM: null, quad: before, quadBefore: before, energyRatio: null, blurred: false, failed: ['outside'], lines: null, interior: null };
  if (before === null) return none;
  const energy = regionEnergy(edges, before);
  const energyRatio = edges.meanMag > 0 ? energy / edges.meanMag : 0;
  const blurred = energy < MIN_REGION_ENERGY || energyRatio < BLUR_ENERGY_RATIO;
  if (blurred) return { ...none, energyRatio: round3(energyRatio), blurred: true, failed: ['blurred'] };
  let best: { rank: number; score: number; dh: number; f: number; quad: Quad; lines: LineSupport; interior: number; texture: number } | null = null;
  const tried: { score: number; dh: number; f: number }[] = [];
  for (let dh = -HEADING_SEARCH_DEG; dh <= HEADING_SEARCH_DEG + 1e-9; dh += HEADING_STEP_DEG) {
    for (let f = 1 - HEIGHT_SEARCH; f <= 1 + HEIGHT_SEARCH + 1e-9; f += HEIGHT_STEP) {
      const quad = wallQuad({ ...cam, heading: cam.heading + dh }, wall, eaveM * f);
      if (quad === null) continue;
      const { score, lines, interior, texture, insideShare } = quadScore(edges, quad);
      if (score === null || insideShare < MIN_INSIDE_SHARE) continue;
      // Ties go to the smaller correction.
      const rank = score - 0.004 * Math.abs(dh) - 0.05 * Math.abs(f - 1);
      tried.push({ score, dh, f });
      if (best === null || rank > best.rank) best = { rank, score, dh, f, quad, lines, interior, texture };
    }
  }
  if (best === null) return { ...none, energyRatio: round3(energyRatio) };

  const failed: LineUpCheck[] = [];
  const { lines, interior, quad } = best;
  if (best.score < FIT_OFF_SCORE) failed.push('weak');
  else if (best.score < FIT_GOOD_SCORE) failed.push('score');
  if ((lines.left ?? 0) < CORNER_MIN) failed.push('left-corner');
  if ((lines.right ?? 0) < CORNER_MIN) failed.push('right-corner');
  if ((lines.eave ?? 0) < EAVE_MIN) failed.push('eave');
  if ((lines.ground ?? 0) < GROUND_MIN) failed.push('ground');
  // A line inside the wall about as strong as the eave could be taken for it; with Google's heights agreeing with the
  // eave's height it only has to stand clearly below the eave (EAVE_MARGIN_AGREED).
  const heightAgrees = opts.heightKnown === true && Math.abs(best.f - 1) <= EAVE_TOLERANCE + 1e-9;
  if (interior > Math.max(INTERIOR_FREE, (lines.eave ?? 0) - best.texture - (heightAgrees ? EAVE_MARGIN_AGREED : EAVE_MARGIN))) failed.push('eave-lookalike');
  if (Math.min(...eaveThirds(edges, quad)) < EAVE_THIRD_MIN) failed.push('eave-short');
  const left = cornerShift(edges, quad, 'left');
  const right = cornerShift(edges, quad, 'right');
  // Each corner where it is drawn, and the wall as wide on the photo as the outline's wall (shifts are shares of the width)
  if (Math.abs(left.shift) > WIDTH_TOLERANCE || Math.abs(right.shift) > WIDTH_TOLERANCE || Math.abs(right.shift - left.shift) > WIDTH_TOLERANCE) failed.push('width');
  const beyond = eaveBeyond(edges, quad);
  if (Math.min(beyond.left, beyond.right) >= BEYOND_MAX) failed.push('wider-line');
  // The best line-up must stand out: another clearly different one (the wall moved sideways or up and down) nearly as
  // good means the edges fit more than one place, so neither can be trusted.
  const b = best;
  const rival = tried.filter((t) => Math.abs(t.dh - b.dh) >= RIVAL_HEADING_DEG).reduce((m, t) => Math.max(m, t.score), -Infinity);
  if (rival > best.score - RIVAL_MARGIN) failed.push('ambiguous');
  if (opts.heightKnown === true && Math.abs(best.f - 1) > EAVE_TOLERANCE + 1e-9) failed.push('height');

  const good = failed.length === 0;
  // 'off': plainly not on the house (few edges at all, or neither vertical corner on one); else 'unknown': can't confirm.
  const off = failed.includes('weak') || (failed.includes('left-corner') && failed.includes('right-corner'));
  const round2 = (v: number | null) => (v === null ? null : round3(v));
  return {
    fit: good ? 'good' : off ? 'off' : 'unknown',
    fitScore: round3(best.score),
    headingCorrectionDeg: good ? Math.round(best.dh * 10) / 10 : 0,
    eaveM: good ? eaveM * best.f : null,
    quad: good ? best.quad : before,
    quadBefore: before,
    energyRatio: round3(energyRatio),
    blurred: false,
    failed,
    lines: { left: round2(lines.left), right: round2(lines.right), eave: round2(lines.eave), ground: round2(lines.ground) },
    interior: round3(interior),
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
