import type { StoredFacadePhoto, WindowGeometry, WindowMeasurementRow } from '@roofline/db';
import {
  type DoorRuler,
  type FacadePhoto,
  type MarkedBox,
  type MeasuredWindow,
  type PhotoWindow,
  type RulerResult,
  type WindowMeasurementView,
  type WindowsReviewReason,
  WINDOWS_REVIEW_REASONS,
  windowSizeClass,
} from '@roofline/shared';
import { estimateAllSides, estimateSidesAndBack, type HouseWalls, houseWalls } from './windows-estimate.ts';
import { type Box, CAMERA_HEIGHT_M, type Camera, frontWalls, inRange, localFrame, METRES_TO_INCHES, type Sized, sizeBox, type Vec, type Wall, wallsOf } from './windows-geometry.ts';
import { correctedCamera, mainWall, type Quad, wallQuad } from './windows-lineup.ts';
import { sizePhotoWindow } from './window-uploads.ts';

/*
 * A stored window measurement as the API answers it (pure): marked windows are sized here from the stored camera and
 * outline (with the person's corner fit, else the automatic line-up's heading correction; on the photo with a door
 * ruler, with the camera distance the ruler gives), and the estimate is worked
 * out from the walls: all sides with nothing measured, the sides and back once front windows are measured.
 */

const M_TO_FT = 3.28084;
const OLD_IMAGERY_YEARS = 5;
/** Below this detector confidence a window is 'low-confidence'. */
const LOW_CONFIDENCE = 0.5;
/** When nothing else says, a wall is drawn this high (one 9 ft floor), metres. */
export const ASSUMED_EAVE_M = 9 / M_TO_FT;

/** The plan geometry of a measurement: the outline's walls and the camera, in a frame round the outline's middle. */
export type Plan = { walls: Wall[]; camera: Vec | null; toLocal(p: [number, number]): Vec };

export function planOf(geometry: WindowGeometry): Plan | null {
  if (geometry.ring.length < 3) return null;
  const n = geometry.ring.length;
  const origin: [number, number] = [geometry.ring.reduce((t, p) => t + p[0], 0) / n, geometry.ring.reduce((t, p) => t + p[1], 0) / n];
  const frame = localFrame(origin);
  return {
    walls: wallsOf(geometry.ring.map((p) => frame.toLocal(p))),
    camera: geometry.camera === null ? null : frame.toLocal(geometry.camera),
    toLocal: (p) => frame.toLocal(p),
  };
}

/** The camera a photo was taken with, as stored (no correction). */
export function rawCamera(plan: Plan, photo: StoredFacadePhoto): Camera | null {
  if (plan.camera === null) return null;
  return { pos: plan.camera, heightM: CAMERA_HEIGHT_M, heading: photo.heading, pitch: photo.pitch, fov: photo.fov, widthPx: photo.widthPx, heightPx: photo.heightPx };
}

/** The camera to size windows with: the person's corner fit, else the line-up's heading correction, else as stored. */
export function sizingCamera(plan: Plan, photo: StoredFacadePhoto): Camera | null {
  const cam = rawCamera(plan, photo);
  if (cam === null) return null;
  const wall = mainWall(plan.walls, cam.pos);
  if (photo.personFit !== null && wall !== null) return correctedCamera(cam, wall, photo.personFit.headingCorrectionDeg, photo.personFit.distanceScale);
  if (photo.lineup !== null) return { ...cam, heading: cam.heading + photo.lineup.headingCorrectionDeg };
  return cam;
}

/** The main wall extended far each way: a marked box just past the outline's corner is still sized on its plane. */
function extended(w: Wall): Wall {
  const ux = (w.b[0] - w.a[0]) / w.lengthM;
  const uy = (w.b[1] - w.a[1]) / w.lengthM;
  return { ...w, a: [w.a[0] - ux * 50, w.a[1] - uy * 50], b: [w.b[0] + ux * 50, w.b[1] + uy * 50], lengthM: w.lengthM + 100 };
}

/** A box sized with `cam` on the front walls (else the main wall extended); null when off every wall or implausible. */
function sizeWith(plan: Plan, cam: Camera, box: Box): Sized | null {
  const front = frontWalls(plan.walls, cam.pos);
  const sized = sizeBox(cam, front, box) ?? (() => {
    const main = mainWall(plan.walls, cam.pos);
    return main === null ? null : sizeBox(cam, [extended(main)], box);
  })();
  return sized;
}

const plausible = (s: Sized | null): s is Sized => s !== null && s.widthIn >= 6 && s.heightIn >= 6 && s.widthIn <= 400 && s.heightIn <= 400;

/** A box marked (or found) on a photo, sized; null when it cannot be (no camera, or off every wall). */
export function sizeOnPhoto(plan: Plan, photo: StoredFacadePhoto, box: Box, cam: Camera | null = sizingCamera(plan, photo)): { widthIn: number; heightIn: number; floor: number; bearing: number } | null {
  if (cam === null) return null;
  const sized = sizeWith(plan, cam, box);
  if (!plausible(sized)) return null;
  return { widthIn: sized.widthIn, heightIn: sized.heightIn, floor: sized.floor, bearing: sized.bearing };
}

/** A ruler's width and height must agree on the scale within this share, else the result says 'check'. */
const RULER_AGREE = 0.15;
/** The camera's distance correction a ruler may make: x1/3 to x3 (beyond that the door or its size is wrong). */
export const RULER_MIN_SCALE = 1 / 3;
export const RULER_MAX_SCALE = 3;

export type AppliedRuler = { result: RulerResult; camera: Camera };

/**
 * A door ruler applied to its photo: the camera that sizes the door at its real size. Assumption: the door is flush with
 * the wall (a garage door nearly always is), and what is wrong is the camera's distance to the house; the camera is
 * moved along its line to the main wall (correctedCamera's distance scale) until the door's geometric-mean size
 * (width x height) matches. A ray-plane sizing is near-linear in the distance, so bisection on the log of the size
 * ratio finds it. Null when the door cannot be sized on the photo, or the correction is out of RULER_MIN/MAX_SCALE.
 */
export function applyRuler(plan: Plan, photo: StoredFacadePhoto, ruler: DoorRuler): AppliedRuler | null {
  const cam = sizingCamera(plan, photo);
  if (cam === null) return null;
  const wall = mainWall(plan.walls, cam.pos);
  if (wall === null) return null;
  const at = (s: number): Sized | null => sizeWith(plan, correctedCamera(cam, wall, 0, s), ruler.box);
  const before = at(1);
  if (before === null || !(before.widthM > 0) || !(before.heightM > 0)) return null;
  const knownW = ruler.widthIn / METRES_TO_INCHES;
  const knownH = ruler.heightIn / METRES_TO_INCHES;
  // log(measured / real), geometric mean of width and height: 0 at the right distance
  const err = (s: Sized) => (Math.log(s.widthM / knownW) + Math.log(s.heightM / knownH)) / 2;
  const e1 = err(before);
  const scale = Math.exp(-e1);
  if (!(scale >= RULER_MIN_SCALE && scale <= RULER_MAX_SCALE)) return null;
  let lo = scale < 1 ? RULER_MIN_SCALE * 0.9 : 1;
  let hi = scale < 1 ? 1 : RULER_MAX_SCALE * 1.1;
  let best: { s: number; sized: Sized } = { s: 1, sized: before };
  for (let k = 0; k < 40; k++) {
    const mid = Math.sqrt(lo * hi);
    const sized = at(mid);
    if (sized === null) {
      // The door's rays leave the wall (moved too far): stay nearer
      if (scale > 1) hi = mid;
      else lo = mid;
      continue;
    }
    best = { s: mid, sized };
    if (err(sized) < 0) lo = mid;
    else hi = mid;
  }
  if (Math.abs(err(best.sized)) > 0.02) return null;
  const kw = ruler.widthIn / (before.widthM * METRES_TO_INCHES);
  const kh = ruler.heightIn / (before.heightM * METRES_TO_INCHES);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    camera: correctedCamera(cam, wall, 0, best.s),
    result: {
      photoId: photo.id,
      kind: ruler.kind,
      widthIn: ruler.widthIn,
      heightIn: ruler.heightIn,
      measuredWidthIn: before.widthIn,
      measuredHeightIn: before.heightIn,
      scale: Math.round(scale * 1000) / 1000,
      rangeM: { before: r1(before.rangeM), after: r1(best.sized.rangeM) },
      agreement: Math.abs(Math.log(kw / kh)) <= Math.log(1 + RULER_AGREE) ? 'good' : 'check',
    },
  };
}

export function markedWindow(plan: Plan | null, photos: readonly StoredFacadePhoto[], m: MarkedBox, ruler: AppliedRuler | null = null): MeasuredWindow | null {
  const photo = photos.find((p) => p.id === m.photoId);
  if (plan === null || photo === undefined) return null;
  const onRuler = ruler !== null && ruler.result.photoId === photo.id;
  const s = sizeOnPhoto(plan, photo, m.box, onRuler ? ruler.camera : undefined);
  if (s === null) return null;
  const plain = onRuler ? sizeOnPhoto(plan, photo, m.box) : null;
  return {
    id: m.id,
    photoId: m.photoId,
    source: 'marked',
    box: { ...m.box },
    widthIn: s.widthIn,
    heightIn: s.heightIn,
    sizeClass: windowSizeClass(s.widthIn, s.heightIn),
    floor: s.floor,
    confidence: 1,
    ...(plain !== null ? { beforeRuler: { widthIn: plain.widthIn, heightIn: plain.heightIn } } : {}),
  };
}

/** Whether a detector box on a counted photo lies on that photo's share of the front (none is counted twice). */
export function countedOn(plan: Plan, photo: StoredFacadePhoto, box: Box): boolean {
  if (!photo.measure) return false;
  const s = sizeOnPhoto(plan, photo, box);
  return s !== null && inRange(s.bearing, photo.range);
}

/** The eave height the walls use: the person's fit, else Google's heights, else the photo line-up, else none. */
function eaveFor(geometry: WindowGeometry, photos: readonly StoredFacadePhoto[]): { eaveM: number | null } {
  const person = photos.find((p) => p.personFit !== null)?.personFit ?? null;
  if (person !== null) return { eaveM: person.eaveM };
  if (geometry.eaveHeightM !== null) return { eaveM: geometry.eaveHeightM };
  const photo = photos.find((p) => p.lineup?.eaveM != null)?.lineup?.eaveM ?? null;
  return { eaveM: photo };
}

export function wallsFor(geometry: WindowGeometry | null, photos: readonly StoredFacadePhoto[]): HouseWalls | null {
  if (geometry === null) return null;
  const plan = planOf(geometry);
  if (plan === null) return null;
  const perimeter = plan.walls.reduce((t, w) => t + w.lengthM, 0);
  const front = plan.camera === null ? null : frontWalls(plan.walls, plan.camera).reduce((t, w) => t + w.lengthM, 0);
  return houseWalls(perimeter, front, eaveFor(geometry, photos).eaveM);
}

function corners01(q: Quad, photo: StoredFacadePhoto): [[number, number], [number, number], [number, number], [number, number]] {
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return q.map(([x, y]) => [r(x / photo.widthPx), r(y / photo.heightPx)]) as [[number, number], [number, number], [number, number], [number, number]];
}

/** The wall overlay to show: drawn with the person's fit when there is one (then 'good'), else as stored. */
function overlayOf(plan: Plan | null, geometry: WindowGeometry | null, photo: StoredFacadePhoto): FacadePhoto['wallOverlay'] {
  const stored = photo.wallOverlay;
  if (photo.personFit === null || plan === null || geometry === null) return stored;
  const cam = sizingCamera(plan, photo);
  const wall = cam === null ? null : mainWall(plan.walls, rawCamera(plan, photo)!.pos);
  const quad = cam === null || wall === null ? null : wallQuad(cam, wall, photo.personFit.eaveM);
  if (quad === null) return stored;
  return {
    corners: corners01(quad, photo),
    fit: 'good',
    fitScore: stored?.fitScore ?? null,
    headingCorrectionDeg: photo.personFit.headingCorrectionDeg,
    wallHeightFromPhotoFt: Math.round(photo.personFit.eaveM * M_TO_FT * 10) / 10,
  };
}

export function publicPhoto(plan: Plan | null, geometry: WindowGeometry | null, p: StoredFacadePhoto): FacadePhoto {
  const overlay = overlayOf(plan, geometry, p);
  return {
    id: p.id,
    heading: p.heading,
    fov: p.fov,
    widthPx: p.widthPx,
    heightPx: p.heightPx,
    capturedOn: p.capturedOn,
    distanceM: p.distanceM,
    ...(overlay !== undefined ? { wallOverlay: overlay } : {}),
  };
}

function yearsBetween(capturedOn: string, now: Date): number {
  const [y, m] = capturedOn.split('-').map(Number);
  return (now.getUTCFullYear() - y! + (now.getUTCMonth() + 1 - m!) / 12);
}

export function toWindowView(row: WindowMeasurementRow, now: Date): WindowMeasurementView {
  const geometry = row.geometry ?? null;
  const plan = geometry === null ? null : planOf(geometry);
  const photos = row.photos;
  const rulerPhoto = row.adjustments.ruler == null ? undefined : photos.find((p) => p.id === row.adjustments.ruler!.photoId);
  const ruler = plan === null || rulerPhoto === undefined ? null : applyRuler(plan, rulerPhoto, row.adjustments.ruler!);
  const marked = (row.adjustments.marked ?? []).map((m) => markedWindow(plan, photos, m, ruler)).filter((w): w is MeasuredWindow => w !== null);
  const windows = [...row.windows, ...marked];
  const walls = wallsFor(geometry, photos);
  const estimated = walls === null ? (row.estimated ?? null) : windows.length > 0 ? estimateSidesAndBack(walls, windows) : estimateAllSides(walls);

  // Windows photographed on site, sized with the shared math from each upload's displayed size and focal length.
  const uploads = row.uploads ?? [];
  const photoWindows = (row.adjustments.photoWindows ?? [])
    .map((input) => {
      const u = uploads.find((x) => x.id === input.uploadId);
      return u === undefined ? null : sizePhotoWindow(input, u);
    })
    .filter((w): w is PhotoWindow => w !== null);
  const allPhotographed = row.adjustments.photosCoverAllWindows === true && photoWindows.length > 0;

  const reasons = new Set<WindowsReviewReason>();
  for (const r of row.reviewReasons) if ((WINDOWS_REVIEW_REASONS as readonly string[]).includes(r)) reasons.add(r as WindowsReviewReason);
  if (windows.length === 0 && !allPhotographed && estimated !== null) reasons.add('estimated-from-size');
  if (windows.length > 0 && estimated !== null) reasons.add('front-only');
  if (row.windows.some((w) => w.confidence < LOW_CONFIDENCE)) reasons.add('low-confidence');
  if (photos.some((p) => p.capturedOn !== null && yearsBetween(p.capturedOn, now) > OLD_IMAGERY_YEARS)) reasons.add('old-imagery');
  const counted = photos.filter((p) => p.measure);
  const personFitted = photos.some((p) => p.personFit !== null);
  // 'off' or 'unknown' (the strict line-up could not confirm it, not blurred): the walls are not confirmed.
  const unconfirmed = (p: StoredFacadePhoto) => p.wallOverlay?.fit === 'off' || (p.wallOverlay?.fit === 'unknown' && p.wallOverlay.fitScore !== null);
  if (!personFitted && counted.some(unconfirmed)) reasons.add('walls-unconfirmed');
  else reasons.delete('walls-unconfirmed');

  const floorsMeasured = windows.length > 0 ? Math.max(...windows.map((w) => w.floor)) : null;
  const stories = walls !== null && walls.heightSource !== 'assumed' ? walls.floors : (floorsMeasured ?? row.stories ?? null);
  return {
    id: row.id,
    propertyId: row.propertyId,
    address: row.address,
    center: row.center,
    createdAt: row.createdAt.toISOString(),
    photos: photos.map((p) => publicPhoto(plan, geometry, p)),
    windows,
    estimated,
    stories,
    walls: walls === null ? null : { perimeterFt: walls.perimeterFt, wallHeightFt: walls.wallHeightFt, wallAreaSqFt: walls.wallAreaSqFt, frontWallFt: walls.frontWallFt },
    detector: row.detector ?? null,
    missing: row.missingReason === null ? null : { reason: row.missingReason },
    needsReview: reasons.size === 0 ? null : { reasons: WINDOWS_REVIEW_REASONS.filter((r) => reasons.has(r)) },
    adjustments: {
      excludedWindowIds: [...row.adjustments.excludedWindowIds],
      manualCounts: { ...row.adjustments.manualCounts },
      ...(row.adjustments.marked !== undefined ? { marked: row.adjustments.marked } : {}),
      ...(row.adjustments.wallCorners != null ? { wallCorners: row.adjustments.wallCorners } : {}),
      ...(row.adjustments.ruler != null ? { ruler: row.adjustments.ruler } : {}),
      ...(row.adjustments.photoWindows !== undefined ? { photoWindows: row.adjustments.photoWindows } : {}),
      ...(row.adjustments.photosCoverAllWindows !== undefined ? { photosCoverAllWindows: row.adjustments.photosCoverAllWindows } : {}),
    },
    tookMs: row.tookMs,
    photoWindows,
    uploads: uploads.map((u) => ({ id: u.id, widthPx: u.widthPx, heightPx: u.heightPx, focal35mm: u.focal35mm, takenAt: u.takenAt })),
    ruler: ruler?.result ?? null,
  };
}
