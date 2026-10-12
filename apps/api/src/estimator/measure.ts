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
import { footprintStateStatus } from '@roofline/db/system';
import { instantEstimate, isTimeZone, isUsStateCode, type MeasurementView, normalizeAddressKey, type Outline } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { type GeocodeResult, GeocoderUnavailableError } from '../providers/geocoder.ts';

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

type NearFootprint = Awaited<ReturnType<typeof footprintsNear>>[number];
type Settings = { pitchX12: number; overhangFt: number };

/** The geocoder, with its outage turned into a plain value (provider calls never run inside a transaction). */
async function lookUp(deps: AppDeps, text: string): Promise<GeocodeResult | null | 'unavailable'> {
  try {
    return await deps.geocoder.geocode(text);
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

  const saved = await findSaved(deps, ctx, street, zip);
  if (saved !== null) return saved;

  const timezone = found.timezone !== null && isTimeZone(found.timezone) ? found.timezone : null;
  const location: LngLat = [found.lng, found.lat];
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

function outlineInput(
  property: PropertyRow,
  point: LngLat,
  main: NearFootprint,
  rows: NearFootprint[],
  settings: Settings,
  jobId: string | null,
): NewMeasurement {
  const outline: Outline = [main.ring];
  return {
    propertyId: property.id,
    jobId,
    kind: 'estimate',
    method: 'outline',
    outline,
    structures: rows.map((r) => ({ footprintId: r.id, included: r.id === main.id, areaSqFt: r.areaSqFt, ring: r.ring })),
    estimate: instantEstimate({ outline, pitchX12: settings.pitchX12, overhangFt: settings.overhangFt }),
    overhangFt: settings.overhangFt,
    center: point,
  };
}

function drawInput(property: PropertyRow, center: LngLat, settings: Settings, jobId: string | null): NewMeasurement {
  return {
    propertyId: property.id,
    jobId,
    kind: 'estimate',
    method: 'outline',
    outline: null,
    structures: [],
    estimate: instantEstimate({ outline: [], pitchX12: settings.pitchX12, overhangFt: settings.overhangFt }),
    overhangFt: settings.overhangFt,
    center,
  };
}

/**
 * Measures a home from its building outline, or opens draw mode when there is no outline to use.
 * - `propertyId` names a saved address the caller may see (404 otherwise); `address` is looked up
 *   with the geocoder and saved (or reused) first. Neither is a 400.
 * - A home with no point is looked up once more; still none means draw mode centred on the US.
 * - When the state's footprints are not loaded yet, one `footprints-load` job is queued (singleton
 *   per state) and the answer is draw mode.
 * - Otherwise the footprints near the point decide: the one containing it, or the nearest within
 *   30 m, is the main structure; every nearby footprint is listed, only the main one included.
 * Never throws for missing or bad geometry: that is draw mode.
 */
export async function measureProperty(
  deps: AppDeps,
  ctx: TenantContext,
  i: { propertyId?: string; address?: string; jobId?: string | null },
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

  const point = await pointOf(deps, ctx, property, now);
  if (point === null) {
    return asNotFound(() =>
      withTenant(deps.pools, ctx, async (tx) =>
        createMeasurement(tx, ctx, drawInput(property, US_MAP_CENTER, await settingsFor(tx, ctx), jobId), now),
      ),
    );
  }

  const state = property.state.trim().toUpperCase();
  // Only a state with a footprint file is ever loaded: a territory or a free-text state opens draw mode.
  const status = isUsStateCode(state) ? await footprintStateStatus(deps.pools.system, state) : null;
  if (status !== 'ready') {
    if (isUsStateCode(state)) await deps.jobs.send('footprints-load', { companyId: ctx.companyId, state }, { singletonKey: state });
    return asNotFound(() =>
      withTenant(deps.pools, ctx, async (tx) =>
        createMeasurement(tx, ctx, drawInput(property, point, await settingsFor(tx, ctx), jobId), now),
      ),
    );
  }

  return asNotFound(() =>
    withTenant(deps.pools, ctx, async (tx) => {
      const settings = await settingsFor(tx, ctx);
      const rows = await footprintsNear(tx, point, FOOTPRINT_SEARCH_M);
      const main = mainOf(rows);
      if (main === undefined) {
        return createMeasurement(tx, ctx, drawInput(property, point, settings, jobId), now);
      }
      const view = await createMeasurement(tx, ctx, outlineInput(property, point, main, rows, settings, jobId), now);
      await setPropertyFootprint(tx, ctx, property.id, main.id);
      return view;
    }),
  );
}
