import { and, asc, desc, eq, gt, isNull, like, not, or, sql } from 'drizzle-orm';
import { companySettings, conversations, messages } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { insertConversation } from './conversations.ts';
import type { TextState } from './messages.ts';

/*
 * D1 Task 14: the rows behind Front Desk texting. Every query names ctx.companyId. Imported by
 * apps/api/src/hooks/twilio.ts and apps/api/src/front-desk/texts.ts.
 */

/** A conversation is new after this long without a message (24 h). */
export const SMS_CONVERSATION_GAP_MS = 24 * 60 * 60 * 1000;

/** The dedupe_key prefix that marks a text the assistant sent. */
const ASSISTANT_PREFIX = 'fd-text:';

export type TextConversationRef = { id: string; created: boolean; customerId: string | null };

/** One inbound text of a conversation, oldest first. */
export type InboundTextRow = { id: string; body: string; createdAt: Date };

/** One earlier text of a conversation (either direction), oldest first, for rebuilding history. */
export type ConversationTextRow = { id: string; direction: 'in' | 'out'; body: string; createdAt: Date; assistant: boolean };

/** True only when the company has Front Desk on and its texts on; false with no settings row. */
export async function frontDeskTextsOn(tx: Tx, ctx: TenantContext): Promise<boolean> {
  const [row] = await tx
    .select({ on: companySettings.frontDeskEnabled, texts: companySettings.frontDeskTexts })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId));
  return row !== undefined && row.on && row.texts;
}

/**
 * Files an inbound text under the sender's active SMS conversation (reused within 24 h of its last
 * message), else under a new one; the old one, when stale, is ended. Counts it as unread.
 */
export async function attachInboundToConversation(
  tx: Tx,
  ctx: TenantContext,
  i: { messageId: string; phoneE164: string; companyNumberE164: string; customerId: string | null },
  now: Date,
): Promise<TextConversationRef> {
  const [open] = await tx
    .select({ id: conversations.id, customerId: conversations.customerId, lastMessageAt: conversations.lastMessageAt })
    .from(conversations)
    .where(
      and(
        eq(conversations.companyId, ctx.companyId),
        eq(conversations.channel, 'sms'),
        eq(conversations.status, 'active'),
        eq(conversations.phoneE164, i.phoneE164),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1)
    .for('update');

  let id: string;
  let created = false;
  let customerId: string | null;
  if (open && now.getTime() - open.lastMessageAt.getTime() <= SMS_CONVERSATION_GAP_MS) {
    id = open.id;
    customerId = open.customerId ?? i.customerId;
  } else {
    if (open) {
      await tx
        .update(conversations)
        .set({ status: 'ended', updatedAt: now })
        .where(and(eq(conversations.companyId, ctx.companyId), eq(conversations.id, open.id)));
    }
    const made = await insertConversation(tx, ctx, {
      channel: 'sms',
      phoneE164: i.phoneE164,
      companyNumberE164: i.companyNumberE164,
      customerId: i.customerId,
    });
    id = made.id;
    created = true;
    customerId = i.customerId;
  }

  await tx
    .update(conversations)
    .set({
      lastMessageAt: now,
      unreadCount: sql`${conversations.unreadCount} + 1`,
      updatedAt: now,
      ...(customerId !== null ? { customerId } : {}),
    })
    .where(and(eq(conversations.companyId, ctx.companyId), eq(conversations.id, id)));
  await tx
    .update(messages)
    .set({ conversationId: id })
    .where(and(eq(messages.companyId, ctx.companyId), eq(messages.id, i.messageId)));
  return { id, created, customerId };
}

/** Inbound texts of the conversation after its latest outbound text (all when none), oldest first. */
export async function listUnansweredInbound(tx: Tx, ctx: TenantContext, conversationId: string): Promise<InboundTextRow[]> {
  const [last] = await tx
    .select({ at: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.companyId, ctx.companyId), eq(messages.conversationId, conversationId), eq(messages.direction, 'out')))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  return tx
    .select({ id: messages.id, body: messages.body, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.companyId, ctx.companyId),
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'in'),
        last ? gt(messages.createdAt, last.at) : undefined,
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id));
}

/** When a person on the team last texted in this conversation (an outbound the assistant did not send), else null. */
export async function lastTeamReplyAt(tx: Tx, ctx: TenantContext, conversationId: string): Promise<Date | null> {
  const [row] = await tx
    .select({ at: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.companyId, ctx.companyId),
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'out'),
        or(isNull(messages.dedupeKey), not(like(messages.dedupeKey, `${ASSISTANT_PREFIX}%`))),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  return row?.at ?? null;
}

/** The last `limit` texts of the conversation (either direction), oldest first. */
export async function listConversationTexts(
  tx: Tx,
  ctx: TenantContext,
  conversationId: string,
  limit: number,
): Promise<ConversationTextRow[]> {
  const rows = await tx
    .select({
      id: messages.id,
      direction: messages.direction,
      body: messages.body,
      createdAt: messages.createdAt,
      dedupeKey: messages.dedupeKey,
    })
    .from(messages)
    .where(and(eq(messages.companyId, ctx.companyId), eq(messages.conversationId, conversationId)))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit);
  return rows.reverse().map((r) => ({
    id: r.id,
    direction: r.direction,
    body: r.body,
    createdAt: r.createdAt,
    assistant: r.direction === 'out' && (r.dedupeKey?.startsWith(ASSISTANT_PREFIX) ?? false),
  }));
}

/** Same columns as messages.ts sets for a step text. */
function stateColumns(state: TextState) {
  switch (state.status) {
    case 'queued':
      return { status: state.status, blockRule: null, blockReason: null, retryable: false };
    case 'scheduled':
      return { status: state.status, scheduledFor: state.scheduledFor, blockRule: state.blockRule, blockReason: state.blockReason, retryable: false };
    case 'blocked':
      return { status: state.status, blockRule: state.blockRule, blockReason: state.blockReason, retryable: false };
    case 'failed':
      return { status: state.status, blockRule: null, blockReason: state.blockReason, retryable: state.retryable };
  }
}

/** Records an assistant text (informational) once per dedupe key; null when the key already has one. */
export async function insertAssistantText(
  tx: Tx,
  ctx: TenantContext,
  i: { conversationId: string; customerId: string; body: string; toE164: string | null; dedupeKey: string },
  state: TextState,
  now: Date,
): Promise<string | null> {
  const [existing] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.companyId, ctx.companyId), eq(messages.dedupeKey, i.dedupeKey), eq(messages.direction, 'out')))
    .limit(1);
  if (existing) return null;
  const [row] = await tx
    .insert(messages)
    .values({
      companyId: ctx.companyId,
      customerId: i.customerId,
      conversationId: i.conversationId,
      channel: 'sms',
      direction: 'out',
      purpose: 'informational',
      body: i.body,
      toE164: i.toE164,
      dedupeKey: i.dedupeKey,
      ...stateColumns(state),
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: messages.id });
  return row?.id ?? null;
}
