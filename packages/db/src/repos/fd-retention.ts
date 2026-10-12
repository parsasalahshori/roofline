import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { calls, companySettings, conversations, conversationTurns, messages } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/* Front Desk retention (D1 Task 16). All run inside withTenant. */

const DAY_MS = 86_400_000;

export type RetentionSettings = { recordingRetentionDays: number; transcriptRetentionDays: number };

/** The company's two retention settings (company_settings); the defaults 90 and 365 when it has no settings row. */
export async function getRetentionSettings(tx: Tx, ctx: TenantContext): Promise<RetentionSettings> {
  const [row] = await tx
    .select({ recordingRetentionDays: companySettings.recordingRetentionDays, transcriptRetentionDays: companySettings.transcriptRetentionDays })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId))
    .limit(1);
  return row ?? { recordingRetentionDays: 90, transcriptRetentionDays: 365 };
}

export type ExpiredRecording = { callId: string; callSid: string; recordingKey: string };

/** Spam calls (calls.spam_reason not null) and spam conversations (outcome 'spam') keep their data this many days. */
export const SPAM_RETENTION_DAYS = 7;

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * Calls with recording_key not null and recording_status <> 'deleted' that are past retention:
 * started_at < now - days, where days = SPAM_RETENTION_DAYS for a spam call and recordingDays otherwise.
 * recordingDays = 0 means nothing is recorded, so non-spam calls are skipped. Forwarding-test calls
 * (conversation_id null and from_e164 = testCaller, when testCaller is not null) are never returned. Oldest first.
 */
export async function findExpiredRecordings(
  tx: Tx,
  ctx: TenantContext,
  opts: { now: Date; recordingDays: number; testCaller: string | null; limit: number },
): Promise<ExpiredRecording[]> {
  const spamDays = opts.recordingDays > 0 ? Math.min(SPAM_RETENTION_DAYS, opts.recordingDays) : SPAM_RETENTION_DAYS;
  const spamExpired = and(isNotNull(calls.spamReason), lt(calls.startedAt, daysAgo(opts.now, spamDays)));
  const normalExpired =
    opts.recordingDays > 0 ? and(isNull(calls.spamReason), lt(calls.startedAt, daysAgo(opts.now, opts.recordingDays))) : undefined;
  const conds: (SQL | undefined)[] = [
    eq(calls.companyId, ctx.companyId),
    isNotNull(calls.recordingKey),
    ne(calls.recordingStatus, 'deleted'),
    normalExpired ? or(spamExpired, normalExpired) : spamExpired,
  ];
  if (opts.testCaller !== null) {
    conds.push(sql`NOT (${calls.conversationId} IS NULL AND ${calls.fromE164} = ${opts.testCaller})`);
  }
  const rows = await tx
    .select({ callId: calls.id, callSid: calls.callSid, recordingKey: calls.recordingKey })
    .from(calls)
    .where(and(...conds))
    .orderBy(asc(calls.startedAt), asc(calls.id))
    .limit(opts.limit);
  return rows.flatMap((r) => (r.recordingKey === null ? [] : [{ callId: r.callId, callSid: r.callSid, recordingKey: r.recordingKey }]));
}

/** Sets recording_status 'deleted' and recording_key null on one call of this company. */
export async function markRecordingDeleted(tx: Tx, ctx: TenantContext, callId: string): Promise<void> {
  await tx
    .update(calls)
    .set({ recordingStatus: 'deleted', recordingKey: null })
    .where(and(eq(calls.companyId, ctx.companyId), eq(calls.id, callId)));
}

/** A turn that still carries text or tool-call arguments (so a second blanking run skips it). */
const blankable = sql`(${conversationTurns.text} <> '' OR (${conversationTurns.toolCalls} IS NOT NULL AND EXISTS (
  SELECT 1 FROM jsonb_array_elements(${conversationTurns.toolCalls}) AS e WHERE e <> jsonb_strip_nulls(jsonb_build_object('name', e->'name', 'ok', e->'ok')))))`;

/**
 * The shared SET clause: text emptied, tool_calls reduced to [{name, ok}] (the inbox's action cards need ok;
 * input and result go). The predicate above uses the same expression, so a second run finds nothing.
 * Metadata columns are never touched.
 */
const blankSet = {
  text: sql`''`,
  toolCalls: sql`CASE WHEN ${conversationTurns.toolCalls} IS NULL THEN NULL ELSE COALESCE(
    (SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('name', e->'name', 'ok', e->'ok'))) FROM jsonb_array_elements(${conversationTurns.toolCalls}) AS e), '[]'::jsonb) END`,
};

/** How many rows one blanking statement changes. The sweep repeats until a statement changes fewer. */
export const BLANK_BATCH = 1000;

/**
 * Blanks up to `limit` (default BLANK_BATCH) turns of this company that are past retention: text = '' and tool_calls
 * reduced to names (each element becomes {"name": <name>}), metadata kept. A turn is past retention when
 * at < now - transcriptDays, or at < now - SPAM_RETENTION_DAYS when its conversation has outcome 'spam'. Oldest first.
 * Rows already blanked are not touched, so a second run returns 0. Returns the number of turns changed; a result equal
 * to `limit` means there may be more, so the caller runs it again (each call in its own transaction).
 */
export async function blankExpiredTurns(
  tx: Tx,
  ctx: TenantContext,
  opts: { now: Date; transcriptDays: number; limit?: number },
): Promise<number> {
  const spamConversations = tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.companyId, ctx.companyId), eq(conversations.outcome, 'spam')));
  const due = tx
    .select({ id: conversationTurns.id })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.companyId, ctx.companyId),
        blankable,
        or(
          lt(conversationTurns.at, daysAgo(opts.now, opts.transcriptDays)),
          and(lt(conversationTurns.at, daysAgo(opts.now, SPAM_RETENTION_DAYS)), inArray(conversationTurns.conversationId, spamConversations)),
        ),
      ),
    )
    .orderBy(asc(conversationTurns.at), asc(conversationTurns.id))
    .limit(opts.limit ?? BLANK_BATCH);
  const rows = await tx
    .update(conversationTurns)
    .set(blankSet)
    .where(and(eq(conversationTurns.companyId, ctx.companyId), inArray(conversationTurns.id, due)))
    .returning({ id: conversationTurns.id });
  return rows.length;
}

/**
 * Blanks up to `limit` (default BLANK_BATCH) Front Desk texts of this company that are past retention: body = '',
 * everything else kept (who, when, status, the gate's reasons). Only messages that belong to a conversation
 * (messages.conversation_id not null) are Front Desk texts; every other message is left alone, and so is a text
 * still waiting to go out (queued or scheduled). The age rule is the turns' rule: created_at < now - transcriptDays,
 * or < now - SPAM_RETENTION_DAYS in a conversation with outcome 'spam'. Returns the number changed.
 */
export async function blankExpiredTexts(
  tx: Tx,
  ctx: TenantContext,
  opts: { now: Date; transcriptDays: number; limit?: number },
): Promise<number> {
  const spamConversations = tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.companyId, ctx.companyId), eq(conversations.outcome, 'spam')));
  const due = tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.companyId, ctx.companyId),
        isNotNull(messages.conversationId),
        ne(messages.body, ''),
        notInArray(messages.status, ['queued', 'scheduled']),
        or(
          lt(messages.createdAt, daysAgo(opts.now, opts.transcriptDays)),
          and(lt(messages.createdAt, daysAgo(opts.now, SPAM_RETENTION_DAYS)), inArray(messages.conversationId, spamConversations)),
        ),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(opts.limit ?? BLANK_BATCH);
  const rows = await tx
    .update(messages)
    .set({ body: '', updatedAt: sql`now()` as unknown as Date })
    .where(and(eq(messages.companyId, ctx.companyId), inArray(messages.id, due)))
    .returning({ id: messages.id });
  return rows.length;
}

/** The recording keys (not deleted) of every call in this customer's conversations. */
export async function recordingKeysForCustomer(tx: Tx, ctx: TenantContext, customerId: string): Promise<{ callId: string; recordingKey: string }[]> {
  const rows = await tx
    .select({ callId: calls.id, recordingKey: calls.recordingKey })
    .from(calls)
    .innerJoin(conversations, and(eq(conversations.id, calls.conversationId), eq(conversations.companyId, calls.companyId)))
    .where(
      and(
        eq(calls.companyId, ctx.companyId),
        eq(conversations.customerId, customerId),
        isNotNull(calls.recordingKey),
        ne(calls.recordingStatus, 'deleted'),
      ),
    )
    .orderBy(asc(calls.startedAt), asc(calls.id));
  return rows.flatMap((r) => (r.recordingKey === null ? [] : [{ callId: r.callId, recordingKey: r.recordingKey }]));
}

/** Blanks every turn of every conversation of this customer at once (same blanking as blankExpiredTurns, no age test). Returns the count. */
export async function blankCustomerTurns(tx: Tx, ctx: TenantContext, customerId: string): Promise<number> {
  const customerConversations = tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.companyId, ctx.companyId), eq(conversations.customerId, customerId)));
  const rows = await tx
    .update(conversationTurns)
    .set(blankSet)
    .where(and(eq(conversationTurns.companyId, ctx.companyId), blankable, inArray(conversationTurns.conversationId, customerConversations)))
    .returning({ id: conversationTurns.id });
  return rows.length;
}
