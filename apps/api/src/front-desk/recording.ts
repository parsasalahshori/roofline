import { eq } from 'drizzle-orm';
import { companySettings, setCallRecording, withTenant, type TenantContext } from '@roofline/db';
import { recordingSubaccount } from '@roofline/db/system';
import type { AppDeps } from '../app.ts';

/*
 * Call recording for the relay (D1 Task 12). Starts once after the greeting began; the caller can
 * object, which stops the recording and turns the transcript off. Logs carry ids only: never
 * numbers, urls, keys or transcript text. A call already stopped_by_caller (a later relay session)
 * starts with objected true and start() does nothing. A call an earlier session already records keeps
 * that one recording: start() does nothing, and an objection stops it (Twilio.CURRENT).
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
export type RecordingCall = {
  callId: string;
  companyId: string;
  callSid: string;
  /** True when the call's status is already 'stopped_by_caller': start() must do nothing and objected starts true. */
  stoppedByCaller?: boolean;
  /**
   * True when an earlier relay session on this call already started the call's recording ('recording' or 'stored'):
   * a call-level recording keeps running across sessions, so start() does nothing and an objection stops the call's
   * current recording at Twilio (Twilio.CURRENT) rather than one this handle started.
   */
  alreadyRecording?: boolean;
};

/** Twilio's name for the call's in-progress recording, for a session that did not start it. */
export const CURRENT_RECORDING = 'Twilio.CURRENT';

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
  let objected = call.stoppedByCaller === true;

  return {
    async start() {
      // A second relay session on a call the caller already objected on: never record again.
      if (call.stoppedByCaller === true) return;
      if (started) return;
      started = true;
      // An earlier session's recording is still running for this call: never start a second one.
      if (call.alreadyRecording === true) return;
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
        const started2 = await deps.callControl.startRecording(sub, call.callSid, `${deps.config.PUBLIC_BASE_URL}/hooks/twilio/voice/recording?c=${call.companyId}`);
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
        if (recordingSid !== null && sub !== null) {
          await deps.callControl.stopRecording(sub, call.callSid, recordingSid);
        } else if (call.alreadyRecording === true) {
          // The recording was started by an earlier session on this call: stop whatever is recording now.
          const owner = sub ?? (await recordingSubaccount(deps.pools.system, call.companyId, deps.config.ENCRYPTION_KEY));
          if (owner !== null) await deps.callControl.stopRecording(owner, call.callSid, CURRENT_RECORDING);
        }
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
