import type { StoredFacadePhoto, WindowGeometry, WindowMeasurementRow } from '@roofline/db';
import {
  type FacadePhoto,
  type MarkedBox,
  type MeasuredWindow,
  type WindowMeasurementView,
  type WindowsReviewReason,
  WINDOWS_REVIEW_REASONS,
  windowSizeClass,
} from '@roofline/shared';
import { estimateAllSides, estimateSidesAndBack, type HouseWalls, houseWalls } from './windows-estimate.ts';
import { type Box, CAMERA_HEIGHT_M, type Camera, frontWalls, inRange, localFrame, sizeBox, type Vec, type Wall, wallsOf } from './windows-geometry.ts';
import { correctedCamera, mainWall, type Quad, wallQuad } from './windows-lineup.ts';

/*
 * A stored window measurement as the API answers it (pure): marked windows are sized here from the stored camera and
 * outline (with the person's corner fit, else the automatic line-up's heading correction), and the estimate is worked
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

/** A box marked (or found) on a photo, sized; null when it cannot be (no camera, or off every wall). */
export function sizeOnPhoto(plan: Plan, photo: StoredFacadePhoto, box: Box): { widthIn: number; heightIn: number; floor: number; bearing: number } | null {
  const cam = sizingCamera(plan, photo);
  if (cam === null) return null;
  const front = frontWalls(plan.walls, cam.pos);
  const sized = sizeBox(cam, front, box) ?? (() => {
    const main = mainWall(plan.walls, cam.pos);
    return main === null ? null : sizeBox(cam, [extended(main)], box);
  })();
  if (sized === null || sized.widthIn < 6 || sized.heightIn < 6 || sized.widthIn > 400 || sized.heightIn > 400) return null;
  return { widthIn: sized.widthIn, heightIn: sized.heightIn, floor: sized.floor, bearing: sized.bearing };
}

export function markedWindow(plan: Plan | null, photos: readonly StoredFacadePhoto[], m: MarkedBox): MeasuredWindow | null {
  const photo = photos.find((p) => p.id === m.photoId);
  if (plan === null || photo === undefined) return null;
  const s = sizeOnPhoto(plan, photo, m.box);
  if (s === null) return null;
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
  const marked = (row.adjustments.marked ?? []).map((m) => markedWindow(plan, photos, m)).filter((w): w is MeasuredWindow => w !== null);
  const windows = [...row.windows, ...marked];
  const walls = wallsFor(geometry, photos);
  const estimated = walls === null ? (row.estimated ?? null) : windows.length > 0 ? estimateSidesAndBack(walls, windows) : estimateAllSides(walls);

  const reasons = new Set<WindowsReviewReason>();
  for (const r of row.reviewReasons) if ((WINDOWS_REVIEW_REASONS as readonly string[]).includes(r)) reasons.add(r as WindowsReviewReason);
  if (windows.length === 0 && estimated !== null) reasons.add('estimated-from-size');
  if (windows.length > 0 && estimated !== null) reasons.add('front-only');
  if (row.windows.some((w) => w.confidence < LOW_CONFIDENCE)) reasons.add('low-confidence');
  if (photos.some((p) => p.capturedOn !== null && yearsBetween(p.capturedOn, now) > OLD_IMAGERY_YEARS)) reasons.add('old-imagery');
  const counted = photos.filter((p) => p.measure);
  const personFitted = photos.some((p) => p.personFit !== null);
  if (!personFitted && counted.some((p) => p.wallOverlay?.fit === 'off')) reasons.add('walls-unconfirmed');
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
    },
    tookMs: row.tookMs,
  };
}
