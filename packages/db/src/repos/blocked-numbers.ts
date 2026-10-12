import { and, eq } from 'drizzle-orm';
import { blockedNumbers, calls, conversations } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/* Blocked numbers and the spam marks on calls (D1 Task 15).  All run inside withTenant. */

export type BlockedNumberRow = { id: string; e164: string; reason: string | null; createdAt: Date };

const BLOCK_ROW = {
  id: blockedNumbers.id,
  e164: blockedNumbers.e164,
  reason: blockedNumbers.reason,
  createdAt: blockedNumbers.createdAt,
};

/** Adds `e164` to the company blocklist; blocking a number already blocked returns the existing row (idempotent, keyed on company + e164). */
export async function blockNumber(
  tx: Tx,
  ctx: TenantContext,
  i: { e164: string; reason: string | null; blockedBy: string | null },
): Promise<BlockedNumberRow> {
  await tx
    .insert(blockedNumbers)
    .values({ companyId: ctx.companyId, e164: i.e164, reason: i.reason, blockedBy: i.blockedBy })
    .onConflictDoNothing({ target: [blockedNumbers.companyId, blockedNumbers.e164] });
  const [row] = await tx
    .select(BLOCK_ROW)
    .from(blockedNumbers)
    .where(and(eq(blockedNumbers.companyId, ctx.companyId), eq(blockedNumbers.e164, i.e164)))
    .limit(1);
  if (!row) throw new Error('The blocked number was not found after insert.');
  return row;
}

/** True when `e164` is on the company's blocklist. */
export async function isNumberBlocked(tx: Tx, ctx: TenantContext, e164: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: blockedNumbers.id })
    .from(blockedNumbers)
    .where(and(eq(blockedNumbers.companyId, ctx.companyId), eq(blockedNumbers.e164, e164)))
    .limit(1);
  return row !== undefined;
}

/** Removes one blocked number of the context's company by id. Returns false when no such row exists for this company. */
export async function unblockNumber(tx: Tx, ctx: TenantContext, id: string): Promise<boolean> {
  const rows = await tx
    .delete(blockedNumbers)
    .where(and(eq(blockedNumbers.companyId, ctx.companyId), eq(blockedNumbers.id, id)))
    .returning({ id: blockedNumbers.id });
  return rows.length > 0;
}

export type SpamMarkResult = { callId: string; fromE164: string; blockedNumberId: string | null; conversationId: string | null };

/** E.164: a plus sign, a non-zero first digit, 7 to 15 digits in all. Anything else (e.g. 'anonymous') is not blocked. */
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * "Mark as spam" on one call of the context's company, by call id. Returns null when the call is not found for this company.
 * Sets calls.spam_reason = 'marked_by_team', sets the call's conversation outcome to 'spam' (when it has one),
 * and blocks the caller's number (skipped when fromE164 is not an E.164 number, e.g. 'anonymous': blockedNumberId null).
 */
export async function markCallSpam(
  tx: Tx,
  ctx: TenantContext,
  callId: string,
  by: { userId: string | null },
): Promise<SpamMarkResult | null> {
  const [call] = await tx
    .select({ id: calls.id, fromE164: calls.fromE164, conversationId: calls.conversationId })
    .from(calls)
    .where(and(eq(calls.companyId, ctx.companyId), eq(calls.id, callId)))
    .limit(1);
  if (!call) return null;

  await tx
    .update(calls)
    .set({ spamReason: 'marked_by_team' })
    .where(and(eq(calls.companyId, ctx.companyId), eq(calls.id, call.id)));

  const conversationId = call.conversationId ?? null;
  if (conversationId) {
    await tx
      .update(conversations)
      .set({ outcome: 'spam' })
      .where(and(eq(conversations.companyId, ctx.companyId), eq(conversations.id, conversationId)));
  }

  let blockedNumberId: string | null = null;
  if (E164.test(call.fromE164)) {
    const blocked = await blockNumber(tx, ctx, { e164: call.fromE164, reason: 'marked_spam', blockedBy: by.userId });
    blockedNumberId = blocked.id;
  }

  return { callId: call.id, fromE164: call.fromE164, blockedNumberId, conversationId };
}

/** Sets calls.spam_reason on one call by id (the engine's polite-ending path). No-op when the call does not exist for this company. */
export async function setCallSpamReason(tx: Tx, ctx: TenantContext, callId: string, reason: string): Promise<void> {
  await tx
    .update(calls)
    .set({ spamReason: reason })
    .where(and(eq(calls.companyId, ctx.companyId), eq(calls.id, callId)));
}
