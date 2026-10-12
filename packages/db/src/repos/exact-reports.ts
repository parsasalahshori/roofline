import { and, asc, eq, isNull, lte, or } from 'drizzle-orm';
import type { ExactOrderStatus } from '@roofline/shared';
import { exactReportOrders } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/*
 * Exact (paid) roof report orders. Money rules: a row is claimed (priced -> ordering) in its own
 * transaction before the provider is called, so a second run finds nothing to claim. Provider text
 * is never stored; error_plain holds only our own plain sentences.
 */
export type ExactOrderRow = {
  id: string;
  measurementId: string;
  status: ExactOrderStatus;
  priceMinCents: number | null;
  priceMaxCents: number | null;
  priceExpiresAt: Date | null;
  providerProductId: string | null;
  providerReportId: string | null;
  referenceId: string;
  taskId: string | null;
  lastPolledAt: Date | null;
  errorPlain: string | null;
};

export type NewExactOrder = {
  measurementId: string;
  priceMinCents: number;
  priceMaxCents: number;
  priceExpiresAt: Date;
  providerProductId: string;
  referenceId: string;
};

const toRow = (r: typeof exactReportOrders.$inferSelect): ExactOrderRow => ({
  id: r.id,
  measurementId: r.measurementId,
  status: r.status,
  priceMinCents: r.priceMinCents,
  priceMaxCents: r.priceMaxCents,
  priceExpiresAt: r.priceExpiresAt,
  providerProductId: r.providerProductId,
  providerReportId: r.providerReportId,
  referenceId: r.referenceId,
  taskId: r.taskId,
  lastPolledAt: r.lastPolledAt,
  errorPlain: r.errorPlain,
});

const mine = (ctx: TenantContext, id: string) =>
  and(eq(exactReportOrders.companyId, ctx.companyId), eq(exactReportOrders.id, id));

/** Inserts an order row with status 'priced'. */
export async function insertExactOrder(tx: Tx, ctx: TenantContext, o: NewExactOrder, now: Date): Promise<ExactOrderRow> {
  const [row] = await tx
    .insert(exactReportOrders)
    .values({
      companyId: ctx.companyId,
      measurementId: o.measurementId,
      status: 'priced',
      priceMinCents: o.priceMinCents,
      priceMaxCents: o.priceMaxCents,
      priceExpiresAt: o.priceExpiresAt,
      providerProductId: o.providerProductId,
      referenceId: o.referenceId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return toRow(row!);
}

export async function getExactOrder(tx: Tx, ctx: TenantContext, id: string): Promise<ExactOrderRow | null> {
  const [row] = await tx.select().from(exactReportOrders).where(mine(ctx, id)).limit(1);
  return row ? toRow(row) : null;
}

/** Sets task_id on an order. */
export async function setExactOrderTask(tx: Tx, ctx: TenantContext, id: string, taskId: string, now: Date): Promise<void> {
  await tx.update(exactReportOrders).set({ taskId, updatedAt: now }).where(mine(ctx, id));
}

/** Atomic claim: priced -> ordering in one statement; null when the row is not 'priced'. */
export async function claimExactOrder(tx: Tx, ctx: TenantContext, id: string, now: Date): Promise<ExactOrderRow | null> {
  const [row] = await tx
    .update(exactReportOrders)
    .set({ status: 'ordering', updatedAt: now })
    .where(and(mine(ctx, id), eq(exactReportOrders.status, 'priced')))
    .returning();
  return row ? toRow(row) : null;
}

/** Stores a fresh price on an order (status unchanged). */
export async function updateExactOrderPrice(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  p: { priceMinCents: number; priceMaxCents: number; priceExpiresAt: Date },
  now: Date,
): Promise<void> {
  await tx
    .update(exactReportOrders)
    .set({ priceMinCents: p.priceMinCents, priceMaxCents: p.priceMaxCents, priceExpiresAt: p.priceExpiresAt, updatedAt: now })
    .where(mine(ctx, id));
}

/** Generic status move; returns false when the row is not in `from`. */
export async function moveExactOrder(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  from: ExactOrderStatus,
  to: ExactOrderStatus,
  set: { providerReportId?: string; errorPlain?: string | null; lastPolledAt?: Date },
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(exactReportOrders)
    .set({
      status: to,
      updatedAt: now,
      ...(set.providerReportId !== undefined && { providerReportId: set.providerReportId }),
      ...(set.errorPlain !== undefined && { errorPlain: set.errorPlain }),
      ...(set.lastPolledAt !== undefined && { lastPolledAt: set.lastPolledAt }),
    })
    .where(and(mine(ctx, id), eq(exactReportOrders.status, from)))
    .returning({ id: exactReportOrders.id });
  return rows.length > 0;
}

/** Stamps last_polled_at only. */
export async function touchExactOrderPolled(tx: Tx, ctx: TenantContext, id: string, at: Date): Promise<void> {
  await tx.update(exactReportOrders).set({ lastPolledAt: at }).where(mine(ctx, id));
}

/** The company's orders with status 'waiting' and (last_polled_at is null or <= cutoff). */
export async function listWaitingExactOrders(tx: Tx, ctx: TenantContext, cutoff: Date): Promise<ExactOrderRow[]> {
  const rows = await tx
    .select()
    .from(exactReportOrders)
    .where(
      and(
        eq(exactReportOrders.companyId, ctx.companyId),
        eq(exactReportOrders.status, 'waiting'),
        or(isNull(exactReportOrders.lastPolledAt), lte(exactReportOrders.lastPolledAt, cutoff)),
      ),
    )
    .orderBy(asc(exactReportOrders.createdAt), asc(exactReportOrders.id));
  return rows.map(toRow);
}
