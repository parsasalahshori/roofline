import { DEFAULT_FRONT_DESK_VOICE, DEFAULT_WORK_HOURS, type ConsentRegime, type TransferResult, type WorkHours } from '@roofline/shared';
import { and, asc, eq, gt, inArray, isNull, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import { blockedNumbers, calls, companySettings } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { customersWithPhone } from './inbound.ts';

/* Call rows (D1 Task 10).  All run inside withTenant. */

export type CallRow = {
  id: string;
  companyId: string;
  callSid: string;
  fromE164: string;
  toE164: string;
  status: 'ringing' | 'ai' | 'ringing_team' | 'transferred' | 'ended' | 'rejected' | 'failed';
  transferResult: TransferResult | null;
  consentRegime: ConsentRegime | null;
};

const ROW = {
  id: calls.id,
  companyId: calls.companyId,
  callSid: calls.callSid,
  fromE164: calls.fromE164,
  toE164: calls.toE164,
  status: calls.status,
  transferResult: calls.transferResult,
  consentRegime: calls.consentRegime,
};

const bySid = (ctx: TenantContext, callSid: string) => and(eq(calls.companyId, ctx.companyId), eq(calls.callSid, callSid));

/** Inserts the call row for a new CallSid (status 'ringing'). A repeat CallSid returns the existing row (on conflict do nothing, then select). */
export async function insertCall(
  tx: Tx,
  ctx: TenantContext,
  i: { callSid: string; fromE164: string; toE164: string; forwardedFrom: string | null; stirVerstat: string | null; now: Date },
): Promise<CallRow> {
  await tx
    .insert(calls)
    .values({
      companyId: ctx.companyId,
      callSid: i.callSid,
      fromE164: i.fromE164,
      toE164: i.toE164,
      forwardedFrom: i.forwardedFrom,
      stirVerstat: i.stirVerstat,
      status: 'ringing',
      startedAt: i.now,
    })
    .onConflictDoNothing({ target: calls.callSid });
  const row = await findCallBySid(tx, ctx, i.callSid);
  if (!row) throw new Error('The call row was not found after insert.');
  return row;
}

export async function findCallBySid(tx: Tx, ctx: TenantContext, callSid: string): Promise<CallRow | null> {
  const [row] = await tx.select(ROW).from(calls).where(bySid(ctx, callSid)).limit(1);
  return row ?? null;
}

/**
 * Facts for screenCall: blocked_numbers has `from`, calls from it in the last hour, a customer has the phone.
 * `callsLastHour` counts calls INCLUDING the current one when its row is already inserted (Task 15's
 * screenCall treats it as "calls including this one").
 */
export async function screeningFacts(
  tx: Tx,
  ctx: TenantContext,
  from: string,
  now: Date,
): Promise<{ blocked: boolean; callsLastHour: number; knownCustomer: boolean }> {
  const [blocked] = await tx
    .select({ id: blockedNumbers.id })
    .from(blockedNumbers)
    .where(and(eq(blockedNumbers.companyId, ctx.companyId), eq(blockedNumbers.e164, from)))
    .limit(1);
  const since = new Date(now.getTime() - 60 * 60 * 1000);
  const [recent] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(calls)
    .where(and(eq(calls.companyId, ctx.companyId), eq(calls.fromE164, from), gt(calls.startedAt, since)));
  const knownCustomer = (await customersWithPhone(tx, ctx, from)).length > 0;
  return { blocked: blocked !== undefined, callsLastHour: recent?.n ?? 0, knownCustomer };
}

/** Calls of the company with status 'ai' (the company concurrent cap). */
export async function countLiveAiCalls(tx: Tx, ctx: TenantContext): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(calls)
    .where(and(eq(calls.companyId, ctx.companyId), eq(calls.status, 'ai')));
  return row?.n ?? 0;
}

/** Changes only the keys present in `patch` (updated_at moves with it). */
export async function updateCall(
  tx: Tx,
  ctx: TenantContext,
  callSid: string,
  patch: {
    status?: CallRow['status'];
    spamReason?: string | null;
    transferResult?: TransferResult;
    transferUserId?: string | null;
    endedAt?: Date;
    aiStartedAt?: Date;
    aiSeconds?: number;
  },
): Promise<void> {
  const set: Partial<typeof calls.$inferInsert> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.spamReason !== undefined) set.spamReason = patch.spamReason;
  if (patch.transferResult !== undefined) set.transferResult = patch.transferResult;
  if (patch.transferUserId !== undefined) set.transferUserId = patch.transferUserId;
  if (patch.endedAt !== undefined) set.endedAt = patch.endedAt;
  if (patch.aiStartedAt !== undefined) set.aiStartedAt = patch.aiStartedAt;
  if (patch.aiSeconds !== undefined) set.aiSeconds = patch.aiSeconds;
  if (Object.keys(set).length === 0) return;
  await tx.update(calls).set(set).where(bySid(ctx, callSid));
}

/** Adds seconds of AI talk time to the call (by CallSid). */
export async function addAiSeconds(tx: Tx, ctx: TenantContext, callSid: string, seconds: number): Promise<void> {
  await tx
    .update(calls)
    .set({ aiSeconds: sql`${calls.aiSeconds} + ${Math.max(0, Math.round(seconds))}` })
    .where(bySid(ctx, callSid));
}

/** Statuses a Twilio status callback never rewrites: a 'failed' row does not become 'ended' or move its endedAt (CV#8). */
const FINAL_STATUSES = ['ended', 'rejected', 'failed'] as const;

/** Twilio's CallStatus on /voice/status -> row: completed/canceled -> ended, busy/no-answer/failed -> failed, in-progress/ringing -> unchanged. Never moves an 'ended'/'rejected'/'failed' row (final review CV#8). Sets endedAt = now for terminal ones. Returns false when the call is unknown. */
export async function applyCallStatus(
  tx: Tx,
  ctx: TenantContext,
  callSid: string,
  twilioStatus: string,
  now: Date,
): Promise<boolean> {
  const row = await findCallBySid(tx, ctx, callSid);
  if (!row) return false;
  if ((FINAL_STATUSES as readonly string[]).includes(row.status)) return true;
  if (twilioStatus === 'completed' || twilioStatus === 'canceled') {
    await finishCall(tx, ctx, callSid, 'ended', now);
  } else if (twilioStatus === 'busy' || twilioStatus === 'no-answer' || twilioStatus === 'failed') {
    await finishCall(tx, ctx, callSid, 'failed', now);
  }
  return true;
}

/** Terminal status write that never moves an 'ended'/'rejected'/'failed' row (a racing callback cannot reopen or rewrite it). */
async function finishCall(tx: Tx, ctx: TenantContext, callSid: string, status: 'ended' | 'failed', now: Date): Promise<void> {
  await tx
    .update(calls)
    .set({ status, endedAt: now })
    .where(and(bySid(ctx, callSid), notInArray(calls.status, [...FINAL_STATUSES])));
}

export type FrontDeskCallSettings = {
  workHours: WorkHours;
  frontDeskEnabled: boolean;
  ringTeamFirstSeconds: number;
  frontDeskVoice: string;
  maxConcurrentAiCalls: number;
};

/** The Front Desk settings a voice webhook needs, with the column defaults when the company has no settings row. */
export async function frontDeskCallSettings(tx: Tx, ctx: TenantContext): Promise<FrontDeskCallSettings> {
  const [row] = await tx
    .select({
      workHours: companySettings.workHours,
      frontDeskEnabled: companySettings.frontDeskEnabled,
      ringTeamFirstSeconds: companySettings.ringTeamFirstSeconds,
      frontDeskVoice: companySettings.frontDeskVoice,
      maxConcurrentAiCalls: companySettings.maxConcurrentAiCalls,
    })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId))
    .limit(1);
  return {
    workHours: row?.workHours ?? DEFAULT_WORK_HOURS,
    frontDeskEnabled: row?.frontDeskEnabled ?? false,
    ringTeamFirstSeconds: row?.ringTeamFirstSeconds ?? 0,
    frontDeskVoice: row?.frontDeskVoice ?? DEFAULT_FRONT_DESK_VOICE,
    maxConcurrentAiCalls: row?.maxConcurrentAiCalls ?? 4,
  };
}

/* Task CV: call/conversation link, live-call cap, read-only check. */

/** A call counts as live for the concurrent cap only for this long after it started (35 minutes). */
export const LIVE_CALL_WINDOW_MS = 35 * 60 * 1000;

/** The live statuses the fd-health stuck-call sweep looks at. */
export const STUCK_CALL_STATUSES = ['ringing', 'ai', 'ringing_team'] as const;

/**
 * How long a 'ringing' or 'ringing_team' call may stay live before the sweep ends it: 4 hours, Twilio's
 * longest <Dial> (timeLimit 14400 s). A ring_first call answered by staff stays 'ringing_team' for the whole
 * bridged call, so the 35-minute bound applies to 'ai' calls only (the relay ends itself at 30 minutes).
 */
export const DIAL_CALL_LIMIT_MS = 4 * 60 * 60 * 1000;

/**
 * Ruling BJ, final review CV#3: ends the company's calls stuck in 'ai' for over 35 minutes
 * (LIVE_CALL_WINDOW_MS) or in 'ringing'/'ringing_team' for over 4 hours (DIAL_CALL_LIMIT_MS):
 * status 'ended', endedAt = now. At most `limit`, oldest first. Returns the ended CallSids.
 */
export async function endStuckCallsForCompany(tx: Tx, ctx: TenantContext, now: Date, limit: number): Promise<string[]> {
  const aiCutoff = new Date(now.getTime() - LIVE_CALL_WINDOW_MS);
  const dialCutoff = new Date(now.getTime() - DIAL_CALL_LIMIT_MS);
  const stuck = and(
    eq(calls.companyId, ctx.companyId),
    or(
      and(eq(calls.status, 'ai'), lt(calls.startedAt, aiCutoff)),
      and(inArray(calls.status, ['ringing', 'ringing_team']), lt(calls.startedAt, dialCutoff)),
    ),
  );
  const ids = await tx.select({ id: calls.id }).from(calls).where(stuck).orderBy(asc(calls.startedAt)).limit(limit);
  if (ids.length === 0) return [];
  const rows = await tx
    .update(calls)
    .set({ status: 'ended', endedAt: now })
    .where(
      and(
        stuck,
        inArray(
          calls.id,
          ids.map((r) => r.id),
        ),
      ),
    )
    .returning({ callSid: calls.callSid });
  return rows.map((r) => r.callSid);
}

/** Sets calls.conversation_id where it is still null (company-scoped, by calls.id). Returns true when a row changed. */
export async function linkCallConversation(tx: Tx, ctx: TenantContext, callId: string, conversationId: string): Promise<boolean> {
  const rows = await tx
    .update(calls)
    .set({ conversationId })
    .where(and(eq(calls.companyId, ctx.companyId), eq(calls.id, callId), isNull(calls.conversationId)))
    .returning({ id: calls.id });
  return rows.length > 0;
}

/** calls.conversation_id of the call (by calls.id), or null when unlinked or unknown. */
export async function findCallConversationId(tx: Tx, ctx: TenantContext, callId: string): Promise<string | null> {
  const [row] = await tx
    .select({ conversationId: calls.conversationId })
    .from(calls)
    .where(and(eq(calls.companyId, ctx.companyId), eq(calls.id, callId)))
    .limit(1);
  return row?.conversationId ?? null;
}

/** Takes pg_advisory_xact_lock(hashtext('fd-ai-cap:' || company_id)) for the transaction. */
export async function lockAiCap(tx: Tx, ctx: TenantContext): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'fd-ai-cap:' + ctx.companyId}))`);
}

/**
 * Calls bound for the AI: status 'ai', or 'ringing' (relay TwiML sent, relay not yet set up), with started_at > now - 35
 * minutes (the live count for the concurrent cap). The /voice hook marks every non-AI path 'ringing_team', so those never
 * count. The call being decided on is excluded when its id is passed.
 */
export async function countLiveCallsInWindow(tx: Tx, ctx: TenantContext, now: Date, excludeCallId?: string): Promise<number> {
  const since = new Date(now.getTime() - LIVE_CALL_WINDOW_MS);
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(calls)
    .where(
      and(
        eq(calls.companyId, ctx.companyId),
        inArray(calls.status, ['ringing', 'ai']),
        gt(calls.startedAt, since),
        excludeCallId === undefined ? undefined : ne(calls.id, excludeCallId),
      ),
    );
  return row?.n ?? 0;
}
