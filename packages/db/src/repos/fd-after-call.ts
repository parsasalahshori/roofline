import type { TransferResult } from '@roofline/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { calls, conversationTurns } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/* After-call reads and writes (D1 Task 13). All run inside withTenant. */

export type AfterCallRow = {
  id: string;
  callSid: string;
  fromE164: string;
  toE164: string;
  status: 'ringing' | 'ai' | 'ringing_team' | 'transferred' | 'ended' | 'rejected' | 'failed';
  conversationId: string | null;
  startedAt: Date;
  /** Set by the relay when the AI picks up (A1: the after-call job counts an AI-handled call even before ai_seconds is added). */
  aiStartedAt: Date | null;
  endedAt: Date | null;
  aiSeconds: number;
  billedMinutes: number;
  transcriptStored: boolean;
  spamReason: string | null;
  transferResult: TransferResult | null;
  textBackMessageId: string | null;
};

/** The call row the after-call job works on, or null. */
export async function loadCallForAfterCall(tx: Tx, ctx: TenantContext, callSid: string): Promise<AfterCallRow | null> {
  const [row] = await tx
    .select({
      id: calls.id,
      callSid: calls.callSid,
      fromE164: calls.fromE164,
      toE164: calls.toE164,
      status: calls.status,
      conversationId: calls.conversationId,
      startedAt: calls.startedAt,
      aiStartedAt: calls.aiStartedAt,
      endedAt: calls.endedAt,
      aiSeconds: calls.aiSeconds,
      billedMinutes: calls.billedMinutes,
      transcriptStored: calls.transcriptStored,
      spamReason: calls.spamReason,
      transferResult: calls.transferResult,
      textBackMessageId: calls.textBackMessageId,
    })
    .from(calls)
    .where(and(eq(calls.companyId, ctx.companyId), eq(calls.callSid, callSid)))
    .limit(1);
  return row ?? null;
}

/** Records the billed minutes of the call. */
export async function closeCallAfterCall(
  tx: Tx,
  ctx: TenantContext,
  callSid: string,
  i: { billedMinutes: number },
): Promise<void> {
  await tx
    .update(calls)
    .set({ billedMinutes: i.billedMinutes })
    .where(and(eq(calls.companyId, ctx.companyId), eq(calls.callSid, callSid)));
}

/** Names of the tools that ran successfully in the conversation, in order (repeats kept). */
export async function loadBookingActions(tx: Tx, ctx: TenantContext, conversationId: string): Promise<string[]> {
  const rows = await tx
    .select({ toolCalls: conversationTurns.toolCalls })
    .from(conversationTurns)
    .where(and(eq(conversationTurns.companyId, ctx.companyId), eq(conversationTurns.conversationId, conversationId)))
    .orderBy(asc(conversationTurns.position));
  const names: string[] = [];
  for (const r of rows) for (const t of r.toolCalls ?? []) if (t.ok) names.push(t.name);
  return names;
}

/** How many turns the caller spoke. */
export async function countCallerTurns(tx: Tx, ctx: TenantContext, conversationId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.companyId, ctx.companyId),
        eq(conversationTurns.conversationId, conversationId),
        eq(conversationTurns.speaker, 'caller'),
      ),
    );
  return row?.n ?? 0;
}
