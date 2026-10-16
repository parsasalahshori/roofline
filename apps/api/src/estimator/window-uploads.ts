import exifr from 'exifr';
import {
  DEFAULT_FOCAL_35MM,
  focalPxFrom35mm,
  INCHES_PER_METRE,
  measureWithSheet,
  type PhotoWindow,
  type PhotoWindowInput,
  type Pt,
  type Quad,
  ROOMPLAN_MIN_UNCERTAINTY_IN,
  ROOMPLAN_UNCERTAINTY_IN,
  SHEET_MAX_RMS_PX,
  SHEET_MIN_POINTS,
  STEEP_CHECK_DEG,
  sizeFromArPoints,
  sizeFromKnownSide,
  sizeFromReference,
  WINDOW_PHOTO_REFERENCES,
  windowSizeClass,
} from '@roofline/shared';

/*
 * On-site window photos: a person photographs one window and marks its corners (plus a sheet of paper on the glass,
 * or one side measured by hand); the window is sized by plane geometry (window-photo-math), no AI.
 *
 * Orientation: the bytes are stored exactly as uploaded (no re-encode: a phone JPEG keeps its quality and EXIF), and
 * the EXIF Orientation is recorded. Every size the API reports (widthPx, heightPx) and every corner it accepts are in the
 * DISPLAYED orientation, the way a browser shows the photo (browsers apply EXIF orientation to <img> by default,
 * `image-orientation: from-image`). The sizing math is rotation-invariant given displayed width/height (principal
 * point at the centre, focal length from the longer side), so no pixel is ever rotated on the server.
 *
 * exifr reads the EXIF: small, pure JavaScript, no native build, widely used and well tested on phone photos (JPEG,
 * HEIC, PNG eXIf). Only three tags are read: Orientation, FocalLengthIn35mmFormat and DateTimeOriginal.
 */

export type ImageKind = 'jpeg' | 'png';
export type ImageInfo = { kind: ImageKind; widthPx: number; heightPx: number; orientation: number; focal35mm: number | null; takenAt: string | null };

/** What the first bytes say the file is. */
export function sniff(bytes: Uint8Array): ImageKind | 'heic' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return 'png';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp') {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis'].includes(brand)) return 'heic';
  }
  return null;
}

/** A JPEG's pixel size from its first SOF marker (as stored, before orientation); null if none is found. */
function jpegSize(b: Uint8Array): { w: number; h: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const h = (b[i + 5]! << 8) | b[i + 6]!;
      const w = (b[i + 7]! << 8) | b[i + 8]!;
      return w > 0 && h > 0 ? { w, h } : null;
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function pngSize(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 24) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const w = v.getUint32(16);
  const h = v.getUint32(20);
  return w > 0 && h > 0 ? { w, h } : null;
}

/** "2026:10:15 12:34:56" (EXIF, local time) as "2026-10-15T12:34:56"; null when it is not that shape. */
function exifDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(v);
  return m === null ? null : `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

/** The largest photo side accepted, pixels (a 200 MP phone photo is about 16,000 px). */
const MAX_SIDE_PX = 20_000;

/** Size (displayed), orientation and the EXIF the sizing uses; 'heic' for a HEIC; null for anything unreadable. */
export async function readImageInfo(bytes: Uint8Array): Promise<ImageInfo | 'heic' | null> {
  const kind = sniff(bytes);
  if (kind === 'heic' || kind === null) return kind;
  const size = kind === 'jpeg' ? jpegSize(bytes) : pngSize(bytes);
  if (size === null || size.w > MAX_SIDE_PX || size.h > MAX_SIDE_PX) return null;
  let tags: Record<string, unknown> = {};
  try {
    tags = ((await exifr.parse(bytes, { pick: ['Orientation', 'FocalLengthIn35mmFormat', 'DateTimeOriginal'], translateValues: false, reviveValues: false })) ?? {}) as Record<string, unknown>;
  } catch {
    // No EXIF, or EXIF it cannot read: the photo still counts, with the default focal length.
  }
  const o = typeof tags.Orientation === 'number' && tags.Orientation >= 1 && tags.Orientation <= 8 ? Math.round(tags.Orientation) : 1;
  const f = tags.FocalLengthIn35mmFormat;
  const focal35mm = typeof f === 'number' && Number.isFinite(f) && f >= 8 && f <= 600 ? f : null;
  // Orientations 5-8 turn the photo a quarter: displayed width is the stored height.
  const swapped = o >= 5;
  return { kind, widthPx: swapped ? size.h : size.w, heightPx: swapped ? size.w : size.h, orientation: o, focal35mm, takenAt: exifDate(tags.DateTimeOriginal) };
}

/** Steeper than this ratio between a quad's opposite sides, the photo was taken at a steep angle. */
const STEEP_SIDE_RATIO = 1.6;
/** The window seen more than this far off square (degrees) is 'check': corners clicked a few pixels off move the size a lot. */
const STEEP_VIEW_DEG = 50;

type V3 = [number, number, number];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * How far off square the camera saw the rectangle, degrees: the plane's normal from the same construction as
 * rectangleAspect (Zhang and He): the two edge directions in camera space, crossed. Null for a degenerate quad.
 */
export function viewingAngleDeg(q: Quad, widthPx: number, heightPx: number, focalPx: number): number | null {
  const h = (p: Pt): V3 => [(p[0] - widthPx / 2) / focalPx, (p[1] - heightPx / 2) / focalPx, 1];
  const [m1, m2, m4, m3] = [h(q[0]), h(q[1]), h(q[2]), h(q[3])];
  const k2den = dot3(cross(m2, m4), m3);
  const k3den = dot3(cross(m3, m4), m2);
  if (Math.abs(k2den) < 1e-12 || Math.abs(k3den) < 1e-12) return null;
  const k2 = dot3(cross(m1, m4), m3) / k2den;
  const k3 = dot3(cross(m1, m4), m2) / k3den;
  const u: V3 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const v: V3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  const n = cross(u, v);
  const len = Math.hypot(...n);
  if (!(len > 0)) return null;
  // The angle between the plane's normal and the line of sight to the rectangle's middle.
  const c: V3 = [(m1[0] + m2[0] + m3[0] + m4[0]) / 4, (m1[1] + m2[1] + m3[1] + m4[1]) / 4, 1];
  const cos = Math.abs(dot3(n, c)) / (len * Math.hypot(...c));
  return (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
}
/** A quad side shorter than this (pixels) is too small to size from reliably. */
const MIN_SIDE_PX = 20;

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function segmentsCross(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d = (a: Pt, b: Pt, c: Pt) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Whether a quad (TL, TR, BR, BL) is a usable view of a rectangle: not crossing, not tiny, not steeply angled. */
export function quadIsGood(q: Quad): boolean {
  if (segmentsCross(q[0], q[1], q[2], q[3]) || segmentsCross(q[1], q[2], q[3], q[0])) return false;
  const sides = [dist(q[0], q[1]), dist(q[1], q[2]), dist(q[2], q[3]), dist(q[3], q[0])];
  if (sides.some((s) => s < MIN_SIDE_PX)) return false;
  const ratio = (a: number, b: number) => Math.max(a, b) / Math.min(a, b);
  return ratio(sides[0]!, sides[2]!) <= STEEP_SIDE_RATIO && ratio(sides[1]!, sides[3]!) <= STEEP_SIDE_RATIO;
}

/** A reference's real size as it lies in the photo: held upright, or turned (its marked top side longer than its left side). */
function referenceSize(reference: keyof typeof WINDOW_PHOTO_REFERENCES, q: Quad): { w: number; h: number } {
  const r = WINDOW_PHOTO_REFERENCES[reference];
  const across = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const down = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  return across > down ? { w: r.heightIn, h: r.widthIn } : { w: r.widthIn, h: r.heightIn };
}

/**
 * One photographed window sized with the shared math, as the view shows it; null when the math cannot size it (a
 * degenerate quad) or the result is not a window's size (3 to 400 in). `photo` is the upload's displayed size and
 * focal length (DEFAULT_FOCAL_35MM when the photo does not say); null when the window has no photo, which only a
 * RoomPlan window may (any other kind without a photo is null).
 */
export function sizePhotoWindow(input: PhotoWindowInput, photo: { widthPx: number; heightPx: number; focal35mm: number | null } | null): PhotoWindow | null {
  const s = input.scale;
  if (s.kind === 'roomplan') return sizeRoomPlanWindow(input, s);
  const corners = input.corners;
  if (photo === null || corners === undefined) return null;
  let size: { widthIn: number; heightIn: number } | null;
  const focalPx = focalPxFrom35mm(photo.focal35mm ?? DEFAULT_FOCAL_35MM, photo.widthPx, photo.heightPx);
  const angle = viewingAngleDeg(corners, photo.widthPx, photo.heightPx, focalPx);
  let good = quadIsGood(corners) && angle !== null && angle <= STEEP_VIEW_DEG;
  let extra: Pick<PhotoWindow, 'uncertaintyIn' | 'distanceIn' | 'viewAngleDeg'> = {};
  // The sheet method is exact to a few hundredths of an inch: kept to 0.01 in (the others to 0.1 in).
  let step = 10;
  if (s.kind === 'reference') {
    const ref = referenceSize(s.reference, s.corners);
    size = sizeFromReference(corners, s.corners, ref.w, ref.h);
    good = good && quadIsGood(s.corners);
  } else if (s.kind === 'sheet') {
    if (sheetProblem(input, photo) !== null) return null;
    const m = measureWithSheet({ widthPx: photo.widthPx, heightPx: photo.heightPx, focalPx, imagePoints: s.imagePoints, sheetPointsIn: s.sheetPointsIn, sheetIndex: s.sheetIndex, printScale: s.printScale, windowQuad: corners, planeOffsetIn: s.planeOffsetIn })!;
    size = { widthIn: m.widthIn, heightIn: m.heightIn };
    // The sheet's pose gives the true viewing angle (the quad-based estimate above is only a fallback).
    good = quadIsGood(corners) && m.viewAngleDeg <= STEEP_CHECK_DEG;
    const r2 = (v: number) => Math.round(v * 100) / 100;
    extra = { uncertaintyIn: { width: r2(m.uncertaintyIn.width), height: r2(m.uncertaintyIn.height) }, distanceIn: Math.round(m.distanceIn), viewAngleDeg: Math.round(m.viewAngleDeg * 10) / 10 };
    step = 100;
  } else if (s.kind === 'ar') {
    // AR: the size is the distance between the tapped points (metres in AR space); the photo only carries the thumbnail.
    if (arProblem(input) !== null) return null;
    const m = sizeFromArPoints(s.pointsM, { device: s.device, cornerSpreadM: s.cornerSpreadM })!;
    size = { widthIn: m.widthIn, heightIn: m.heightIn };
    good = m.quality === 'good' && s.trackingLostCount <= AR_MAX_TRACKING_LOST;
    const r2 = (v: number) => Math.round(v * 100) / 100;
    extra = { uncertaintyIn: { width: r2(m.uncertaintyIn.width), height: r2(m.uncertaintyIn.height) }, distanceIn: null, viewAngleDeg: null };
    step = 100;
  } else {
    size = sizeFromKnownSide(corners, photo.widthPx, photo.heightPx, s.side, s.inches, focalPx);
  }
  if (size === null || !Number.isFinite(size.widthIn) || !Number.isFinite(size.heightIn)) return null;
  if (size.widthIn < 3 || size.heightIn < 3 || size.widthIn > 400 || size.heightIn > 400) return null;
  const widthIn = Math.round(size.widthIn * step) / step;
  const heightIn = Math.round(size.heightIn * step) / step;
  return { ...input, widthIn, heightIn, sizeClass: windowSizeClass(widthIn, heightIn), ...extra, quality: good ? 'good' : 'check' };
}

/**
 * A RoomPlan window: its size as the scan gave it (0.1 in), always 'check', with at least ROOMPLAN_MIN_UNCERTAINTY_IN
 * of ± (more at lower confidence), so it is never order-grade. Null outside AR_MIN_IN..AR_MAX_IN.
 */
function sizeRoomPlanWindow(input: PhotoWindowInput, s: Extract<PhotoWindowInput['scale'], { kind: 'roomplan' }>): PhotoWindow | null {
  if (roomPlanProblem(input) !== null) return null;
  const widthIn = Math.round(s.widthM * INCHES_PER_METRE * 10) / 10;
  const heightIn = Math.round(s.heightM * INCHES_PER_METRE * 10) / 10;
  const u = Math.max(ROOMPLAN_MIN_UNCERTAINTY_IN, ROOMPLAN_UNCERTAINTY_IN[s.confidence] ?? ROOMPLAN_MIN_UNCERTAINTY_IN);
  return { ...input, widthIn, heightIn, sizeClass: windowSizeClass(widthIn, heightIn), uncertaintyIn: { width: u, height: u }, distanceIn: null, viewAngleDeg: null, quality: 'check' };
}

/** Why a RoomPlan window cannot be sized, in words for the person; null when it can (or it is not a RoomPlan window). */
export function roomPlanProblem(input: PhotoWindowInput): string | null {
  const s = input.scale;
  if (s.kind !== 'roomplan') return null;
  const w = s.widthM * INCHES_PER_METRE;
  const h = s.heightM * INCHES_PER_METRE;
  const out = (v: number) => !(v >= AR_MIN_IN && v <= AR_MAX_IN);
  if (out(w) || out(h)) return `its room-scan size ${w.toFixed(1)} x ${h.toFixed(1)} in is outside ${AR_MIN_IN} to ${AR_MAX_IN} in`;
  return null;
}

/**
 * Why a window scaled by the measuring sheet cannot be sized, in words for the person; null when it can. The browser
 * found the points; the server refits them: fewer than SHEET_MIN_POINTS matched points, or a homography whose RMS
 * reprojection error is above SHEET_MAX_RMS_PX (2.5 px: a flat, sharp sheet fits to well under 1 px; more means a
 * curled sheet, a blurred photo or points that are not the sheet's), is refused rather than sized wrong.
 */
export function sheetProblem(input: PhotoWindowInput, photo: { widthPx: number; heightPx: number; focal35mm: number | null }): string | null {
  const s = input.scale;
  if (s.kind !== 'sheet' || input.corners === undefined) return null;
  if (s.imagePoints.length < SHEET_MIN_POINTS || s.imagePoints.length !== s.sheetPointsIn.length) return 'too few points of the measuring sheet were found';
  const focalPx = focalPxFrom35mm(photo.focal35mm ?? DEFAULT_FOCAL_35MM, photo.widthPx, photo.heightPx);
  const m = measureWithSheet({ widthPx: photo.widthPx, heightPx: photo.heightPx, focalPx, imagePoints: s.imagePoints, sheetPointsIn: s.sheetPointsIn, sheetIndex: s.sheetIndex, printScale: s.printScale, windowQuad: input.corners, planeOffsetIn: s.planeOffsetIn });
  if (m === null) return 'the measuring sheet\'s points do not fit a flat sheet';
  if (m.rmsPx > SHEET_MAX_RMS_PX) return `the measuring sheet is not flat or the photo is blurred (fit error ${m.rmsPx.toFixed(1)} px)`;
  return null;
}

/** AR sizes outside this (inches, either side) are not a window: refused with a 422 naming the window. */
export const AR_MIN_IN = 6;
export const AR_MAX_IN = 200;
/** AR losing the wall more often than this while the corners were tapped: the window is 'check' (the points may have drifted). */
export const AR_MAX_TRACKING_LOST = 3;

/**
 * Why a window measured in AR cannot be sized, in words for the person; null when it can (or it was not measured in
 * AR): degenerate points, or a size outside 6..200 in.
 */
export function arProblem(input: PhotoWindowInput): string | null {
  const s = input.scale;
  if (s.kind !== 'ar') return null;
  const m = sizeFromArPoints(s.pointsM, { device: s.device, cornerSpreadM: s.cornerSpreadM });
  if (m === null) return 'its AR corners are on top of each other or in a line';
  const out = (v: number) => !(v >= AR_MIN_IN && v <= AR_MAX_IN);
  if (out(m.widthIn) || out(m.heightIn)) return `its AR size ${m.widthIn.toFixed(1)} x ${m.heightIn.toFixed(1)} in is outside ${AR_MIN_IN} to ${AR_MAX_IN} in`;
  return null;
}
