import { and, asc, desc, eq, inArray, isNull, ne, or, type SQL, sql } from 'drizzle-orm';
import type {
  CallStatus,
  ConversationChannel,
  ConversationDetail,
  ConversationFilter,
  ConversationListItem,
  ConversationOutcome,
  ConversationPage,
  ConversationStatus,
  HandledBy,
  RecordingStatus,
  ToolActionCard,
  TransferResult,
  TurnView,
} from '@roofline/shared';
import type { Db } from '../pools.ts';
import { calls, claimIntakes, conversations, conversationTurns, customers, memberships } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { canPlayCallRecording, findCallRecording } from './call-recording.ts';
import { customerScope } from './scope.ts';

/*
 * The Front Desk inbox (D1 Task 18): the conversation list, one conversation's detail, and the small
 * writes the window makes (read, handling, reply bookkeeping). Every function runs inside withTenant.
 *
 * Who sees what: the owner and the office see every conversation. A rep sees the conversations of
 * their own customers (`customerScope`) and, only while they are on call, those of unknown numbers.
 * `memberships` is a global table the tenant role cannot read, so the route learns "on call" with
 * `isOnCallMember` (the system pool) and passes it in as `scope`.
 */

export type InboxScope = { onCall: boolean };

/** How many conversations one page of the list holds. */
export const INBOX_PAGE_SIZE = 30;

/** How long "the team is handling it" keeps the assistant quiet. */
export const TEAM_HANDLING_MS = 2 * 60 * 60 * 1000;

const LIVE_CALL_STATUSES: CallStatus[] = ['ringing', 'ai', 'ringing_team'];

/** Whether the user is on the company's call list (a rep sees unknown-number conversations only then). */
export async function isOnCallMember(system: Db, ctx: TenantContext): Promise<boolean> {
  if (ctx.userId === null) return false;
  const [row] = await system
    .select({ order: memberships.onCallOrder })
    .from(memberships)
    .where(and(eq(memberships.companyId, ctx.companyId), eq(memberships.userId, ctx.userId), eq(memberships.status, 'active')))
    .limit(1);
  return row !== undefined && row.order !== null;
}

/** The WHERE condition for what this member may see; undefined means everything in the company. Needs customers joined. */
function visibleTo(ctx: TenantContext, scope: InboxScope): SQL | undefined {
  if (ctx.role !== 'rep') return undefined;
  return or(
    and(sql`${conversations.customerId} is not null`, customerScope(ctx)),
    scope.onCall ? isNull(conversations.customerId) : undefined,
  );
}

const notSpam = (): SQL | undefined => or(isNull(conversations.outcome), ne(conversations.outcome, 'spam'));

/** Unread and not spam: the dock badge counts these as needing attention. */
const NEEDS_ATTENTION = sql<boolean>`(${conversations.unreadCount} > 0 and ${conversations.outcome} is distinct from 'spam')`;

/** True when the assistant took a message marked urgent on this conversation. */
const URGENT = sql<boolean>`exists (
  select 1 from conversation_turns ct, jsonb_array_elements(coalesce(ct.tool_calls, '[]'::jsonb)) tc
  where ct.company_id = ${conversations.companyId} and ct.conversation_id = ${conversations.id}
    and tc ->> 'name' = 'take_message' and tc -> 'input' ->> 'urgent' = 'true'
)`;

function filterCondition(filter: ConversationFilter): SQL | undefined {
  switch (filter) {
    case 'all':
      return notSpam();
    case 'needs_attention':
      return NEEDS_ATTENTION;
    case 'booked':
      return eq(conversations.outcome, 'booked');
    case 'messages':
      return and(eq(conversations.channel, 'sms'), notSpam());
    case 'spam':
      return eq(conversations.outcome, 'spam');
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The cursor is `base64url("<last_message_at as the database prints it>|<id>")`. Null when it is not one of ours. */
export function decodeInboxCursor(raw: string): { at: string; id: string } | null {
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const cut = text.lastIndexOf('|');
  if (cut <= 0) return null;
  const at = text.slice(0, cut);
  const id = text.slice(cut + 1);
  if (!UUID_RE.test(id) || Number.isNaN(Date.parse(at))) return null;
  return { at, id: id.toLowerCase() };
}

const encodeInboxCursor = (at: string, id: string): string => Buffer.from(`${at}|${id}`, 'utf8').toString('base64url');

export type ListInboxInput = { filter: ConversationFilter; cursor: string | null; limit?: number };

/** One page of the inbox, newest first. `cursor` must already have passed `decodeInboxCursor`. */
export async function listConversationInbox(
  tx: Tx,
  ctx: TenantContext,
  scope: InboxScope,
  input: ListInboxInput,
): Promise<ConversationPage> {
  const limit = input.limit ?? INBOX_PAGE_SIZE;
  const cursor = input.cursor === null ? null : decodeInboxCursor(input.cursor);
  const rows = await tx
    .select({
      id: conversations.id,
      channel: conversations.channel,
      status: conversations.status,
      customerId: conversations.customerId,
      name: customers.displayName,
      phoneE164: conversations.phoneE164,
      outcome: conversations.outcome,
      summary: conversations.summary,
      handledBy: conversations.handledBy,
      unreadCount: conversations.unreadCount,
      needsAttention: NEEDS_ATTENTION,
      urgent: URGENT,
      lastMessageAt: conversations.lastMessageAt,
      cursorAt: sql<string>`${conversations.lastMessageAt}::text`,
    })
    .from(conversations)
    .leftJoin(customers, and(eq(customers.companyId, conversations.companyId), eq(customers.id, conversations.customerId)))
    .where(
      and(
        eq(conversations.companyId, ctx.companyId),
        visibleTo(ctx, scope),
        filterCondition(input.filter),
        cursor === null
          ? undefined
          : sql`(${conversations.lastMessageAt}, ${conversations.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`,
      ),
    )
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const live = await liveCallsOf(
    tx,
    ctx,
    page.map((r) => r.id),
  );
  const items: ConversationListItem[] = page.map((r) => ({
    id: r.id,
    channel: r.channel as ConversationChannel,
    status: r.status as ConversationStatus,
    customerId: r.customerId,
    name: r.name,
    phoneE164: r.phoneE164,
    outcome: r.outcome as ConversationOutcome | null,
    summary: r.summary,
    handledBy: r.handledBy as HandledBy,
    unreadCount: r.unreadCount,
    needsAttention: r.needsAttention === true,
    urgent: r.urgent === true,
    lastMessageAt: r.lastMessageAt.toISOString(),
    liveCall: live.get(r.id) ?? null,
  }));
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last !== undefined ? encodeInboxCursor(last.cursorAt, last.id) : null;
  return { items, nextCursor };
}

async function liveCallsOf(
  tx: Tx,
  ctx: TenantContext,
  conversationIds: string[],
): Promise<Map<string, { callId: string; status: CallStatus; startedAt: string }>> {
  const out = new Map<string, { callId: string; status: CallStatus; startedAt: string }>();
  if (conversationIds.length === 0) return out;
  const rows = await tx
    .select({ id: calls.id, conversationId: calls.conversationId, status: calls.status, startedAt: calls.startedAt })
    .from(calls)
    .where(
      and(
        eq(calls.companyId, ctx.companyId),
        inArray(calls.conversationId, conversationIds),
        inArray(calls.status, LIVE_CALL_STATUSES),
      ),
    )
    .orderBy(desc(calls.startedAt), desc(calls.id));
  for (const r of rows) {
    if (r.conversationId === null || out.has(r.conversationId)) continue;
    out.set(r.conversationId, { callId: r.id, status: r.status as CallStatus, startedAt: r.startedAt.toISOString() });
  }
  return out;
}

/** What the reply and handling routes need about one conversation the member may see. */
export type VisibleConversation = {
  id: string;
  channel: ConversationChannel;
  customerId: string | null;
  handledBy: HandledBy;
  teamUntil: Date | null;
};

/** One conversation of this company the member may see, or null (missing, another company's, or out of scope). */
export async function findVisibleConversation(
  tx: Tx,
  ctx: TenantContext,
  scope: InboxScope,
  id: string,
): Promise<VisibleConversation | null> {
  const [row] = await tx
    .select({
      id: conversations.id,
      channel: conversations.channel,
      customerId: conversations.customerId,
      handledBy: conversations.handledBy,
      teamUntil: conversations.teamUntil,
    })
    .from(conversations)
    .leftJoin(customers, and(eq(customers.companyId, conversations.companyId), eq(customers.id, conversations.customerId)))
    .where(and(eq(conversations.companyId, ctx.companyId), eq(conversations.id, id), visibleTo(ctx, scope)))
    .limit(1);
  if (!row) return null;
  return { ...row, channel: row.channel as ConversationChannel, handledBy: row.handledBy as HandledBy };
}

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const inputOf = (input: unknown): Record<string, unknown> =>
  typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};

const ACTION_LABELS: Record<string, { ok: string; failed: string }> = {
  lookup_my_jobs: { ok: "Looked up the caller's jobs", failed: "Could not look up the caller's jobs" },
  verify_caller: { ok: 'Verified the caller', failed: 'Could not verify the caller' },
  check_forecast: { ok: 'Checked the forecast', failed: 'Could not check the forecast' },
  hail_at_my_home: { ok: 'Checked hail history for the home', failed: 'Could not check hail history' },
  find_inspection_times: { ok: 'Looked for inspection times', failed: 'Could not find inspection times' },
  book_inspection: { ok: 'Booked an inspection', failed: 'Could not book the inspection' },
  confirm_appointment: { ok: 'Confirmed the appointment', failed: 'Could not confirm the appointment' },
  move_inspection: { ok: 'Moved the inspection', failed: 'Could not move the inspection' },
  cancel_inspection: { ok: 'Canceled the inspection', failed: 'Could not cancel the inspection' },
  take_claim_details: { ok: 'Took down claim details', failed: 'Could not take down claim details' },
  take_message: { ok: 'Took a message for the team', failed: 'Could not take the message' },
  transfer_to_person: { ok: 'Passed the call to a person', failed: 'Could not pass the call to a person' },
  end_call: { ok: 'Ended the call', failed: 'Could not end the call' },
};

/** A record past transcript retention keeps only name and ok (Task 16); one with no boolean ok reads as done. */
function cardOf(raw: { name: string; input?: unknown; ok?: unknown }): ToolActionCard {
  const rec = { name: raw.name, input: raw.input ?? null, ok: raw.ok !== false };
  const labels = ACTION_LABELS[rec.name];
  const input = inputOf(rec.input);
  let link: ToolActionCard['link'] = null;
  if (rec.ok) {
    if (isUuid(input.appointmentId)) link = { kind: 'appointment', id: input.appointmentId };
    else if (rec.name === 'take_claim_details' && isUuid(input.jobId)) link = { kind: 'job', id: input.jobId };
  }
  const label = labels ? (rec.ok ? labels.ok : labels.failed) : rec.ok ? 'Did something for the caller' : 'Could not finish a step';
  return { tool: rec.name, ok: rec.ok, label, link };
}

/** One conversation with its calls, transcript and links, or null when the member may not see it. */
export async function getConversationDetail(
  tx: Tx,
  ctx: TenantContext,
  scope: InboxScope,
  id: string,
): Promise<ConversationDetail | null> {
  const [row] = await tx
    .select({
      id: conversations.id,
      channel: conversations.channel,
      status: conversations.status,
      customerId: conversations.customerId,
      customerName: customers.displayName,
      phoneE164: conversations.phoneE164,
      outcome: conversations.outcome,
      summary: conversations.summary,
      identity: conversations.identity,
      handledBy: conversations.handledBy,
      teamUntil: conversations.teamUntil,
    })
    .from(conversations)
    .leftJoin(customers, and(eq(customers.companyId, conversations.companyId), eq(customers.id, conversations.customerId)))
    .where(and(eq(conversations.companyId, ctx.companyId), eq(conversations.id, id), visibleTo(ctx, scope)))
    .limit(1);
  if (!row) return null;

  const callRows = await tx
    .select({
      id: calls.id,
      status: calls.status,
      startedAt: calls.startedAt,
      endedAt: calls.endedAt,
      aiSeconds: calls.aiSeconds,
      recordingStatus: calls.recordingStatus,
      transcriptStored: calls.transcriptStored,
      transferResult: calls.transferResult,
      transferUserId: calls.transferUserId,
      spamReason: calls.spamReason,
    })
    .from(calls)
    .where(and(eq(calls.companyId, ctx.companyId), eq(calls.conversationId, id)))
    .orderBy(asc(calls.startedAt), asc(calls.id));

  const names = await memberNames(
    tx,
    callRows.map((c) => c.transferUserId).filter((u): u is string => u !== null),
  );
  const callViews: ConversationDetail['calls'] = [];
  for (const c of callRows) {
    const rec = await findCallRecording(tx, ctx, c.id);
    callViews.push({
      id: c.id,
      status: c.status as CallStatus,
      startedAt: c.startedAt.toISOString(),
      endedAt: c.endedAt === null ? null : c.endedAt.toISOString(),
      aiSeconds: c.aiSeconds,
      recordingStatus: c.recordingStatus as RecordingStatus,
      transcriptStored: c.transcriptStored,
      transferResult: (c.transferResult ?? 'none') as TransferResult,
      transferTo: c.transferUserId === null ? null : { userId: c.transferUserId, name: names.get(c.transferUserId) ?? '' },
      spamReason: c.spamReason,
      canPlayRecording:
        rec !== null &&
        rec.recordingKey !== null &&
        (rec.recordingStatus === 'stored' || rec.recordingStatus === 'stopped_by_caller') &&
        (await canPlayCallRecording(tx, ctx, rec)),
    });
  }

  const storedByCall = new Map(callRows.map((c) => [c.id, c.transcriptStored]));
  const turnRows = await tx
    .select({
      id: conversationTurns.id,
      callId: conversationTurns.callId,
      position: conversationTurns.position,
      speaker: conversationTurns.speaker,
      text: conversationTurns.text,
      truncated: conversationTurns.truncated,
      at: conversationTurns.at,
      toolCalls: conversationTurns.toolCalls,
    })
    .from(conversationTurns)
    .where(and(eq(conversationTurns.companyId, ctx.companyId), eq(conversationTurns.conversationId, id)))
    .orderBy(asc(conversationTurns.position));

  const jobIds = new Set<string>();
  const appointmentIds = new Set<string>();
  const turns: TurnView[] = turnRows.map((t) => {
    const records = t.toolCalls ?? [];
    for (const rec of records) {
      const input = inputOf(rec.input);
      if (rec.ok && isUuid(input.appointmentId)) appointmentIds.add(input.appointmentId);
      if (rec.ok && isUuid(input.jobId)) jobIds.add(input.jobId);
    }
    const kept = t.callId === null ? true : storedByCall.get(t.callId) === true;
    return {
      id: t.id,
      position: t.position,
      speaker: t.speaker,
      text: kept && t.text !== '' ? t.text : null,
      truncated: t.truncated,
      at: t.at.toISOString(),
      actions: records.map(cardOf),
    };
  });

  const claims = await tx
    .select({ id: claimIntakes.id, jobId: claimIntakes.jobId })
    .from(claimIntakes)
    .where(and(eq(claimIntakes.companyId, ctx.companyId), eq(claimIntakes.conversationId, id)))
    .orderBy(asc(claimIntakes.createdAt), asc(claimIntakes.id));
  for (const c of claims) if (c.jobId !== null) jobIds.add(c.jobId);

  return {
    id: row.id,
    channel: row.channel as ConversationChannel,
    status: row.status as ConversationStatus,
    customer: row.customerId === null || row.customerName === null ? null : { id: row.customerId, name: row.customerName },
    phoneE164: row.phoneE164,
    outcome: row.outcome as ConversationOutcome | null,
    summary: row.summary,
    followUps: [],
    identity: row.identity,
    handledBy: row.handledBy as HandledBy,
    teamUntil: row.teamUntil === null ? null : row.teamUntil.toISOString(),
    calls: callViews,
    turns,
    links: { jobIds: [...jobIds], appointmentIds: [...appointmentIds], claimIntakeIds: claims.map((c) => c.id) },
    canReply: row.channel === 'sms',
  };
}

/** Member names through the `company_members` view (the tenant role's only way to see them). */
async function memberNames(tx: Tx, userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (userIds.length === 0) return out;
  const result = await tx.execute(
    sql`select user_id, name from company_members where user_id in (${sql.join(
      [...new Set(userIds)].map((u) => sql`${u}::uuid`),
      sql`, `,
    )})`,
  );
  for (const r of result.rows as { user_id: string; name: string }[]) out.set(r.user_id, r.name);
  return out;
}

/** Marks the conversation read. False when it is not there. */
export async function markConversationRead(tx: Tx, ctx: TenantContext, id: string): Promise<boolean> {
  const rows = await tx
    .update(conversations)
    .set({ unreadCount: 0, updatedAt: sql`now()` as unknown as Date })
    .where(and(eq(conversations.companyId, ctx.companyId), eq(conversations.id, id)))
    .returning({ id: conversations.id });
  return rows.length > 0;
}

/**
 * Switches who answers. `teamUntil` is when the team's turn ends (null clears it, for the assistant).
 * `touchedAt` also moves the conversation to the top of the list (a reply).
 */
export async function setConversationHandling(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  by: HandledBy,
  teamUntil: Date | null,
  touchedAt?: Date,
): Promise<boolean> {
  const rows = await tx
    .update(conversations)
    .set({
      handledBy: by,
      teamUntil,
      ...(touchedAt !== undefined && { lastMessageAt: touchedAt }),
      updatedAt: sql`now()` as unknown as Date,
    })
    .where(and(eq(conversations.companyId, ctx.companyId), eq(conversations.id, id)))
    .returning({ id: conversations.id });
  return rows.length > 0;
}
