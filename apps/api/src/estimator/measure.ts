import { eq } from 'drizzle-orm';
import {
  companySettings,
  createMeasurement,
  createProperty,
  CustomerRequiredError,
  DuplicateAddressError,
  footprintsNear,
  getProperty,
  listProperties,
  type LngLat,
  MeasurementPropertyNotFoundError,
  type NewMeasurement,
  type PropertyInput,
  type PropertyRow,
  setPropertyFootprint,
  type TenantContext,
  type Tx,
  US_MAP_CENTER,
  updateProperty,
  withTenant,
} from '@roofline/db';
import {
  dominantPitchX12,
  footprintTilesNear,
  instantEstimate,
  isTimeZone,
  measureRoof,
  type MeasurementView,
  normalizeAddressKey,
  metresToBuilding,
  type Outline,
  outlineFromSolar,
  polygonAreaSqFt,
  type Ring,
  type Roof3d,
  type Roof3dSnapshot,
  roofPlanesFrom3d,
  seededPitchX12,
  type SolarSnapshot,
} from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { type GeocodeResult, GeocoderUnavailableError } from '../providers/geocoder.ts';
import { ensureFootprintTiles } from './footprint-tiles.ts';
import { roof3dAt, roof3dForHome, roof3dOnBoughtLayers } from './roof-3d.ts';
import { type PitchPick, pitchFromSolar, SOLAR_BUILDING_SNAP_M, solarAt, solarForHome } from './solar.ts';

const PICK_ADDRESS_MESSAGE = 'Pick an address.';
const NOT_FOUND_MESSAGE = 'We could not find that address.';
const UNAVAILABLE_MESSAGE = "Address lookup isn't available right now.";
const SAVED_ELSEWHERE_MESSAGE = 'That address is already saved. Pick it from the list.';
const PICK_CUSTOMER_MESSAGE = 'Pick the customer for this address first.';

/** Used when the company has no settings row yet (the same defaults the settings page starts from). */
const FALLBACK_PITCH_X12 = 6;
const FALLBACK_OVERHANG_FT = 1;

/** A footprint that contains the home point wins; otherwise the nearest one within this distance. */
const FOOTPRINT_SEARCH_M = 40;
const FOOTPRINT_SNAP_M = 30;
/** A point this close to its footprint tile's edge also needs the tile next door (a building may be filed there). */
const FOOTPRINT_TILE_MARGIN_M = 100;
/**
 * How long Measure waits for the roof in 3D (Google's height map bought and the roof worked out, started by the Measure
 * search's prefetch) before it carries on with the outline's roof instead.
 */
const ROOF_3D_WAIT_MS = 25_000;
/** Another footprint at least this share inside the 3D roof's outline is part of that roof (a garage under the same roof). */
const PART_OF_ROOF_SHARE = 0.5;

type NearFootprint = Awaited<ReturnType<typeof footprintsNear>>[number];
/** A building the user picked on the map: its footprint and a point on it. */
export type SelectedFootprint = { id: string; ring: Ring; areaSqFt: number; point: LngLat };
type Settings = { pitchX12: number; overhangFt: number };

/** Typed addresses looked up lately, per process: the Measure search's prefetch and the Measure after it ask once. */
const looked = new WeakMap<AppDeps, Map<string, { at: number; value: GeocodeResult | null }>>();
const LOOKED_TTL_MS = 10 * 60 * 1000;
const LOOKED_MAX = 500;

function lookedFor(deps: AppDeps): Map<string, { at: number; value: GeocodeResult | null }> {
  let map = looked.get(deps);
  if (map === undefined) {
    map = new Map();
    looked.set(deps, map);
  }
  return map;
}

/** The geocoder, with its outage turned into a plain value (provider calls never run inside a transaction). */
async function lookUp(deps: AppDeps, text: string): Promise<GeocodeResult | null | 'unavailable'> {
  const map = lookedFor(deps);
  const k = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const hit = map.get(k);
  if (hit !== undefined && Date.now() - hit.at < LOOKED_TTL_MS) return hit.value;
  try {
    const value = await deps.geocoder.geocode(text);
    map.set(k, { at: Date.now(), value });
    while (map.size > LOOKED_MAX) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
    return value;
  } catch (err) {
    if (err instanceof GeocoderUnavailableError) return 'unavailable';
    throw err;
  }
}

/** The one-line form of an address that the geocoder is asked about. */
function lineOf(p: Pick<PropertyRow, 'addressLine' | 'city' | 'state' | 'zip'>): string {
  return `${p.addressLine}, ${p.city}, ${p.state} ${p.zip}`;
}

/** The company's address with the same street and ZIP, however it was written; visible to the caller only. */
async function findSaved(deps: AppDeps, ctx: TenantContext, addressLine: string, zip: string): Promise<PropertyRow | null> {
  const key = normalizeAddressKey(addressLine, zip);
  const result = await withTenant(deps.pools, ctx, (tx) =>
    listProperties(tx, ctx, { q: addressLine, includeArchived: true, limit: 50 }),
  );
  return result.properties.find((p) => normalizeAddressKey(p.addressLine, p.zip) === key) ?? null;
}

/** Free text in, a saved address out: geocode first (no transaction open), then save it or reuse the one already saved. */
async function homeFromAddress(deps: AppDeps, ctx: TenantContext, address: string, now: Date): Promise<PropertyRow> {
  const found = await lookUp(deps, address);
  if (found === 'unavailable') throw new AppError(503, UNAVAILABLE_MESSAGE);
  if (found === null) throw new AppError(400, NOT_FOUND_MESSAGE, 'address');
  const { street, city, state, zip } = found;
  if (street === null || city === null || state === null || zip === null) throw new AppError(400, NOT_FOUND_MESSAGE, 'address');
  const timezone = found.timezone !== null && isTimeZone(found.timezone) ? found.timezone : null;
  return saveHome(deps, ctx, { street, city, state, zip }, [found.lng, found.lat], timezone, now);
}

/**
 * A looked-up address in, a saved address out: the company's address with the same street and ZIP when there is
 * one, else a new one at `location`. Shared by the typed-address path and the map's "Estimate this roof".
 */
export async function saveHome(
  deps: AppDeps,
  ctx: TenantContext,
  address: { street: string; city: string; state: string; zip: string },
  location: LngLat,
  timezone: string | null,
  now: Date,
): Promise<PropertyRow> {
  const { street, city, state, zip } = address;
  const saved = await findSaved(deps, ctx, street, zip);
  if (saved !== null) return saved;

  const input: PropertyInput = {
    addressLine: street,
    city,
    state,
    zip,
    location,
    ...(timezone !== null ? { timezone } : {}),
  };
  try {
    return await withTenant(deps.pools, ctx, (tx) => createProperty(tx, ctx, input, { now }));
  } catch (err) {
    if (err instanceof DuplicateAddressError) {
      const again = await findSaved(deps, ctx, street, zip);
      if (again !== null) return again;
      throw new AppError(409, SAVED_ELSEWHERE_MESSAGE, 'address');
    }
    if (err instanceof CustomerRequiredError) throw new AppError(400, PICK_CUSTOMER_MESSAGE, 'address');
    throw err;
  }
}

/** The home's point: its saved one, or a fresh lookup that is saved for next time. Null when there is none. */
async function pointOf(deps: AppDeps, ctx: TenantContext, property: PropertyRow, now: Date): Promise<LngLat | null> {
  if (property.geom != null) return property.geom;
  const found = await lookUp(deps, lineOf(property));
  if (found === null || found === 'unavailable') return null;
  const location: LngLat = [found.lng, found.lat];
  await withTenant(deps.pools, ctx, (tx) => updateProperty(tx, ctx, property.id, { location }, { now }));
  return location;
}

/** The company's pitch and overhang defaults, read inside the tenant transaction. */
async function settingsFor(tx: Tx, ctx: TenantContext): Promise<Settings> {
  const [row] = await tx
    .select({ pitchX12: companySettings.defaultPitchX12, overhangFt: companySettings.overhangFt })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId))
    .limit(1);
  return row ?? { pitchX12: FALLBACK_PITCH_X12, overhangFt: FALLBACK_OVERHANG_FT };
}

/** The structure the home sits on: the one that contains the point, else the nearest within the snap distance. */
function mainOf(rows: NearFootprint[]): NearFootprint | undefined {
  const inside = rows.find((r) => r.contains);
  if (inside !== undefined) return inside;
  let best: NearFootprint | undefined;
  for (const r of rows) {
    if (r.distanceM <= FOOTPRINT_SNAP_M && (best === undefined || r.distanceM < best.distanceM)) best = r;
  }
  return best;
}

/** A job that is not at this address, or an address that went away mid-request, is a 404 like any missing record. */
async function asNotFound<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof MeasurementPropertyNotFoundError) throw new AppError(404, MESSAGES.notFound);
    throw err;
  }
}

/** The middle of an outline (the mean of its corners), where Solar is asked about that building. */
function ringMiddle(ring: Ring): LngLat {
  const corners = ring.length > 1 && ring[0]![0] === ring.at(-1)![0] && ring[0]![1] === ring.at(-1)![1] ? ring.slice(0, -1) : ring;
  return [corners.reduce((t, p) => t + p[0], 0) / corners.length, corners.reduce((t, p) => t + p[1], 0) / corners.length];
}

/**
 * The Solar answer whose roof planes lie over `ring`: the one already asked when it does, else Solar asked again at
 * the outline's middle (its building can differ from the one nearest the address point). The first answer when
 * neither covers the outline, so the pitch falls back as before.
 */
async function solarCovering(deps: AppDeps, solar: SolarSnapshot | null, ring: Ring): Promise<SolarSnapshot | null> {
  // No answer at all (not set up, or Solar failed) is not retried here: the next measurement asks again.
  if (!deps.solar.configured || solar === null) return solar;
  const middle = ringMiddle(ring);
  if (pitchFromSolar(solar, ring, middle, 0).source === 'solar') return solar;
  const again = await solarAt(deps, middle);
  return again !== null && pitchFromSolar(again, ring, middle, 0).source === 'solar' ? again : solar;
}

/** The promise's value, or `fallback` when it takes longer than `ms` (it carries on in the background). */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([p.catch(() => fallback), late]).finally(() => clearTimeout(timer));
}

/** The centre of a ring's corners. */
function cornerMean(ring: Ring): LngLat {
  return ringMiddle(ring);
}

/** Whether a point lies inside a ring (ray casting; fine at a building's size). */
function insideRing(point: LngLat, ring: Ring): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** The share of a footprint inside a ring, by a grid of points over the footprint's box. */
function shareInside(footprint: Ring, ring: Ring): number {
  const lngs = footprint.map((p) => p[0]);
  const lats = footprint.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...lngs), Math.max(...lngs), Math.min(...lats), Math.max(...lats)];
  let inFoot = 0;
  let inBoth = 0;
  const n = 16;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const p: LngLat = [x0 + ((i + 0.5) / n) * (x1 - x0), y0 + ((j + 0.5) / n) * (y1 - y0)];
      if (!insideRing(p, footprint)) continue;
      inFoot++;
      if (insideRing(p, ring)) inBoth++;
    }
  }
  return inFoot > 0 ? inBoth / inFoot : 0;
}

/** Whether a 3D roof is the building a footprint outlines: either one's middle lies inside the other. */
function sameBuilding(roof: Roof3d, ring: Ring): boolean {
  return insideRing(cornerMean(ring), roof.outline) || insideRing(cornerMean(roof.outline), ring);
}

/**
 * The 3D roof to measure from: the snapshot's roof when it is the main footprint's building (or there is no footprint);
 * else the roof under the footprint's middle on layers already bought, when there is one. `snapshot` is what to keep.
 */
async function roof3dFor(
  deps: AppDeps,
  snapshot: Roof3dSnapshot | null,
  main: { ring: Ring } | undefined,
): Promise<{ roof: Roof3d | null; snapshot: Roof3dSnapshot | null }> {
  const roof = snapshot?.roof ?? null;
  if (roof === null || main === undefined || sameBuilding(roof, main.ring)) return { roof, snapshot };
  // The address point was on another roof than the footprint picked: that building, if the layers bought hold it.
  const again = await roof3dOnBoughtLayers(deps, cornerMean(main.ring));
  if (again?.roof != null && sameBuilding(again.roof, main.ring)) return { roof: again.roof, snapshot: again };
  return { roof: null, snapshot };
}

/**
 * A measurement made from the roof in 3D: its real outline, its faces (each with its own pitch) and lines. The
 * measurement's pitch is the faces' dominant one; footprints near the home are listed as before, the main one with
 * the 3D roof's outline, and any footprint mostly inside that outline (part of the same roof) left out.
 */
function roof3dInput(
  property: PropertyRow,
  point: LngLat,
  roof: Roof3d,
  snapshot: Roof3dSnapshot | null,
  rows: NearFootprint[],
  main: NearFootprint | undefined,
  settings: Settings,
  jobId: string | null,
  solar: SolarSnapshot | null,
): NewMeasurement {
  const outline: Outline = [roof.outline];
  const planes = roofPlanesFrom3d(roof);
  const pitchX12 = dominantPitchX12(planes) ?? seededPitchX12(property.id);
  const { estimate, roof: model } = measureRoof({ outline, pitchX12, overhangFt: settings.overhangFt, planes, roof3d: { roof, ownPitch: true } });
  const listed = main === undefined ? [] : rows.filter((r) => r.id === main.id || shareInside(r.ring, roof.outline) < PART_OF_ROOF_SHARE);
  return {
    propertyId: property.id,
    jobId,
    kind: 'estimate',
    method: 'outline',
    outline,
    structures: listed.map((r) =>
      r.id === main?.id
        ? { footprintId: r.id, included: true, areaSqFt: Math.round(polygonAreaSqFt(roof.outline) * 10) / 10, ring: roof.outline, main: true }
        : { footprintId: r.id, included: false, areaSqFt: r.areaSqFt, ring: r.ring },
    ),
    estimate,
    facets: model?.totals.facetCount ?? null,
    overhangFt: settings.overhangFt,
    center: point,
    pitchSource: 'solar-3d',
    pitchPlanes: planes,
    solar,
    roof3d: snapshot,
  };
}

/** What a measurement keeps of its pitch: the pitch, where it came from, Solar's planes and the Solar answer. */
function pitchFields(pick: PitchPick, solar: SolarSnapshot | null): Pick<NewMeasurement, 'pitchSource' | 'pitchPlanes' | 'solar'> {
  return { pitchSource: pick.source, pitchPlanes: pick.planes, solar };
}

function outlineInput(
  property: PropertyRow,
  point: LngLat,
  main: NearFootprint,
  rows: NearFootprint[],
  settings: Settings,
  jobId: string | null,
  solar: SolarSnapshot | null,
  roof3d: Roof3dSnapshot | null = null,
): NewMeasurement {
  const outline: Outline = [main.ring];
  // The pitch is Google Solar's for this roof when it has one; otherwise it is chosen per home (4/12 to 7/12, the
  // same every time), so the roof drawn and the estimate priced from it agree. The rep can still change it.
  const pick = pitchFromSolar(solar, main.ring, point, seededPitchX12(property.id));
  const { estimate, roof } = measureRoof({ outline, pitchX12: pick.pitchX12, overhangFt: settings.overhangFt, planes: pick.planes });
  return {
    propertyId: property.id,
    jobId,
    kind: 'estimate',
    method: 'outline',
    outline,
    // The building measured is marked `main` (only that entry carries the key): the rep can include others later.
    structures: rows.map((r) => ({
      footprintId: r.id,
      included: r.id === main.id,
      areaSqFt: r.areaSqFt,
      ring: r.ring,
      ...(r.id === main.id ? { main: true } : {}),
    })),
    estimate,
    facets: roof?.totals.facetCount ?? null,
    overhangFt: settings.overhangFt,
    center: point,
    ...pitchFields(pick, solar),
    roof3d,
  };
}

/** No footprint near the home, but Google Solar has its roof: the outline is made from Solar's roof planes. */
function solarOutlineInput(
  property: PropertyRow,
  point: LngLat,
  outline: Outline,
  settings: Settings,
  jobId: string | null,
  solar: SolarSnapshot,
  roof3d: Roof3dSnapshot | null = null,
): NewMeasurement {
  const pick = pitchFromSolar(solar, outline[0] ?? null, point, seededPitchX12(property.id));
  const { estimate, roof } = measureRoof({ outline, pitchX12: pick.pitchX12, overhangFt: settings.overhangFt, planes: pick.planes });
  return {
    propertyId: property.id,
    jobId,
    kind: 'estimate',
    method: 'outline',
    outline,
    structures: [],
    estimate,
    facets: roof?.totals.facetCount ?? null,
    overhangFt: settings.overhangFt,
    center: point,
    ...pitchFields(pick, solar),
    roof3d,
  };
}

function drawInput(
  property: PropertyRow,
  center: LngLat,
  settings: Settings,
  jobId: string | null,
  solar: SolarSnapshot | null = null,
  roof3d: Roof3dSnapshot | null = null,
): NewMeasurement {
  // Draw mode still knows the roof's pitch when Google Solar has the building at the home.
  const pick = pitchFromSolar(solar, null, center, settings.pitchX12);
  return {
    propertyId: property.id,
    jobId,
    kind: 'estimate',
    method: 'outline',
    outline: null,
    structures: [],
    estimate: instantEstimate({ outline: [], pitchX12: pick.pitchX12, overhangFt: settings.overhangFt }),
    overhangFt: settings.overhangFt,
    center,
    ...pitchFields(pick, solar),
    roof3d,
  };
}

/** The Solar outline for a home with no footprint: only for Google's building at (or within 30 m of) the home. */
function solarOutline(solar: SolarSnapshot | null, point: LngLat): Outline | null {
  const building = solar?.building ?? null;
  if (building === null || metresToBuilding(building, point) > SOLAR_BUILDING_SNAP_M) return null;
  const ring = outlineFromSolar(building);
  return ring === null ? null : [ring];
}

/** The zoom-9 footprint tiles a home at `point` needs, and the state they are queued under. */
function tilesFor(property: PropertyRow, point: LngLat): { tiles: string[]; state: string } {
  return { tiles: footprintTilesNear(point[0], point[1], FOOTPRINT_TILE_MARGIN_M), state: property.state.trim().toUpperCase() };
}

/**
 * Measures a home from its building outline, or opens draw mode when no source has the roof.
 * - `propertyId` names a saved address the caller may see (404 otherwise); `address` is looked up
 *   with the geocoder and saved (or reused) first. Neither is a 400.
 * - A home with no point is looked up once more; still none means draw mode centred on the US. `at` (a roof
 *   clicked on the map) is measured instead of the home's saved point.
 * - The footprints are loaded per zoom-9 tile: the point's own tile, plus the tile next door when the
 *   point is within FOOTPRINT_TILE_MARGIN_M of its edge. A tile that is not ready is loaded during this
 *   request (or waited for, when another process is loading it), for up to FOOTPRINT_WAIT_MS: the first
 *   measurement in an area takes about 30 seconds, later ones are instant. Meanwhile Google Solar is asked
 *   about the point (once per home: the answer is kept on the measurement).
 * - The footprints near the point decide: the one containing it, or the nearest within 30 m, is the main
 *   structure; every nearby footprint is listed, only the main one included. Its pitch is Google Solar's
 *   (per facet where a Solar plane fits, else the roof's dominant pitch), or the per-home default.
 * - No footprint (none there, or the tiles did not load in time): Google Solar's building at the home gives
 *   the outline. Only when neither has the roof is it draw mode.
 * - Before all of that: the roof in 3D. Google Solar's height map and roof mask (Data Layers, bought once per roof
 *   and kept on the measurement) are reconstructed into the roof's real outline, faces (each with its own pitch)
 *   and lines. When that roof is the main footprint's building (or there is no footprint), the measurement is made
 *   from it (pitch source 'solar-3d'); otherwise (no imagery, no roof found, another building, or not ready within
 *   ROOF_3D_WAIT_MS) it is made as above, and what was bought is still kept.
 * Never throws for missing or bad geometry: that is draw mode.
 */
export async function measureProperty(
  deps: AppDeps,
  ctx: TenantContext,
  i: { propertyId?: string; address?: string; jobId?: string | null; footprint?: SelectedFootprint; at?: LngLat },
): Promise<MeasurementView> {
  const now = deps.clock.now();
  const jobId = i.jobId ?? null;

  let property: PropertyRow;
  if (i.propertyId !== undefined) {
    const propertyId = i.propertyId;
    const found = await withTenant(deps.pools, ctx, (tx) => getProperty(tx, ctx, propertyId));
    if (found === null) throw new AppError(404, MESSAGES.notFound);
    property = found;
  } else if (i.address !== undefined) {
    property = await homeFromAddress(deps, ctx, i.address, now);
  } else {
    throw new AppError(400, PICK_ADDRESS_MESSAGE, 'address');
  }

  if (i.footprint !== undefined) return measureOnFootprint(deps, ctx, property, i.footprint, jobId, now);

  // `at`: the roof a person clicked on the map, which may not be where the home's saved point is
  const point = i.at ?? (await pointOf(deps, ctx, property, now));
  if (point === null) {
    return asNotFound(() =>
      withTenant(deps.pools, ctx, async (tx) =>
        createMeasurement(tx, ctx, drawInput(property, US_MAP_CENTER, await settingsFor(tx, ctx), jobId), now),
      ),
    );
  }

  // Google Solar, its height map (the roof in 3D) and the footprint tiles at once: all network work, none in a
  // transaction.
  const solarAsked = solarForHome(deps, ctx, property.id, point);
  const roof3dAsked = within(
    roof3dForHome(deps, ctx, property.id, point, solarAsked.then((sol) => sol?.building ?? null)),
    ROOF_3D_WAIT_MS,
    null,
  );
  const { tiles, state } = tilesFor(property, point);
  const tilesOutcome = await ensureFootprintTiles(deps, tiles, { state, waitMs: deps.config.FOOTPRINT_WAIT_MS });
  if (tilesOutcome !== 'ready') {
    // Not loaded in time (it carries on here), or a load failed: the worker tries again too.
    for (const quadkey of tiles) {
      await deps.jobs.send('footprints-load', { companyId: ctx.companyId, quadkey, state }, { singletonKey: quadkey });
    }
  }
  const askedSolar = await solarAsked;
  const rows = await withTenant(deps.pools, ctx, (tx) => footprintsNear(tx, point, FOOTPRINT_SEARCH_M));
  const picked = mainOf(rows);
  // Solar answers for the building nearest the address point, which can be the neighbour of the outline picked here.
  const solar = picked === undefined ? askedSolar : await solarCovering(deps, askedSolar, picked.ring);
  // The roof in 3D, when Google has it for this building: its real outline, faces and lines.
  const r3 = await roof3dFor(deps, await roof3dAsked, picked);

  return asNotFound(() =>
    withTenant(deps.pools, ctx, async (tx) => {
      const settings = await settingsFor(tx, ctx);
      const main = picked;
      if (r3.roof !== null) {
        const view = await createMeasurement(tx, ctx, roof3dInput(property, point, r3.roof, r3.snapshot, rows, main, settings, jobId, solar), now);
        if (main !== undefined) await setPropertyFootprint(tx, ctx, property.id, main.id);
        return view;
      }
      if (main === undefined) {
        const outline = solarOutline(solar, point);
        if (outline !== null) return createMeasurement(tx, ctx, solarOutlineInput(property, point, outline, settings, jobId, solar!, r3.snapshot), now);
        return createMeasurement(tx, ctx, drawInput(property, point, settings, jobId, solar, r3.snapshot), now);
      }
      const view = await createMeasurement(tx, ctx, outlineInput(property, point, main, rows, settings, jobId, solar, r3.snapshot), now);
      await setPropertyFootprint(tx, ctx, property.id, main.id);
      return view;
    }),
  );
}

/**
 * The map's "Estimate this roof": the picked building is the main structure, whatever the home's saved point
 * says; every footprint near it is listed (only the picked one included), as for a typed address.
 */
async function measureOnFootprint(
  deps: AppDeps,
  ctx: TenantContext,
  property: PropertyRow,
  picked: SelectedFootprint,
  jobId: string | null,
  now: Date,
): Promise<MeasurementView> {
  const solarAsked = solarForHome(deps, ctx, property.id, picked.point);
  const roof3dAsked = within(
    roof3dForHome(deps, ctx, property.id, picked.point, solarAsked.then((sol) => sol?.building ?? null)),
    ROOF_3D_WAIT_MS,
    null,
  );
  const solar = await solarCovering(deps, await solarAsked, picked.ring);
  const r3 = await roof3dFor(deps, await roof3dAsked, picked);
  return asNotFound(() =>
    withTenant(deps.pools, ctx, async (tx) => {
      const settings = await settingsFor(tx, ctx);
      const near = await footprintsNear(tx, picked.point, FOOTPRINT_SEARCH_M);
      const main: NearFootprint = near.find((r) => r.id === picked.id) ?? { id: picked.id, ring: picked.ring, areaSqFt: picked.areaSqFt, contains: true, distanceM: 0 };
      const rows = near.some((r) => r.id === picked.id) ? near : [main, ...near];
      const input =
        r3.roof !== null
          ? roof3dInput(property, picked.point, r3.roof, r3.snapshot, rows, main, settings, jobId, solar)
          : outlineInput(property, picked.point, main, rows, settings, jobId, solar, r3.snapshot);
      const view = await createMeasurement(tx, ctx, input, now);
      await setPropertyFootprint(tx, ctx, property.id, picked.id);
      return view;
    }),
  );
}

/**
 * The Measure search's head start: as soon as an address is typed (before Measure is pressed), it is looked up and
 * the area's footprint tiles start loading (nobody waits for them here), Google Solar is asked about the point, and
 * the roof is reconstructed in 3D from Google's height map (both kept in this process for the Measure that follows;
 * a saved home with a fresh 3D roof on its measurements buys nothing). Nothing is saved. `found` is false when the
 * address is not found; an unreachable geocoder is a 503 like Measure's.
 */
export async function prefetchMeasure(
  deps: AppDeps,
  ctx: TenantContext,
  i: { propertyId?: string; address?: string },
): Promise<{ found: boolean }> {
  let point: LngLat | null = null;
  let state: string | undefined;
  const propertyId = i.propertyId;
  let savedHome: PropertyRow | null = null;
  if (propertyId !== undefined) {
    const found = await withTenant(deps.pools, ctx, (tx) => getProperty(tx, ctx, propertyId));
    if (found === null) throw new AppError(404, MESSAGES.notFound);
    point = found.geom ?? null;
    state = found.state.trim().toUpperCase();
  } else if (i.address !== undefined) {
    const found = await lookUp(deps, i.address);
    if (found === 'unavailable') throw new AppError(503, UNAVAILABLE_MESSAGE);
    if (found !== null) {
      point = [found.lng, found.lat];
      state = found.state?.trim().toUpperCase();
      // An address already saved keeps its 3D roof on its measurements: no need to buy it again.
      if (found.street !== null && found.zip !== null) savedHome = await findSaved(deps, ctx, found.street, found.zip);
    }
  }
  if (point === null) return { found: false };
  // A saved home is measured at its saved point: the 3D roof is asked for there, so Measure finds it.
  const at = savedHome?.geom ?? point;
  const tiles = footprintTilesNear(point[0], point[1], FOOTPRINT_TILE_MARGIN_M);
  const asked = solarAt(deps, at);
  // The roof in 3D (Google's height map, a paid request) starts now too, unless the home already has a fresh one kept.
  const roof3d = (async () => {
    const homeId = propertyId ?? (savedHome !== null ? savedHome.id : undefined);
    if (homeId !== undefined) await roof3dForHome(deps, ctx, homeId, at, asked.then((sol) => sol?.building ?? null));
    else await roof3dAt(deps, at, (await asked)?.building ?? null);
  })();
  const work = Promise.allSettled([
    ensureFootprintTiles(deps, tiles, { ...(state !== undefined ? { state } : {}), waitMs: 0 }),
    asked,
    roof3d,
  ]).then(() => undefined);
  deps.onBackgroundTask?.(work);
  return { found: true };
}
