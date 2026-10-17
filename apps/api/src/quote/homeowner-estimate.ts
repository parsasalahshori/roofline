import { getQuoteEstimate, type QuoteEstimateRow, type TenantContext, withTenant } from '@roofline/db';
import type { HomeownerCallbackReason, InstantQuoteSettings, QuoteProduct } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError } from '../errors.ts';
import { estimateForAddress, type StoredEstimateResult } from './estimate.ts';
import type { QuoteCallbackReason } from './gates.ts';

/*
 * The homeowner app's first answer: the address looked up and, for roof and windows, measured from above exactly as
 * the instant quote page does (estimate.ts: the same 30-day cache, the same daily cap, the same gates that send an
 * apartment or a doubtful home to a call back). The measurement always runs with the company's own page settings, never
 * narrowed to what this homeowner asked about, so the stored row is complete and a later visitor of the address (the
 * page, or the app asking about something else) is answered from it. Gutters are not offered to homeowners at all.
 */

export type HomeownerEstimateOutcome = {
  status: 'ready' | 'callback';
  callbackReason: HomeownerCallbackReason | null;
  /** The shared estimate row whose id the request keeps; null when nothing could be measured. */
  estimate: QuoteEstimateRow | null;
  /** The company's saved address for the home, when the lookup found it. */
  propertyId: string | null;
  /** The address as found (or as typed when the lookup was down). */
  address: string;
};

/** The call-back reasons the app tells apart (docs/windows/homeowner-api.md), from the page's finer ones. */
export function coarseReason(reason: QuoteCallbackReason | 'visit-only'): HomeownerCallbackReason {
  switch (reason) {
    case 'unit':
      return 'unit';
    case 'not-rooftop':
    case 'street-changed':
      return 'address';
    case 'roof-review':
    case 'outline-off-house':
      return 'satellite-unusable';
    case 'too-big':
    case 'flat-unmeasured':
      return 'home';
    case 'visit-only':
      return 'home';
  }
}

/**
 * The reason given: 'satellite-unusable' only says "your roof" when the roof was asked about. A home that could not be
 * measured from above, asked about for windows only, is a plain 'home'; and a roof asked about but not priced because of
 * the pictures is 'satellite-unusable' wherever the call back would otherwise say 'home'.
 */
function roofReason(services: readonly QuoteProduct[], stored: StoredEstimateResult, reason: HomeownerCallbackReason): HomeownerCallbackReason {
  const roof = services.includes('roof');
  if (reason === 'satellite-unusable' && !roof) return 'home';
  if (reason === 'home' && roof && stored.satellite !== undefined) return 'satellite-unusable';
  return reason;
}

export async function estimateForHomeowner(
  deps: AppDeps,
  ctx: TenantContext,
  settings: InstantQuoteSettings,
  input: { address: string; services: readonly QuoteProduct[]; ipHash: string | null },
): Promise<HomeownerEstimateOutcome> {
  let shown;
  try {
    shown = await estimateForAddress(deps, ctx, settings, { address: input.address, ipHash: input.ipHash });
  } catch (err) {
    if (err instanceof AppError && err.status === 422) throw new AppError(422, err.message, 'address').coded('address_not_found');
    throw err;
  }
  const row = await withTenant(deps.pools, ctx, (tx) => getQuoteEstimate(tx, ctx, shown.quoteId));
  if (row === null) throw new AppError(503, 'Please try again in a moment.').coded('unavailable');
  const stored = row.result as StoredEstimateResult;
  if (row.status === 'fallback') {
    // The page's checks decided it (stored with their reason), or nothing could be measured right now (the daily limit,
    // the address lookup down): 'busy', unless a measurement was made and still could not be priced.
    const reason = roofReason(input.services, stored, stored.callback !== undefined ? coarseReason(stored.callback) : row.measured ? 'home' : 'busy');
    return { status: 'callback', callbackReason: reason, estimate: row, propertyId: row.propertyId, address: row.address };
  }
  // Ready, but if nothing asked for has an estimate, a person has to look.
  const nothing =
    (!input.services.includes('roof') || shown.roof === null) && (!input.services.includes('windows') || shown.windows === null);
  if (nothing) return { status: 'callback', callbackReason: roofReason(input.services, stored, 'home'), estimate: row, propertyId: row.propertyId, address: row.address };
  return { status: 'ready', callbackReason: null, estimate: row, propertyId: row.propertyId, address: row.address };
}
