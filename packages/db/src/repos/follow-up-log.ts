import { and, count, eq, gte, inArray, isNull, like, max } from 'drizzle-orm';
import type { FollowUpKind } from '@roofline/shared';
import { followUpLog, messages } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/*
 * The follow-up log: one row per follow-up the Follow-up agent texted, so it never nags twice, plus
 * the two message-history lookups its rules need (last inbound text, last storm text). Everything
 * runs inside `withTenant`, and each query also names the company.
 */

export type FollowUpLogRow = { customerId: string; jobId: string | null; kind: FollowUpKind; n: number; messageId: string | null; at: Date };

/** The log rows of these customers from `since` on (inclusive), oldest first. */
export async function followUpLogFor(tx: Tx, ctx: TenantContext, customerIds: readonly string[], since: Date): Promise<FollowUpLogRow[]> {
  if (customerIds.length === 0) return [];
  const rows = await tx
    .select({
      customerId: followUpLog.customerId,
      jobId: followUpLog.jobId,
      kind: followUpLog.kind,
      n: followUpLog.n,
      messageId: followUpLog.messageId,
      at: followUpLog.at,
    })
    .from(followUpLog)
    .where(and(eq(followUpLog.companyId, ctx.companyId), inArray(followUpLog.customerId, [...customerIds]), gte(followUpLog.at, since)))
    .orderBy(followUpLog.at, followUpLog.id);
  return rows;
}

/**
 * Logs one follow-up. `n` is 1 plus the earlier rows for the same job and kind (same customer and
 * kind when there is no job). A second call with the same message id adds nothing. The check and the
 * insert share this transaction; there is no unique index on `message_id`, so a select-then-insert.
 */
export async function recordFollowUp(
  tx: Tx,
  ctx: TenantContext,
  row: { customerId: string; jobId: string | null; kind: FollowUpKind; messageId: string; at: Date },
): Promise<void> {
  const [existing] = await tx
    .select({ id: followUpLog.id })
    .from(followUpLog)
    .where(and(eq(followUpLog.companyId, ctx.companyId), eq(followUpLog.messageId, row.messageId)))
    .limit(1);
  if (existing) return;
  const [prior] = await tx
    .select({ n: count() })
    .from(followUpLog)
    .where(
      and(
        eq(followUpLog.companyId, ctx.companyId),
        eq(followUpLog.kind, row.kind),
        row.jobId === null
          ? and(eq(followUpLog.customerId, row.customerId), isNull(followUpLog.jobId))
          : eq(followUpLog.jobId, row.jobId),
      ),
    );
  await tx.insert(followUpLog).values({
    companyId: ctx.companyId,
    customerId: row.customerId,
    jobId: row.jobId,
    kind: row.kind,
    n: (prior?.n ?? 0) + 1,
    messageId: row.messageId,
    at: row.at,
  });
}

/** When the customer last texted in, or null if never. */
export async function lastInboundAt(tx: Tx, ctx: TenantContext, customerId: string): Promise<Date | null> {
  const [row] = await tx
    .select({ at: max(messages.createdAt) })
    .from(messages)
    .where(and(eq(messages.companyId, ctx.companyId), eq(messages.customerId, customerId), eq(messages.direction, 'in')));
  return row?.at ?? null;
}

/** When the customer was last sent a storm text (outbound, dedupe key `storm:...`), or null. */
export async function lastStormTextAt(tx: Tx, ctx: TenantContext, customerId: string): Promise<Date | null> {
  const [row] = await tx
    .select({ at: max(messages.createdAt) })
    .from(messages)
    .where(
      and(
        eq(messages.companyId, ctx.companyId),
        eq(messages.customerId, customerId),
        eq(messages.direction, 'out'),
        like(messages.dedupeKey, 'storm:%'),
      ),
    );
  return row?.at ?? null;
}
