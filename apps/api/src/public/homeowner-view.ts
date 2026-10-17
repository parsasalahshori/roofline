import { getHomeownerMeasurement, getQuoteEstimate, getWindowCatalog, homeownerProgress, type HomeownerProgress, type HomeownerRequestRow, type QuoteEstimateRow, type StoredWindowUpload, type TenantContext, type Tx } from '@roofline/db';
import {
  buildHomeownerQuote,
  HOMEOWNER_APP_SOURCE,
  type HomeownerBooking,
  type HomeownerEstimate,
  type HomeownerHome,
  type HomeownerQuote,
  type HomeownerRequestSummary,
  type HomeownerRequestView,
  type HomeownerStage,
  type HomeownerStatus,
  type HomeownerWindow,
  type HomeownerWindowInput,
  isTimeZone,
  type PhotoWindow,
  type PhotoWindowInput,
  type QuoteProduct,
  type StyleTile,
  tileOfStyle,
  type WindowCatalog,
  SATELLITE_UNUSABLE_MESSAGE,
  sizeFromArPoints,
  windowSizeLabel,
  windowUncertaintyLabel,
} from '@roofline/shared';
import { zoneOf } from '../front-desk/tools/times.ts';
import { AR_MAX_TRACKING_LOST, sizePhotoWindow } from '../estimator/window-uploads.ts';
import { estimateView, type StoredEstimateResult } from '../quote/estimate.ts';

/*
 * The homeowner API's view of a request (GET /requests/:id and the answer to every change): the home and estimates as
 * stored for the address, the windows the homeowner measured sized again from what is stored, the quote, and (once
 * the request is filed) the booking and status. Pure reads inside the caller's transaction.
 */

const hundreds = (cents: number): number => Math.round(cents / 100);

/** What the address said about the home. */
export function homeOf(request: HomeownerRequestRow, estimate: QuoteEstimateRow | null): HomeownerHome {
  if (estimate === null || request.status === 'callback') return { address: request.address, floors: null, outline: null };
  const stored = estimate.result as StoredEstimateResult;
  const view = estimateView(estimate);
  return { address: request.address, floors: stored.floors ?? null, outline: view.outline };
}

/** What the app shows in place of the roof price when the satellite pictures cannot be trusted. */
const ROOF_NOTE = { reason: 'satellite-unusable', message: SATELLITE_UNUSABLE_MESSAGE } as const;

/** The estimates for the services asked about: null where not asked, not estimated, or the request is a call back. */
export function estimateOf(request: HomeownerRequestRow, estimate: QuoteEstimateRow | null): HomeownerEstimate {
  const unusable = request.services.includes('roof') && request.callbackReason === 'satellite-unusable';
  if (estimate === null || request.status === 'callback') return { windows: null, roof: null, ...(unusable && { roofNote: ROOF_NOTE }) };
  const view = estimateView(estimate);
  const stored = estimate.result as StoredEstimateResult;
  const range = stored.windowCountRange ?? null;
  const windows =
    request.services.includes('windows') && view.windows !== null
      ? { low: Math.min(range?.low ?? view.windows.count, view.windows.count), high: Math.max(range?.high ?? view.windows.count, view.windows.count), likely: view.windows.count }
      : null;
  const roof = request.services.includes('roof') && view.roof !== null ? { low: hundreds(view.roof.range.lowCents), high: hundreds(view.roof.range.highCents), squares: view.roof.squares } : null;
  const withheld = request.services.includes('roof') && roof === null && stored.satellite !== undefined;
  return { windows, roof, ...(withheld && { roofNote: ROOF_NOTE }) };
}

/** The homeowner's windows on the request's measurement, sized from what is stored (quote-grade, source homeowner-app). */
export async function sizedWindows(tx: Tx, ctx: TenantContext, request: HomeownerRequestRow): Promise<{ windows: PhotoWindow[]; uploads: StoredWindowUpload[] }> {
  const row = await getHomeownerMeasurement(tx, ctx, request);
  if (row === null) return { windows: [], uploads: [] };
  const uploads = row.uploads ?? [];
  const windows = (row.adjustments.photoWindows ?? [])
    .filter((w) => w.source === HOMEOWNER_APP_SOURCE)
    .map((input) => (input.uploadId === undefined ? sizePhotoWindow(input, null) : sizePhotoWindow(input, uploads.find((u) => u.id === input.uploadId) ?? null)))
    .filter((w): w is PhotoWindow => w !== null);
  return { windows, uploads };
}

const TRACKING_LOST = 'Your phone lost track of the wall while you measured. Move slowly and measure it again.';
const NOT_FLAT = "The four corners don't look like a flat window. Tap the corners of the frame again.";
const ROOM_SCAN = 'A room scan gives a rough size. We measure again at your free visit.';
const UNSURE = 'This size is less certain. We measure again at your free visit.';

/** Why a window is `check`, in plain words for the homeowner; none when it is good. */
export function reasonsOf(w: PhotoWindow): string[] {
  if (w.quality === 'good') return [];
  const s = w.scale;
  if (s.kind === 'roomplan') return [ROOM_SCAN];
  if (s.kind === 'card') return w.reasons !== undefined && w.reasons.length > 0 ? w.reasons : [UNSURE];
  if (s.kind === 'ar') {
    const out: string[] = [];
    if (s.trackingLostCount > AR_MAX_TRACKING_LOST) out.push(TRACKING_LOST);
    const size = sizeFromArPoints(s.pointsM, { device: s.device, cornerSpreadM: s.cornerSpreadM });
    if (size !== null && size.quality === 'check') out.push(NOT_FLAT);
    return out.length > 0 ? out : [UNSURE];
  }
  return [UNSURE];
}

/** A stored, sized window as the homeowner sees it. */
export function windowView(w: PhotoWindow, tiles: readonly StyleTile[]): HomeownerWindow {
  const style = w.style ?? 'double-hung';
  const uncertaintyIn = w.uncertaintyIn ?? { width: 0.5, height: 0.5 };
  const scale = w.scale as HomeownerWindowInput['scale'];
  return {
    id: w.id,
    room: w.room ?? '',
    ...(w.label !== undefined && { label: w.label }),
    style,
    ...(w.frosted === true && { frosted: true }),
    scale,
    ...(w.uploadId !== undefined && { uploadId: w.uploadId }),
    ...(w.corners !== undefined && { corners: w.corners }),
    widthIn: w.widthIn,
    heightIn: w.heightIn,
    sizeClass: w.sizeClass,
    uncertaintyIn,
    quality: w.quality,
    reasons: reasonsOf(w),
    sizeLabel: windowSizeLabel(w.widthIn, w.heightIn),
    uncertaintyLabel: windowUncertaintyLabel(uncertaintyIn),
    styleLabel: tileOfStyle(tiles, style).label,
  };
}

/** The windows quote for a request, or null when it is not about windows or is a call back. */
export function quoteOf(request: HomeownerRequestRow, estimate: QuoteEstimateRow | null, windows: readonly PhotoWindow[], catalog: WindowCatalog): HomeownerQuote | null {
  if (request.status === 'callback' || !request.services.includes('windows')) return null;
  const expected = estimateOf(request, estimate).windows;
  const stored = estimate?.result as StoredEstimateResult | undefined;
  return buildHomeownerQuote({
    measured: windows.map((w) => ({ id: w.id, sizeClass: w.sizeClass, ...(w.style !== undefined && { style: w.style }), frosted: w.frosted === true })),
    catalog,
    expected,
    override: request.windowCountOverride,
    mix: stored?.windowMix ?? null,
  });
}

/** The first name only. */
const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Where the request is on its way from asked to installed. */
export function statusOf(request: HomeownerRequestRow, progress: HomeownerProgress | null, timeZone: string): HomeownerStatus {
  let stage: HomeownerStage = 'requested';
  if (progress?.visit) stage = 'visit-booked';
  if (progress !== null && (progress.repMeasuredAt !== null || ['proposal', 'won'].includes(progress.jobStage ?? ''))) stage = 'measured';
  const order = progress?.order ?? null;
  const ordered = order !== null && (order.status === 'ready' || order.status === 'sent');
  if (ordered) stage = 'ordered';
  const installed = progress?.jobStage === 'installed';
  if (installed) stage = 'installed';
  return {
    stage,
    dates: {
      requestedAt: request.createdAt.toISOString(),
      visit: iso(progress?.visit?.startsAt),
      measuredAt: iso(progress?.repMeasuredAt),
      orderedAt: ordered ? iso(order.sentAt ?? order.readyAt) : null,
      installedAt: installed ? iso(progress?.jobUpdatedAt) : null,
    },
    ...(progress?.repName != null && progress.repName !== '' && { rep: { name: firstName(progress.repName) } }),
    timeZone,
  };
}

/** The whole view of a request. */
export async function buildRequestView(tx: Tx, ctx: TenantContext, request: HomeownerRequestRow): Promise<HomeownerRequestView> {
  const estimate = request.quoteEstimateId === null ? null : await getQuoteEstimate(tx, ctx, request.quoteEstimateId);
  const { windows } = await sizedWindows(tx, ctx, request);
  const catalog = await getWindowCatalog(tx, ctx);
  const summary: HomeownerRequestSummary = {
    id: request.id,
    status: request.status,
    ...(request.callbackReason !== null && { callbackReason: request.callbackReason }),
    services: request.services as HomeownerRequestSummary['services'],
    home: homeOf(request, estimate),
    estimate: estimateOf(request, estimate),
    estimatedTotalOverride: request.windowCountOverride,
    contactFiled: request.quoteRequestId !== null,
    createdAt: request.createdAt.toISOString(),
    expiresAt: request.expiresAt.toISOString(),
  };
  const views = windows.map((w) => windowView(w, catalog.styleTiles));
  const rooms = [...new Set(views.map((w) => w.room).filter((r) => r !== ''))];
  const view: HomeownerRequestView = { request: summary, windows: views, rooms, quote: quoteOf(request, estimate, windows, catalog) };
  if (request.quoteRequestId !== null) {
    const rawZone = await zoneOf(tx, ctx);
    const timeZone = isTimeZone(rawZone) ? rawZone : 'UTC';
    const progress = await homeownerProgress(tx, ctx, request);
    view.status = statusOf(request, progress, timeZone);
    if (progress?.visit || request.callMe) {
      const booking: HomeownerBooking = {
        visit: progress?.visit ? { start: progress.visit.startsAt.toISOString(), end: progress.visit.endsAt.toISOString(), timeZone } : null,
        callMe: request.callMe,
      };
      view.booking = booking;
    }
  }
  return view;
}

/** Just GET .../status. */
export async function buildStatus(tx: Tx, ctx: TenantContext, request: HomeownerRequestRow): Promise<HomeownerStatus> {
  const rawZone = await zoneOf(tx, ctx);
  const timeZone = isTimeZone(rawZone) ? rawZone : 'UTC';
  return statusOf(request, await homeownerProgress(tx, ctx, request), timeZone);
}

/** The input to store for a window the homeowner sent (the server's fields added). */
export function storedInput(w: HomeownerWindowInput): PhotoWindowInput {
  return {
    id: w.id,
    ...(w.uploadId !== undefined && { uploadId: w.uploadId.toLowerCase() }),
    label: w.label,
    ...(w.corners !== undefined && { corners: w.corners }),
    scale: w.scale,
    source: HOMEOWNER_APP_SOURCE,
    room: w.room,
    style: w.style,
    ...(w.frosted === true && { frosted: true }),
  } as PhotoWindowInput;
}

const dollars = (n: number): string => `$${n.toLocaleString('en-US')}`;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The windows quote in one plain line: "Good $9,800, Better $12,400, Best $17,900". */
function tierLine(quote: HomeownerQuote): string {
  return quote.tiers.map((t) => `${t.label} ${dollars(t.total)}`).join(', ');
}

/**
 * What the homeowner was shown and did in the app, in one plain line for the job's timeline: the ranges and prices they
 * saw (as the instant quote page does for its ranges), the windows they measured and how many are flagged to check.
 */
export function leadSummary(products: readonly QuoteProduct[], view: HomeownerRequestView): string {
  const parts: string[] = [];
  const e = view.request.estimate;
  if (products.includes('roof') && e.roof) parts.push(`Roof about ${e.roof.squares} squares, ${dollars(e.roof.low)} to ${dollars(e.roof.high)}`);
  const q = view.quote;
  if (products.includes('windows') && q !== null) {
    const check = view.windows.filter((w) => w.quality === 'check').length;
    const total = q.measuredCount + q.estimatedCount;
    const measured = q.measuredCount > 0 ? `${plural(q.measuredCount, 'window', 'windows')} measured in the app${check > 0 ? ` (${check} to check)` : ''}: ` : e.windows ? `about ${e.windows.likely} windows, estimated: ` : '';
    const rest = q.estimatedCount > 0 && q.measuredCount > 0 ? ` (${q.estimatedCount} estimated)` : '';
    parts.push(`${measured}${tierLine(q)} for ${plural(total, 'window', 'windows')}${rest}`);
  }
  const asked = `Asked about ${products.join(', ')}.`;
  const visit = products.includes('gutters') ? ' Gutters are priced at the visit.' : '';
  return parts.length > 0 ? `${asked} Shown: ${parts.join('; ')}.${visit}` : `${asked} No estimate was shown; call them.${visit}`;
}
