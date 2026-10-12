import {
  blankCustomerTurns,
  blankExpiredTurns,
  findExpiredRecordings,
  getRetentionSettings,
  markRecordingDeleted,
  recordingKeysForCustomer,
  withTenant,
  type TenantContext,
  type Tx,
} from '@roofline/db';
import type { AppDeps } from '../app.ts';
import type { ObjectStore } from '../providers/object-store.ts';

/* Front Desk retention (D1 Task 16, Ruling DX). Summaries and outcomes on conversations are never touched. */

export type SweepResult = { recordingsDeleted: number; turnsBlanked: number };

const BATCH = 200;

/** Sweeps one company: recordings then turns past retention. Idempotent. Logs ids only. */
export async function sweepCompanyRetention(deps: AppDeps, companyId: string, now: Date): Promise<SweepResult> {
  const ctx: TenantContext = { companyId, role: 'system', userId: null, canApproveSpend: false };
  const settings = await withTenant(deps.pools, ctx, (tx) => getRetentionSettings(tx, ctx));

  let recordingsDeleted = 0;
  if (deps.objectStore.configured) {
    const testCaller = deps.config.TWILIO_TEST_CALLER_NUMBER ?? null;
    for (;;) {
      const batch = await withTenant(deps.pools, ctx, (tx) =>
        findExpiredRecordings(tx, ctx, { now, recordingDays: settings.recordingRetentionDays, testCaller, limit: BATCH }),
      );
      let deletedInBatch = 0;
      for (const row of batch) {
        try {
          await deps.objectStore.delete(row.recordingKey);
        } catch {
          console.warn(`retention: recording delete failed call=${row.callId} company=${companyId}`);
          continue;
        }
        await withTenant(deps.pools, ctx, (tx) => markRecordingDeleted(tx, ctx, row.callId));
        deletedInBatch += 1;
      }
      recordingsDeleted += deletedInBatch;
      if (deletedInBatch === 0 || batch.length < BATCH) break;
    }
  }

  const turnsBlanked = await withTenant(deps.pools, ctx, (tx) =>
    blankExpiredTurns(tx, ctx, { now, transcriptDays: settings.transcriptRetentionDays }),
  );
  return { recordingsDeleted, turnsBlanked };
}

/**
 * For a future hard-delete path (NOT hooked into setArchived, Ruling DX). Deletes each of the customer's
 * recordings from the object store and marks the call 'deleted', blanks every turn text and reduces
 * tool_calls to names. It runs inside the caller's transaction; object-store deletes are not transactional,
 * so a later rollback cannot bring a deleted file back.
 */
export async function purgeCustomerConversations(tx: Tx, ctx: TenantContext, customerId: string, objectStore: ObjectStore): Promise<SweepResult> {
  const keys = await recordingKeysForCustomer(tx, ctx, customerId);
  let recordingsDeleted = 0;
  for (const { callId, recordingKey } of keys) {
    await objectStore.delete(recordingKey);
    await markRecordingDeleted(tx, ctx, callId);
    recordingsDeleted += 1;
  }
  const turnsBlanked = await blankCustomerTurns(tx, ctx, customerId);
  return { recordingsDeleted, turnsBlanked };
}
