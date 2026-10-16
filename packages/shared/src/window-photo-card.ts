// Sizing a window from a photo with an ordinary credit card on the glass ("card method"): plane geometry only.
// The person photographs the window with an ID-1 card (ISO/IEC 7810, 85.60 x 53.98 mm: credit, debit and driver licence
// cards are all this size) held or taped flat on the glass, then taps the card's four corners and the window frame's four
// corners.
//
// Two stages, because the card is tiny next to the window (a window 10 to 30 times the card's size, a card 100 to 200
// pixels wide in the photo):
//  1. The plane's TILT comes from the window's own four corners (a rectangle seen in perspective, Zhang and He, the maths
//     of rectangleAspect). The card cannot give it: an exact homography from four taps on a card 150 px wide has a
//     perspective term that is mostly tap noise, and that noise grows with the distance from the card, so the window comes
//     out tens of percent off (docs/windows/card-method.md has the numbers).
//  2. The card gives the SCALE: its four taps are put on that plane (each ray meets it), and the best-fit rectangle of the
//     card's real size gives the distance to the glass. The window's corners are then put on the plane the frame sits on
//     (the offset in front of the glass, exactly for oblique views) and the size is read off it: width = the mean of the
//     top and bottom edges, height = the mean of the left and right edges (the measuring-sheet method's convention).
//
// The size is quote-grade: the card's tap noise is a share of a percent to a couple of percent of the window's size, and
// the uncertainty (first-order propagation, window-photo-sheet.ts style) says so. See docs/windows/card-method.md.
import type { Pt, Quad } from './window-photo-math.ts';
import { SHEET_FOCAL_SIGMA, STEEP_CHECK_DEG, ULTRA_WIDE_FOCAL_35MM } from './window-photo-sheet.ts';

/** An ID-1 card (ISO/IEC 7810), millimetres: a credit, debit or driver licence card. Landscape: widthMm is the long side. */
export const ID1_CARD_MM = { widthMm: 85.6, heightMm: 53.98 } as const;
/** The radius of an ID-1 card's rounded corners, millimetres (ISO/IEC 7810: 3.18 mm). */
export const ID1_CORNER_RADIUS_MM = 3.18;
/**
 * The tip of a rounded corner sits (1 - 1/sqrt(2)) * radius = 0.93 mm inside the card's true (sharp) corner, along both
 * edges. A person taps the visible tip, so the four taps make a rectangle this much smaller on every side.
 */
export const ID1_TIP_INSET_MM = (1 - Math.SQRT1_2) * ID1_CORNER_RADIUS_MM;
/** The rectangle the four taps make, millimetres: the card inset by the corner rounding, 83.74 x 52.12 mm. The metric rectangle the math uses. */
export const ID1_TAP_RECT_MM = { widthMm: ID1_CARD_MM.widthMm - 2 * ID1_TIP_INSET_MM, heightMm: ID1_CARD_MM.heightMm - 2 * ID1_TIP_INSET_MM } as const;
/** One-sigma doubt in each side of the tapped rectangle, millimetres: where on the rounded corner the person really tapped. */
export const CARD_RECT_SIGMA_MM = 0.5;

/** Quality is 'check' when the predicted uncertainty (the larger of width and height) is strictly above this: 3/8 inch. */
export const CARD_CHECK_UNCERTAINTY_IN = 3 / 8;
/** The frame's inner edge sits about this far in front of the glass the card is on, inches (the person does not enter it). */
export const CARD_DEFAULT_OFFSET_IN = 1;
/** One-sigma doubt in that offset, inches: frames stand proud of the glass by anything from nothing to two inches. */
export const CARD_OFFSET_SIGMA_IN = 0.5;
/** A floor for what the model leaves out (lens distortion, a card that is not quite flat, a window that is not quite square): 0.1% of the size. */
export const CARD_MODEL_FLOOR = 0.001;
/**
 * The propagated one-sigma error is multiplied by this so that about 68% of real errors fall inside it: fitted with the
 * Monte-Carlo study (scripts/window-card-accuracy.ts, docs/windows/card-method.md) on synthetic photos.
 */
export const CARD_SIGMA_SCALE = 1;
/** The card's longest side is under this share of the photo's long side (about 60 px on a 4032 px photo): 'check'. */
export const CARD_MIN_LONG_SIDE_FRAC = 0.015;
/** ... and under this share (about 30 px on a 4032 px photo) the card is refused: too small to tap. */
export const CARD_REFUSE_LONG_SIDE_FRAC = 0.0075;
/** The sizes accepted, inches (the sheet method's window range). */
export const CARD_MIN_WINDOW_IN = 3;
export const CARD_MAX_WINDOW_IN = 400;
/** Offsets accepted, inches (frame in front of + / behind - the glass). */
export const CARD_MAX_OFFSET_IN = 6;
/** The card size may differ from ID-1 by this much, millimetres, and still be the same card (a rounding). */
export const CARD_SIZE_TOLERANCE_MM = 0.05;
/** The tapped card, put on the plane, may differ from the real card's long-to-short ratio by this share before it is 'check' (not a card, or not on the glass). */
export const CARD_SHAPE_TOLERANCE = 0.3;
/** A window side shorter than this many pixels is too small to size from. */
const MIN_WINDOW_SIDE_PX = 20;
/** An interior angle closer than this to straight (or to folded flat), degrees, is not a corner. */
const MIN_CORNER_DEG = 10;
/** Above this angle off square (degrees) the reason says to stand square on, as well as to come closer. */
const STEEP_ADVICE_DEG = 35;
/** The step of the central differences, photo pixels. */
const TAP_STEP_PX = 0.5;

const MM_PER_IN = 25.4;
const RECT_W_IN = ID1_TAP_RECT_MM.widthMm / MM_PER_IN;
const RECT_H_IN = ID1_TAP_RECT_MM.heightMm / MM_PER_IN;
const CARD_LONG_IN = ID1_CARD_MM.widthMm / MM_PER_IN;
const SIN_MIN_CORNER = Math.sin((MIN_CORNER_DEG * Math.PI) / 180);

/** One-sigma noise of one tapped coordinate, photo pixels, when the caller does not say: 0.05% of the photo's long side, at least 1 px (2 px on 4032). */
export function defaultTapSigmaPx(widthPx: number, heightPx: number): number {
  return Math.max(1, 0.0005 * Math.max(widthPx, heightPx));
}

export type CardSizeInput = {
  /** The photo as displayed (EXIF orientation applied), pixels; the principal point is at its centre. */
  widthPx: number;
  heightPx: number;
  /** From the 35 mm-equivalent focal length (focalPxFrom35mm), DEFAULT_FOCAL_35MM (26) when the photo has none. */
  focalPx: number;
  /** One-sigma doubt in the focal length, a fraction: SHEET_FOCAL_SIGMA (3%) by default; pass SHEET_FOCAL_UNKNOWN_SIGMA when it was assumed. */
  focalSigmaFrac?: number;
  /**
   * The card's four corners in photo pixels, each tapped at the TIP of the rounded corner, in order around the card:
   * clockwise or counterclockwise, starting at any corner.
   */
  cardCorners: Quad;
  /** The window frame's corners: top-left, top-right, bottom-right, bottom-left, photo pixels. */
  windowCorners: Quad;
  /** How far the frame sits in front of (+) or behind (-) the glass the card is on, inches. Default CARD_DEFAULT_OFFSET_IN. */
  planeOffsetIn?: number;
  /** One-sigma noise of one tapped coordinate, photo pixels. Default defaultTapSigmaPx. */
  tapSigmaPx?: number;
};

export type CardSize = {
  widthIn: number;
  heightIn: number;
  /** About 1 sigma, calibrated (CARD_SIGMA_SCALE). */
  uncertaintyIn: { width: number; height: number };
  quality: 'good' | 'check';
  /** Why 'check', in plain words for a homeowner (empty when 'good'). */
  reasons: string[];
  /** Camera to the glass plane, inches. */
  distanceIn: number;
  /** How far off square the camera is at the window's middle, degrees. */
  viewAngleDeg: number;
  /** The window's longest side over the card's long side: the uncertainty grows with it. */
  sizeRatio: number;
};

// ---------------------------------------------------------------------------------------------------------------------
// Shapes of tapped quads

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cross2 = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const finite = (q: readonly Pt[]) => q.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
/** Shoelace area, squared units; positive when the corners run clockwise on screen (y down). */
const signedArea = (q: readonly Pt[]) => q.reduce((s, p, i) => s + p[0] * q[(i + 1) % q.length]![1] - q[(i + 1) % q.length]![0] * p[1], 0) / 2;

function segmentsCross(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d1 = cross2(p3, p4, p1);
  const d2 = cross2(p3, p4, p2);
  const d3 = cross2(p1, p2, p3);
  const d4 = cross2(p1, p2, p4);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

type Shape = 'ok' | 'crossing' | 'concave' | 'degenerate';

/**
 * What four corners in order make: 'crossing' (a bow tie), 'degenerate' (a corner that is straight or folded flat: three
 * in a line, or no area), 'concave' (a dart), else 'ok' (a convex four-cornered shape, either winding).
 */
function quadShape(q: readonly Pt[]): Shape {
  if (segmentsCross(q[0]!, q[1]!, q[2]!, q[3]!) || segmentsCross(q[1]!, q[2]!, q[3]!, q[0]!)) return 'crossing';
  let positive = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const c = q[(i + 2) % 4]!;
    const l1 = dist(a, b);
    const l2 = dist(b, c);
    if (!(l1 > 0) || !(l2 > 0)) return 'degenerate';
    const sin = cross2(a, b, c) / (l1 * l2);
    if (!(Math.abs(sin) >= SIN_MIN_CORNER)) return 'degenerate';
    if (sin > 0) positive++;
  }
  return positive === 4 || positive === 0 ? 'ok' : 'concave';
}

const sidesPx = (q: readonly Pt[]) => [dist(q[0]!, q[1]!), dist(q[1]!, q[2]!), dist(q[2]!, q[3]!), dist(q[3]!, q[0]!)];
const longSidePx = (q: readonly Pt[]) => Math.max(...sidesPx(q));
const inside = (q: readonly Pt[], w: number, h: number) => q.every((p) => p[0] >= -1 && p[0] <= w + 1 && p[1] >= -1 && p[1] <= h + 1);

// ---------------------------------------------------------------------------------------------------------------------
// The geometry (camera frame: x right, y down, z forward; a pixel p is the ray ((px - cx) / f, (py - cy) / f, 1))

type V3 = [number, number, number];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dist3 = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const rayOf = (p: Pt, f: number, cx: number, cy: number): V3 => [(p[0] - cx) / f, (p[1] - cy) / f, 1];

/**
 * The unit normal, pointing away from the camera, of the plane a rectangle lies in, from its four corner rays in order
 * (either winding): the rectangle's two edge directions in space (Zhang and He, "Whiteboard scanning", 2007), crossed.
 * Null for a degenerate quad.
 */
function rectangleNormal(m: readonly V3[]): V3 | null {
  const [m1, m2, m4, m3] = [m[0]!, m[1]!, m[2]!, m[3]!];
  const k2den = dot3(cross3(m2, m4), m3);
  const k3den = dot3(cross3(m3, m4), m2);
  if (!(Math.abs(k2den) > 1e-12) || !(Math.abs(k3den) > 1e-12)) return null;
  const k2 = dot3(cross3(m1, m4), m3) / k2den;
  const k3 = dot3(cross3(m1, m4), m2) / k3den;
  const u: V3 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const v: V3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  const n = cross3(u, v);
  const len = Math.hypot(...n);
  if (!(len > 0)) return null;
  const centre: V3 = [(m1[0] + m2[0] + m3[0] + m4[0]) / 4, (m1[1] + m2[1] + m3[1] + m4[1]) / 4, 1];
  return scale3(n, (dot3(n, centre) < 0 ? -1 : 1) / len);
}

/**
 * The card's corner rays put on the plane n . X = 1 and written in that plane's own axes (x along the camera's right,
 * y down, so a clockwise card on screen is clockwise here), the centroid at the origin. Null when a ray meets the plane
 * behind the camera.
 */
function onUnitPlane(rays: readonly V3[], n: V3): Pt[] | null {
  const pts: V3[] = [];
  for (const r of rays) {
    const d = dot3(r, n);
    if (!(d > 1e-9)) return null;
    pts.push(scale3(r, 1 / d));
  }
  const c: V3 = [0, 1, 2].map((k) => (pts[0]![k]! + pts[1]![k]! + pts[2]![k]! + pts[3]![k]!) / 4) as V3;
  const e1: V3 = [1 - n[0] * n[0], -n[0] * n[1], -n[0] * n[2]];
  const l1 = Math.hypot(...e1);
  if (!(l1 > 1e-9)) return null;
  const x = scale3(e1, 1 / l1);
  const y = cross3(n, x);
  return pts.map((p) => {
    const d = sub3(p, c);
    return [dot3(d, x), dot3(d, y)] as Pt;
  });
}

/** How the four taps are labelled: reversed to run clockwise, then started so that the first edge is the long one. */
type Labelling = { reverse: boolean; rotate: boolean };

function orderOf(y: readonly Pt[]): Labelling {
  const reverse = signedArea(y) < 0;
  const p = reverse ? [y[0]!, y[3]!, y[2]!, y[1]!] : [...y];
  const across = dist(p[0]!, p[1]!) + dist(p[3]!, p[2]!);
  const down = dist(p[0]!, p[3]!) + dist(p[1]!, p[2]!);
  return { reverse, rotate: across < down };
}

function labelled<T>(q: readonly T[], l: Labelling): T[] {
  const a = l.reverse ? [q[0]!, q[3]!, q[2]!, q[1]!] : [...q];
  return l.rotate ? [a[1]!, a[2]!, a[3]!, a[0]!] : a;
}

/**
 * The distance (along the normal) to a plane n . X = D on which the card's four taps, in the plane's units at D = 1 and
 * labelled long side first, best fit (least squares, a turn and a scale) a rectangle of rectWIn x rectHIn inches.
 */
function distanceFromCard(y: readonly Pt[], rectWIn: number, rectHIn: number): number {
  const t: Pt[] = [[-rectWIn / 2, -rectHIn / 2], [rectWIn / 2, -rectHIn / 2], [rectWIn / 2, rectHIn / 2], [-rectWIn / 2, rectHIn / 2]];
  // The complex number a with t_i ~ a * z_i: a = sum(conj(z_i) t_i) / sum(|z_i|^2); its length is the distance.
  let re = 0;
  let im = 0;
  let zz = 0;
  for (let i = 0; i < 4; i++) {
    const [zr, zi] = y[i]!;
    const [tr, ti] = t[i]!;
    re += zr * tr + zi * ti;
    im += zr * ti - zi * tr;
    zz += zr * zr + zi * zi;
  }
  return Math.hypot(re, im) / zz;
}

type Setup = { card: Quad; win: Quad; focalPx: number; offsetIn: number; rectWIn: number; rectHIn: number };
type Solved = { w: number; h: number; distanceIn: number; normal: V3; shapeRatio: number; winRays: V3[] };

/** The window's width and height on the frame's plane. `labelling` fixes how the taps are read (decided once, on the real taps). */
function solve(s: Setup, cx: number, cy: number, labelling?: Labelling): (Solved & { labelling: Labelling }) | null {
  const f = s.focalPx;
  const winRays = s.win.map((p) => rayOf(p, f, cx, cy));
  const n = rectangleNormal(winRays);
  if (n === null) return null;
  const y = onUnitPlane(s.card.map((p) => rayOf(p, f, cx, cy)), n);
  if (y === null) return null;
  const l = labelling ?? orderOf(y);
  const yl = labelled(y, l);
  const D = distanceFromCard(yl, s.rectWIn, s.rectHIn);
  const frame = D - s.offsetIn;
  if (!(D > 0) || !(frame > 0)) return null;
  const X: V3[] = [];
  for (const r of winRays) {
    const d = dot3(r, n);
    if (!(d > 1e-9)) return null;
    X.push(scale3(r, frame / d));
  }
  const w = (dist3(X[0]!, X[1]!) + dist3(X[3]!, X[2]!)) / 2;
  const h = (dist3(X[0]!, X[3]!) + dist3(X[1]!, X[2]!)) / 2;
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  const long = (dist(yl[0]!, yl[1]!) + dist(yl[3]!, yl[2]!)) / 2;
  const short = (dist(yl[0]!, yl[3]!) + dist(yl[1]!, yl[2]!)) / 2;
  return { w, h, distanceIn: D, normal: n, shapeRatio: long / short, winRays, labelling: l };
}

const clone = (q: Quad): Quad => q.map((p) => [p[0], p[1]] as Pt) as Quad;

/** Inches in words, rounded UP to an eighth (to a whole inch above 4): "1/2 inch", "1 1/4 inches", "6 inches". */
export function inchesInWords(inches: number): string {
  if (!(inches > 0)) return '0 inches';
  if (inches > 4) return `${Math.ceil(inches)} inches`;
  const eighths = Math.max(1, Math.ceil(inches * 8 - 1e-9));
  const whole = Math.floor(eighths / 8);
  let num = eighths % 8;
  let den = 8;
  while (num > 0 && num % 2 === 0) {
    num /= 2;
    den /= 2;
  }
  const frac = num === 0 ? '' : `${num}/${den}`;
  const text = [whole > 0 ? String(whole) : '', frac].filter((v) => v !== '').join(' ');
  return `${text} ${whole > 1 || (whole === 1 && frac !== '') ? 'inches' : 'inch'}`;
}

/**
 * A window's size from a photo with an ID-1 card on the glass: see the file header for the two stages. Sizes are not
 * rounded.
 *
 * Uncertainty (about 1 sigma, per dimension), added in quadrature and multiplied by CARD_SIGMA_SCALE: first-order
 * propagation by central differences of the 16 tapped coordinates (each tapSigmaPx), the focal length (everything is
 * refitted at f*(1+s) and f/(1+s)), the plane offset (CARD_OFFSET_SIGMA_IN), the tapped rectangle's two sides
 * (CARD_RECT_SIGMA_MM each) and a floor of CARD_MODEL_FLOOR of the size. The whole figure is CONDITIONAL on the tap noise:
 * 2 px on a 4032 px photo is a careful fingertip with the magnifier.
 *
 * 'check' when the larger uncertainty is above CARD_CHECK_UNCERTAINTY_IN, the view is steeper than STEEP_CHECK_DEG, the
 * card is small in the photo or does not have a card's shape on the plane, the lens is a wide one (under
 * ULTRA_WIDE_FOCAL_35MM, which bends straight lines), or the window's corners are not a usable view; each gets a reason
 * in plain words.
 *
 * Null when it cannot be sized at all: a non-finite number, a card or window quad that is not a convex four-cornered
 * shape (it crosses itself, has three corners in a line, or is a dart), rays that miss the plane in front of the camera,
 * or a size outside CARD_MIN_WINDOW_IN..CARD_MAX_WINDOW_IN. cardProblem says in words what a person can fix.
 */
export function sizeFromCard(input: CardSizeInput): CardSize | null {
  const { widthPx, heightPx, focalPx, cardCorners, windowCorners } = input;
  if (![widthPx, heightPx, focalPx].every((v) => Number.isFinite(v) && v > 0)) return null;
  const offsetIn = input.planeOffsetIn ?? CARD_DEFAULT_OFFSET_IN;
  if (!Number.isFinite(offsetIn) || Math.abs(offsetIn) > CARD_MAX_OFFSET_IN) return null;
  const tapSigma = input.tapSigmaPx ?? defaultTapSigmaPx(widthPx, heightPx);
  const focalSigma = input.focalSigmaFrac ?? SHEET_FOCAL_SIGMA;
  if (!Number.isFinite(tapSigma) || !(tapSigma >= 0) || !Number.isFinite(focalSigma) || !(focalSigma >= 0)) return null;
  if (cardCorners.length !== 4 || windowCorners.length !== 4 || !finite(cardCorners) || !finite(windowCorners)) return null;
  if (quadShape(cardCorners) !== 'ok') return null;
  // A rectangle seen from anywhere in front of it is a convex four-cornered shape: a bow tie, a dart or a line is a mistap.
  if (quadShape(windowCorners) !== 'ok') return null;

  const cx = widthPx / 2;
  const cy = heightPx / 2;
  const setup: Setup = { card: cardCorners, win: windowCorners, focalPx, offsetIn, rectWIn: RECT_W_IN, rectHIn: RECT_H_IN };
  const base = solve(setup, cx, cy);
  if (base === null) return null;
  if (base.w < CARD_MIN_WINDOW_IN || base.h < CARD_MIN_WINDOW_IN || base.w > CARD_MAX_WINDOW_IN || base.h > CARD_MAX_WINDOW_IN) return null;
  const labelling = base.labelling;

  // Uncertainty, first order: d(size)/d(each source) by central differences, then the root of the sum of squares.
  let varW = 0;
  let varH = 0;
  const add = (dw: number, dh: number) => {
    varW += dw * dw;
    varH += dh * dh;
  };
  const diff = (a: Setup, b: Setup, step: number, sigma: number): boolean => {
    const ra = solve(a, cx, cy, labelling);
    const rb = solve(b, cx, cy, labelling);
    if (ra === null || rb === null) return false;
    add(((ra.w - rb.w) / (2 * step)) * sigma, ((ra.h - rb.h) / (2 * step)) * sigma);
    return true;
  };
  for (const which of ['card', 'win'] as const) {
    for (let k = 0; k < 4; k++) {
      for (let axis = 0; axis < 2; axis++) {
        const up = clone(setup[which]);
        const dn = clone(setup[which]);
        up[k]![axis]! += TAP_STEP_PX;
        dn[k]![axis]! -= TAP_STEP_PX;
        if (!diff({ ...setup, [which]: up }, { ...setup, [which]: dn }, TAP_STEP_PX, tapSigma)) return null;
      }
    }
  }
  const sf = 1 + focalSigma;
  if (!diff({ ...setup, focalPx: focalPx * sf }, { ...setup, focalPx: focalPx / sf }, 1, 1)) return null;
  if (!diff({ ...setup, offsetIn: offsetIn + CARD_OFFSET_SIGMA_IN }, { ...setup, offsetIn: offsetIn - CARD_OFFSET_SIGMA_IN }, 1, 1)) return null;
  const rw = CARD_RECT_SIGMA_MM / MM_PER_IN;
  if (!diff({ ...setup, rectWIn: RECT_W_IN + rw }, { ...setup, rectWIn: RECT_W_IN - rw }, 2 * rw, rw)) return null;
  if (!diff({ ...setup, rectHIn: RECT_H_IN + rw }, { ...setup, rectHIn: RECT_H_IN - rw }, 2 * rw, rw)) return null;
  add(CARD_MODEL_FLOOR * base.w, CARD_MODEL_FLOOR * base.h);
  const uncertaintyIn = { width: CARD_SIGMA_SCALE * Math.sqrt(varW), height: CARD_SIGMA_SCALE * Math.sqrt(varH) };

  // The angle between the line of sight to the window's middle and the plane's normal.
  const centre: V3 = [0, 1, 2].map((k) => (base.winRays[0]![k]! + base.winRays[1]![k]! + base.winRays[2]![k]! + base.winRays[3]![k]!) / 4) as V3;
  const viewAngleDeg = (Math.acos(Math.min(1, Math.abs(dot3(centre, base.normal)) / Math.hypot(...centre))) * 180) / Math.PI;
  const sizeRatio = Math.max(base.w, base.h) / CARD_LONG_IN;

  const reasons: string[] = [];
  const worst = Math.max(uncertaintyIn.width, uncertaintyIn.height);
  if (worst > CARD_CHECK_UNCERTAINTY_IN) {
    const off = `could be off by about ${inchesInWords(worst)}`;
    reasons.push(
      viewAngleDeg > STEEP_ADVICE_DEG
        ? `The size ${off}. Stand straight in front of the window, hold the card flat in the middle of the glass and step a little closer.`
        : `The card is small next to this window, so the size ${off}. Hold the card flat in the middle of the glass and step a little closer.`,
    );
  }
  if (viewAngleDeg > STEEP_CHECK_DEG) reasons.push('The photo was taken from well off to one side of the window. Stand straight in front of it and take the photo again.');
  if ((focalPx * 36) / Math.max(widthPx, heightPx) < ULTRA_WIDE_FOCAL_35MM) reasons.push('This photo looks like it was taken with the wide lens, which bends straight lines. Use the main (1x) camera and take it again.');
  if (longSidePx(cardCorners) < CARD_MIN_LONG_SIDE_FRAC * Math.max(widthPx, heightPx)) reasons.push('The card looks small in the photo. Step a little closer so it is easy to see, then mark its corners again.');
  if (Math.abs(base.shapeRatio / (RECT_W_IN / RECT_H_IN) - 1) > CARD_SHAPE_TOLERANCE) reasons.push('The corners marked on the card do not look like a credit card lying flat on the glass. Tape the card flat and mark the tip of each corner again.');
  if (sidesPx(windowCorners).some((s) => s < MIN_WINDOW_SIDE_PX)) reasons.push('The window is very small in this photo. Step a little closer so it fills more of the picture, then mark its corners again.');

  return { widthIn: base.w, heightIn: base.h, uncertaintyIn, quality: reasons.length === 0 ? 'good' : 'check', reasons, distanceIn: base.distanceIn, viewAngleDeg, sizeRatio };
}

// ---------------------------------------------------------------------------------------------------------------------
// What a person can fix

const PROBLEMS = {
  photo: 'The photo could not be read. Take it again.',
  notId1: 'This only works with a credit-card-sized card, 3 3/8 by 2 1/8 inches. A credit, debit or driver licence card is the right size; many gift cards are not.',
  cardOutside: 'Some of the card corners are outside the photo. Mark all four corners of the card where they show in the photo.',
  windowOutside: 'Some of the window corners are outside the photo. Mark the corners where they show, or take the photo again from farther back so the whole window is in it.',
  cardCrossing: 'The card corners cross over each other. Mark them one after another around the card.',
  cardShape: 'The four card corners do not make the shape of a card. Mark the tip of each corner of the card again.',
  cardSmall: 'The card is too small in this photo to measure from. Take the photo again a little closer, with the card flat on the glass.',
  windowCrossing: 'The window corners cross over each other. Mark them in order: top left, top right, bottom right, bottom left.',
  windowShape: 'The four window corners do not make the shape of a window. Mark the four corners of the frame again.',
  cardBigger: 'The card looks bigger than the window. Mark the four corners of the card first, then the four corners of the window.',
} as const;

/**
 * Why the card and window points cannot be used, in plain words for the homeowner; null when they can. For a 422. The
 * card, when given, must be the ID-1 size (CARD_SIZE_TOLERANCE_MM). Checked: the photo's size, the card size, points
 * inside the photo, the card's corners (crossing, or not a four-cornered shape), the card not too small to tap (under
 * CARD_REFUSE_LONG_SIDE_FRAC of the photo), the window's corners (crossing, or not a convex four-cornered shape), and the
 * card not bigger than the window.
 */
export function cardProblem(input: Pick<CardSizeInput, 'widthPx' | 'heightPx' | 'cardCorners' | 'windowCorners'> & { card?: { widthMm: number; heightMm: number } }): string | null {
  const { widthPx, heightPx, cardCorners, windowCorners, card } = input;
  if (!(Number.isFinite(widthPx) && widthPx > 0 && Number.isFinite(heightPx) && heightPx > 0)) return PROBLEMS.photo;
  if (card !== undefined) {
    const [a, b] = card.widthMm >= card.heightMm ? [card.widthMm, card.heightMm] : [card.heightMm, card.widthMm];
    if (!(Math.abs(a - ID1_CARD_MM.widthMm) <= CARD_SIZE_TOLERANCE_MM && Math.abs(b - ID1_CARD_MM.heightMm) <= CARD_SIZE_TOLERANCE_MM)) return PROBLEMS.notId1;
  }
  if (cardCorners.length !== 4 || !finite(cardCorners) || !inside(cardCorners, widthPx, heightPx)) return PROBLEMS.cardOutside;
  if (windowCorners.length !== 4 || !finite(windowCorners) || !inside(windowCorners, widthPx, heightPx)) return PROBLEMS.windowOutside;
  const cardShape = quadShape(cardCorners);
  if (cardShape === 'crossing') return PROBLEMS.cardCrossing;
  if (cardShape !== 'ok') return PROBLEMS.cardShape;
  if (longSidePx(cardCorners) < CARD_REFUSE_LONG_SIDE_FRAC * Math.max(widthPx, heightPx)) return PROBLEMS.cardSmall;
  const windowShape = quadShape(windowCorners);
  if (windowShape === 'crossing') return PROBLEMS.windowCrossing;
  if (windowShape !== 'ok') return PROBLEMS.windowShape;
  if (Math.abs(signedArea(cardCorners)) >= 0.5 * Math.abs(signedArea(windowCorners))) return PROBLEMS.cardBigger;
  return null;
}
