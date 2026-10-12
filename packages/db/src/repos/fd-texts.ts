import { and, asc, desc, eq, gt, inArray, isNull, like, not, or, sql } from 'drizzle-orm';
import { companySettings, conversations, messages } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { companyReadOnly } from './front-desk-settings.ts';
import { insertConversation } from './conversations.ts';
import { FD_DEDUPE_PREFIX, FD_DEDUPE_WHERE, type TextState } from './messages.ts';

/*
 * D1 Task 14: the rows behind Front Desk texting. Every query names ctx.companyId. Imported by
 * apps/api/src/hooks/twilio.ts and apps/api/src/front-desk/texts.ts.
 */

/** A conversation is new after this long without a message (24 h). */
export const SMS_CONVERSATION_GAP_MS = 24 * 60 * 60 * 1000;

/** The dedupe_key prefix that marks a text the assistant sent. */
const ASSISTANT_PREFIX = 'fd-text:';
/** G1's "Thanks, got it." to a claims reply (`claims-ack:<message id>`): filed in the thread, but not a person's reply. */
export const CLAIMS_ACK_PREFIX = 'claims-ack:';
/** The dedupe key prefix of a reply a team member sends from the conversation (routes/conversations.ts). */
const STAFF_REPLY_PREFIX = 'fd-reply:';

export type TextConversationRef = { id: string; created: boolean; customerId: string | null };

/** One inbound text of a conversation, oldest first. */
export type InboundTextRow = { id: string; body: string; createdAt: Date };

/** One earlier text of a conversation (either direction), oldest first, for rebuilding history. */
export type ConversationTextRow = { id: string; direction: 'in' | 'out'; body: string; createdAt: Date; assistant: boolean };

/** True only when the company has Front Desk on and its texts on and is not read-only (trial ended or canceled, Ruling BG); false with no settings row. */
export async function frontDeskTextsOn(tx: Tx, ctx: TenantContext): Promise<boolean> {
  if (await companyReadOnly(tx, ctx)) return false;
  const [row] = await tx
    .select({ on: companySettings.frontDeskEnabled, texts: companySettings.frontDeskTexts })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId));
  return row !== undefined && row.on && row.texts;
}

/**
 * Files an inbound text under the sender's active SMS conversation (reused within 24 h of its last
 * message), else under a new one; the old one, when stale, is ended. Counts it as unread.
 *
 * Two texts from one number can arrive together when it has no active conversation (its first text,
 * or the first after a 24 h gap). FOR UPDATE locks no row then, so both would insert and the second
 * would fail on conversations_active_sms_uniq, rolling back its whole webhook. A transaction-scoped
 * advisory lock per company and number comes first: the second waits for the first's transaction and
 * then finds, and reuses, the conversation it made.
 */
export async function attachInboundToConversation(
  tx: Tx,
  ctx: TenantContext,
  i: { messageId: string; phoneE164: string; companyNumberE164: string; customerId: string | null },
  now: Date,
): Promise<TextConversationRef> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.companyId}::text || ':fd-sms:' || ${i.phoneE164}::text, 0))`);
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
      now,
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

/** When a person on the team last texted in this conversation (an outbound neither the assistant nor the Claims agent sent), else null. */
export async function lastTeamReplyAt(tx: Tx, ctx: TenantContext, conversationId: string): Promise<Date | null> {
  const [row] = await tx
    .select({ at: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.companyId, ctx.companyId),
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'out'),
        // Only a reply that went out (or will) quiets the assistant: a failed or blocked one reached nobody.
        inArray(messages.status, ['scheduled', 'queued', 'sent', 'delivered']),
        // Only a person replying counts: staff replies (fd-reply:) and texts with no system key. Every Front Desk system
        // text (fd-text:, fd-book:, fd-textback:, any fd-*) and claims acknowledgements are not a person (G1 review a).
        or(
          isNull(messages.dedupeKey),
          like(messages.dedupeKey, `${STAFF_REPLY_PREFIX}%`),
          and(not(like(messages.dedupeKey, 'fd-%')), not(like(messages.dedupeKey, `${CLAIMS_ACK_PREFIX}%`))),
        ),
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
  const values = {
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
  } satisfies typeof messages.$inferInsert;
  // An fd- key is covered by the partial unique index messages_fd_dedupe_uniq, which decides a race: the loser inserts nothing.
  const insert = tx.insert(messages).values(values);
  const [row] = await (
    i.dedupeKey.startsWith(FD_DEDUPE_PREFIX)
      ? insert.onConflictDoNothing({ target: [messages.companyId, messages.dedupeKey], where: FD_DEDUPE_WHERE })
      : insert
  ).returning({ id: messages.id });
  return row?.id ?? null;
}
