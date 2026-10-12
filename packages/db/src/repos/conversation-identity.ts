import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { VERIFY_MISMATCH_PREFIX, type IdentityLevel } from '@roofline/shared';
import { conversations, conversationTurns } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/*
 * D1 Task RC-1: who the conversation is with, and how far it got. SHELL: package A fills in the bodies;
 * the signatures are final. Work on the tenant pool inside withTenant (no app_system grants exist).
 */

export type StoredIdentity = {
  identity: IdentityLevel;
  customerId: string | null;
  /** Failed verify_caller calls recorded in this conversation's stored turns (name 'verify_caller', ok false, and a mismatch result or none: redacted or expired). */
  verifyFailures: number;
};

export type StoredTurnStats = {
  /** max(position)+1 over the conversation's turns, 0 when there are none. */
  nextPosition: number;
  /** Rows with speaker 'caller'. */
  callerTurns: number;
  /** Rows with speaker 'assistant'. */
  assistantTurns: number;
};

/** The conversation's stored identity, customer and failed-verification count; null when the conversation is not this company's. */
export async function loadStoredIdentity(tx: Tx, ctx: TenantContext, conversationId: string): Promise<StoredIdentity | null> {
  const [row] = await tx
    .select({ identity: conversations.identity, customerId: conversations.customerId })
    .from(conversations)
    .where(and(eq(conversations.companyId, ctx.companyId), eq(conversations.id, conversationId)));
  if (!row) return null;
  const turns = await tx
    .select({ toolCalls: conversationTurns.toolCalls })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.companyId, ctx.companyId),
        eq(conversationTurns.conversationId, conversationId),
        isNotNull(conversationTurns.toolCalls),
      ),
    );
  let verifyFailures = 0;
  for (const t of turns) {
    for (const call of t.toolCalls ?? []) {
      // A real mismatch, or a row whose result redaction (a recording objection) or retention stripped, so the lockout
      // survives both. Engine refusals (invalid input, not available, errors) keep their result and are not counted.
      const result = typeof call.result === 'string' ? call.result : '';
      if (call.name === 'verify_caller' && call.ok === false && (result === '' || result.startsWith(VERIFY_MISMATCH_PREFIX))) {
        verifyFailures += 1;
      }
    }
  }
  return { identity: row.identity as IdentityLevel, customerId: row.customerId, verifyFailures };
}

/** Writes conversations.identity and conversations.customer_id (and updated_at) in one UPDATE. */
export async function saveCallerIdentity(
  tx: Tx,
  ctx: TenantContext,
  conversationId: string,
  i: { identity: IdentityLevel; customerId: string | null },
): Promise<void> {
  await tx
    .update(conversations)
    .set({ identity: i.identity, customerId: i.customerId, updatedAt: sql`now()` as unknown as Date })
    .where(and(eq(conversations.companyId, ctx.companyId), eq(conversations.id, conversationId)));
}

/** Counts and the next position of the stored turns of one conversation. */
export async function loadTurnStats(tx: Tx, ctx: TenantContext, conversationId: string): Promise<StoredTurnStats> {
  const [row] = await tx
    .select({
      next: sql<number>`coalesce(max(${conversationTurns.position}), -1) + 1`,
      caller: sql<number>`count(*) filter (where ${conversationTurns.speaker} = 'caller')`,
      assistant: sql<number>`count(*) filter (where ${conversationTurns.speaker} = 'assistant')`,
    })
    .from(conversationTurns)
    .where(and(eq(conversationTurns.companyId, ctx.companyId), eq(conversationTurns.conversationId, conversationId)));
  return { nextPosition: Number(row!.next), callerTurns: Number(row!.caller), assistantTurns: Number(row!.assistant) };
}
