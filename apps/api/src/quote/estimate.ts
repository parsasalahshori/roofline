import {
  companyDayStart,
  countMeasuredSince,
  findCachedEstimate,
  latestSolarSnapshot,
  insertQuoteEstimate,
  noteEstimateReused,
  type PropertyRow,
  quoteInputKey,
  type QuoteEstimateRow,
  type TenantContext,
  withTenant,
  zoneDayStart,
  getWindowCatalog,
} from '@roofline/db';
import {
  type InstantQuoteSettings,
  metresToBuilding,
  type LngLat,
  type MeasurementView,
  normalizeAddressKey,
  priceRange,
  priceWindows,
  type PriceRange,
  type PublicQuoteEstimate,
  QUOTE_LIMITS,
  QUOTE_WINDOW_COUNT,
  type PublicQuoteWindows,
  scaleWindowMix,
  windowCounts,
  type WindowCounts,
  type WindowTier,
  type WindowSizeClass,
  WINDOW_SIZE_CLASSES,
} from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError } from '../errors.ts';
import { priceOptions } from '../estimator/build.ts';
import { lookUpHome, measureProperty } from '../estimator/measure.ts';
import { heightLayersFor } from '../estimator/roof-3d.ts';
import { SOLAR_BUILDING_SNAP_M, solarForHome } from '../estimator/solar.ts';
import { estimateAllSides } from '../estimator/windows-estimate.ts';
import { eaveHeightAboveGround } from '../estimator/windows-heights.ts';
import { wallsFor } from '../estimator/windows-view.ts';
import {
  type LookupFacts,
  lookupGate,
  measurementGate,
  metresOutsideRing,
  type QuoteCallbackReason,
  rangePctFor,
  type SatelliteProblem,
  satelliteGate,
  typedUnit,
} from './gates.ts';

/*
 * POST /api/public/quote/:slug/estimate: one typed address in, RANGES out. The roof is measured the way the
 * estimator measures it (measureProperty: footprints, Google Solar, the roof in 3D) and priced with the company's
 * own templates (priceOptions), then widened by the company's range and rounded to hundreds of dollars; windows are
 * the walls-only estimate (no Street View), priced with the window tiers. Only the ranges, a rounded roof size, a
 * window count and a small outline leave this file: never a tier's price, the price book or a measurement id.
 * Gutters are never priced here (the roof's eaves read short): they are priced at the visit.
 *
 * Never a confident wrong price: the checks in gates.ts send an apartment, a commercial building, a lookup that
 * missed the house or a roof that needs a person's look to 'fallback' (we'll call you); why is kept in the stored
 * result (`callback`), with what the lookup said (`lookup`), and never sent to the page.
 *
 * Cost guard: an address measured in the last 30 days is answered from storage (no paid call); past the company's
 * daily cap of priced measurements the page gets 'fallback' and still takes the request. A home measured and then
 * sent to a call back does not use up the cap, but every measurement counts toward a ceiling of twice the cap.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOT_FOUND = "We couldn't find that address. Please check the street, city and ZIP.";
/** The roof outline sent for the picture: at most this many corners (a house has a few dozen). */
const MAX_OUTLINE_POINTS = 80;
/** How long the windows' wall height may wait for Google's height map (usually already bought for the roof). */
const HEIGHTS_BUDGET_MS = 6000;
/** Every measurement of a day (priced or sent to a call back) stays under this many times the daily cap. */
const CEILING_TIMES_CAP = 2;

/** Fresh measurements running now, per company: counted against the cap so a burst cannot overshoot it. */
const inflight = new Map<string, number>();

/**
 * What a stored estimate's `result` carries beyond the public answer (all optional: older rows lack the newer ones).
 * `callback`: why the page's checks sent the address to a call back; `lookup`: what the address lookup said (never sent
 * to a page); `windowMix`: the estimated windows per size class; `floors` and `windowCountRange`: for the homeowner
 * app's home facts and its "did we miss any" check.
 */
export type StoredEstimateResult = {
  callback?: StoredCallback;
  /** Why the satellite pictures were not trusted for this home (staff only), with the imagery's facts; see satelliteGate. */
  satellite?: StoredSatellite;
  windowMix?: Partial<Record<WindowSizeClass, number>>;
  windowPct?: number;
  floors?: number | null;
  windowCountRange?: { low: number; high: number } | null;
};

/** The windows as the page gets them: the count, its plausible range (never narrower than the likely count) and the price. */
function windowsView(w: { count: number; range: PriceRange } | null, countRange: { low: number; high: number } | null): PublicQuoteEstimate['windows'] {
  if (w === null) return null;
  return { ...w, countRange: { low: Math.min(countRange?.low ?? w.count, w.count), high: Math.max(countRange?.high ?? w.count, w.count) } };
}

export type StoredSatellite = { problems: SatelliteProblem[]; quality: string | null; date: string | null; roofAsked: boolean };

/** The public answer a stored row carries (its result plus its id). */
export function estimateView(row: QuoteEstimateRow): PublicQuoteEstimate {
  const r = row.result as Omit<PublicQuoteEstimate, 'quoteId' | 'windows'> & { windows?: { count: number; range: PriceRange } | null; satellite?: StoredSatellite; windowCountRange?: { low: number; high: number } | null };
  const notice = r.satellite?.roofAsked === true ? ('satellite-unusable' as const) : null;
  return { quoteId: row.id, status: row.status, address: row.address, roof: r.roof ?? null, windows: windowsView(r.windows ?? null, r.windowCountRange ?? null), gutters: r.gutters ?? null, outline: r.outline ?? null, ...(notice !== null && { notice }) };
}

function lineOf(p: Pick<PropertyRow, 'addressLine' | 'city' | 'state' | 'zip'>): string {
  return `${p.addressLine}, ${p.city}, ${p.state} ${p.zip}`;
}

/** The main roof's open ring: the main structure's footprint, else the outline. */
function mainRing(view: MeasurementView): LngLat[] | null {
  const main = view.structures.find((s) => s.main) ?? view.structures.find((s) => s.included);
  const ring = view.outline?.[0] ?? main?.ring ?? null;
  if (ring === null || ring.length < 3) return null;
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  const open = first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring;
  return open.map((p) => [p[0], p[1]] as LngLat);
}

/** Every k-th corner so the picture's outline stays small; 6 decimals (about 10 cm). */
function thin(ring: readonly LngLat[]): LngLat[] {
  const step = Math.max(1, Math.ceil(ring.length / MAX_OUTLINE_POINTS));
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  return ring.filter((_, i) => i % step === 0).map(([x, y]) => [r6(x), r6(y)] as LngLat);
}

/** The roof's range from the company's own three options (the enabled ones), or null when it cannot be priced. */
async function roofRange(deps: AppDeps, ctx: TenantContext, view: MeasurementView, pct: number): Promise<{ squares: number; range: PriceRange } | null> {
  if (view.drawMode || view.estimate.surfaceSqFt <= 0) return null;
  try {
    const options = await withTenant(deps.pools, ctx, (tx) =>
      priceOptions(tx, ctx, {
        id: view.id,
        propertyId: view.propertyId,
        jobId: null,
        kind: view.kind,
        surfaceSqFt: view.estimate.surfaceSqFt,
        pitchX12: view.estimate.pitchX12,
        edgeFt: view.estimate.edgeFt,
        ridgeFt: view.estimate.ridgeFt,
        valleyFt: view.estimate.valleyFt,
      }),
    );
    const enabled = options.filter((o) => o.enabled);
    const range = priceRange((enabled.length > 0 ? enabled : options).map((o) => o.totalCents), pct);
    if (range === null) return null;
    // Rounded to the half square: a size, not a measurement to quote from.
    return { squares: Math.round(view.estimate.squares * 2) / 2, range };
  } catch (err) {
    if (err instanceof AppError) return null; // too large or nothing to price: we call instead
    throw err;
  }
}

/** The eave's height above the ground from Google's height map (usually already bought for the roof), or null. */
async function eaveOf(deps: AppDeps, ctx: TenantContext, property: PropertyRow, point: LngLat, ring: LngLat[]): Promise<number | null> {
  try {
    const solar = await solarForHome(deps, ctx, property.id, point);
    const layers = await heightLayersFor(deps, point, solar?.building ?? null, HEIGHTS_BUDGET_MS);
    return layers === null ? null : eaveHeightAboveGround(layers, ring);
  } catch (err) {
    deps.logError?.(err, 'quote-heights');
    return null;
  }
}

type WindowMix = Record<WindowSizeClass, number>;

/** The window tiers' range for a count of each size. */
function rangeOfMix(mix: WindowMix, pct: number, tiers?: readonly WindowTier[]): PriceRange | null {
  const counts = Object.fromEntries(WINDOW_SIZE_CLASSES.map((c) => [c, { measured: 0, estimated: mix[c] }])) as WindowCounts;
  return priceRange(priceWindows(counts, tiers).map((q) => q.totalCents), pct);
}

/**
 * The walls estimate (every side, no photos), its price range, its mix of sizes, the floors (null when the height is
 * not known and one floor is only assumed) and the plausible window-count range, or null without an outline.
 */
function windowsRange(
  ring: LngLat[],
  eaveHeightM: number | null,
  pct: number,
  tiers?: readonly WindowTier[],
): { count: number; range: PriceRange; mix: WindowMix; floors: number | null; countRange: { low: number; high: number } | null } | null {
  const walls = wallsFor({ ring, camera: null, eaveHeightM, outlineSource: 'footprint' }, []);
  if (walls === null) return null;
  const estimated = estimateAllSides(walls);
  const counts = windowCounts({ windows: [], estimated, adjustments: { excludedWindowIds: [], manualCounts: {} } });
  const mix = Object.fromEntries(WINDOW_SIZE_CLASSES.map((c) => [c, counts[c].estimated])) as WindowMix;
  const count = WINDOW_SIZE_CLASSES.reduce((n, c) => n + mix[c], 0);
  if (count === 0) return null;
  const range = rangeOfMix(mix, pct, tiers);
  return range === null ? null : { count, range, mix, floors: walls.heightSource === 'assumed' ? null : walls.floors, countRange: estimated.range ?? null };
}

/** `mix` scaled to `count` windows in all, keeping its shares (largest remainders); all 'standard' with no mix. */
export const scaleMix: (mix: Partial<WindowMix> | null, count: number) => WindowMix = scaleWindowMix;

/**
 * The windows range for the homeowner's own count (QUOTE_WINDOW_COUNT, 1 to 80), from a stored 'ready' estimate with
 * windows: the estimate's mix of sizes scaled to that count, at the width the estimate was priced at. Null when the
 * estimate has no windows. The stored estimate is never changed (another visitor of the address shares it).
 */
export function windowsForCount(row: QuoteEstimateRow, count: number, fallbackPct: number, tiers?: readonly WindowTier[]): PublicQuoteWindows | null {
  const r = row.result as { windows?: { count: number } | null; windowMix?: Partial<WindowMix>; windowPct?: number };
  if (row.status !== 'ready' || !r.windows) return null;
  const n = Math.min(QUOTE_WINDOW_COUNT.max, Math.max(QUOTE_WINDOW_COUNT.min, Math.round(count)));
  const range = rangeOfMix(scaleMix(r.windowMix ?? null, n), typeof r.windowPct === 'number' ? r.windowPct : fallbackPct, tiers);
  return range === null ? null : { count: n, range };
}

export type Place = { property: PropertyRow | null; addressKey: string | null; address: string; lookup: LookupFacts | null };

/**
 * The typed address looked up and saved as one of the company's addresses (Geocodio, no Google). A unit the lookup
 * read (or one typed that it dropped) stays on the saved street line, so the request is filed under the flat.
 */
export async function locate(deps: AppDeps, ctx: TenantContext, address: string): Promise<Place> {
  try {
    const { property, found } = await lookUpHome(deps, ctx, address, deps.clock.now(), { keepUnit: (f) => f.unit ?? typedUnit(address) });
    const lookup: LookupFacts = {
      accuracy: found.accuracy,
      accuracyType: found.accuracyType,
      unit: found.unit ?? null,
      number: found.number ?? null,
      streetName: found.streetName ?? null,
    };
    return { property, addressKey: normalizeAddressKey(property.addressLine, property.zip), address: lineOf(property), lookup };
  } catch (err) {
    if (err instanceof AppError && err.status === 400) throw new AppError(422, NOT_FOUND, 'address');
    // The lookup is down: no estimate, but the request can still be taken (we call instead).
    if (err instanceof AppError && err.status === 503) return { property: null, addressKey: null, address, lookup: null };
    throw err;
  }
}

/** The call backs a measurement decided: the same home's answer whoever asks, however it was typed. */
const MEASURED_CALLBACKS: ReadonlySet<string> = new Set<QuoteCallbackReason>(['roof-review', 'outline-off-house', 'too-big', 'flat-unmeasured']);

/** Why a stored call back was decided (gates.ts), plus 'visit-only': the page offers nothing priced online. */
export type StoredCallback = QuoteCallbackReason | 'visit-only';

export type EstimateInput = { address: string; ipHash: string | null };

/**
 * The estimate for one typed address. Order: the 30-day cache by typed text (no lookup at all), the address lookup,
 * the cache by found address, the daily cap, then the measurement. Throws AppError(422) for an address not found.
 */
export async function estimateForAddress(
  deps: AppDeps,
  ctx: TenantContext,
  settings: InstantQuoteSettings,
  input: EstimateInput,
): Promise<PublicQuoteEstimate> {
  const now = deps.clock.now();
  const inputKey = quoteInputKey(input.address);
  const expiresAt = new Date(now.getTime() + QUOTE_LIMITS.cacheDays * DAY_MS);

  const typed = await withTenant(deps.pools, ctx, async (tx) => {
    const hit = await findCachedEstimate(tx, ctx, { inputKey }, now);
    if (hit) await noteEstimateReused(tx, ctx, hit.id, now);
    return hit;
  });
  if (typed) return estimateView(typed);

  const place = await locate(deps, ctx, input.address);
  const lookup = place.lookup === null ? null : { accuracy: place.lookup.accuracy, accuracyType: place.lookup.accuracyType, unit: place.lookup.unit };

  /** A call back. `callback`: why, when the page's checks decided it (stored, and reused like a price). */
  const fallback = async (o: { callback?: StoredCallback; measurementId?: string; satellite?: StoredSatellite } = {}): Promise<PublicQuoteEstimate> => {
    const row = await withTenant(deps.pools, ctx, (tx) =>
      insertQuoteEstimate(
        tx,
        ctx,
        {
          inputKey,
          addressKey: place.addressKey,
          address: place.address,
          status: 'fallback',
          measured: o.measurementId !== undefined,
          propertyId: place.property?.id ?? null,
          measurementId: o.measurementId ?? null,
          result: { roof: null, windows: null, gutters: null, outline: null, ...(o.callback !== undefined && { callback: o.callback }), ...(o.satellite !== undefined && { satellite: o.satellite }), lookup },
          ipHash: input.ipHash,
          expiresAt,
        },
        now,
      ),
    );
    return estimateView(row);
  };

  if (place.property === null || place.addressKey === null || place.lookup === null) return fallback();
  const property = place.property;
  const addressKey = place.addressKey;

  // The lookup's own doubts first: nothing is measured for a flat, an office suite or a point off the house.
  const before = lookupGate(input.address, place.lookup);
  if (before !== null) return fallback({ callback: before });

  const wantsRoof = settings.products.includes('roof');
  const wantsWindows = settings.products.includes('windows');
  // Only gutters on the page: they are priced at the visit, so there is nothing to measure.
  if (!wantsRoof && !wantsWindows) return fallback({ callback: 'visit-only' });

  // By the found address, a call back is reused only when the measurement decided it: one the lookup decided was
  // about how the address was typed (a unit, another street), which this visitor typed differently.
  const found = await withTenant(deps.pools, ctx, async (tx) => {
    const hit = await findCachedEstimate(tx, ctx, { addressKey }, now);
    const callback = (hit?.result as { callback?: string } | undefined)?.callback;
    if (hit === null || (callback !== undefined && !MEASURED_CALLBACKS.has(callback))) return null;
    await noteEstimateReused(tx, ctx, hit.id, now);
    return hit;
  });
  if (found) return estimateView(found);

  // The daily cap counts priced measurements since the company's local midnight, plus the ones running now; every
  // measurement of the day (call backs too) stays under the ceiling.
  const { priced, all } = await withTenant(deps.pools, ctx, async (tx) => {
    const { day, zone } = await companyDayStart(tx, ctx, now);
    const since = zoneDayStart(day, zone);
    return { priced: await countMeasuredSince(tx, ctx, since, { readyOnly: true }), all: await countMeasuredSince(tx, ctx, since) };
  });
  const running = inflight.get(ctx.companyId) ?? 0;
  if (priced + running >= settings.dailyCap || all + running >= settings.dailyCap * CEILING_TIMES_CAP) return fallback();

  inflight.set(ctx.companyId, running + 1);
  try {
    const view = await measureProperty(deps, ctx, { propertyId: property.id });
    const ring = mainRing(view);
    const point: LngLat = property.geom ?? view.center;
    // Can the satellite pictures be trusted? Solar's answer kept on the measurement (no new paid call), the 3D roof's
    // own facts and the outline against the geocoded house. The cause is kept for staff; the homeowner hears one sentence.
    const kept = await withTenant(deps.pools, ctx, (tx) => latestSolarSnapshot(tx, ctx, property.id));
    const building = kept === null ? undefined : kept.building !== null && metresToBuilding(kept.building, point) <= SOLAR_BUILDING_SNAP_M ? kept.building : null;
    const sat = satelliteGate({
      now,
      solarBuilding: building,
      roof3d: view.roof3d ?? null,
      reasons: view.needsReview?.reasons ?? [],
      yearBuilt: property.yearBuilt ?? null,
      outlineGapM: ring === null ? null : metresOutsideRing(point, ring),
    });
    const satellite: StoredSatellite | undefined =
      sat.problems.length === 0 ? undefined : { problems: sat.problems, quality: sat.imagery.quality, date: sat.imagery.date, roofAsked: wantsRoof };
    // The outline itself is in doubt (not the house, or joined buildings): windows are counted on it, so no estimate at all.
    if (satellite !== undefined && sat.blocksWindows) {
      return await fallback({ callback: sat.problems.includes('outline-off-house') ? 'outline-off-house' : 'roof-review', measurementId: view.id, satellite });
    }
    // The measurement's own doubts: a building too big for a home, a flat roof read without 3D.
    const gate = measurementGate(view);
    if (gate.callback !== null) return await fallback({ callback: gate.callback, measurementId: view.id, ...(satellite !== undefined && { satellite }) });
    const pct = rangePctFor(settings.rangePct, gate, QUOTE_LIMITS.rangePctMax);
    // No roof price when the satellite pictures cannot be trusted; the windows and gutters carry on.
    const roof = wantsRoof && satellite === undefined ? await roofRange(deps, ctx, view, pct) : null;
    const eaveM = wantsWindows && ring !== null ? await eaveOf(deps, ctx, property, point, ring) : null;
    const tiers = wantsWindows ? (await withTenant(deps.pools, ctx, (tx) => getWindowCatalog(tx, ctx))).tiers : undefined;
    const counted = wantsWindows && ring !== null ? windowsRange(ring, eaveM, pct, tiers) : null;
    const windows = counted === null ? null : { count: counted.count, range: counted.range };
    const outline = ring === null ? null : { center: view.center, ring: thin(ring) };
    const ready = roof !== null || windows !== null;
    const row = await withTenant(deps.pools, ctx, (tx) =>
      insertQuoteEstimate(
        tx,
        ctx,
        {
          inputKey,
          addressKey,
          address: place.address,
          status: ready ? 'ready' : 'fallback',
          measured: true,
          propertyId: property.id,
          measurementId: view.id,
          result: {
            roof,
            windows,
            gutters: null,
            outline,
            lookup,
            ...(satellite !== undefined && { satellite }),
            ...(gate.widen && { widened: true }),
            ...(counted !== null && { windowMix: counted.mix, windowPct: pct, floors: counted.floors, windowCountRange: counted.countRange }),
          },
          ipHash: input.ipHash,
          expiresAt,
        },
        now,
      ),
    );
    return estimateView(row);
  } finally {
    const left = (inflight.get(ctx.companyId) ?? 1) - 1;
    if (left <= 0) inflight.delete(ctx.companyId);
    else inflight.set(ctx.companyId, left);
  }
}
