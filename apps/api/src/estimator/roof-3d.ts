import { randomUUID } from 'node:crypto';
import { latestRoof3dSnapshot, type TenantContext, withTenant } from '@roofline/db';
import {
  type LngLat,
  metresApart,
  metresToBuilding,
  type Roof3d,
  type Roof3dPhoto,
  type Roof3dSnapshot,
  roof3dSnapshotFresh,
  type SolarBuilding,
} from '@roofline/shared';
import { lngLatToUtm, reconstructRoof, toRoof3d, utmToLngLat, utmZoneOfEpsg } from '@roofline/shared/roof-reconstruct';
import type { AppDeps } from '../app.ts';
import { type RoofLayers, SolarLayersUnavailableError } from '../providers/solar-layers.ts';
import { encodeRgbPng } from './png.ts';
import { withGoogleCheck } from './roof-3d-compare.ts';
import { SOLAR_BUILDING_SNAP_M } from './solar.ts';

/*
 * The roof in 3D for the estimator: Google Solar's Data Layers (a height map and roof mask, a paid request) bought at
 * most once per roof, and the roof reconstructed from them (roof-reconstruct). Kept three ways so re-measuring never
 * buys again: on the measurement (roof_3d, reused for ROOF_3D_CACHE_DAYS), in this process by point (a prefetch and
 * the Measure after it share one request), and the layers themselves in this process for a while (another roof on the
 * same layers, such as the building a footprint names, costs nothing).
 */

const ROOF_TTL_MS = 30 * 60 * 1000;
const ROOF_MAX = 500;
const LAYERS_TTL_MS = 15 * 60 * 1000;
const LAYERS_MAX = 8;
/** Room round the building asked for, metres: the roof must not run off the layers' edge. */
const MARGIN_M = 6;
const MIN_RADIUS_M = 15;
const MAX_RADIUS_M = 60;
/** Asked about a point with no Solar building near it: this far round it. */
const NO_BUILDING_RADIUS_M = 30;

type LayersEntry = { at: number; value: Promise<RoofLayers | null>; settled: RoofLayers | null };
const layersCache = new WeakMap<AppDeps, LayersEntry[]>();
const roofCache = new WeakMap<AppDeps, Map<string, { at: number; value: Promise<Roof3dSnapshot | null> }>>();

function key(point: LngLat): string {
  return `${point[0].toFixed(5)},${point[1].toFixed(5)}`;
}

/**
 * Where to ask for the layers of the roof at `point`: round Google Solar's building when it is this home's (its box,
 * plus a margin, and always reaching the point), else round the point.
 */
export function layersRequest(point: LngLat, building: SolarBuilding | null): { center: LngLat; radiusM: number } {
  const box = building?.box ?? null;
  if (building === null || box === null || metresToBuilding(building, point) > SOLAR_BUILDING_SNAP_M) {
    return { center: [point[0], point[1]], radiusM: NO_BUILDING_RADIUS_M };
  }
  const center: LngLat = [(box.sw[0] + box.ne[0]) / 2, (box.sw[1] + box.ne[1]) / 2];
  const half = metresApart(box.sw, box.ne) / 2;
  const radius = Math.max(half + MARGIN_M, metresApart(center, point) + MARGIN_M + 4);
  return { center, radiusM: Math.round(Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, radius))) };
}

/** Whether a point lies at least `marginM` inside the layers' grid. */
function covers(layers: RoofLayers, point: LngLat, marginM: number): boolean {
  const zone = utmZoneOfEpsg(layers.epsg);
  if (zone === null) return false;
  const { easting, northing } = lngLatToUtm(zone, point[0], point[1]);
  const { width, height, pixelSizeM } = layers.raster;
  const x = easting - layers.originX;
  const y = layers.originY - northing;
  return x >= marginM && y >= marginM && x <= width * pixelSizeM - marginM && y <= height * pixelSizeM - marginM;
}

/** Layers already bought in this process that cover the point with room to spare, or null. */
function cachedLayers(deps: AppDeps, point: LngLat): RoofLayers | null {
  const list = layersCache.get(deps) ?? [];
  const now = Date.now();
  return list.find((e) => now - e.at < LAYERS_TTL_MS && e.settled !== null && covers(e.settled, point, MARGIN_M))?.settled ?? null;
}

/** The layers for a roof at `point`: from this process when some cover it, else one (paid) request. */
function layersFor(deps: AppDeps, point: LngLat, building: SolarBuilding | null): Promise<RoofLayers | null> {
  const hit = cachedLayers(deps, point);
  if (hit !== null) return Promise.resolve(hit);
  let list = layersCache.get(deps);
  if (list === undefined) {
    list = [];
    layersCache.set(deps, list);
  }
  const { center, radiusM } = layersRequest(point, building);
  const entry: LayersEntry = { at: Date.now(), value: Promise.resolve(null), settled: null };
  entry.value = deps.solarLayers.roofLayers(center, radiusM).then((layers) => {
    entry.settled = layers;
    return layers;
  });
  list.push(entry);
  while (list.length > LAYERS_MAX) list.shift();
  return entry.value;
}

/** Room round the roof kept in its photo, metres. */
const PHOTO_MARGIN_M = 10;

/**
 * Where the layers' photo is green (vegetation), on the height map's grid: green above red and blue, with an excess
 * green (2G - R - B) of at least 20. Null without a photo.
 */
export function greenOf(layers: RoofLayers): Uint8Array | null {
  const photo = layers.photo ?? null;
  if (photo === null) return null;
  const { width, height, pixelSizeM } = layers.raster;
  const out = new Uint8Array(width * height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const x = layers.originX + (c + 0.5) * pixelSizeM;
      const y = layers.originY - (r + 0.5) * pixelSizeM;
      const pc = Math.floor((x - photo.originX) / photo.pixelSizeM);
      const pr = Math.floor((photo.originY - y) / photo.pixelSizeM);
      if (pc < 0 || pr < 0 || pc >= photo.width || pr >= photo.height) continue;
      const at = (pr * photo.width + pc) * 3;
      const red = photo.rgb[at]!;
      const green = photo.rgb[at + 1]!;
      const blue = photo.rgb[at + 2]!;
      if (green >= red && green >= blue && 2 * green - red - blue >= 20) out[r * width + c] = 1;
    }
  }
  return out;
}

/**
 * The roof at `point` reconstructed on these layers, in [lng, lat]; null when no roof part comes near the point, it is
 * too small, no plane is found, or it runs off the layers' edge. `steep`: Google's segments show a plane steeper than
 * 18/12 (steepRoof). `building`: Google Solar's building for the point; when it is this home's, its box cuts the roof
 * out of a mask part it shares with the buildings it touches (a terrace).
 */
export function roofOnLayers(layers: RoofLayers, point: LngLat, o: { steep?: boolean; building?: SolarBuilding | null } = {}): Roof3d | null {
  const zone = utmZoneOfEpsg(layers.epsg);
  if (zone === null) return null;
  const s = layers.raster.pixelSizeM;
  const toPixel = ([lng, lat]: LngLat) => {
    const { easting, northing } = lngLatToUtm(zone, lng, lat);
    return { col: (easting - layers.originX) / s, row: (layers.originY - northing) / s };
  };
  const box = o.building?.box ?? null;
  const ownBox = box !== null && metresToBuilding(o.building!, point) <= SOLAR_BUILDING_SNAP_M;
  const raster = { ...layers.raster, green: layers.raster.green ?? greenOf(layers) };
  const local = reconstructRoof(raster, toPixel(point), {
    imageryQuality: layers.imageryQuality,
    ...(o.steep === true ? { planes: { maxPitchX12: 24 } } : {}),
    ...(ownBox ? { building: [box.sw, [box.ne[0], box.sw[1]] as LngLat, box.ne, [box.sw[0], box.ne[1]] as LngLat].map(toPixel) } : {}),
  });
  if (local === null || local.clipped) return null;
  return toRoof3d(local, (x, y) => utmToLngLat(zone, layers.originX + x, layers.originY + y), {
    imageryQuality: layers.imageryQuality,
    imageryDate: layers.imageryDate,
  });
}

/**
 * Google's photo round a reconstructed roof (its box plus PHOTO_MARGIN_M), stored once as a PNG in the file store; the
 * roof view shows it under the 3D roof (true ortho, so they match). Null without a photo or a file store.
 */
export async function storeRoofPhoto(deps: AppDeps, layers: RoofLayers, roof: Roof3d): Promise<Roof3dPhoto | null> {
  const photo = layers.photo ?? null;
  const zone = utmZoneOfEpsg(layers.epsg);
  if (photo === null || zone === null || !deps.objectStore.configured) return null;
  const utm = roof.outline.map(([lng, lat]) => lngLatToUtm(zone, lng, lat));
  const px = photo.pixelSizeM;
  const c0 = Math.max(0, Math.floor((Math.min(...utm.map((p) => p.easting)) - PHOTO_MARGIN_M - photo.originX) / px));
  const c1 = Math.min(photo.width, Math.ceil((Math.max(...utm.map((p) => p.easting)) + PHOTO_MARGIN_M - photo.originX) / px));
  const r0 = Math.max(0, Math.floor((photo.originY - Math.max(...utm.map((p) => p.northing)) - PHOTO_MARGIN_M) / px));
  const r1 = Math.min(photo.height, Math.ceil((photo.originY - Math.min(...utm.map((p) => p.northing)) + PHOTO_MARGIN_M) / px));
  const width = c1 - c0;
  const height = r1 - r0;
  if (width < 2 || height < 2) return null;
  const rgb = new Uint8Array(width * height * 3);
  for (let r = 0; r < height; r++) rgb.set(photo.rgb.subarray(((r + r0) * photo.width + c0) * 3, ((r + r0) * photo.width + c1) * 3), r * width * 3);
  const corner = (c: number, r: number): LngLat => {
    const [lng, lat] = utmToLngLat(zone, photo.originX + c * px, photo.originY - r * px);
    return [Math.round(lng * 1e8) / 1e8, Math.round(lat * 1e8) / 1e8];
  };
  const key = `roof-photos/${randomUUID()}.png`;
  await deps.objectStore.put(key, encodeRgbPng(width, height, rgb), 'image/png');
  return { key, corners: [corner(c0, r0), corner(c1, r0), corner(c1, r1), corner(c0, r1)], width, height };
}

/**
 * A reconstruction too far off to show at all (the roof is then measured from its outline as before): its outline
 * overlaps Google's mask by less than 0.6, or its faces cover less than 60% of it. Milder shortfalls are shown,
 * marked for review (RoofQuality).
 */
export function unusable(roof: Roof3d): boolean {
  const q = roof.quality;
  return q !== undefined && (q.outlineIoU < 0.6 || q.faceCoverage < 0.6);
}

/** Steeper than 18/12 in degrees: Google's own segments must show such a roof before a face may be that steep. */
const STEEP_DEG = (Math.atan(18 / 12) * 180) / Math.PI;

/** Whether Google Solar's segments for the building include a roof plane steeper than 18/12. */
export function steepRoof(building: SolarBuilding | null): boolean {
  return (building?.segments ?? []).some((seg) => seg.pitchDeg > STEEP_DEG && seg.pitchDeg < 75 && seg.groundAreaM2 >= 2);
}

/** storeRoofPhoto that never fails the measurement: a photo that cannot be stored is left out. */
async function photoOrNull(deps: AppDeps, layers: RoofLayers, roof: Roof3d): Promise<Roof3dPhoto | null> {
  try {
    return await storeRoofPhoto(deps, layers, roof);
  } catch (err) {
    deps.logError?.(err, 'roof-photo');
    return null;
  }
}

/**
 * Google's roof at `point` in 3D, as a snapshot to keep: the reconstruction, or why there is none (no HIGH or MEDIUM
 * imagery there, or no roof at the point). Null when Data Layers is not set up or did not answer (not kept: the next
 * Measure asks again). `building` (Google Solar's building insights for the point, when known) sizes the request.
 * The same point within ROOF_TTL_MS shares the first answer.
 */
export function roof3dAt(deps: AppDeps, point: LngLat, building: SolarBuilding | null): Promise<Roof3dSnapshot | null> {
  if (!deps.solarLayers.configured) return Promise.resolve(null);
  let map = roofCache.get(deps);
  if (map === undefined) {
    map = new Map();
    roofCache.set(deps, map);
  }
  const k = key(point);
  const hit = map.get(k);
  if (hit !== undefined && Date.now() - hit.at < ROOF_TTL_MS) return hit.value;
  const entries = map;
  const at: LngLat = [point[0], point[1]];
  const value = layersFor(deps, point, building).then(
    async (layers): Promise<Roof3dSnapshot> => {
      const fetchedAt = deps.clock.now().toISOString();
      if (layers === null) return { fetchedAt, at, roof: null, none: 'no-imagery' };
      const found = roofOnLayers(layers, point, { steep: steepRoof(building), building });
      if (found === null || unusable(found)) return { fetchedAt, at, roof: null, none: 'no-roof' };
      const roof = withGoogleCheck(found, building);
      return { fetchedAt, at, roof, photo: await photoOrNull(deps, layers, roof) };
    },
    (err: unknown) => {
      if (!(err instanceof SolarLayersUnavailableError)) deps.logError?.(err, 'google-solar-layers');
      if (entries.get(k)?.value === value) entries.delete(k);
      return null;
    },
  );
  map.set(k, { at: Date.now(), value });
  while (map.size > ROOF_MAX) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  return value;
}

/** The roof at `point` on layers this process already bought (no new request), or null when none cover it. */
export async function roof3dOnBoughtLayers(deps: AppDeps, point: LngLat): Promise<Roof3dSnapshot | null> {
  const layers = cachedLayers(deps, point);
  if (layers === null) return null;
  const roof = roofOnLayers(layers, point);
  if (roof === null || unusable(roof)) return null;
  return { fetchedAt: deps.clock.now().toISOString(), at: [point[0], point[1]], roof, photo: await photoOrNull(deps, layers, roof) };
}

/**
 * The 3D roof for a saved home at `point`: the one kept on its newest measurement when still fresh for this roof,
 * else roof3dAt (sized by Google Solar's building, awaited from `building`).
 */
export async function roof3dForHome(
  deps: AppDeps,
  ctx: TenantContext,
  propertyId: string,
  point: LngLat,
  building: Promise<SolarBuilding | null>,
): Promise<Roof3dSnapshot | null> {
  if (!deps.solarLayers.configured) return null;
  const kept = await withTenant(deps.pools, ctx, (tx) => latestRoof3dSnapshot(tx, ctx, propertyId));
  if (kept !== null && roof3dSnapshotFresh(kept, point, deps.clock.now())) return kept;
  return roof3dAt(deps, point, await building);
}
