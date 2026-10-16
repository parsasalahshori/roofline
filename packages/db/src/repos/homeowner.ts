import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { type HomeownerCallbackReason, HOMEOWNER_APP_SOURCE, type QuoteProduct } from '@roofline/shared';
import {
  appointments,
  homeownerRequests,
  jobs,
  quoteRequests,
  windowMeasurements,
  windowOrders,
} from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { audit } from './audit.ts';
import { memberNames } from './appointments.ts';
import { getProperty } from './properties.ts';
import { createWindowMeasurement, type WindowMeasurementRow } from './window-measurements.ts';
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

/** The filed request's quote_requests row (the contact and the consent as stored), or null before it is filed. */
export async function getFiledQuoteRequest(tx: Tx, ctx: TenantContext, quoteRequestId: string) {
  const [row] = await tx
    .select()
    .from(quoteRequests)
    .where(and(eq(quoteRequests.id, quoteRequestId), eq(quoteRequests.companyId, ctx.companyId)))
    .limit(1);
  return row ?? null;
}

/** What has happened to the filed request since, for GET /status. */
export type HomeownerProgress = {
  jobStage: string | null;
  jobUpdatedAt: Date | null;
  visit: { startsAt: Date; endsAt: Date } | null;
  repName: string | null;
  /** The newest time a person from the company put a window of their own on the address's window measurement. */
  repMeasuredAt: Date | null;
  /** A factory order for the address's windows: 'draft' | 'ready' | 'sent', and when it became ready / was sent. */
  order: { status: string; readyAt: Date | null; sentAt: Date | null } | null;
};

/**
 * The filed request's job, visit, the company's own measuring and factory order, so the app can say where things are.
 * Null before the request is filed (no job yet).
 */
export async function homeownerProgress(tx: Tx, ctx: TenantContext, request: HomeownerRequestRow): Promise<HomeownerProgress | null> {
  if (request.quoteRequestId === null) return null;
  const [filed] = await tx
    .select({ jobId: quoteRequests.jobId, appointmentId: quoteRequests.appointmentId })
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

  // The company's own measuring: any window on any measurement of this address that did not come from the app.
  const propertyId = job?.propertyId ?? request.propertyId;
  let repMeasuredAt: Date | null = null;
  let order: HomeownerProgress['order'] = null;
  if (propertyId !== null) {
    const measurements = await tx
      .select({ id: windowMeasurements.id, adjustments: windowMeasurements.adjustments, updatedAt: windowMeasurements.updatedAt })
      .from(windowMeasurements)
      .where(and(eq(windowMeasurements.propertyId, propertyId), eq(windowMeasurements.companyId, ctx.companyId)))
      .orderBy(desc(windowMeasurements.createdAt));
    for (const m of measurements) {
      const own = (m.adjustments.photoWindows ?? []).some((w) => w.source !== HOMEOWNER_APP_SOURCE);
      if (own && (repMeasuredAt === null || m.updatedAt > repMeasuredAt)) repMeasuredAt = m.updatedAt;
    }
    if (measurements.length > 0) {
      const orders = await tx
        .select({ status: windowOrders.status, readyAt: windowOrders.readyAt, sentAt: windowOrders.sentAt })
        .from(windowOrders)
        .where(and(eq(windowOrders.companyId, ctx.companyId), inArray(windowOrders.windowMeasurementId, measurements.map((m) => m.id))))
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
  };
}
