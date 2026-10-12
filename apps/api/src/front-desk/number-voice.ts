import { decrypt } from '@roofline/db';
import type { AppDeps } from '../app.ts';
import type { SubaccountRef } from '../providers/registrar.ts';

/*
 * Voice URL setup for Front Desk numbers (D1 Task 17). Pure: this file never touches the system pool
 * (boundaries.test.ts). The callers that fetch the rows and record the marker live in
 * jobs/scheduler/fd-health.ts, which is allowed to import @roofline/db/system.
 */

/** Path of the voice webhook and of its status callback (apps/api/src/app.ts mounts them). */
export const VOICE_HOOK_PATH = '/hooks/twilio/voice';
export const VOICE_STATUS_HOOK_PATH = '/hooks/twilio/voice-status';

/** A number whose voice URL is still to be set. The token stays encrypted until it is used. */
export type VoiceNumberRow = {
  companyId: string;
  numberId: string;
  providerSid: string;
  subaccountSid: string;
  authTokenEncrypted: Buffer;
};

export type VoiceUrlResult = { set: number; failed: number };

/**
 * Sets the voice URL and status callback on each number, one at a time. A failure on one number is
 * counted and logged with the company id only (never the number), and the others still run. `markSet`
 * runs after a successful set; a number whose set or mark throws stays unmarked and is retried later.
 */
export async function applyVoiceUrls(
  deps: AppDeps,
  rows: VoiceNumberRow[],
  markSet: (numberId: string) => Promise<void>,
): Promise<VoiceUrlResult> {
  const result: VoiceUrlResult = { set: 0, failed: 0 };
  const base = deps.config.PUBLIC_BASE_URL;
  for (const row of rows) {
    try {
      const sub: SubaccountRef = {
        accountSid: row.subaccountSid,
        authToken: decrypt(row.authTokenEncrypted, deps.config.ENCRYPTION_KEY),
      };
      await deps.callControl.setVoiceUrl(sub, row.providerSid, base + VOICE_HOOK_PATH, base + VOICE_STATUS_HOOK_PATH);
      await markSet(row.numberId);
      result.set++;
    } catch {
      result.failed++;
      console.error(`Front Desk: the voice URL was not set for company ${row.companyId}.`);
    }
  }
  return result;
}
