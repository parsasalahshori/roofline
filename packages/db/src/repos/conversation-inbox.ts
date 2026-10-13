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
  FrontDeskTabCounts,
  HandledBy,
  RecordingStatus,
  ToolActionCard,
  TransferResult,
  TurnView,
} from '@roofline/shared';
import { calls, claimIntakes, conversations, conversationTurns, customers, messages } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { canPlayCallRecording, findCallRecording } from './call-recording.ts';
import { getRetentionSettings, SPAM_RETENTION_DAYS } from './fd-retention.ts';
import { customerScope } from './scope.ts';

/*
 * The Front Desk inbox (D1 Task 18): the conversation list, one conversation's detail, and the small
 * writes the window makes (read, handling, reply bookkeeping). Every function runs inside withTenant.
 *
 * Who sees what: the owner and the office see every conversation. A rep sees the conversations of
 * their own customers (`customerScope`) and, only while they are on call, those of unknown numbers.
 * `memberships` is a global table the tenant role cannot read, so the route learns "on call" with
 * `isOnCallMember` (the system pool, in `@roofline/db/system`) and passes it in as `scope`.
 */

export type InboxScope = { onCall: boolean };

/** How many conversations one page of the list holds. */
export const INBOX_PAGE_SIZE = 30;

/** How long "the team is handling it" keeps the assistant quiet. */
export const TEAM_HANDLING_MS = 2 * 60 * 60 * 1000;

const LIVE_CALL_STATUSES: CallStatus[] = ['ringing', 'ai', 'ringing_team'];

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

/** True when the assistant took a message marked urgent on this conversation and it succeeded (redacted rows keep ok). */
const URGENT = sql<boolean>`exists (
  select 1 from conversation_turns ct, jsonb_array_elements(coalesce(ct.tool_calls, '[]'::jsonb)) tc
  where ct.company_id = ${conversations.companyId} and ct.conversation_id = ${conversations.id}
    and tc ->> 'name' = 'take_message' and tc -> 'input' ->> 'urgent' = 'true' and tc ->> 'ok' = 'true'
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
  const latest = await latestCallFacts(
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
    ...(latest.get(r.id) ?? { durationSeconds: null, transferredToName: null, textBackSent: false }),
  }));
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last !== undefined ? encodeInboxCursor(last.cursorAt, last.id) : null;
  return { items, nextCursor };
}

type LatestCallFacts = { durationSeconds: number | null; transferredToName: string | null; textBackSent: boolean };

/** What each listed conversation's calls say for its row: the latest call's length and transfer target, and whether any call was texted back. */
async function latestCallFacts(tx: Tx, ctx: TenantContext, conversationIds: string[]): Promise<Map<string, LatestCallFacts>> {
  const out = new Map<string, LatestCallFacts>();
  if (conversationIds.length === 0) return out;
  const rows = await tx
    .select({
      conversationId: calls.conversationId,
      startedAt: calls.startedAt,
      endedAt: calls.endedAt,
      transferUserId: calls.transferUserId,
      textBackMessageId: calls.textBackMessageId,
    })
    .from(calls)
    .where(and(eq(calls.companyId, ctx.companyId), inArray(calls.conversationId, conversationIds)))
    .orderBy(desc(calls.startedAt), desc(calls.id));
  const names = await memberNames(
    tx,
    rows.map((c) => c.transferUserId).filter((u): u is string => u !== null),
  );
  for (const r of rows) {
    if (r.conversationId === null) continue;
    const seen = out.get(r.conversationId);
    if (seen) {
      // Rows come newest first: the first call fixes length and transfer target, any call may carry the text-back.
      seen.textBackSent ||= r.textBackMessageId !== null;
      continue;
    }
    out.set(r.conversationId, {
      durationSeconds: r.endedAt === null ? null : Math.max(0, Math.round((r.endedAt.getTime() - r.startedAt.getTime()) / 1000)),
      transferredToName: r.transferUserId === null ? null : (names.get(r.transferUserId) ?? null),
      textBackSent: r.textBackMessageId !== null,
    });
  }
  return out;
}

/** How many conversations each tab holds, over everything the member may see (the same filters the list uses). */
export async function conversationTabCounts(tx: Tx, ctx: TenantContext, scope: InboxScope): Promise<FrontDeskTabCounts> {
  const counts: FrontDeskTabCounts = { all: 0, booked: 0, messages: 0, spam: 0 };
  for (const filter of ['all', 'booked', 'messages', 'spam'] as const) {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(conversations)
      .leftJoin(customers, and(eq(customers.companyId, conversations.companyId), eq(customers.id, conversations.customerId)))
      .where(and(eq(conversations.companyId, ctx.companyId), visibleTo(ctx, scope), filterCondition(filter)));
    counts[filter] = row?.n ?? 0;
  }
  return counts;
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
  // A message the caller left for the team is what staff need to read, also for a caller with no record
  // (E1 CV review #6). A turn redacted after a recording objection has no reason, and keeps the plain label.
  if (rec.name === 'take_message' && rec.ok && typeof input.reason === 'string' && input.reason.trim() !== '') {
    return { tool: rec.name, ok: rec.ok, label: `${labels!.ok}: ${input.reason.trim().slice(0, 300)}`, link };
  }
  return { tool: rec.name, ok: rec.ok, label, link };
}

/** The most recent texts one conversation detail shows. */
const DETAIL_TEXT_LIMIT = 500;

/** The dedupe_key prefixes of texts the assistant sent: its replies, booking confirmations and missed-call text-backs. */
const ASSISTANT_TEXT_PREFIXES = ['fd-text:', 'fd-book:', 'fd-textback:'];

/** Outbound states that mean the text went out (or is going out); a blocked, failed or scheduled one is not shown as said. */
const SHOWN_OUT_STATUSES = ['queued', 'sent', 'delivered'];

const squash = (v: string): string => v.replace(/\s+/g, ' ').trim();

/**
 * Time order; at one instant, position order, then id. A text line has position 0, so it sorts before the turns at
 * the same instant (a turn at position 0 ties with it and the id decides).
 */
export function compareTurnViews(a: TurnView, b: TurnView): number {
  const byTime = Date.parse(a.at) - Date.parse(b.at);
  if (byTime !== 0) return byTime;
  if (a.position !== b.position) return a.position - b.position;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** `a` begins with `b` and ends there or at a space: "We can come Friday. More." begins with "We can come Friday." */
const startsAtWord = (a: string, b: string): boolean => a.startsWith(b) && (a.length === b.length || a[b.length] === ' ');

/**
 * Which texts a turn already shows, one text to one turn line (final review). The contract with the fd-text job
 * (apps/api/src/front-desk/texts.ts and the engine's turn save):
 * - Caller: one engine turn answers every unanswered inbound text at once, and its caller turn holds their bodies
 *   joined with '\n' in arrival order, saved after the texts arrived (turn `at` >= each text's createdAt). Each
 *   inbound text, oldest first, takes the first unused run of lines (a text can hold line breaks of its own) of a
 *   caller turn at or after it that equals its own lines, compared after whitespace squashing.
 * - Assistant: the reply text is the assistant turn's words, possibly cut short at a sentence end to fit two
 *   segments (texts.ts fitSegments), and is written after the turn (turn `at` <= the text's createdAt), except a
 *   reply backdated to just after the text it answers (ASSISTANT_TURN_AFTER_TEXT_TOLERANCE_MS). Each assistant
 *   text, oldest first, takes the first unused assistant turn at or before it (or within that tolerance after it) whose words begin with the
 *   text's words, or the other way round, ending at a word boundary.
 * Each turn line (caller) or turn (assistant) is used once. A text that matches nothing is shown as its own line,
 * so a change in what texts.ts writes can repeat a text, never hide one.
 */
/**
 * How long after an assistant text its own turn may be stamped. texts.ts dates a reply sent while a newer text
 * waits as lastUnanswered.createdAt + 1 ms, which is before the assistant turn it carries (final review RC-1 #7).
 */
const ASSISTANT_TURN_AFTER_TEXT_TOLERANCE_MS = 5 * 60_000;

function turnMatcher(turns: TurnView[]) {
  const ordered = turns.filter((t) => t.callId === null && t.text !== null).sort(compareTurnViews);
  const callerTurns = ordered
    .filter((t) => t.speaker === 'caller')
    .map((t) => ({ at: Date.parse(t.at), lines: (t.text ?? '').split('\n').map(squash), used: [] as boolean[] }));
  const assistantTurns = ordered
    .filter((t) => t.speaker === 'assistant')
    .map((t) => ({ at: Date.parse(t.at), words: squash(t.text ?? ''), used: false }));

  const callerShown = (body: string, createdAt: Date): boolean => {
    const want = body.split('\n').map(squash);
    for (const turn of callerTurns) {
      if (turn.at < createdAt.getTime()) continue;
      for (let i = 0; i + want.length <= turn.lines.length; i++) {
        if (want.every((line, k) => turn.used[i + k] !== true && turn.lines[i + k] === line)) {
          for (let k = 0; k < want.length; k++) turn.used[i + k] = true;
          return true;
        }
      }
    }
    return false;
  };

  const assistantShown = (body: string, createdAt: Date): boolean => {
    const words = squash(body);
    if (words === '') return false;
    const turn = assistantTurns.find(
      (t) => !t.used && t.at <= createdAt.getTime() + ASSISTANT_TURN_AFTER_TEXT_TOLERANCE_MS && t.words !== '' && (startsAtWord(t.words, words) || startsAtWord(words, t.words)),
    );
    if (!turn) return false;
    turn.used = true;
    return true;
  };

  return (speaker: 'caller' | 'assistant', body: string, createdAt: Date): boolean =>
    speaker === 'caller' ? callerShown(body, createdAt) : assistantShown(body, createdAt);
}

/**
 * An SMS conversation's detail is built from its turns (what the assistant heard and said, with its tool
 * cards) and from the conversation's texts (`messages.conversation_id`), which also hold the team's replies and
 * the inbound texts the assistant never took a turn for. A text becomes a line of its own unless a turn already
 * shows it (`turnMatcher`, one text to one turn line). A text whose body was blanked by retention is hidden when a
 * blanked turn of the same speaker already stands for it. Texts are shown as turns with `callId` null and
 * `position` 0 (the sort is by time).
 *
 * An empty body is either a text with no words (a photo-only text) or one blanked by retention: blankExpiredTexts
 * sets body '' and leaves no other mark, so an empty text counts as blanked only when it is past the same age rule
 * (created before now - transcriptDays, or before now - SPAM_RETENTION_DAYS in a spam conversation). Any other
 * empty text is shown with `noWords`.
 */
async function textItems(
  tx: Tx,
  ctx: TenantContext,
  conversation: { id: string; spam: boolean },
  turns: TurnView[],
  now: Date,
): Promise<TurnView[]> {
  const conversationId = conversation.id;
  const { transcriptRetentionDays } = await getRetentionSettings(tx, ctx);
  const daysAgo = (days: number) => now.getTime() - days * 86_400_000;
  const pastRetention = (createdAt: Date) =>
    createdAt.getTime() < daysAgo(transcriptRetentionDays) || (conversation.spam && createdAt.getTime() < daysAgo(SPAM_RETENTION_DAYS));
  const rows = (
    await tx
      .select({
        id: messages.id,
        direction: messages.direction,
        body: messages.body,
        status: messages.status,
        dedupeKey: messages.dedupeKey,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(and(eq(messages.companyId, ctx.companyId), eq(messages.conversationId, conversationId)))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(DETAIL_TEXT_LIMIT)
  ).reverse();

  const said = (speaker: 'caller' | 'assistant') => turns.filter((t) => t.callId === null && t.speaker === speaker);
  const hasBlankedTurn = {
    caller: said('caller').some((t) => t.text === null),
    assistant: said('assistant').some((t) => t.text === null),
  };
  const shownByTurn = turnMatcher(turns);

  const out: TurnView[] = [];
  for (const r of rows) {
    if (r.direction === 'out' && !SHOWN_OUT_STATUSES.includes(r.status)) continue;
    const speaker: TurnView['speaker'] =
      r.direction === 'in'
        ? 'caller'
        : ASSISTANT_TEXT_PREFIXES.some((p) => r.dedupeKey?.startsWith(p) ?? false)
          ? 'assistant'
          : 'team';
    const body = squash(r.body);
    const blanked = body === '' && pastRetention(r.createdAt);
    if (speaker !== 'team') {
      if (blanked ? hasBlankedTurn[speaker] : shownByTurn(speaker, r.body, r.createdAt)) continue;
    }
    out.push({
      id: r.id,
      callId: null,
      position: 0,
      speaker,
      text: body === '' ? null : r.body,
      truncated: false,
      at: r.createdAt.toISOString(),
      actions: [],
      ...(body === '' && !blanked ? { noWords: true as const } : {}),
    });
  }
  return out;
}

/** One conversation with its calls, transcript and links, or null when the member may not see it. `now` dates the retention age rule for texts. */
export async function getConversationDetail(
  tx: Tx,
  ctx: TenantContext,
  scope: InboxScope,
  id: string,
  now: Date,
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
      callId: t.callId,
      position: t.position,
      speaker: t.speaker,
      text: kept && t.text !== '' ? t.text : null,
      truncated: t.truncated,
      at: t.at.toISOString(),
      actions: records.map(cardOf),
    };
  });

  if (row.channel === 'sms') turns.push(...(await textItems(tx, ctx, { id, spam: row.outcome === 'spam' }, turns, now)));
  turns.sort(compareTurnViews);

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
