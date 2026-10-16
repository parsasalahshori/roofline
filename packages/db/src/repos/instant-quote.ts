import { and, count, desc, eq, gt, gte, isNull } from 'drizzle-orm';
import {
  type InstantQuoteSettings,
  localDate,
  normalizeAddressKey,
  QUOTE_DEFAULTS,
  type QuoteProduct,
  QUOTE_PRODUCTS,
} from '@roofline/shared';
import { companies, companySettings, measurements, quoteEstimates, quoteRequests } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { addActivity } from './activities.ts';
import { audit } from './audit.ts';
import { createJob } from './jobs.ts';
import { addressCustomerFor, addressRowFor, lockWebLead, phoneCustomerFor, webLeadZone, type WebLeadInput } from './web-lead.ts';

/*
 * Instant quote (public /q/:slug): the owner's settings, the stored estimates (a 30-day cache by address, and the
 * count against the daily cap) and the homeowner's request that becomes a customer, address and Lead job.
 * Everything runs inside the caller's withTenant; the public route uses a 'system' context for the page's company.
 */

const isProduct = (p: string): p is QuoteProduct => (QUOTE_PRODUCTS as readonly string[]).includes(p);

/** The owner's instant quote settings, or the defaults when the company has no settings row yet. */
export async function getQuoteSettings(tx: Tx, ctx: TenantContext): Promise<InstantQuoteSettings> {
  const [row] = await tx
    .select({
      enabled: companySettings.quoteEnabled,
      slug: companySettings.quoteSlug,
      products: companySettings.quoteProducts,
      rangePct: companySettings.quoteRangePct,
      dailyCap: companySettings.quoteDailyCap,
      embedOrigins: companySettings.quoteEmbedOrigins,
      booking: companySettings.quoteBooking,
      accentColor: companySettings.quoteAccentColor,
    })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId))
    .limit(1);
  if (!row) {
    return {
      enabled: false,
      slug: null,
      products: [...QUOTE_DEFAULTS.products],
      rangePct: QUOTE_DEFAULTS.rangePct,
      dailyCap: QUOTE_DEFAULTS.dailyCap,
      embedOrigins: [],
      booking: false,
      accentColor: null,
    };
  }
  // Ordered as QUOTE_PRODUCTS, whatever order they were saved in.
  const products = QUOTE_PRODUCTS.filter((p) => row.products.includes(p));
  return { ...row, products };
}

/** A slug another company's page already uses. */
export class QuoteSlugTakenError extends Error {
  constructor() {
    super('That page address is taken.');
    this.name = 'QuoteSlugTakenError';
  }
}

/** Saves the settings (the route has checked every field), with an audit row of what changed. */
export async function saveQuoteSettings(tx: Tx, ctx: TenantContext, next: InstantQuoteSettings, now: Date): Promise<InstantQuoteSettings> {
  const before = await getQuoteSettings(tx, ctx);
  const values = {
    quoteEnabled: next.enabled,
    quoteSlug: next.slug,
    quoteProducts: next.products.filter(isProduct),
    quoteRangePct: next.rangePct,
    quoteDailyCap: next.dailyCap,
    quoteEmbedOrigins: next.embedOrigins,
    quoteBooking: next.booking,
    quoteAccentColor: next.accentColor,
    updatedAt: now,
  };
  try {
    await tx
      .insert(companySettings)
      .values({ companyId: ctx.companyId, ...values })
      .onConflictDoUpdate({ target: companySettings.companyId, set: values });
  } catch (err) {
    const code = (err as { cause?: { code?: string; constraint?: string }; code?: string; constraint?: string }) ?? {};
    const pg = code.cause ?? code;
    if (pg.code === '23505' && pg.constraint === 'company_settings_quote_slug_uniq') throw new QuoteSlugTakenError();
    throw err;
  }
  const after = await getQuoteSettings(tx, ctx);
  await audit(tx, ctx, { action: 'company.instant_quote_settings', targetType: 'company', targetId: ctx.companyId, before, after, ip: null, at: now });
  return after;
}

/** The company's public face for the page: name, logo, phone. */
export async function quoteCompany(tx: Tx, ctx: TenantContext): Promise<{ name: string; logoUrl: string | null; phoneE164: string | null } | null> {
  const [row] = await tx
    .select({ name: companies.name, logoUrl: companies.logoUrl, phoneE164: companies.phoneE164 })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  return row ?? null;
}

export type QuoteEstimateRow = typeof quoteEstimates.$inferSelect;

/** The typed address as a cache key: lowercase, spaces and commas collapsed. */
export function quoteInputKey(address: string): string {
  return address
    .trim()
    .toLowerCase()
    .replace(/[\s,]+/g, ' ')
    .replace(/[.#]/g, '');
}

/**
 * The newest unexpired 'ready' estimate for this typed address (or, given `addressKey`, for the found address),
 * or null. Fallback rows are never reused: the next visit may have room under the cap.
 */
export async function findCachedEstimate(
  tx: Tx,
  ctx: TenantContext,
  by: { inputKey: string } | { addressKey: string },
  now: Date,
): Promise<QuoteEstimateRow | null> {
  const [row] = await tx
    .select()
    .from(quoteEstimates)
    .where(
      and(
        eq(quoteEstimates.companyId, ctx.companyId),
        eq(quoteEstimates.status, 'ready'),
        gt(quoteEstimates.expiresAt, now),
        'inputKey' in by ? eq(quoteEstimates.inputKey, by.inputKey) : eq(quoteEstimates.addressKey, by.addressKey),
      ),
    )
    .orderBy(desc(quoteEstimates.createdAt))
    .limit(1);
  return row ?? null;
}

/** Estimates since `since` that spent paid calls: what the daily cap counts. */
export async function countMeasuredSince(tx: Tx, ctx: TenantContext, since: Date): Promise<number> {
  const [row] = await tx
    .select({ total: count() })
    .from(quoteEstimates)
    .where(and(eq(quoteEstimates.companyId, ctx.companyId), eq(quoteEstimates.measured, true), gte(quoteEstimates.createdAt, since)));
  return row?.total ?? 0;
}

/** The start of the company's local day containing `now` (the daily cap resets at local midnight). */
export async function companyDayStart(tx: Tx, ctx: TenantContext, now: Date): Promise<{ day: string; zone: string }> {
  const zone = await webLeadZone(tx, ctx);
  return { day: localDate(now, zone), zone };
}

export type NewQuoteEstimate = {
  inputKey: string;
  addressKey: string | null;
  address: string;
  status: 'ready' | 'fallback';
  measured: boolean;
  propertyId: string | null;
  measurementId: string | null;
  result: Record<string, unknown>;
  ipHash: string | null;
  expiresAt: Date;
};

export async function insertQuoteEstimate(tx: Tx, ctx: TenantContext, e: NewQuoteEstimate, now: Date): Promise<QuoteEstimateRow> {
  const [row] = await tx
    .insert(quoteEstimates)
    .values({ companyId: ctx.companyId, ...e, createdAt: now, updatedAt: now })
    .returning();
  await audit(tx, ctx, {
    action: 'quote.estimate',
    targetType: 'quote_estimate',
    targetId: row!.id,
    // No address, no IP: only what happened.
    after: { status: e.status, measured: e.measured },
    ip: null,
    at: now,
  });
  return row!;
}

/** One estimate of this company by id (RLS keeps other companies' out), or null. */
export async function getQuoteEstimate(tx: Tx, ctx: TenantContext, id: string): Promise<QuoteEstimateRow | null> {
  const [row] = await tx.select().from(quoteEstimates).where(and(eq(quoteEstimates.id, id), eq(quoteEstimates.companyId, ctx.companyId))).limit(1);
  return row ?? null;
}

/** Notes a cache hit: the audit trail says the estimate was shown again, without who to. */
export async function noteEstimateReused(tx: Tx, ctx: TenantContext, id: string, now: Date): Promise<void> {
  await audit(tx, ctx, { action: 'quote.estimate_reused', targetType: 'quote_estimate', targetId: id, ip: null, at: now });
}

export type QuoteRequestInput = WebLeadInput & {
  quoteEstimateId: string | null;
  firstName: string;
  lastName: string;
  email: string;
  postalCode: string;
  products: QuoteProduct[];
  consentText: string;
  consentVersion: string;
  ipHash: string | null;
  /** The measurement to attach to the new job (the estimate's), when there is one. */
  measurementId: string | null;
  /** One line for the job's timeline, saying what the homeowner was shown (ranges only). */
  summary: string;
  now: Date;
};

export type QuoteRequestResult = { requestId: string; customerId: string; jobId: string; propertyId: string; created: boolean };

/** The follow-up put on the new job, so it shows on Today the day the request came in. */
const NEXT_STEP = 'Call the homeowner about their instant quote';
/** A repeat from the same phone within this long goes to the job already made, with no second job. */
const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Files the homeowner's request in one transaction (the caller's withTenant), the way a storm page request is filed
 * (web-lead.ts): the customer for the phone (reused with its consent untouched, or a new 'web' customer at consent
 * 'none': the page's box is recorded here as evidence, Ruling BF), the address (an owned address keeps its owner),
 * a Lead job (source 'web', the next step for today) with a timeline line of the ranges shown, the estimate's
 * measurement attached to the job when it has none, and the request row with the consent text, version, time and
 * the IP hash. The same phone again within a day is the same request: no second customer or job.
 */
export async function createQuoteRequest(tx: Tx, ctx: TenantContext, input: QuoteRequestInput): Promise<QuoteRequestResult> {
  const { now } = input;
  await lockWebLead(tx, ctx.companyId, `quote:${input.phoneE164}`);
  const [repeat] = await tx
    .select({ id: quoteRequests.id, customerId: quoteRequests.customerId, jobId: quoteRequests.jobId })
    .from(quoteRequests)
    .where(and(eq(quoteRequests.companyId, ctx.companyId), eq(quoteRequests.phoneE164, input.phoneE164), gte(quoteRequests.createdAt, new Date(now.getTime() - REPEAT_WINDOW_MS))))
    .orderBy(desc(quoteRequests.createdAt))
    .limit(1);

  const phoneCustomer = await phoneCustomerFor(tx, ctx, input, now);
  const addressKey = normalizeAddressKey(input.property.addressLine, input.property.zip);
  await lockWebLead(tx, ctx.companyId, `address:${addressKey}`);
  const jobCustomer = await addressCustomerFor(tx, ctx, addressKey, phoneCustomer);
  const property = await addressRowFor(tx, ctx, input, addressKey, jobCustomer, now);

  if (repeat && repeat.customerId !== null && repeat.jobId !== null) {
    return { requestId: repeat.id, customerId: repeat.customerId, jobId: repeat.jobId, propertyId: property.id, created: false };
  }

  const zone = await webLeadZone(tx, ctx);
  const job = await createJob(
    tx,
    ctx,
    { customerId: jobCustomer.id, propertyId: property.id, stage: 'lead', source: 'web', nextStep: NEXT_STEP, nextStepOn: localDate(now, zone) },
    { now },
  );
  const attached = jobCustomer.id !== phoneCustomer.id;
  await addActivity(tx, ctx, {
    subjectType: 'job',
    subjectId: job.id,
    kind: 'job.created',
    summary: attached ? `Instant quote request, sent for this home by ${input.name}. ${input.summary}` : `Instant quote request. ${input.summary}`,
    data: { quoteEstimateId: input.quoteEstimateId, products: input.products, ...(attached && { requestedByCustomerId: phoneCustomer.id }) },
    at: now,
  });

  // The roof measurement the estimate was made from goes on the job, so the rep opens it from there.
  if (input.measurementId !== null) {
    await tx
      .update(measurements)
      .set({ jobId: job.id, updatedAt: now })
      .where(and(eq(measurements.id, input.measurementId), eq(measurements.companyId, ctx.companyId), eq(measurements.propertyId, property.id), isNull(measurements.jobId)));
  }

  const [row] = await tx
    .insert(quoteRequests)
    .values({
      companyId: ctx.companyId,
      quoteEstimateId: input.quoteEstimateId,
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phoneE164: input.phoneE164,
      postalCode: input.postalCode,
      products: input.products,
      consentText: input.consentText,
      consentVersion: input.consentVersion,
      consentAt: now,
      ipHash: input.ipHash,
      customerId: jobCustomer.id,
      jobId: job.id,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: quoteRequests.id });
  await audit(tx, ctx, {
    action: 'quote.request',
    targetType: 'quote_request',
    targetId: row!.id,
    // Ids and products only: no name, phone, email or address in the audit trail.
    after: { jobId: job.id, customerId: jobCustomer.id, products: input.products, consentVersion: input.consentVersion },
    ip: null,
    at: now,
  });
  return { requestId: row!.id, customerId: jobCustomer.id, jobId: job.id, propertyId: property.id, created: true };
}

/** Records the visit booked for a request. */
export async function setQuoteRequestAppointment(tx: Tx, ctx: TenantContext, requestId: string, appointmentId: string, now: Date): Promise<void> {
  await tx
    .update(quoteRequests)
    .set({ appointmentId, updatedAt: now })
    .where(and(eq(quoteRequests.id, requestId), eq(quoteRequests.companyId, ctx.companyId)));
}
