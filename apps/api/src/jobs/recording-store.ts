import { findCallRecording, setCallRecording, type TenantContext, withTenant } from '@roofline/db';
import { recordingSubaccount } from '@roofline/db/system';
import type { AppDeps } from '../app.ts';
import { TwilioApiError } from '../providers/twilio/http.ts';
import type { JobData, JobMeta } from './queue.ts';

/**
 * The fd-recording-store job: copy a finished call recording from Twilio to file storage, then delete
 * it at Twilio. Safe to run again: a recording whose object key is already on the call skips the copy and
 * only retries the delete. A failed delete at Twilio fails the job (so it is retried) until the last attempt;
 * a recording Twilio no longer has (404) counts as deleted.
 * Logs carry the call id and company id only.
 */
export async function storeRecording(deps: AppDeps, data: JobData, meta: JobMeta): Promise<void> {
  const { companyId, callId, recordingSid } = data;
  if (callId === undefined || recordingSid === undefined) return;
  const ctx: TenantContext = { companyId, role: 'system', userId: null, canApproveSpend: false };

  const call = await withTenant(deps.pools, ctx, (tx) => findCallRecording(tx, ctx, callId));
  if (call === null || call.recordingStatus === 'deleted') return;

  const sub = await recordingSubaccount(deps.pools.system, companyId, deps.config.ENCRYPTION_KEY);
  if (sub === null) throw new Error('The company has no Twilio subaccount.');

  // A caller who objected keeps 'stopped_by_caller' (a later relay session on this call reads it to keep the transcript off and not record again); only the Twilio copy goes.
  const markDeleted = async (): Promise<void> => {
    if (call.recordingStatus === 'stopped_by_caller') return;
    await withTenant(deps.pools, ctx, (tx) => setCallRecording(tx, ctx, call.callSid, { recordingStatus: 'deleted' }));
  };
  const deleteAtTwilio = async (): Promise<void> => {
    try {
      await deps.callControl.deleteRecording(sub, recordingSid);
    } catch (err) {
      // A recording already gone at Twilio is fine.
      if (err instanceof TwilioApiError && err.status === 404) return;
      // Anything else is retried by the job; on the last attempt it is logged and left.
      if (!meta.lastAttempt) throw err;
      console.warn(`recording delete at Twilio failed call=${callId} company=${companyId}`);
    }
  };

  // Note 42: the Twilio recording SID is kept in recording_key (recordings/<companyId>/<callId>-<recordingSid>.mp3); the job deletes the Twilio copy itself, so no separate column is needed.
  const key = `recordings/${companyId}/${callId}-${recordingSid}.mp3`;
  // Already copied means THIS recording's object is on the call: a call stored from another recording still copies this one.
  const alreadyCopied = call.recordingKey === key;
  if (!alreadyCopied) {
    if (!deps.objectStore.configured) {
      // No file storage: the Twilio copy is deleted anyway (no recording is kept there) and only the metadata stays.
      await deleteAtTwilio();
      await markDeleted();
      console.warn(`recording deleted at Twilio, file storage not set up call=${callId} company=${companyId}`);
      return;
    }
    let putStarted = false;
    try {
      const bytes = await deps.callControl.fetchRecording(sub, recordingSid);
      putStarted = true;
      await deps.objectStore.put(key, bytes, 'audio/mpeg');
      // TODO(e1-estimator merge, Ruling DJ/DV): also insert the stored_files row of kind 'call_recording' here.
      // A caller who objected keeps 'stopped_by_caller': the partial recording is stored, the status stays.
      const status = call.recordingStatus === 'stopped_by_caller' ? 'stopped_by_caller' : 'stored';
      await withTenant(deps.pools, ctx, (tx) => setCallRecording(tx, ctx, call.callSid, { recordingKey: key, recordingStatus: status }));
    } catch (err) {
      if (!meta.lastAttempt) throw err;
      if (putStarted) {
        // A put that failed part-way may have left an object behind; remove the orphan.
        try {
          await deps.objectStore.delete(key);
        } catch {
          console.warn(`recording store cleanup failed call=${callId} company=${companyId}`);
        }
      }
      // Last attempt: do not leave the recording at Twilio. Drop it there and keep only the metadata.
      await deleteAtTwilio();
      await markDeleted();
      console.warn(`recording store gave up, Twilio copy deleted call=${callId} company=${companyId}`);
      return;
    }
  }

  await deleteAtTwilio();
}
