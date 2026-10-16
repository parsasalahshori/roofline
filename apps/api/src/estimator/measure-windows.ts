import { randomUUID } from 'node:crypto';
import {
  createWindowMeasurement,
  footprintsNear,
  getProperty,
  type PropertyRow,
  type StoredFacadePhoto,
  type TenantContext,
  US_MAP_CENTER,
  WindowMeasurementPropertyNotFoundError,
  type WindowGeometry,
  type WindowMeasurementRow,
  withTenant,
} from '@roofline/db';
import type { LngLat, MeasuredWindow, WindowDetectorName, WindowMeasurementView, WindowsMissReason, WindowsReviewReason } from '@roofline/shared';
import { windowSizeClass } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { StreetViewUnavailableError, type StreetViewPano } from '../providers/street-view.ts';
import { DetectorUnconfiguredError } from '../providers/window-detector.ts';
import { ensureFootprintTiles } from './footprint-tiles.ts';
import { FOOTPRINT_SEARCH_M, homeFromAddress, mainOf, pointOf, tilesFor } from './measure.ts';
import { heightLayersFor } from './roof-3d.ts';
import { solarForHome } from './solar.ts';
import { estimateAllSides } from './windows-estimate.ts';
import { centreRange, facadeRegion, frontWalls, planShots, type Shot } from './windows-geometry.ts';
import { eaveHeightAboveGround } from './windows-heights.ts';
import { decodeGray, lineUp, mainWall, sobel } from './windows-lineup.ts';
import { ASSUMED_EAVE_M, countedOn, planOf, rawCamera, sizeOnPhoto, toWindowView, wallsFor } from './windows-view.ts';

/*
 * Measure windows, POST /api/window-measurements. Like Measure roof, the default needs no AI:
 *   address -> saved home and point -> the house's outline (Microsoft footprint, else Google Solar's box) and Google's
 *   height map (eave height above ground) -> the walls estimate; and in parallel Street View's panorama nearest the
 *   house -> photos aimed at the outline's front wall -> the wall drawn into each photo and lined up with its edges.
 * The optional detector (WINDOW_DETECTOR=owlv2) then finds front windows. Every failure after the address is found
 * becomes a typed `missing` reason, with the walls estimate still there whenever the outline is known; nothing throws
 * into the request except a missing address (404) or an unreachable geocoder (503), as for the roof.
 */

const PHOTO_PX = 640;
const STREET_VIEW_RADIUS_M = 80;
/** Google's Street View terms: images kept no longer than 30 days. */
export const PHOTO_KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const M_TO_FT = 3.28084;
const HEIGHTS_BUDGET_MS = 30_000;

type Missing = WindowsMissReason | null;

async function homeOf(deps: AppDeps, ctx: TenantContext, i: { propertyId?: string; address?: string }, now: Date): Promise<PropertyRow> {
  if (i.propertyId !== undefined) {
    const id = i.propertyId;
    const found = await withTenant(deps.pools, ctx, (tx) => getProperty(tx, ctx, id));
    if (found === null) throw new AppError(404, MESSAGES.notFound);
    return found;
  }
  if (i.address !== undefined) return homeFromAddress(deps, ctx, i.address, now);
  throw new AppError(400, 'Pick an address.', 'address');
}

/** The outline: the footprint at the home (as Measure roof picks it), else Google Solar's box for the building. */
async function outlineOf(deps: AppDeps, ctx: TenantContext, property: PropertyRow, point: LngLat): Promise<{ ring: LngLat[]; source: WindowGeometry['outlineSource'] } | null> {
  const { tiles, state } = tilesFor(property, point);
  try {
    await ensureFootprintTiles(deps, tiles, { state, waitMs: deps.config.FOOTPRINT_WAIT_MS });
  } catch (err) {
    deps.logError?.(err, 'window-footprints');
  }
  const rows = await withTenant(deps.pools, ctx, (tx) => footprintsNear(tx, point, FOOTPRINT_SEARCH_M));
  const main = mainOf(rows);
  if (main !== undefined) {
    const ring = main.ring.length > 1 && main.ring[0]![0] === main.ring.at(-1)![0] && main.ring[0]![1] === main.ring.at(-1)![1] ? main.ring.slice(0, -1) : main.ring;
    return { ring: ring.map((p) => [p[0], p[1]] as LngLat), source: 'footprint' };
  }
  const solar = await solarForHome(deps, ctx, property.id, point);
  const box = solar?.building?.box ?? null;
  if (box === null) return null;
  return { ring: [box.sw, [box.ne[0], box.sw[1]], box.ne, [box.sw[0], box.ne[1]]], source: 'solar-box' };
}

async function eaveOf(deps: AppDeps, ctx: TenantContext, property: PropertyRow, point: LngLat, ring: LngLat[]): Promise<number | null> {
  try {
    const solar = await solarForHome(deps, ctx, property.id, point);
    const layers = await heightLayersFor(deps, point, solar?.building ?? null, HEIGHTS_BUDGET_MS);
    return layers === null ? null : eaveHeightAboveGround(layers, ring);
  } catch (err) {
    deps.logError?.(err, 'window-heights');
    return null;
  }
}

async function panoOf(deps: AppDeps, centre: LngLat): Promise<StreetViewPano | 'none' | 'error'> {
  if (!deps.streetView.configured) return 'error';
  try {
    return (await deps.streetView.metadata(centre, { radiusM: STREET_VIEW_RADIUS_M })) ?? 'none';
  } catch (err) {
    if (!(err instanceof StreetViewUnavailableError)) deps.logError?.(err, 'street-view');
    return 'error';
  }
}

export type TakenPhoto = {
  stored: StoredFacadePhoto;
  bytes: Uint8Array;
  blurred: boolean;
  /** The drawn wall is mostly outside this photo (the line-up could not look at it). */
  outside: boolean;
};

/** One photo: fetched, kept in the object store (30 days), and the front wall drawn and lined up on it. */
export async function takePhoto(
  deps: AppDeps,
  pano: StreetViewPano,
  shot: Shot,
  plan: NonNullable<ReturnType<typeof planOf>>,
  eaveM: number,
  now: Date,
  /** The eave height is Google's (not assumed): the photo's eave height must then agree with it for a 'good' line-up. */
  heightKnown = false,
): Promise<TakenPhoto | null> {
  let bytes: Uint8Array;
  try {
    bytes = await deps.streetView.image({ panoId: pano.panoId, heading: shot.heading, fov: shot.fov, pitch: shot.pitch, widthPx: PHOTO_PX, heightPx: PHOTO_PX });
  } catch (err) {
    if (!(err instanceof StreetViewUnavailableError)) deps.logError?.(err, 'street-view');
    return null;
  }
  const id = randomUUID();
  let key: string | null = `window-photos/${id}.jpg`;
  try {
    await deps.objectStore.put(key, bytes, 'image/jpeg');
  } catch (err) {
    deps.logError?.(err, 'window-photo-store');
    key = null;
  }
  const base: StoredFacadePhoto = {
    id,
    heading: shot.heading,
    fov: shot.fov,
    widthPx: PHOTO_PX,
    heightPx: PHOTO_PX,
    capturedOn: pano.capturedOn,
    distanceM: 0,
    key,
    fetchedAt: now.toISOString(),
    deleteBy: new Date(now.getTime() + PHOTO_KEEP_DAYS * DAY_MS).toISOString(),
    pitch: shot.pitch,
    measure: shot.measure,
    range: shot.range,
    lineup: null,
    personFit: null,
  };
  const cam = rawCamera(plan, base)!;
  const front = frontWalls(plan.walls, cam.pos);
  base.distanceM = Math.round((centreRange(cam, front) ?? 0) * 10) / 10;
  const wall = mainWall(plan.walls, cam.pos);
  const gray = decodeGray(bytes);
  if (wall === null || gray === null) return { stored: base, bytes, blurred: false, outside: false };
  // The photo is 640 x 640 as asked; a different size (never seen) is drawn at the size it came.
  const cameraAsCame = { ...cam, widthPx: gray.w, heightPx: gray.h };
  const r = lineUp(sobel(gray), cameraAsCame, wall, eaveM, { heightKnown });
  const quad = r.quad;
  base.widthPx = gray.w;
  base.heightPx = gray.h;
  if (quad !== null) {
    const round = (v: number) => Math.round(v * 10000) / 10000;
    base.wallOverlay = {
      corners: quad.map(([x, y]) => [round(x / gray.w), round(y / gray.h)]) as NonNullable<StoredFacadePhoto['wallOverlay']>['corners'],
      fit: r.fit,
      fitScore: r.fitScore,
      headingCorrectionDeg: r.headingCorrectionDeg,
      wallHeightFromPhotoFt: r.eaveM === null ? null : Math.round(r.eaveM * M_TO_FT * 10) / 10,
    };
  }
  base.lineup = r.fit === 'good' ? { headingCorrectionDeg: r.headingCorrectionDeg, eaveM: r.eaveM } : null;
  return { stored: base, bytes, blurred: r.blurred, outside: r.failed.includes('outside') };
}

/** The optional detector on the counted photos: windows sized like marked ones, on each photo's share of the front. */
async function detect(
  deps: AppDeps,
  plan: NonNullable<ReturnType<typeof planOf>>,
  taken: TakenPhoto[],
  eaveM: number,
): Promise<{ windows: MeasuredWindow[]; missing: Missing }> {
  const windows: MeasuredWindow[] = [];
  for (const t of taken) {
    if (!t.stored.measure) continue;
    const cam = rawCamera(plan, t.stored)!;
    const region = facadeRegion(cam, frontWalls(plan.walls, cam.pos), eaveM + 1);
    let boxes;
    try {
      boxes = await deps.windowDetector.detect(t.bytes, { photoId: t.stored.id, region });
    } catch (err) {
      return { windows: [], missing: err instanceof DetectorUnconfiguredError ? 'detector-unconfigured' : 'detector-error' };
    }
    for (const b of boxes) {
      const box = { x: b.x, y: b.y, w: b.w, h: b.h };
      if (!countedOn(plan, t.stored, box)) continue;
      const s = sizeOnPhoto(plan, t.stored, box);
      if (s === null) continue;
      windows.push({ id: randomUUID(), photoId: t.stored.id, source: 'detector', box, widthIn: s.widthIn, heightIn: s.heightIn, sizeClass: windowSizeClass(s.widthIn, s.heightIn), floor: s.floor, confidence: Math.round(b.confidence * 1000) / 1000 });
    }
  }
  return { windows, missing: null };
}

function lineOf(p: PropertyRow): string {
  return `${p.addressLine}, ${p.city}, ${p.state} ${p.zip}`;
}

export async function measureWindows(deps: AppDeps, ctx: TenantContext, i: { propertyId?: string; address?: string }): Promise<WindowMeasurementView> {
  const started = performance.now();
  const now = deps.clock.now();
  const property = await homeOf(deps, ctx, i, now);
  const point = await pointOf(deps, ctx, property, now);

  let missing: Missing = null;
  const reasons: WindowsReviewReason[] = [];
  let geometry: WindowGeometry | null = null;
  const photos: StoredFacadePhoto[] = [];
  let windows: MeasuredWindow[] = [];
  let detector: WindowDetectorName | null = null;

  const outline = point === null ? null : await outlineOf(deps, ctx, property, point);
  if (point === null || outline === null) {
    missing = 'no-footprint';
  } else {
    const n = outline.ring.length;
    const centre: LngLat = [outline.ring.reduce((t, p) => t + p[0], 0) / n, outline.ring.reduce((t, p) => t + p[1], 0) / n];
    const [eave, pano] = await Promise.all([eaveOf(deps, ctx, property, point, outline.ring), panoOf(deps, centre)]);
    geometry = { ring: outline.ring, camera: typeof pano === 'object' ? pano.location : null, eaveHeightM: eave, outlineSource: outline.source };
    const plan = planOf(geometry);
    if (typeof pano !== 'object') {
      missing = 'no-street-view';
    } else if (plan === null || plan.camera === null) {
      missing = 'no-footprint';
    } else {
      const front = frontWalls(plan.walls, plan.camera);
      const shots = planShots(front, plan.camera);
      const eaveM = eave ?? ASSUMED_EAVE_M;
      const taken = (await Promise.all(shots.map((s) => takePhoto(deps, pano, s, plan, eaveM, now, eave !== null)))).filter((t): t is TakenPhoto => t !== null);
      photos.push(...taken.map((t) => t.stored));
      const counted = taken.filter((t) => t.stored.measure);
      if (shots.length === 0) missing = 'facade-hidden';
      else if (taken.length === 0) missing = 'no-street-view';
      else if (counted.length > 0 && counted.every((t) => t.blurred)) missing = 'house-blurred';
      else {
        if (counted.some((t) => t.outside)) reasons.push('partly-hidden');
        if (deps.windowDetector.name !== null) {
          detector = deps.windowDetector.name;
          const found = await detect(deps, plan, taken, eaveM);
          windows = found.windows;
          missing = found.missing;
          if (missing !== null) detector = null;
        }
      }
    }
  }

  const walls = wallsFor(geometry, photos);
  const estimated = walls === null ? null : estimateAllSides(walls);
  const deleteBy = photos.length > 0 ? new Date(now.getTime() + PHOTO_KEEP_DAYS * DAY_MS) : null;
  let row: WindowMeasurementRow;
  try {
    row = await withTenant(deps.pools, ctx, (tx) =>
      createWindowMeasurement(
        tx,
        ctx,
        {
          propertyId: property.id,
          address: lineOf(property),
          center: point ?? US_MAP_CENTER,
          photos,
          windows,
          estimated,
          stories: walls !== null && walls.heightSource !== 'assumed' ? walls.floors : null,
          geometry,
          detector,
          missingReason: missing,
          reviewReasons: reasons,
          tookMs: performance.now() - started,
          photosDeleteBy: deleteBy,
        },
        now,
      ),
    );
  } catch (err) {
    if (err instanceof WindowMeasurementPropertyNotFoundError) throw new AppError(404, MESSAGES.notFound);
    throw err;
  }
  return toWindowView(row, now);
}
