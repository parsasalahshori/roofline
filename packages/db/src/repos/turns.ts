import { and, asc, eq } from 'drizzle-orm';
import type { TurnRoute, TurnSpeaker } from '@roofline/shared';
import { conversationTurns } from '../schema/index.ts';
import type { ToolCallRecord } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

export type NewTurn = {
  conversationId: string;
  callId?: string | null;
  position: number;
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

/** Appends one turn. A second turn at the same position of a conversation is rejected by the database. */
export async function insertTurn(tx: Tx, ctx: TenantContext, t: NewTurn): Promise<{ id: string }> {
  const [row] = await tx
    .insert(conversationTurns)
    .values({
      companyId: ctx.companyId,
      conversationId: t.conversationId,
      callId: t.callId ?? null,
      position: t.position,
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
