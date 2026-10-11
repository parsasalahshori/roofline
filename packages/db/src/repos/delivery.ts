import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { earlyDeliveryReports, messages } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/*
 * Delivery reports that arrive before the send is saved (spec 4.5). The provider can report a
 * text's delivery before our send has stored the provider's id for it. Such a report is kept in
 * `early_delivery_reports` and applied when the send is saved (`applyEarlyDeliveryReports`). A
 * per-SID advisory transaction lock makes the report and the save take turns, so a report is never
 * stored after the save already looked for it.
 */

/**
 * Takes the per-SID advisory transaction lock for this company and provider id; held until the
 * transaction ends. Both the `/status` path and `applyEarlyDeliveryReports` take it first.
 */
export async function lockDeliverySid(tx: Tx, ctx: TenantContext, providerSid: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${ctx.companyId}::text || ':' || ${providerSid}::text, 0))`,
  );
}

/**
 * Stores a delivery report that came in before the send was saved. A repeat of the same report
 * (same SID and status) stores nothing. The caller holds the SID lock (`lockDeliverySid`).
 */
export async function saveEarlyDeliveryReport(
  tx: Tx,
  ctx: TenantContext,
  r: { providerSid: string; status: 'delivered' | 'failed'; reason: string | null },
  now: Date,
): Promise<void> {
  await tx
    .insert(earlyDeliveryReports)
    .values({
      companyId: ctx.companyId,
      providerMessageSid: r.providerSid,
      status: r.status,
      reason: r.reason,
      receivedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
}

/**
 * Applies the company's unapplied early reports for this provider id to the text that was just
 * saved as `sent` (`messageId`). Takes the SID lock first, then reads the reports `for update`. No
 * reports: null. A `failed` report wins over `delivered`; a failure fails the text with the stored
 * reason (not retryable). Each read report is marked applied. Returns the status applied. Only a
 * `sent` text moves.
 */
export async function applyEarlyDeliveryReports(
  tx: Tx,
  ctx: TenantContext,
  messageId: string,
  providerSid: string,
  now: Date,
): Promise<'delivered' | 'failed' | null> {
  await lockDeliverySid(tx, ctx, providerSid);
  const reports = await tx
    .select({ id: earlyDeliveryReports.id, status: earlyDeliveryReports.status, reason: earlyDeliveryReports.reason })
    .from(earlyDeliveryReports)
    .where(
      and(
        eq(earlyDeliveryReports.companyId, ctx.companyId),
        eq(earlyDeliveryReports.providerMessageSid, providerSid),
        isNull(earlyDeliveryReports.appliedAt),
      ),
    )
    .orderBy(earlyDeliveryReports.id)
    .for('update');
  if (reports.length === 0) return null;

  const failed = reports.find((r) => r.status === 'failed');
  const applied = failed ? 'failed' : 'delivered';
  const where = and(eq(messages.companyId, ctx.companyId), eq(messages.id, messageId), eq(messages.status, 'sent'));
  if (failed) {
    await tx
      .update(messages)
      .set({ status: 'failed', retryable: false, blockRule: null, blockReason: failed.reason, updatedAt: now })
      .where(where);
  } else {
    await tx.update(messages).set({ status: 'delivered', updatedAt: now }).where(where);
  }

  await tx
    .update(earlyDeliveryReports)
    .set({ appliedAt: now, updatedAt: now })
    .where(
      and(eq(earlyDeliveryReports.companyId, ctx.companyId), inArray(earlyDeliveryReports.id, reports.map((r) => r.id))),
    );
  return applied;
}
