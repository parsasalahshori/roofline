import { DEFAULT_FRONT_DESK_VOICE, DEFAULT_WORK_HOURS, type ConsentRegime, type TransferResult, type WorkHours } from '@roofline/shared';
import { and, eq, gt, sql } from 'drizzle-orm';
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
  },
): Promise<void> {
  const set: Partial<typeof calls.$inferInsert> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.spamReason !== undefined) set.spamReason = patch.spamReason;
  if (patch.transferResult !== undefined) set.transferResult = patch.transferResult;
  if (patch.transferUserId !== undefined) set.transferUserId = patch.transferUserId;
  if (patch.endedAt !== undefined) set.endedAt = patch.endedAt;
  if (Object.keys(set).length === 0) return;
  await tx.update(calls).set(set).where(bySid(ctx, callSid));
}

/** Twilio's CallStatus on /voice/status -> row: completed/canceled -> ended, busy/no-answer/failed -> failed, in-progress/ringing -> unchanged. Never moves an 'ended'/'rejected' row back. Sets endedAt = now for terminal ones. Returns false when the call is unknown. */
export async function applyCallStatus(
  tx: Tx,
  ctx: TenantContext,
  callSid: string,
  twilioStatus: string,
  now: Date,
): Promise<boolean> {
  const row = await findCallBySid(tx, ctx, callSid);
  if (!row) return false;
  if (row.status === 'ended' || row.status === 'rejected') return true;
  if (twilioStatus === 'completed' || twilioStatus === 'canceled') {
    await updateCall(tx, ctx, callSid, { status: 'ended', endedAt: now });
  } else if (twilioStatus === 'busy' || twilioStatus === 'no-answer' || twilioStatus === 'failed') {
    await updateCall(tx, ctx, callSid, { status: 'failed', endedAt: now });
  }
  return true;
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
