import { and, eq } from 'drizzle-orm';
import { calls, conversations, customers } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { customerScope } from './scope.ts';

/*
 * Recording columns of `calls` (D1 Task 12). SHELL: signatures only; package C fills the bodies.
 * All run inside withTenant. No stored_files row on this base (TODO at the e1-estimator merge, Ruling DV).
 */

export type RecordingStatusValue = 'none' | 'recording' | 'stopped_by_caller' | 'stored' | 'deleted';

/** What the recording route and the store job need about one call. */
export type CallRecordingRow = {
  id: string;
  companyId: string;
  callSid: string;
  conversationId: string | null;
  /** conversations.customer_id (null when unknown or no conversation). */
  customerId: string | null;
  recordingKey: string | null;
  recordingStatus: RecordingStatusValue;
  transferResult: 'answered' | 'no_answer' | 'none' | null;
  status: string;
  transcriptStored: boolean;
};

const columns = {
  id: calls.id,
  companyId: calls.companyId,
  callSid: calls.callSid,
  conversationId: calls.conversationId,
  customerId: conversations.customerId,
  recordingKey: calls.recordingKey,
  recordingStatus: calls.recordingStatus,
  transferResult: calls.transferResult,
  status: calls.status,
  transcriptStored: calls.transcriptStored,
};

async function findOne(tx: Tx, ctx: TenantContext, match: ReturnType<typeof eq>): Promise<CallRecordingRow | null> {
  const [row] = await tx
    .select(columns)
    .from(calls)
    .leftJoin(conversations, and(eq(conversations.id, calls.conversationId), eq(conversations.companyId, calls.companyId)))
    .where(and(eq(calls.companyId, ctx.companyId), match))
    .limit(1);
  return row ? (row as CallRecordingRow) : null;
}

/** By call id. Null when it is not this company's. */
export async function findCallRecording(tx: Tx, ctx: TenantContext, callId: string): Promise<CallRecordingRow | null> {
  return findOne(tx, ctx, eq(calls.id, callId));
}

/** By CallSid. Null when unknown. */
export async function findCallRecordingBySid(tx: Tx, ctx: TenantContext, callSid: string): Promise<CallRecordingRow | null> {
  return findOne(tx, ctx, eq(calls.callSid, callSid));
}

/** Changes only the keys present. */
export async function setCallRecording(
  tx: Tx,
  ctx: TenantContext,
  callSid: string,
  patch: { recordingStatus?: RecordingStatusValue; recordingKey?: string | null; recordingSeconds?: number | null; transcriptStored?: boolean },
): Promise<void> {
  const set: Partial<typeof calls.$inferInsert> = {};
  if (patch.recordingStatus !== undefined) set.recordingStatus = patch.recordingStatus;
  if (patch.recordingKey !== undefined) set.recordingKey = patch.recordingKey;
  if (patch.recordingSeconds !== undefined) set.recordingSeconds = patch.recordingSeconds;
  if (patch.transcriptStored !== undefined) set.transcriptStored = patch.transcriptStored;
  if (Object.keys(set).length === 0) return;
  await tx.update(calls).set(set).where(and(eq(calls.companyId, ctx.companyId), eq(calls.callSid, callSid)));
}

/**
 * Whether this member may play the call's recording (spec 11): owner and office yes; a rep only when the
 * call's customer is in `customerScope` for them and the call was not transferred (transferResult
 * 'answered' or status 'transferred' -> no). Other roles no.
 */
export async function canPlayCallRecording(tx: Tx, ctx: TenantContext, row: CallRecordingRow): Promise<boolean> {
  if (ctx.role === 'owner' || ctx.role === 'office') return true;
  if (ctx.role !== 'rep') return false;
  if (row.transferResult === 'answered' || row.status === 'transferred') return false;
  if (row.customerId === null) return false;
  const [seen] = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, row.customerId), customerScope(ctx)))
    .limit(1);
  return seen !== undefined;
}
