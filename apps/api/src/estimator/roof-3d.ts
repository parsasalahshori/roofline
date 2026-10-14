import { latestRoof3dSnapshot, type TenantContext, withTenant } from '@roofline/db';
import { type LngLat, metresApart, metresToBuilding, type Roof3d, type Roof3dSnapshot, roof3dSnapshotFresh, type SolarBuilding } from '@roofline/shared';
import { lngLatToUtm, reconstructRoof, toRoof3d, utmToLngLat, utmZoneOfEpsg } from '@roofline/shared/roof-reconstruct';
import type { AppDeps } from '../app.ts';
import { type RoofLayers, SolarLayersUnavailableError } from '../providers/solar-layers.ts';
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

/**
 * The roof at `point` reconstructed on these layers, in [lng, lat]; null when no roof part comes near the point, it is
 * too small, no plane is found, or it runs off the layers' edge.
 */
export function roofOnLayers(layers: RoofLayers, point: LngLat): Roof3d | null {
  const zone = utmZoneOfEpsg(layers.epsg);
  if (zone === null) return null;
  const { easting, northing } = lngLatToUtm(zone, point[0], point[1]);
  const s = layers.raster.pixelSizeM;
  const local = reconstructRoof(layers.raster, { col: (easting - layers.originX) / s, row: (layers.originY - northing) / s });
  if (local === null || local.clipped) return null;
  return toRoof3d(local, (x, y) => utmToLngLat(zone, layers.originX + x, layers.originY + y), {
    imageryQuality: layers.imageryQuality,
    imageryDate: layers.imageryDate,
  });
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
    (layers): Roof3dSnapshot => {
      const fetchedAt = deps.clock.now().toISOString();
      if (layers === null) return { fetchedAt, at, roof: null, none: 'no-imagery' };
      const roof = roofOnLayers(layers, point);
      return roof === null ? { fetchedAt, at, roof: null, none: 'no-roof' } : { fetchedAt, at, roof };
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
export function roof3dOnBoughtLayers(deps: AppDeps, point: LngLat): Roof3dSnapshot | null {
  const layers = cachedLayers(deps, point);
  if (layers === null) return null;
  const roof = roofOnLayers(layers, point);
  return roof === null ? null : { fetchedAt: deps.clock.now().toISOString(), at: [point[0], point[1]], roof };
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
