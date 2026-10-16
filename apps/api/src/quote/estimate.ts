import {
  companyDayStart,
  countMeasuredSince,
  findCachedEstimate,
  insertQuoteEstimate,
  noteEstimateReused,
  type PropertyRow,
  quoteInputKey,
  type QuoteEstimateRow,
  type TenantContext,
  withTenant,
  zoneDayStart,
} from '@roofline/db';
import {
  type InstantQuoteSettings,
  type LngLat,
  type MeasurementView,
  normalizeAddressKey,
  priceRange,
  priceWindows,
  type PriceRange,
  type PublicQuoteEstimate,
  QUOTE_LIMITS,
  windowCounts,
  WINDOW_SIZE_CLASSES,
} from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError } from '../errors.ts';
import { priceOptions } from '../estimator/build.ts';
import { homeFromAddress, measureProperty } from '../estimator/measure.ts';
import { heightLayersFor } from '../estimator/roof-3d.ts';
import { solarForHome } from '../estimator/solar.ts';
import { estimateAllSides } from '../estimator/windows-estimate.ts';
import { eaveHeightAboveGround } from '../estimator/windows-heights.ts';
import { wallsFor } from '../estimator/windows-view.ts';
import { gutterRange } from './gutters.ts';

/*
 * POST /api/public/quote/:slug/estimate: one typed address in, RANGES out. The roof is measured the way the
 * estimator measures it (measureProperty: footprints, Google Solar, the roof in 3D) and priced with the company's
 * own templates (priceOptions), then widened by the company's range and rounded to hundreds of dollars; windows are
 * the walls-only estimate (no Street View), priced with the window tiers. Only the ranges, a rounded roof size, a
 * window count and a small outline leave this file: never a tier's price, the price book or a measurement id.
 *
 * Cost guard: an address measured in the last 30 days is answered from storage (no paid call); past the company's
 * daily cap of fresh measurements the page gets 'fallback' (we'll call you) and still takes the request.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOT_FOUND = "We couldn't find that address. Please check the street, city and ZIP.";
/** The roof outline sent for the picture: at most this many corners (a house has a few dozen). */
const MAX_OUTLINE_POINTS = 80;
/** How long the windows' wall height may wait for Google's height map (usually already bought for the roof). */
const HEIGHTS_BUDGET_MS = 6000;

/** Fresh measurements running now, per company: counted against the cap so a burst cannot overshoot it. */
const inflight = new Map<string, number>();

/** The public answer a stored row carries (its result plus its id). */
export function estimateView(row: QuoteEstimateRow): PublicQuoteEstimate {
  const r = row.result as Omit<PublicQuoteEstimate, 'quoteId'>;
  return { quoteId: row.id, status: row.status, address: row.address, roof: r.roof ?? null, windows: r.windows ?? null, gutters: r.gutters ?? null, outline: r.outline ?? null };
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

/** The walls estimate (every side, no photos) and its range, or null without an outline. */
function windowsRange(ring: LngLat[], eaveHeightM: number | null, pct: number): { count: number; range: PriceRange } | null {
  const walls = wallsFor({ ring, camera: null, eaveHeightM, outlineSource: 'footprint' }, []);
  if (walls === null) return null;
  const estimated = estimateAllSides(walls);
  const counts = windowCounts({ windows: [], estimated, adjustments: { excludedWindowIds: [], manualCounts: {} } });
  const count = WINDOW_SIZE_CLASSES.reduce((n, c) => n + counts[c].estimated, 0);
  if (count === 0) return null;
  const range = priceRange(priceWindows(counts).map((q) => q.totalCents), pct);
  return range === null ? null : { count, range };
}

type Place = { property: PropertyRow | null; addressKey: string | null; address: string };

/** The typed address looked up and saved as one of the company's addresses (Geocodio, no Google). */
async function locate(deps: AppDeps, ctx: TenantContext, address: string): Promise<Place> {
  try {
    const property = await homeFromAddress(deps, ctx, address, deps.clock.now());
    return { property, addressKey: normalizeAddressKey(property.addressLine, property.zip), address: lineOf(property) };
  } catch (err) {
    if (err instanceof AppError && err.status === 400) throw new AppError(422, NOT_FOUND, 'address');
    // The lookup is down: no estimate, but the request can still be taken (we call instead).
    if (err instanceof AppError && err.status === 503) return { property: null, addressKey: null, address };
    throw err;
  }
}

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

  const fallback = async (): Promise<PublicQuoteEstimate> => {
    const row = await withTenant(deps.pools, ctx, (tx) =>
      insertQuoteEstimate(
        tx,
        ctx,
        {
          inputKey,
          addressKey: place.addressKey,
          address: place.address,
          status: 'fallback',
          measured: false,
          propertyId: place.property?.id ?? null,
          measurementId: null,
          result: { roof: null, windows: null, gutters: null, outline: null },
          ipHash: input.ipHash,
          expiresAt,
        },
        now,
      ),
    );
    return estimateView(row);
  };

  if (place.property === null || place.addressKey === null) return fallback();
  const property = place.property;
  const addressKey = place.addressKey;

  const found = await withTenant(deps.pools, ctx, async (tx) => {
    const hit = await findCachedEstimate(tx, ctx, { addressKey }, now);
    if (hit) await noteEstimateReused(tx, ctx, hit.id, now);
    return hit;
  });
  if (found) return estimateView(found);

  // The daily cap counts fresh measurements since the company's local midnight, plus the ones running now.
  const measuredToday = await withTenant(deps.pools, ctx, async (tx) => {
    const { day, zone } = await companyDayStart(tx, ctx, now);
    return countMeasuredSince(tx, ctx, zoneDayStart(day, zone));
  });
  const running = inflight.get(ctx.companyId) ?? 0;
  if (measuredToday + running >= settings.dailyCap) return fallback();

  inflight.set(ctx.companyId, running + 1);
  try {
    const wantsRoof = settings.products.includes('roof');
    const wantsWindows = settings.products.includes('windows');
    const wantsGutters = settings.products.includes('gutters');
    const view = await measureProperty(deps, ctx, { propertyId: property.id });
    const ring = mainRing(view);
    const point: LngLat = property.geom ?? view.center;
    const roof = wantsRoof ? await roofRange(deps, ctx, view, settings.rangePct) : null;
    const eaveM = (wantsWindows || wantsGutters) && ring !== null ? await eaveOf(deps, ctx, property, point, ring) : null;
    const windows = wantsWindows && ring !== null ? windowsRange(ring, eaveM, settings.rangePct) : null;
    const gutters = wantsGutters ? gutterRange(view, settings.rangePct, eaveM) : null;
    const outline = ring === null ? null : { center: view.center, ring: thin(ring) };
    const ready = roof !== null || windows !== null || gutters !== null;
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
          result: { roof, windows, gutters, outline },
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
