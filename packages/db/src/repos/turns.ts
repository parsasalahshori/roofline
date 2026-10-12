import { and, asc, eq, sql } from 'drizzle-orm';
import type { TurnRoute, TurnSpeaker } from '@roofline/shared';
import { conversations, conversationTurns } from '../schema/index.ts';
import type { ToolCallRecord } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

export type NewTurn = {
  conversationId: string;
  callId?: string | null;
  /** Deprecated and IGNORED: insertTurn allocates the position itself. */
  position?: number;
  speaker: TurnSpeaker;
  text: string;
  at?: Date;
  model?: string | null;
  route?: TurnRoute | null;
  routerMs?: number | null;
  firstTokenMs?: number | null;
  totalMs?: number | null;
  inputTokens?: number | null;
  cachedTokens?: number | null;
  outputTokens?: number | null;
  toolCalls?: ToolCallRecord[] | null;
  guardHits?: string[];
};

/**
 * Appends one turn at the next free position of its conversation. The conversation row is locked first, so
 * concurrent inserts into one conversation queue up and get distinct, consecutive positions.
 */
export async function insertTurn(tx: Tx, ctx: TenantContext, t: NewTurn): Promise<{ id: string }> {
  const locked = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.companyId, ctx.companyId), eq(conversations.id, t.conversationId)))
    .for('update');
  if (locked.length === 0) throw new Error('Conversation not found.');
  const [next] = await tx
    .select({ n: sql<number>`coalesce(max(${conversationTurns.position}), -1) + 1` })
    .from(conversationTurns)
    .where(and(eq(conversationTurns.companyId, ctx.companyId), eq(conversationTurns.conversationId, t.conversationId)));
  const position = Number(next!.n);
  const [row] = await tx
    .insert(conversationTurns)
    .values({
      companyId: ctx.companyId,
      conversationId: t.conversationId,
      callId: t.callId ?? null,
      position,
      speaker: t.speaker,
      text: t.text,
      ...(t.at !== undefined && { at: t.at }),
      model: t.model ?? null,
      route: t.route ?? null,
      routerMs: t.routerMs ?? null,
      firstTokenMs: t.firstTokenMs ?? null,
      totalMs: t.totalMs ?? null,
      inputTokens: t.inputTokens ?? null,
      cachedTokens: t.cachedTokens ?? null,
      outputTokens: t.outputTokens ?? null,
      toolCalls: t.toolCalls ?? null,
      guardHits: t.guardHits ?? [],
    })
    .returning({ id: conversationTurns.id });
  return { id: row!.id };
}

/** UPDATE only text, tool_calls, truncated (all app_tenant may change). */
export async function updateTurn(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  patch: { text?: string; toolCalls?: ToolCallRecord[]; truncated?: boolean },
): Promise<void> {
  const set: { text?: string; toolCalls?: ToolCallRecord[]; truncated?: boolean } = {};
  if (patch.text !== undefined) set.text = patch.text;
  if (patch.toolCalls !== undefined) set.toolCalls = patch.toolCalls;
  if (patch.truncated !== undefined) set.truncated = patch.truncated;
  if (Object.keys(set).length === 0) return;
  await tx
    .update(conversationTurns)
    .set(set)
    .where(and(eq(conversationTurns.companyId, ctx.companyId), eq(conversationTurns.id, id)));
}

export async function listTurns(
  tx: Tx,
  ctx: TenantContext,
  conversationId: string,
): Promise<{ id: string; position: number; speaker: TurnSpeaker; text: string; truncated: boolean; guardHits: string[] }[]> {
  return tx
    .select({
      id: conversationTurns.id,
      position: conversationTurns.position,
      speaker: conversationTurns.speaker,
      text: conversationTurns.text,
      truncated: conversationTurns.truncated,
      guardHits: conversationTurns.guardHits,
    })
    .from(conversationTurns)
    .where(and(eq(conversationTurns.companyId, ctx.companyId), eq(conversationTurns.conversationId, conversationId)))
    .orderBy(asc(conversationTurns.position));
}

/**
 * A1 Task 21: marks a conversation as having had a model_failure hand-off: a system turn with route
 * 'transfer' and guardHits ['model_failure'] at the next free position. Agents metrics read it to leave
 * the conversation out of the Front Desk success rate. It carries no customer text. Idempotent: a second
 * call for the same conversation is a no-op.
 *
 * The conversation row is locked first (the same lock D1's insertTurn takes, RC-1), so the existence check and
 * the next position are read with no other turn writer of this conversation in between: concurrent calls never
 * collide on a position and never write a second hand-off turn.
 */
export async function recordModelFailureHandoff(tx: Tx, ctx: TenantContext, conversationId: string): Promise<void> {
  const locked = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.companyId, ctx.companyId), eq(conversations.id, conversationId)))
    .for('update');
  if (locked.length === 0) return;
  const [existing] = await tx
    .select({ id: conversationTurns.id })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.companyId, ctx.companyId),
        eq(conversationTurns.conversationId, conversationId),
        eq(conversationTurns.route, 'transfer'),
        sql`'model_failure' = any(${conversationTurns.guardHits})`,
      ),
    )
    .limit(1);
  if (existing) return;
  // insertTurn (RC-1) allocates the next position under the same conversation lock.
  await insertTurn(tx, ctx, {
    conversationId,
    speaker: 'system',
    text: 'Hand-off: the assistant could not continue',
    route: 'transfer',
    guardHits: ['model_failure'],
  });
}
