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
  footprintTilesNear,
  instantEstimate,
  isTimeZone,
  measureRoof,
  type MeasurementView,
  normalizeAddressKey,
  metresToBuilding,
  type Outline,
  outlineFromSolar,
  type Ring,
  seededPitchX12,
  type SolarSnapshot,
} from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { type GeocodeResult, GeocoderUnavailableError } from '../providers/geocoder.ts';
import { ensureFootprintTiles } from './footprint-tiles.ts';
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
    structures: rows.map((r) => ({ footprintId: r.id, included: r.id === main.id, areaSqFt: r.areaSqFt, ring: r.ring })),
    estimate,
    facets: roof?.totals.facetCount ?? null,
    overhangFt: settings.overhangFt,
    center: point,
    ...pitchFields(pick, solar),
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
  };
}

function drawInput(property: PropertyRow, center: LngLat, settings: Settings, jobId: string | null, solar: SolarSnapshot | null = null): NewMeasurement {
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

  // Google Solar and the footprint tiles at once: both are network work, neither in a transaction.
  const solarAsked = solarForHome(deps, ctx, property.id, point);
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

  return asNotFound(() =>
    withTenant(deps.pools, ctx, async (tx) => {
      const settings = await settingsFor(tx, ctx);
      const main = picked;
      if (main === undefined) {
        const outline = solarOutline(solar, point);
        if (outline !== null) return createMeasurement(tx, ctx, solarOutlineInput(property, point, outline, settings, jobId, solar!), now);
        return createMeasurement(tx, ctx, drawInput(property, point, settings, jobId, solar), now);
      }
      const view = await createMeasurement(tx, ctx, outlineInput(property, point, main, rows, settings, jobId, solar), now);
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
  const solar = await solarCovering(deps, await solarForHome(deps, ctx, property.id, picked.point), picked.ring);
  return asNotFound(() =>
    withTenant(deps.pools, ctx, async (tx) => {
      const settings = await settingsFor(tx, ctx);
      const near = await footprintsNear(tx, picked.point, FOOTPRINT_SEARCH_M);
      const main: NearFootprint = near.find((r) => r.id === picked.id) ?? { id: picked.id, ring: picked.ring, areaSqFt: picked.areaSqFt, contains: true, distanceM: 0 };
      const rows = near.some((r) => r.id === picked.id) ? near : [main, ...near];
      const view = await createMeasurement(tx, ctx, outlineInput(property, picked.point, main, rows, settings, jobId, solar), now);
      await setPropertyFootprint(tx, ctx, property.id, picked.id);
      return view;
    }),
  );
}

/**
 * The Measure search's head start: as soon as an address is typed (before Measure is pressed), it is looked up and
 * the area's footprint tiles start loading (nobody waits for them here), and Google Solar is asked about the point
 * (kept in this process for the Measure that follows). Nothing is saved. `found` is false when the address is not
 * found; an unreachable geocoder is a 503 like Measure's.
 */
export async function prefetchMeasure(
  deps: AppDeps,
  ctx: TenantContext,
  i: { propertyId?: string; address?: string },
): Promise<{ found: boolean }> {
  let point: LngLat | null = null;
  let state: string | undefined;
  if (i.propertyId !== undefined) {
    const propertyId = i.propertyId;
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
    }
  }
  if (point === null) return { found: false };
  const tiles = footprintTilesNear(point[0], point[1], FOOTPRINT_TILE_MARGIN_M);
  const work = Promise.allSettled([
    ensureFootprintTiles(deps, tiles, { ...(state !== undefined ? { state } : {}), waitMs: 0 }),
    solarAt(deps, point),
  ]).then(() => undefined);
  deps.onBackgroundTask?.(work);
  return { found: true };
}
