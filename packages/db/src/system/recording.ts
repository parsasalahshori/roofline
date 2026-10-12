import { eq } from 'drizzle-orm';
import { decrypt } from '../crypto.ts';
import type { Db } from '../pools.ts';
import { calls, textingRegistrations } from '../schema/index.ts';

/** The company's Twilio subaccount login for call control; null when it has none. Only apps/api/src/{front-desk,jobs,hooks}/** import this. */
export async function recordingSubaccount(system: Db, companyId: string, encryptionKeyB64: string): Promise<{ accountSid: string; authToken: string } | null> {
  const [row] = await system
    .select({ sid: textingRegistrations.subaccountSid, token: textingRegistrations.subaccountAuthTokenEncrypted })
    .from(textingRegistrations)
    .where(eq(textingRegistrations.companyId, companyId))
    .limit(1);
  if (!row?.sid || !row.token) return null;
  return { accountSid: row.sid, authToken: decrypt(row.token, encryptionKeyB64) };
}

/** The company that owns a call, by Twilio CallSid (recording callbacks carry no To). Null when unknown. Only apps/api/src/hooks/twilio-voice-recording.ts imports this. */
export async function companyIdForCallSid(system: Db, callSid: string): Promise<string | null> {
  const [row] = await system.select({ companyId: calls.companyId }).from(calls).where(eq(calls.callSid, callSid)).limit(1);
  return row?.companyId ?? null;
}
