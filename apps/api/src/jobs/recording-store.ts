import { findCallRecording, setCallRecording, type TenantContext, withTenant } from '@roofline/db';
import { recordingSubaccount } from '@roofline/db/system';
import type { AppDeps } from '../app.ts';
import type { JobData, JobMeta } from './queue.ts';

/**
 * The fd-recording-store job: copy a finished call recording from Twilio to file storage, then delete
 * it at Twilio. Safe to run again: a call already 'stored' skips the copy and only retries the delete.
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

  const alreadyCopied = call.recordingStatus === 'stored' || (call.recordingKey !== null && call.recordingStatus === 'stopped_by_caller');
  if (!alreadyCopied) {
    if (!deps.objectStore.configured) {
      // Twilio keeps the recording for up to 7 days; nothing is deleted there.
      console.warn(`recording kept at Twilio, file storage not set up call=${callId} company=${companyId}`);
      return;
    }
    try {
      const bytes = await deps.callControl.fetchRecording(sub, recordingSid);
      const key = `recordings/${companyId}/${callId}.mp3`;
      await deps.objectStore.put(key, bytes, 'audio/mpeg');
      // TODO(e1-estimator merge, Ruling DJ/DV): also insert the stored_files row of kind 'call_recording' here.
      // A caller who objected keeps 'stopped_by_caller': the partial recording is stored, the status stays.
      const status = call.recordingStatus === 'stopped_by_caller' ? 'stopped_by_caller' : 'stored';
      await withTenant(deps.pools, ctx, (tx) => setCallRecording(tx, ctx, call.callSid, { recordingKey: key, recordingStatus: status }));
    } catch (err) {
      if (meta.lastAttempt) console.warn(`recording store gave up call=${callId} company=${companyId}`);
      throw err;
    }
  }

  try {
    await deps.callControl.deleteRecording(sub, recordingSid);
  } catch {
    // A recording already gone at Twilio is fine; the copy is safe.
    console.warn(`recording delete at Twilio failed call=${callId} company=${companyId}`);
  }
}
