import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { INVOICE_KINDS, type Meter, meterUnits } from '@roofline/shared';
import type { UsageKind } from '../schema/enums.ts';
import { companies, usageEvents } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/*
 * Metered usage (spec 5.2): one `usage_events` row per billable thing that happened, such as a
 * segment of a sent text, an AI call minute or an exact report. The Stripe reporter reads these
 * rows later; writing them here never talks to Stripe.
 */

/** One billable event, before it is written to `usage_events`. */
export type NewUsage = {
  kind: UsageKind;
  quantity: number;
  unitCostCents: number | null;
  /** What the event is about, for example `message` or `report`. */
  refType: string;
  /** The id of that thing, as text. */
  refId: string;
  /** A plain description for the invoice line, such as "Exact roof report - 812 Oak St". */
  description: string | null;
  at: Date;
};

/**
 * Writes one usage event for the context's company. A repeated call for the same reference
 * (company, kind, refType, refId) is a no-op: the partial unique index `usage_events_ref_uniq`
 * drops the second insert, so a retried job never bills the same thing twice. Returns true when a
 * row was written, false when one already existed.
 */
export async function recordUsage(tx: Tx, ctx: TenantContext, input: NewUsage): Promise<boolean> {
  const rows = await tx
    .insert(usageEvents)
    .values({
      companyId: ctx.companyId,
      kind: input.kind,
      quantity: input.quantity,
      unitCostCents: input.unitCostCents,
      refType: input.refType,
      refId: input.refId,
      description: input.description,
      at: input.at,
      createdAt: input.at,
      updatedAt: input.at,
    })
    .onConflictDoNothing({
      target: [usageEvents.companyId, usageEvents.kind, usageEvents.refType, usageEvents.refId],
      where: sql`${usageEvents.refId} is not null`,
    })
    .returning({ id: usageEvents.id });
  return rows.length > 0;
}

/** The kinds that feed a Stripe Billing Meter (spec 5.2). Other kinds are invoiced per item instead. */
const METERED_KINDS = ['sms_segment', 'mms', 'ai_call_minute'] as const;

/** One open batch: the unreported rows of one meter that share a batch id, summed for Stripe. */
export type MeterBatch = { batchId: string; meter: Meter; value: number; rows: number };

/**
 * Gives every unreported metered row without a batch a batch id (one per meter), then returns
 * every open batch of the company. A row whose batch id is already set (from a run that crashed
 * before it marked the batch) comes back under the same id, so resending it is safe: the batch id
 * is the meter event's identifier at Stripe. Batches with no rows are not returned.
 */
export async function openMeterBatches(tx: Tx, ctx: TenantContext): Promise<MeterBatch[]> {
  const ai = randomUUID();
  const sms = randomUUID();
  await tx
    .update(usageEvents)
    .set({
      meterBatchId: sql`case when ${usageEvents.kind} = 'ai_call_minute' then ${ai}::uuid else ${sms}::uuid end`,
    })
    .where(
      and(
        eq(usageEvents.companyId, ctx.companyId),
        isNull(usageEvents.reportedToStripeAt),
        isNull(usageEvents.meterBatchId),
        inArray(usageEvents.kind, METERED_KINDS),
      ),
    );

  const rows = await tx
    .select({
      kind: usageEvents.kind,
      quantity: usageEvents.quantity,
      meterBatchId: usageEvents.meterBatchId,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.companyId, ctx.companyId),
        isNull(usageEvents.reportedToStripeAt),
        isNotNull(usageEvents.meterBatchId),
      ),
    );

  const batches = new Map<string, MeterBatch>();
  for (const row of rows) {
    if (!row.meterBatchId) continue;
    const unit = meterUnits(row.kind, row.quantity);
    if (!unit) continue;
    const existing = batches.get(row.meterBatchId);
    if (existing) {
      existing.value += unit.value;
      existing.rows += 1;
    } else {
      batches.set(row.meterBatchId, {
        batchId: row.meterBatchId,
        meter: unit.meter,
        value: unit.value,
        rows: 1,
      });
    }
  }
  return [...batches.values()].sort((a, b) => a.meter.localeCompare(b.meter));
}

/**
 * Marks the batch's rows as reported at `now`. Only rows not yet reported are touched, so a
 * second call is a no-op. Returns how many rows were marked.
 */
export async function markBatchReported(
  tx: Tx,
  ctx: TenantContext,
  batchId: string,
  now: Date,
): Promise<number> {
  const rows = await tx
    .update(usageEvents)
    .set({ reportedToStripeAt: now, updatedAt: now })
    .where(
      and(
        eq(usageEvents.companyId, ctx.companyId),
        eq(usageEvents.meterBatchId, batchId),
        isNull(usageEvents.reportedToStripeAt),
      ),
    )
    .returning({ id: usageEvents.id });
  return rows.length;
}

/** One invoiced usage row that has no Stripe invoice item yet. */
export type InvoiceUsageRow = {
  id: string;
  kind: UsageKind;
  quantity: number;
  unitCostCents: number;
  description: string;
};

/**
 * The company's invoiced usage (exact reports, registration fees, phone number fees) that has no
 * Stripe invoice item yet, oldest first. Rows without a unit cost are left out.
 */
export async function unbilledInvoiceUsage(tx: Tx, ctx: TenantContext): Promise<InvoiceUsageRow[]> {
  const rows = await tx
    .select({
      id: usageEvents.id,
      kind: usageEvents.kind,
      quantity: usageEvents.quantity,
      unitCostCents: usageEvents.unitCostCents,
      description: usageEvents.description,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.companyId, ctx.companyId),
        inArray(usageEvents.kind, INVOICE_KINDS),
        isNull(usageEvents.stripeInvoiceItemId),
        isNotNull(usageEvents.unitCostCents),
      ),
    )
    .orderBy(asc(usageEvents.at), asc(usageEvents.id));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    quantity: r.quantity,
    unitCostCents: r.unitCostCents as number,
    description: r.description ?? '',
  }));
}

/** Records the Stripe invoice item for a usage row, and marks the row reported at `now`. */
export async function markInvoiced(
  tx: Tx,
  ctx: TenantContext,
  usageId: string,
  invoiceItemId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(usageEvents)
    .set({ stripeInvoiceItemId: invoiceItemId, reportedToStripeAt: now, updatedAt: now })
    .where(and(eq(usageEvents.companyId, ctx.companyId), eq(usageEvents.id, usageId)));
}

/** The company's Stripe customer id, or null when it has none yet (no checkout has happened). */
export async function stripeCustomerIdFor(tx: Tx, ctx: TenantContext): Promise<string | null> {
  const [row] = await tx
    .select({ stripeCustomerId: companies.stripeCustomerId })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  return row?.stripeCustomerId ?? null;
}
