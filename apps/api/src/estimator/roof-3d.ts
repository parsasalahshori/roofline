import { randomUUID } from 'node:crypto';
import { latestRoof3dSnapshot, type TenantContext, withTenant } from '@roofline/db';
import {
  type LngLat,
  metresApart,
  metresToBuilding,
  type Roof3d,
  type Roof3dPhoto,
  type Roof3dSnapshot,
  type Roof3dStructure,
  roof3dSnapshotFresh,
  roof3dSnapshotStamp,
  roofMaskCut,
  roof3dSnapshotVersion,
  type SolarBuilding,
} from '@roofline/shared';
import { lngLatToUtm, otherRoofParts, type RasterProblem, rasterProblem, reconstructRoof, toRoof3d, utmToLngLat, utmZoneOfEpsg } from '@roofline/shared/roof-reconstruct';
import type { AppDeps } from '../app.ts';
import { type RoofLayers, SolarLayersUnavailableError } from '../providers/solar-layers.ts';
import { encodeRgbPng } from './png.ts';
import { countRoof3d } from './roof-3d-events.ts';
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

/** A building box (Google's) or a point the reused layers must hold with room to spare, in [lng, lat]. */
type Need = { sw: LngLat; ne: LngLat; marginM: number };
type LayersEntry = { at: number; value: Promise<RoofLayers | null>; settled: RoofLayers | null };
const layersCache = new WeakMap<AppDeps, LayersEntry[]>();
const roofCache = new WeakMap<AppDeps, Map<string, { at: number; value: Promise<Roof3dSnapshot | null> }>>();

/**
 * Without a building box, what reused layers must hold round the point, metres. A new request round a point with no
 * building asks for NO_BUILDING_RADIUS_M, so layers bought that way always qualify; layers bought for another house
 * qualify only when the point is this deep inside them. 20 m is the half-diagonal of a 28 m square house: the 6 m the
 * point alone used to need let 87% of the 54 test roofs run off the reused layers' edge in simulation (FM05).
 */
const NO_BUILDING_REACH_M = 20;
/**
 * A roof that still runs off the edge of layers bought for it gets one more request, this much wider (and never past
 * Google's 100 m cap): a roof bigger than Google's box for it (a joined garage, a porch) is rarely more than half
 * again its size.
 */
const RETRY_GROWTH = 1.5;
const MAX_REQUEST_RADIUS_M = 100;
/**
 * The longest a Measure waits for the layers, ms: the provider's own per-request timeouts (12 s for the call, 24 s
 * for each file) can add up past a person's patience; past this the attempt is a typed 'timeout', not kept.
 */
const LAYERS_BUDGET_MS = 40_000;

/** The roof cache key: the point, and the building box the request was sized by (another box is another answer). */
function key(point: LngLat, building: SolarBuilding | null): string {
  const box = ownBox(point, building);
  const b = box === null ? 'none' : `${box.sw[0].toFixed(6)},${box.sw[1].toFixed(6)},${box.ne[0].toFixed(6)},${box.ne[1].toFixed(6)}`;
  return `${point[0].toFixed(5)},${point[1].toFixed(5)}|${b}`;
}

/** Google's box for the building when it is this home's (within SOLAR_BUILDING_SNAP_M of the point), else null. */
function ownBox(point: LngLat, building: SolarBuilding | null): { sw: LngLat; ne: LngLat } | null {
  const box = building?.box ?? null;
  if (building === null || box === null || metresToBuilding(building, point) > SOLAR_BUILDING_SNAP_M) return null;
  return box;
}

/** What reused layers must cover for the roof at `point`: Google's box for it plus MARGIN_M, else the point plus NO_BUILDING_REACH_M. */
function needFor(point: LngLat, building: SolarBuilding | null): Need {
  const box = ownBox(point, building);
  if (box === null) return { sw: point, ne: point, marginM: NO_BUILDING_REACH_M };
  return {
    sw: [Math.min(box.sw[0], point[0]), Math.min(box.sw[1], point[1])],
    ne: [Math.max(box.ne[0], point[0]), Math.max(box.ne[1], point[1])],
    marginM: MARGIN_M,
  };
}

/**
 * Where to ask for the layers of the roof at `point`: round Google Solar's building when it is this home's (its box,
 * plus a margin, and always reaching the point), else round the point.
 */
export function layersRequest(point: LngLat, building: SolarBuilding | null): { center: LngLat; radiusM: number } {
  const box = ownBox(point, building);
  if (box === null) return { center: [point[0], point[1]], radiusM: NO_BUILDING_RADIUS_M };
  const center: LngLat = [(box.sw[0] + box.ne[0]) / 2, (box.sw[1] + box.ne[1]) / 2];
  const half = metresApart(box.sw, box.ne) / 2;
  const radius = Math.max(half + MARGIN_M, metresApart(center, point) + MARGIN_M + 4);
  return { center, radiusM: Math.round(Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, radius))) };
}

/** Whether every corner of `need` lies at least its margin inside the layers' grid. */
export function layersCover(layers: RoofLayers, need: Need): boolean {
  const zone = utmZoneOfEpsg(layers.epsg);
  if (zone === null) return false;
  const { width, height, pixelSizeM } = layers.raster;
  const corners: LngLat[] = [need.sw, [need.ne[0], need.sw[1]], need.ne, [need.sw[0], need.ne[1]]];
  return corners.every((p) => {
    const { easting, northing } = lngLatToUtm(zone, p[0], p[1]);
    const x = easting - layers.originX;
    const y = layers.originY - northing;
    return x >= need.marginM && y >= need.marginM && x <= width * pixelSizeM - need.marginM && y <= height * pixelSizeM - need.marginM;
  });
}

/** Half the layers' smaller side, metres (the radius they were bought with, near enough). */
function layersReachM(layers: RoofLayers): number {
  return (Math.min(layers.raster.width, layers.raster.height) * layers.raster.pixelSizeM) / 2;
}

/** Layers already bought in this process that cover `need` with room to spare, or null. */
function cachedLayers(deps: AppDeps, need: Need): RoofLayers | null {
  const list = layersCache.get(deps) ?? [];
  const now = Date.now();
  return list.find((e) => now - e.at < LAYERS_TTL_MS && e.settled !== null && layersCover(e.settled, need))?.settled ?? null;
}

/** One (paid) Data Layers request, kept in this process for other roofs on the same layers. */
function buyLayers(deps: AppDeps, center: LngLat, radiusM: number): Promise<RoofLayers | null> {
  let list = layersCache.get(deps);
  if (list === undefined) {
    list = [];
    layersCache.set(deps, list);
  }
  const entry: LayersEntry = { at: Date.now(), value: Promise.resolve(null), settled: null };
  entry.value = deps.solarLayers.roofLayers(center, radiusM).then((layers) => {
    entry.settled = layers;
    return layers;
  });
  list.push(entry);
  while (list.length > LAYERS_MAX) list.shift();
  return entry.value;
}

/** The layers for a roof at `point`: from this process when some cover its building with room, else one request. */
function layersFor(deps: AppDeps, point: LngLat, building: SolarBuilding | null): Promise<{ layers: RoofLayers | null; reused: boolean }> {
  const hit = cachedLayers(deps, needFor(point, building));
  if (hit !== null) return Promise.resolve({ layers: hit, reused: true });
  const { center, radiusM } = layersRequest(point, building);
  return buyLayers(deps, center, radiusM).then((layers) => ({ layers, reused: false }));
}

/** `p` or, past `ms`, a SolarLayersUnavailableError with reason 'timeout'. */
function withBudget<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SolarLayersUnavailableError('timeout', 'timeout')), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
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
 * out of a mask part it shares with the buildings it touches (a terrace). Other roofs near it on the layers (a
 * detached garage, a shed) come with it as `structures` (otherRoofParts), outside its own faces and totals.
 */
export function roofOnLayers(layers: RoofLayers, point: LngLat, o: RoofOnLayersOptions = {}): Roof3d | null {
  const found = roofOnLayersResult(layers, point, o);
  return 'roof' in found ? found.roof : null;
}

export type RoofOnLayersOptions = { steep?: boolean; building?: SolarBuilding | null; seed?: number };
/**
 * Why roofOnLayersResult found no roof: 'clipped' (it runs off the layers' edge), 'not-found' (no roof part near the
 * point, too small, or no plane), or the input guard's reason (rasterProblem: a garbled, empty or oversized grid; a
 * grid not in UTM is 'bad-crs').
 */
export type RoofOnLayersMiss = 'clipped' | 'not-found' | 'bad-crs' | RasterProblem;

/** roofOnLayers with the reason when there is no roof. Never throws: an exception inside is reported as 'not-found'. */
export function roofOnLayersResult(layers: RoofLayers, point: LngLat, o: RoofOnLayersOptions = {}): { roof: Roof3d } | { miss: RoofOnLayersMiss } {
  try {
    return roofOnLayersOrThrow(layers, point, o);
  } catch {
    return { miss: 'not-found' };
  }
}

function roofOnLayersOrThrow(layers: RoofLayers, point: LngLat, o: RoofOnLayersOptions): { roof: Roof3d } | { miss: RoofOnLayersMiss } {
  const zone = utmZoneOfEpsg(layers.epsg);
  if (zone === null || !Number.isFinite(layers.originX) || !Number.isFinite(layers.originY)) return { miss: 'bad-crs' };
  const s = layers.raster.pixelSizeM;
  const toPixel = ([lng, lat]: LngLat) => {
    const { easting, northing } = lngLatToUtm(zone, lng, lat);
    return { col: (easting - layers.originX) / s, row: (layers.originY - northing) / s };
  };
  const box = o.building?.box ?? null;
  const ownBox = box !== null && metresToBuilding(o.building!, point) <= SOLAR_BUILDING_SNAP_M;
  const problem = rasterProblem(layers.raster, toPixel(point));
  if (problem !== null) return { miss: problem };
  const raster = { ...layers.raster, green: layers.raster.green ?? greenOf(layers) };
  const local = reconstructRoof(raster, toPixel(point), {
    imageryQuality: layers.imageryQuality,
    // The benchmark (roof3d:bench) runs seeds 7, 8 and 9 to show the result does not hang on the random sample; the
    // server never sets it (the reconstruction's own default seed, 7, applies).
    ...(o.seed !== undefined ? { seed: o.seed } : {}),
    ...(o.steep === true ? { planes: { maxPitchX12: 24 } } : {}),
    ...(ownBox ? { building: [box.sw, [box.ne[0], box.sw[1]] as LngLat, box.ne, [box.sw[0], box.ne[1]] as LngLat].map(toPixel) } : {}),
  });
  if (local === null) return { miss: 'not-found' };
  if (local.clipped) return { miss: 'clipped' };
  const toLngLat = (x: number, y: number) => utmToLngLat(zone, layers.originX + x, layers.originY + y);
  const meta = { imageryQuality: layers.imageryQuality, imageryDate: layers.imageryDate };
  const cut = roofMaskCut(local.cuts);
  const roof: Roof3d = { ...toRoof3d(local, toLngLat, meta), ...(cut !== null ? { maskCut: cut } : {}) };
  // Detached garages, sheds and carports on the same layers: offered beside the main roof, not added to it.
  const structures: Roof3dStructure[] = [];
  for (const other of otherRoofParts(raster, local)) {
    const found = reconstructRoof(raster, other.at, { imageryQuality: layers.imageryQuality, maxPointDistM: 1, ...(o.seed !== undefined ? { seed: o.seed } : {}) });
    if (found === null || found.clipped || found.faces.length === 0) continue;
    const r = toRoof3d(found, toLngLat, meta);
    if (r.quality !== undefined && (r.quality.outlineIoU < 0.6 || r.quality.faceCoverage < 0.6)) continue;
    structures.push({ outline: r.outline, faces: r.faces, lines: r.lines, ...(r.quality !== undefined ? { quality: r.quality } : {}), gapFt: Math.round(other.gapM * 3.280839895 * 10) / 10 });
  }
  return { roof: structures.length > 0 ? { ...roof, structures } : roof };
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

/** The kill switch (config ROOF_3D_MODE): on, shadow or off. */
export type Roof3dMode = 'off' | 'shadow' | 'on';
function modeOf(deps: AppDeps): Roof3dMode {
  const mode = (deps.config as { ROOF_3D_MODE?: unknown } | undefined)?.ROOF_3D_MODE;
  return mode === 'off' || mode === 'shadow' ? mode : 'on';
}

/** Google's roof segments' ground area, square metres (what a shadow roof is compared with). */
function segmentsAreaM2(building: SolarBuilding | null): number {
  return (building?.segments ?? []).reduce((sum, seg) => sum + (Number.isFinite(seg.groundAreaM2) ? seg.groundAreaM2 : 0), 0);
}

/**
 * A shadow roof is counted as differing when its plan area is off Google's segments by more than this share: the
 * benchmark's "bad" line for area (10%).
 */
const SHADOW_DIFF_SHARE = 0.1;
const SQ_FT_PER_M2 = 10.7639104167;

/** One reconstruction attempt on the layers for `point`; a clipped roof on any layers buys wider layers once. */
async function attempt(deps: AppDeps, point: LngLat, building: SolarBuilding | null): Promise<Roof3dSnapshot> {
  const at: LngLat = [point[0], point[1]];
  const stamp = (s: Roof3dSnapshot) => roof3dSnapshotStamp(s);
  let { layers, reused } = await layersFor(deps, point, building);
  const fetchedAt = () => deps.clock.now().toISOString();
  if (layers === null) {
    countRoof3d(deps, 'no-imagery', { reused });
    return stamp({ fetchedAt: fetchedAt(), at, roof: null, none: 'no-imagery' });
  }
  const steep = steepRoof(building);
  let found = roofOnLayersResult(layers, point, { steep, building });
  if ('miss' in found && found.miss === 'clipped') {
    // The roof runs past these layers' edge: layers bought for a neighbour, or a roof bigger than Google's box. Buy
    // fresh layers once, centred as a new request would be and wider, instead of keeping a "no roof" for 30 days.
    countRoof3d(deps, 'clipped-retry', { reused });
    const { center, radiusM } = layersRequest(point, building);
    const wider = Math.min(MAX_REQUEST_RADIUS_M, Math.ceil(Math.max(radiusM, layersReachM(layers)) * RETRY_GROWTH));
    const again = await buyLayers(deps, center, wider);
    if (again !== null) {
      layers = again;
      reused = false;
      found = roofOnLayersResult(layers, point, { steep, building });
    }
  }
  if ('miss' in found) {
    const none = found.miss === 'clipped' ? 'clipped' : found.miss === 'not-found' ? (ownBox(point, building) === null && building === null ? 'no-building' : 'no-roof') : 'unusable';
    countRoof3d(deps, none, { miss: found.miss, reused });
    return stamp({ fetchedAt: fetchedAt(), at, roof: null, none });
  }
  if (unusable(found.roof)) {
    countRoof3d(deps, 'unusable', { reused });
    return stamp({ fetchedAt: fetchedAt(), at, roof: null, none: 'unusable' });
  }
  const roof = withGoogleCheck(found.roof, building);
  countRoof3d(deps, 'built', { reused, faces: roof.faces.length, review: (roof.quality?.reasons.length ?? 0) > 0 });
  return stamp({ fetchedAt: fetchedAt(), at, roof, photo: await photoOrNull(deps, layers, roof) });
}

/**
 * Google's roof at `point` in 3D, as a snapshot to keep: the reconstruction, or why there is none
 * (Roof3dSnapshot.none: no imagery, no building, no roof, clipped, unusable, timeout). Null when Data Layers is not set
 * up, ROOF_3D_MODE is off, or Data Layers failed other than by a timeout (not kept: the next Measure asks again).
 * `building` (Google Solar's building insights for the point, when known) sizes the request and must be covered by
 * reused layers. The same point and building within ROOF_TTL_MS share the first answer; an answer about one attempt
 * (clipped, unusable, timeout) is not shared. Never rejects.
 */
export function roof3dAt(deps: AppDeps, point: LngLat, building: SolarBuilding | null): Promise<Roof3dSnapshot | null> {
  if (!deps.solarLayers.configured) return Promise.resolve(null);
  if (modeOf(deps) === 'off') {
    countRoof3d(deps, 'off');
    return Promise.resolve(null);
  }
  if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return Promise.resolve(null);
  let map = roofCache.get(deps);
  if (map === undefined) {
    map = new Map();
    roofCache.set(deps, map);
  }
  const k = key(point, building);
  const hit = map.get(k);
  if (hit !== undefined && Date.now() - hit.at < ROOF_TTL_MS) return hit.value;
  const entries = map;
  const forget = () => {
    if (entries.get(k)?.value === value) entries.delete(k);
  };
  const value: Promise<Roof3dSnapshot | null> = withBudget(attempt(deps, point, building), LAYERS_BUDGET_MS).then(
    (snapshot) => {
      if (snapshot.roof === null && snapshot.none !== 'no-imagery' && snapshot.none !== 'no-building') forget();
      return snapshot;
    },
    (err: unknown) => {
      forget();
      if (err instanceof SolarLayersUnavailableError && err.reason === 'timeout') {
        countRoof3d(deps, 'timeout');
        return roof3dSnapshotStamp({ fetchedAt: deps.clock.now().toISOString(), at: [point[0], point[1]], roof: null, none: 'timeout' as const });
      }
      if (!(err instanceof SolarLayersUnavailableError)) deps.logError?.(err, 'google-solar-layers');
      countRoof3d(deps, 'unavailable', err instanceof SolarLayersUnavailableError ? { reason: err.reason } : { reason: 'error' });
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
  if (modeOf(deps) !== 'on') return null;
  const layers = cachedLayers(deps, needFor(point, null));
  if (layers === null) return null;
  const roof = roofOnLayers(layers, point);
  if (roof === null || unusable(roof)) return null;
  return roof3dSnapshotStamp({ fetchedAt: deps.clock.now().toISOString(), at: [point[0], point[1]], roof, photo: await photoOrNull(deps, layers, roof) });
}

/** A kept shadow snapshot as the roof it holds (turning ROOF_3D_MODE on reuses it); anything else unchanged. */
function fromShadow(snapshot: Roof3dSnapshot): Roof3dSnapshot {
  if (snapshot.roof !== null || snapshot.none !== 'shadow' || snapshot.shadowRoof == null) return snapshot;
  const { shadowRoof, ...rest } = snapshot;
  delete rest.none;
  return { ...rest, roof: shadowRoof };
}

/** A snapshot with its roof moved to shadowRoof (ROOF_3D_MODE=shadow): kept on the measurement, never measured from. */
function toShadow(deps: AppDeps, snapshot: Roof3dSnapshot | null, building: SolarBuilding | null): Roof3dSnapshot | null {
  if (snapshot === null || snapshot.roof === null) return snapshot;
  const plan = snapshot.roof.faces.reduce((sum, f) => sum + f.planAreaSqFt, 0);
  const google = segmentsAreaM2(building) * SQ_FT_PER_M2;
  const share = google > 0 ? Math.abs(plan - google) / google : null;
  countRoof3d(deps, 'shadow', { faces: snapshot.roof.faces.length });
  if (share !== null && share > SHADOW_DIFF_SHARE) countRoof3d(deps, 'shadow-diff', { areaShare: Math.round(share * 1000) / 1000 });
  const { roof, ...rest } = snapshot;
  return { ...rest, roof: null, none: 'shadow', shadowRoof: roof };
}

/**
 * The 3D roof for a saved home at `point`: the one kept on its newest measurement when still fresh for this roof and
 * made by this reconstruction (roof3dSnapshotFresh checks ROOF_3D_ALGORITHM_VERSION), else roof3dAt (sized by Google
 * Solar's building, awaited from `building`). ROOF_3D_MODE off: null, nothing bought. shadow: the roof is worked out
 * and returned as shadowRoof with roof null, so Measure keeps it but measures the old way. Never rejects.
 */
export async function roof3dForHome(
  deps: AppDeps,
  ctx: TenantContext,
  propertyId: string,
  point: LngLat,
  building: Promise<SolarBuilding | null>,
): Promise<Roof3dSnapshot | null> {
  if (!deps.solarLayers.configured) return null;
  // Off: nothing read, nothing bought.
  if (modeOf(deps) === 'off') return roof3dFromKept(deps, null, point, building);
  const kept = await withTenant(deps.pools, ctx, (tx) => latestRoof3dSnapshot(tx, ctx, propertyId));
  return roof3dFromKept(deps, kept, point, building);
}

/**
 * roof3dForHome after the newest kept snapshot is read (`kept`, null when there is none): reused when fresh and made by
 * this algorithm, else worked out again; ROOF_3D_MODE applied. Never rejects.
 */
export async function roof3dFromKept(
  deps: AppDeps,
  kept: Roof3dSnapshot | null,
  point: LngLat,
  building: Promise<SolarBuilding | null>,
): Promise<Roof3dSnapshot | null> {
  if (!deps.solarLayers.configured) return null;
  const mode = modeOf(deps);
  if (mode === 'off') {
    countRoof3d(deps, 'off');
    return null;
  }
  const usable = kept === null ? null : fromShadow(kept);
  let snapshot: Roof3dSnapshot | null;
  if (usable !== null && roof3dSnapshotFresh(usable, point, deps.clock.now())) {
    countRoof3d(deps, 'reused', { version: roof3dSnapshotVersion(usable).algorithm ?? 0 });
    snapshot = usable;
  } else {
    if (usable !== null) countRoof3d(deps, 'stale-snapshot', { version: roof3dSnapshotVersion(usable).algorithm ?? 0, none: usable.none ?? 'roof' });
    const found = await building.catch(() => null);
    snapshot = await roof3dAt(deps, point, found);
    if (mode === 'shadow') snapshot = toShadow(deps, snapshot, found);
  }
  if (mode === 'shadow' && snapshot?.roof != null) snapshot = toShadow(deps, snapshot, null);
  if (snapshot?.roof == null) countRoof3d(deps, 'fallback', { none: snapshot?.none ?? 'unavailable' });
  return snapshot;
}
