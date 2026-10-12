import { and, desc, eq, sql } from 'drizzle-orm';
import {
  calculateQuote,
  localDate,
  type Calculation,
  type Pricebook,
  type QuoteMeasurement,
  type QuoteStatus,
  type QuoteSummary,
  type QuoteView,
  type Scope,
} from '@roofline/shared';
import { jobs, quoteCounters, quotes } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { addActivity } from './activities.ts';
import { getJob, updateJob } from './jobs.ts';
import { getPricebook } from './pricebook.ts';
import { canSeeJobValue, jobScope, jobValueScope } from './scope.ts';

type QuoteRow = typeof quotes.$inferSelect;

/** Days a new quote stays valid from the day it is started. */
const VALID_DAYS = 30;

/** Thrown by `createQuote` when the job does not exist or the member may not see it. The route maps it to 404. */
export class QuoteJobNotFoundError extends Error {
  constructor() {
    super('job-not-found');
    this.name = 'QuoteJobNotFoundError';
  }
}

/**
 * Matches a quote whose job the member may see (scope.ts). A quote whose job is outside the
 * member's scope is reported exactly like one that does not exist.
 */
function visibleQuoteCondition(ctx: TenantContext) {
  // Both are undefined for the owner and office; interpolating one would leave a dangling `and )`.
  // A quote carries the job's value, so a rep sees it only on jobs whose value they may see.
  const scope = jobScope(ctx);
  const valueScope = jobValueScope(ctx);
  return sql`exists (select 1 from ${jobs} where ${jobs.id} = ${quotes.jobId} and ${jobs.companyId} = ${quotes.companyId}${scope ? sql` and ${scope}` : sql``}${valueScope ? sql` and ${valueScope}` : sql``})`;
}

async function findVisibleQuote(tx: Tx, ctx: TenantContext, id: string, lock: boolean): Promise<QuoteRow | null> {
  const query = tx
    .select()
    .from(quotes)
    .where(and(eq(quotes.id, id), eq(quotes.companyId, ctx.companyId), visibleQuoteCondition(ctx)))
    .limit(1);
  const [row] = lock ? await query.for('update') : await query;
  return row ?? null;
}

/** The quote's scope with its area, area type and pitch forced to match the measurement. */
function syncScope(scope: Scope, measurement: QuoteMeasurement): Scope {
  return { ...scope, areaSqFt: measurement.areaSqFt, areaType: measurement.areaType, pitch: measurement.pitch };
}

/** Adds `days` to a `YYYY-MM-DD` day using UTC arithmetic only (no local-time methods). */
function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** `Q-0001` style: at least four digits, growing past 9999 on its own. */
function formatQuoteNumber(n: number): string {
  return `Q-${String(n).padStart(4, '0')}`;
}

function toView(row: QuoteRow): QuoteView {
  return {
    id: row.id,
    jobId: row.jobId,
    number: row.number,
    status: row.status as QuoteStatus,
    measurement: row.measurement as QuoteMeasurement,
    scope: row.scope as Scope,
    prices: row.prices as Pricebook,
    calculation: row.calculation as Calculation,
    notes: row.notes,
    validUntil: row.validUntil,
    createdAt: row.createdAt.toISOString(),
    finalizedAt: row.finalizedAt ? row.finalizedAt.toISOString() : null,
    canEdit: row.status === 'draft',
  };
}

/**
 * The next quote number for the company. One atomic upsert: the first call inserts the counter at
 * 2 and issues 1; later calls increment it. The conflict takes a row lock, so concurrent creates
 * each get their own number.
 */
export async function nextQuoteNumber(tx: Tx, ctx: TenantContext): Promise<string> {
  const [row] = await tx
    .insert(quoteCounters)
    .values({ companyId: ctx.companyId, nextNumber: 2 })
    .onConflictDoUpdate({
      target: quoteCounters.companyId,
      set: { nextNumber: sql`${quoteCounters.nextNumber} + 1`, updatedAt: sql`now()` },
    })
    .returning({ nextNumber: quoteCounters.nextNumber });
  if (!row) throw new Error('quote counter not returned');
  return formatQuoteNumber(row.nextNumber - 1);
}

/**
 * Inserts a draft for a job with the current pricebook prices snapshotted into it, and writes the
 * job's timeline line. The caller has already checked that the job is visible to the member.
 */
async function insertDraft(
  tx: Tx,
  ctx: TenantContext,
  draft: { jobId: string; measurement: QuoteMeasurement; scope: Scope; notes: string | null },
  now: Date,
  timeZone: string,
): Promise<QuoteView> {
  const { prices } = await getPricebook(tx, ctx);
  const scope = syncScope(draft.scope, draft.measurement);
  const calculation = calculateQuote(scope, prices);
  const number = await nextQuoteNumber(tx, ctx);
  const [row] = await tx
    .insert(quotes)
    .values({
      companyId: ctx.companyId,
      jobId: draft.jobId,
      number,
      status: 'draft',
      measurement: draft.measurement,
      scope,
      prices,
      calculation,
      notes: draft.notes,
      validUntil: addDays(localDate(now, timeZone), VALID_DAYS),
      createdByUserId: ctx.userId,
      finalizedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error('quote not returned');
  await addActivity(tx, ctx, {
    subjectType: 'job',
    subjectId: draft.jobId,
    kind: 'quote.created',
    summary: `Quote ${number} started`,
    at: now,
  });
  return toView(row);
}

/** A new draft quote for a job the member may see. Throws `QuoteJobNotFoundError` otherwise. */
export async function createQuote(
  tx: Tx,
  ctx: TenantContext,
  i: { jobId: string; measurement: QuoteMeasurement; scope: Scope; notes: string | null },
  now: Date,
  timeZone: string,
): Promise<QuoteView> {
  const job = await getJob(tx, ctx, i.jobId);
  if (!job || !canSeeJobValue(ctx, job)) throw new QuoteJobNotFoundError();
  return insertDraft(tx, ctx, i, now, timeZone);
}

/**
 * Edits a draft. Null when the quote is not visible; 'final' when it is final (final quotes are
 * frozen). Scope area, area type and pitch always follow the resulting measurement. The calculation
 * is recomputed from the resulting scope and prices.
 */
export async function updateQuote(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  p: Partial<{ measurement: QuoteMeasurement; scope: Scope; notes: string | null; refreshPrices: boolean }>,
  now: Date,
): Promise<QuoteView | 'final' | null> {
  const row = await findVisibleQuote(tx, ctx, id, true);
  if (!row) return null;
  if (row.status === 'final') return 'final';

  const measurement = p.measurement !== undefined ? p.measurement : (row.measurement as QuoteMeasurement);
  const scope = syncScope(p.scope !== undefined ? p.scope : (row.scope as Scope), measurement);
  const notes = p.notes !== undefined ? p.notes : row.notes;
  const prices = p.refreshPrices ? (await getPricebook(tx, ctx)).prices : (row.prices as Pricebook);
  const calculation = calculateQuote(scope, prices);

  const [updated] = await tx
    .update(quotes)
    .set({ measurement, scope, notes, prices, calculation, updatedAt: now })
    .where(and(eq(quotes.id, id), eq(quotes.companyId, ctx.companyId)))
    .returning();
  if (!updated) return null;
  return toView(updated);
}

/**
 * Marks a draft final, freezing its prices and calculation. When the job has no value yet, the
 * job's value is set to the quote total (through `updateJob`, so its audit row is written).
 * Null when not visible; 'final' when already final.
 */
export async function finalizeQuote(tx: Tx, ctx: TenantContext, id: string, now: Date): Promise<QuoteView | 'final' | null> {
  const row = await findVisibleQuote(tx, ctx, id, true);
  if (!row) return null;
  if (row.status === 'final') return 'final';

  const [updated] = await tx
    .update(quotes)
    .set({ status: 'final', finalizedAt: now, updatedAt: now })
    .where(and(eq(quotes.id, id), eq(quotes.companyId, ctx.companyId)))
    .returning();
  if (!updated) return null;
  const view = toView(updated);
  const { number, calculation } = view;

  const job = await getJob(tx, ctx, row.jobId);
  if (job && job.valueCents === null) {
    await updateJob(tx, ctx, row.jobId, { valueCents: calculation.totalCents }, { now, ip: null });
    await addActivity(tx, ctx, {
      subjectType: 'job',
      subjectId: row.jobId,
      kind: 'quote.value_set',
      summary: `Value set from quote ${number}`,
      at: now,
    });
  }
  await addActivity(tx, ctx, {
    subjectType: 'job',
    subjectId: row.jobId,
    kind: 'quote.finalized',
    summary: `Quote ${number} marked final`,
    at: now,
  });
  return view;
}

/**
 * A new draft for the same job, copied from a visible quote, with today's prices. Null when the
 * source quote is not visible.
 */
export async function copyQuote(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  now: Date,
  timeZone: string,
): Promise<QuoteView | null> {
  const source = await findVisibleQuote(tx, ctx, id, false);
  if (!source) return null;
  return insertDraft(
    tx,
    ctx,
    {
      jobId: source.jobId,
      measurement: source.measurement as QuoteMeasurement,
      scope: source.scope as Scope,
      notes: source.notes,
    },
    now,
    timeZone,
  );
}

/** One quote the member may see, or null. */
export async function getQuote(tx: Tx, ctx: TenantContext, id: string): Promise<QuoteView | null> {
  const row = await findVisibleQuote(tx, ctx, id, false);
  return row ? toView(row) : null;
}

/** A job's quotes, newest first. Empty when the job is not visible to the member. */
export async function listQuoteSummaries(tx: Tx, ctx: TenantContext, jobId: string): Promise<QuoteSummary[]> {
  const rows = await tx
    .select({
      id: quotes.id,
      number: quotes.number,
      status: quotes.status,
      calculation: quotes.calculation,
      updatedAt: quotes.updatedAt,
    })
    .from(quotes)
    .where(and(eq(quotes.companyId, ctx.companyId), eq(quotes.jobId, jobId), visibleQuoteCondition(ctx)))
    .orderBy(desc(quotes.createdAt), desc(quotes.id));
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    status: r.status as QuoteStatus,
    totalCents: (r.calculation as Calculation).totalCents,
    updatedAt: r.updatedAt.toISOString(),
  }));
}
