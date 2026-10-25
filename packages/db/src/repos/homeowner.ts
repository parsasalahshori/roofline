import { and, desc, eq, gt, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import { type HomeownerCallbackReason, HOMEOWNER_APP_SOURCE, type OrderStage, type QuoteProduct, type WindowAdjustments } from '@roofline/shared';
import {
  appointments,
  homeownerRequests,
  jobs,
  quoteRequests,
  windowMeasurements,
  windowOrders,
} from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { addActivity } from './activities.ts';
import { audit } from './audit.ts';
import { memberNames } from './appointments.ts';
import { jobOrderProgress } from './backoffice.ts';
import { getProperty } from './properties.ts';
import { createWindowMeasurement, notHomeownerMeasurement, type WindowMeasurementRow } from './window-measurements.ts';
import { US_MAP_CENTER } from './measurements.ts';

/*
 * The homeowner app's requests (public homeowner API, /api/public/homeowner/:slug). Everything runs inside the caller's
 * withTenant; the public routes use a 'system' context for the company the slug names. Only the SHA-256 hash of the
 * bearer token is ever stored (token_hash). The audit trail gets ids and outcomes only: no address, name, phone, email,
 * IP or token.
 */

export type HomeownerRequestRow = typeof homeownerRequests.$inferSelect;

export type NewHomeownerRequest = {
  /** SHA-256 of the bearer token, hex. */
  tokenHash: string;
  expiresAt: Date;
  services: QuoteProduct[];
  address: string;
  status: 'ready' | 'callback';
  callbackReason: HomeownerCallbackReason | null;
  quoteEstimateId: string | null;
  propertyId: string | null;
  ipHash: string | null;
};

export async function createHomeownerRequest(tx: Tx, ctx: TenantContext, r: NewHomeownerRequest, now: Date): Promise<HomeownerRequestRow> {
  const [row] = await tx
    .insert(homeownerRequests)
    .values({ companyId: ctx.companyId, ...r, createdAt: now, updatedAt: now })
    .returning();
  await audit(tx, ctx, {
    action: 'homeowner.request',
    targetType: 'homeowner_request',
    targetId: row!.id,
    after: { services: r.services, status: r.status, callbackReason: r.callbackReason },
    ip: null,
    at: now,
  });
  return row!;
}

/**
 * One request of this company by id (RLS keeps other companies' out), or null. `lock`: the row is locked (FOR UPDATE)
 * until the transaction ends, for a change that must not race another one on the same request (a first photo and a first
 * window arriving together must make one measurement, not two).
 */
export async function getHomeownerRequest(tx: Tx, ctx: TenantContext, id: string, opts?: { lock?: boolean }): Promise<HomeownerRequestRow | null> {
  const query = tx
    .select()
    .from(homeownerRequests)
    .where(and(eq(homeownerRequests.id, id), eq(homeownerRequests.companyId, ctx.companyId)))
    .limit(1);
  const [row] = await (opts?.lock === true ? query.for('update') : query);
  return row ?? null;
}

/** Sets (or clears, with null) the number of windows the homeowner says the house has. */
export async function setHomeownerWindowCount(tx: Tx, ctx: TenantContext, id: string, count: number | null, now: Date): Promise<HomeownerRequestRow | null> {
  const [row] = await tx
    .update(homeownerRequests)
    .set({ windowCountOverride: count, updatedAt: now })
    .where(and(eq(homeownerRequests.id, id), eq(homeownerRequests.companyId, ctx.companyId)))
    .returning();
  return row ?? null;
}

/**
 * The window measurement that holds this request's windows and photos, made on the first call (the caller holds the
 * request's lock). It carries no walls estimate and no Street View photos: only what the homeowner measured, each window
 * marked source 'homeowner-app'. The staff app opens it as the address's newest window measurement.
 */
export async function ensureHomeownerMeasurement(tx: Tx, ctx: TenantContext, request: HomeownerRequestRow, now: Date): Promise<WindowMeasurementRow | null> {
  if (request.propertyId === null) return null;
  if (request.windowMeasurementId !== null) {
    const [existing] = await tx
      .select()
      .from(windowMeasurements)
      .where(and(eq(windowMeasurements.id, request.windowMeasurementId), eq(windowMeasurements.companyId, ctx.companyId)))
      .limit(1);
    if (existing) return existing;
  }
  const property = await getProperty(tx, ctx, request.propertyId);
  if (property === null) return null;
  const made = await createWindowMeasurement(
    tx,
    ctx,
    {
      propertyId: property.id,
      address: request.address,
      center: property.geom ?? US_MAP_CENTER,
      photos: [],
      windows: [],
      estimated: null,
      stories: null,
      geometry: null,
      detector: null,
      missingReason: null,
      reviewReasons: [],
      tookMs: 0,
      photosDeleteBy: null,
    },
    now,
  );
  await tx
    .update(homeownerRequests)
    .set({ windowMeasurementId: made.id, updatedAt: now })
    .where(and(eq(homeownerRequests.id, request.id), eq(homeownerRequests.companyId, ctx.companyId)));
  return made;
}

/**
 * A new window measurement of an address (a rep's "Measure windows") starts with the windows the homeowner measured in
 * the app there: those of the newest request at the address that was sent to the company (the contact form: a request
 * the homeowner never sent stays theirs alone) and has not expired. They come along as they were, still marked
 * 'homeowner-app' (quote-grade; a rep who moves a corner or the scale makes one their own), with the photos they stand
 * on. The homeowner's own measurement is not touched, and what they change later does not reach this copy. Returns the
 * measurement as it is now.
 */
export async function adoptHomeownerWindows(tx: Tx, ctx: TenantContext, target: WindowMeasurementRow, now: Date): Promise<WindowMeasurementRow> {
  const sources = await tx
    .select({ adjustments: windowMeasurements.adjustments, uploads: windowMeasurements.uploads })
    .from(homeownerRequests)
    .innerJoin(windowMeasurements, and(eq(windowMeasurements.id, homeownerRequests.windowMeasurementId), eq(windowMeasurements.companyId, homeownerRequests.companyId)))
    .where(
      and(
        eq(homeownerRequests.companyId, ctx.companyId),
        eq(homeownerRequests.propertyId, target.propertyId),
        isNotNull(homeownerRequests.quoteRequestId),
        gt(homeownerRequests.expiresAt, now),
      ),
    )
    .orderBy(desc(homeownerRequests.createdAt), desc(homeownerRequests.id))
    .limit(5);
  const ownWindows = (adjustments: WindowAdjustments) => (adjustments.photoWindows ?? []).filter((w) => w.source === HOMEOWNER_APP_SOURCE);
  const from = sources.find((x) => ownWindows(x.adjustments).length > 0);
  if (from === undefined) return target;
  const held = new Set((target.adjustments.photoWindows ?? []).map((w) => w.id));
  const windows = ownWindows(from.adjustments).filter((w) => !held.has(w.id));
  if (windows.length === 0) return target;
  const photoIds = new Set(windows.flatMap((w) => (w.uploadId === undefined ? [] : [w.uploadId])));
  const heldPhotos = new Set((target.uploads ?? []).map((u) => u.id));
  const photos = (from.uploads ?? []).filter((u) => photoIds.has(u.id) && !heldPhotos.has(u.id));
  const [row] = await tx
    .update(windowMeasurements)
    .set({
      adjustments: { ...target.adjustments, photoWindows: [...(target.adjustments.photoWindows ?? []), ...windows] },
      uploads: [...(target.uploads ?? []), ...photos],
      updatedAt: now,
    })
    .where(and(eq(windowMeasurements.id, target.id), eq(windowMeasurements.companyId, ctx.companyId)))
    .returning();
  return row ?? target;
}

/** The adjustments (the homeowner's windows) and uploads (their photos) of the request's measurement, or null before it has one. */
export async function getHomeownerMeasurement(
  tx: Tx,
  ctx: TenantContext,
  request: Pick<HomeownerRequestRow, 'windowMeasurementId'>,
): Promise<Pick<WindowMeasurementRow, 'id' | 'adjustments' | 'uploads' | 'propertyId'> | null> {
  if (request.windowMeasurementId === null) return null;
  const [row] = await tx
    .select({ id: windowMeasurements.id, adjustments: windowMeasurements.adjustments, uploads: windowMeasurements.uploads, propertyId: windowMeasurements.propertyId })
    .from(windowMeasurements)
    .where(and(eq(windowMeasurements.id, request.windowMeasurementId), eq(windowMeasurements.companyId, ctx.companyId)))
    .limit(1);
  return row ?? null;
}

/** The contact form filed the request with the company: remember the quote request (consent evidence, customer, job). */
export async function linkHomeownerLead(tx: Tx, ctx: TenantContext, id: string, quoteRequestId: string, now: Date): Promise<void> {
  await tx
    .update(homeownerRequests)
    .set({ quoteRequestId, updatedAt: now })
    .where(and(eq(homeownerRequests.id, id), eq(homeownerRequests.companyId, ctx.companyId)));
}

/** The homeowner asked for a call to set up the visit. */
export async function markHomeownerCallMe(tx: Tx, ctx: TenantContext, id: string, now: Date): Promise<void> {
  await tx
    .update(homeownerRequests)
    .set({ callMe: true, updatedAt: now })
    .where(and(eq(homeownerRequests.id, id), eq(homeownerRequests.companyId, ctx.companyId)));
}

/** The lead a filed request made: the customer, job, address and visit, and the phone it was filed under. */
export type FiledLead = {
  requestId: string;
  customerId: string;
  jobId: string;
  propertyId: string;
  appointmentId: string | null;
  phoneE164: string;
};

/** The lead the contact form made for a request, or null before it is filed (or when it is gone). */
export async function getFiledLead(tx: Tx, ctx: TenantContext, quoteRequestId: string): Promise<FiledLead | null> {
  const [row] = await tx
    .select({
      requestId: quoteRequests.id,
      customerId: quoteRequests.customerId,
      jobId: quoteRequests.jobId,
      appointmentId: quoteRequests.appointmentId,
      phoneE164: quoteRequests.phoneE164,
      propertyId: jobs.propertyId,
    })
    .from(quoteRequests)
    .innerJoin(jobs, and(eq(jobs.id, quoteRequests.jobId), eq(jobs.companyId, quoteRequests.companyId)))
    .where(and(eq(quoteRequests.id, quoteRequestId), eq(quoteRequests.companyId, ctx.companyId)))
    .limit(1);
  if (!row || row.customerId === null || row.jobId === null) return null;
  return { requestId: row.requestId, customerId: row.customerId, jobId: row.jobId, propertyId: row.propertyId, appointmentId: row.appointmentId, phoneE164: row.phoneE164 };
}

/** A line on the lead job's timeline about what the homeowner did in the app (windows measured, a visit asked for). */
export async function addHomeownerNote(tx: Tx, ctx: TenantContext, jobId: string, entry: { kind: string; summary: string; data?: Record<string, unknown> }, now: Date): Promise<void> {
  await addActivity(tx, ctx, { subjectType: 'job', subjectId: jobId, kind: entry.kind, summary: entry.summary, ...(entry.data !== undefined && { data: entry.data }), at: now });
}

/** What has happened to the filed request since, for GET /status. */
export type HomeownerProgress = {
  jobStage: string | null;
  jobUpdatedAt: Date | null;
  visit: { startsAt: Date; endsAt: Date } | null;
  repName: string | null;
  /** The newest time, since the request was sent, that a person from the company put a window of their own on the address's window measurement. */
  repMeasuredAt: Date | null;
  /** A factory order made since the request was sent for the address's windows: 'draft' | 'ready' | 'sent', and when it became ready / was sent. */
  order: { status: string; readyAt: Date | null; sentAt: Date | null } | null;
  /**
   * The back office order for the job (WinChoice): its stage and the times it first reached measured, ordered and installed. When
   * it exists it is the authority for what the homeowner sees (HOMEOWNER_STAGE_FOR); null for a company without the back office.
   */
  backoffice: { stage: OrderStage; measuredAt: Date | null; orderedAt: Date | null; installedAt: Date | null } | null;
};

/** The newest few of the company's own window measurements of the address that the progress looks at. */
const PROGRESS_MEASUREMENTS = 20;

/**
 * The filed request's job, visit, the company's own measuring and factory order, so the app can say where things are.
 * Null before the request is filed (no job yet). The measuring and the order count only when they came after the
 * request was sent: what the company did at this address earlier (for someone else, or for the people who lived there
 * before) is not this homeowner's to see. The homeowners' own app measurements are never the company's work.
 */
export async function homeownerProgress(tx: Tx, ctx: TenantContext, request: HomeownerRequestRow): Promise<HomeownerProgress | null> {
  if (request.quoteRequestId === null) return null;
  const [filed] = await tx
    .select({ jobId: quoteRequests.jobId, appointmentId: quoteRequests.appointmentId, filedAt: quoteRequests.createdAt })
    .from(quoteRequests)
    .where(and(eq(quoteRequests.id, request.quoteRequestId), eq(quoteRequests.companyId, ctx.companyId)))
    .limit(1);
  if (!filed) return null;
  const [job] =
    filed.jobId === null
      ? []
      : await tx
          .select({ stage: jobs.stage, updatedAt: jobs.updatedAt, assignedUserId: jobs.assignedUserId, propertyId: jobs.propertyId })
          .from(jobs)
          .where(and(eq(jobs.id, filed.jobId), eq(jobs.companyId, ctx.companyId)))
          .limit(1);
  const [visit] =
    filed.appointmentId === null
      ? []
      : await tx
          .select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt, assignedUserId: appointments.assignedUserId })
          .from(appointments)
          .where(and(eq(appointments.id, filed.appointmentId), eq(appointments.companyId, ctx.companyId), ne(appointments.status, 'canceled'), isNull(appointments.archivedAt)))
          .limit(1);
  const repId = visit?.assignedUserId ?? job?.assignedUserId ?? null;
  const repName = repId === null ? null : ((await memberNames(tx)).get(repId) ?? null);

  // The company's own measuring since the request was sent: a window on a measurement of this address that did not come from the app.
  const propertyId = job?.propertyId ?? request.propertyId;
  let repMeasuredAt: Date | null = null;
  let order: HomeownerProgress['order'] = null;
  if (propertyId !== null) {
    const measurements = await tx
      .select({ id: windowMeasurements.id, adjustments: windowMeasurements.adjustments, updatedAt: windowMeasurements.updatedAt })
      .from(windowMeasurements)
      .where(and(eq(windowMeasurements.propertyId, propertyId), eq(windowMeasurements.companyId, ctx.companyId), notHomeownerMeasurement(tx)))
      .orderBy(desc(windowMeasurements.createdAt))
      .limit(PROGRESS_MEASUREMENTS);
    for (const m of measurements) {
      const own = m.updatedAt > filed.filedAt && (m.adjustments.photoWindows ?? []).some((w) => w.source !== HOMEOWNER_APP_SOURCE);
      if (own && (repMeasuredAt === null || m.updatedAt > repMeasuredAt)) repMeasuredAt = m.updatedAt;
    }
    if (measurements.length > 0) {
      const orders = await tx
        .select({ status: windowOrders.status, readyAt: windowOrders.readyAt, sentAt: windowOrders.sentAt })
        .from(windowOrders)
        .where(
          and(
            eq(windowOrders.companyId, ctx.companyId),
            inArray(windowOrders.windowMeasurementId, measurements.map((m) => m.id)),
            gt(windowOrders.createdAt, filed.filedAt),
          ),
        )
        .orderBy(desc(windowOrders.updatedAt));
      // The furthest order wins: sent, then ready, then draft.
      order = orders.find((o) => o.status === 'sent') ?? orders.find((o) => o.status === 'ready') ?? orders[0] ?? null;
    }
  }
  return {
    jobStage: job?.stage ?? null,
    jobUpdatedAt: job?.updatedAt ?? null,
    visit: visit ? { startsAt: visit.startsAt, endsAt: visit.endsAt } : null,
    repName,
    repMeasuredAt,
    order,
    backoffice: filed.jobId === null ? null : await jobOrderProgress(tx, ctx, filed.jobId),
  };
}
