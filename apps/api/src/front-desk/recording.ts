import { eq } from 'drizzle-orm';
import { companySettings, setCallRecording, withTenant, type TenantContext } from '@roofline/db';
import { recordingSubaccount } from '@roofline/db/system';
import type { AppDeps } from '../app.ts';

/*
 * Call recording for the relay (D1 Task 12). Starts once after the greeting began; the caller can
 * object, which stops the recording and turns the transcript off. Logs carry ids only: never
 * numbers, urls, keys or transcript text.
 * TODO(e1-estimator merge, Ruling DJ/DV): the stored_files row of kind 'call_recording' is added there.
 */
export type RecordingHandle = {
  /** Starts recording once (second call is a no-op). Never throws; failures are logged with ids only. */
  start(): Promise<void>;
  /** Stops recording and marks the transcript off (caller objected). Idempotent. */
  stopForObjection(): Promise<void>;
  /** True once the caller has objected: turns from now on are stored with text ''. */
  readonly objected: boolean;
};
export type RecordingCall = { callId: string; companyId: string; callSid: string };

const OBJECTION = new RegExp(
  [
    "(don'?t|do not|dont|please don'?t|never)\\s+(you\\s+)?record",
    'stop\\s+(the\\s+|this\\s+)?(call\\s+)?recording',
    'stop\\s+recording',
    'no\\s+recording',
    'turn\\s+(off|of)\\s+(the\\s+|this\\s+)?recording',
    "(don'?t|do not|dont)\\s+want\\s+(to\\s+be|this|it|the\\s+call)\\s+(call\\s+)?recorded",
    "(don'?t|do not|dont)\\s+want\\s+(you\\s+)?(to\\s+)?record",
    'not\\s+be\\s+recorded',
  ].join('|'),
);

export function createRecording(deps: AppDeps, call: RecordingCall): RecordingHandle {
  const ctx: TenantContext = { companyId: call.companyId, userId: null, role: 'system', canApproveSpend: false };
  let recordingSid: string | null = null;
  let sub: { accountSid: string; authToken: string } | null = null;
  let started = false;
  let objected = false;

  return {
    async start() {
      if (started) return;
      started = true;
      try {
        const days = await withTenant(deps.pools, ctx, async (tx) => {
          const [row] = await tx
            .select({ days: companySettings.recordingRetentionDays })
            .from(companySettings)
            .where(eq(companySettings.companyId, ctx.companyId))
            .limit(1);
          return row?.days ?? 90;
        });
        if (days === 0) return;
        sub = await recordingSubaccount(deps.pools.system, call.companyId, deps.config.ENCRYPTION_KEY);
        if (sub === null) {
          console.error(`recording skipped, no subaccount call=${call.callId} company=${call.companyId}`);
          return;
        }
        const started2 = await deps.callControl.startRecording(sub, call.callSid, `${deps.config.PUBLIC_BASE_URL}/hooks/twilio/voice/recording`);
        recordingSid = started2.recordingSid;
        if (objected) {
          // The caller objected while the start was in flight: stop at once.
          await deps.callControl.stopRecording(sub, call.callSid, recordingSid);
          return;
        }
        await withTenant(deps.pools, ctx, (tx) => setCallRecording(tx, ctx, call.callSid, { recordingStatus: 'recording' }));
      } catch {
        console.error(`recording start failed call=${call.callId} company=${call.companyId}`);
      }
    },
    async stopForObjection() {
      if (objected) return;
      objected = true;
      try {
        if (recordingSid !== null && sub !== null) await deps.callControl.stopRecording(sub, call.callSid, recordingSid);
      } catch {
        console.error(`recording stop failed call=${call.callId} company=${call.companyId}`);
      }
      try {
        await withTenant(deps.pools, ctx, (tx) =>
          setCallRecording(tx, ctx, call.callSid, { recordingStatus: 'stopped_by_caller', transcriptStored: false }),
        );
      } catch {
        console.error(`recording mark failed call=${call.callId} company=${call.companyId}`);
      }
    },
    get objected() {
      return objected;
    },
  };
}

/** True when the caller's words object to being recorded ("don't record me", "stop recording", ...). */
export function isRecordingObjection(text: string): boolean {
  return OBJECTION.test(text.toLowerCase().replace(/[’]/g, "'"));
}
