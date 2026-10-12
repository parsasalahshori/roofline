import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { companies, companyPhoneNumbers, memberships, textingRegistrations } from '../schema/index.ts';

/*
 * Voice webhook routing on the app_system pool (D1 Task 10). Only apps/api/src/hooks/twilio-voice*.ts
 * imports this. Memberships are read only here (Ruling DK).
 */

/** What a voice webhook needs about the company that owns the dialed number (settings are read tenant-side). */
export type VoiceNumberRoute = { companyId: string; companyName: string; timezone: string };

/** An active texting/voice number (company_phone_numbers, status 'active') -> its company; null when none. */
export async function voiceRouteForNumber(system: Db, e164: string): Promise<VoiceNumberRoute | null> {
  const [row] = await system
    .select({ companyId: companyPhoneNumbers.companyId, companyName: companies.name, timezone: companies.timezone })
    .from(companyPhoneNumbers)
    .innerJoin(companies, eq(companies.id, companyPhoneNumbers.companyId))
    .where(and(eq(companyPhoneNumbers.e164, e164), eq(companyPhoneNumbers.status, 'active')))
    .limit(1);
  return row ?? null;
}

export type OnCallMember = { userId: string; phone: string; onCallOrder: number };

/** Active memberships with transfer_phone_e164 and on_call_order both set, ordered by on_call_order asc then user id. */
export async function onCallMembers(system: Db, companyId: string): Promise<OnCallMember[]> {
  const rows = await system
    .select({ userId: memberships.userId, phone: memberships.transferPhoneE164, onCallOrder: memberships.onCallOrder })
    .from(memberships)
    .where(
      and(
        eq(memberships.companyId, companyId),
        eq(memberships.status, 'active'),
        isNotNull(memberships.transferPhoneE164),
        isNotNull(memberships.onCallOrder),
      ),
    )
    .orderBy(asc(memberships.onCallOrder), asc(memberships.userId));
  const out: OnCallMember[] = [];
  for (const r of rows) {
    if (r.phone !== null && r.onCallOrder !== null) out.push({ userId: r.userId, phone: r.phone, onCallOrder: r.onCallOrder });
  }
  return out;
}

/** The team's ring-first targets: same rows as onCallMembers, all of them. Alias kept for readability in the voice hook. */
export async function teamDialNumbers(system: Db, companyId: string): Promise<string[]> {
  return (await onCallMembers(system, companyId)).map((m) => m.phone);
}

/*
 * Voice URL setup (D1 Task 17). The schema has no voice-url column, so "voice URL set" is the marker
 * VOICE_URL_MARKER appended to company_phone_numbers.capabilities. The api layer decrypts the token.
 */

/** The capability marker that records a number's voice URL as set on Twilio. */
export const VOICE_URL_MARKER = 'voice_url';

/** An active voice number still missing its marker, with its company's subaccount (token still encrypted). */
export type VoiceNumberToSet = {
  companyId: string;
  numberId: string;
  providerSid: string;
  subaccountSid: string;
  authTokenEncrypted: Buffer;
};

/**
 * Active company_phone_numbers with 'voice' and without the 'voice_url' marker, whose company has a
 * texting registration with a subaccount. Oldest first. `companyId` null means every company.
 */
export async function numbersNeedingVoiceUrl(system: Db, companyId: string | null, limit: number): Promise<VoiceNumberToSet[]> {
  const rows = await system
    .select({
      companyId: companyPhoneNumbers.companyId,
      numberId: companyPhoneNumbers.id,
      providerSid: companyPhoneNumbers.providerSid,
      subaccountSid: textingRegistrations.subaccountSid,
      authTokenEncrypted: textingRegistrations.subaccountAuthTokenEncrypted,
    })
    .from(companyPhoneNumbers)
    .innerJoin(textingRegistrations, eq(textingRegistrations.companyId, companyPhoneNumbers.companyId))
    .where(
      and(
        eq(companyPhoneNumbers.status, 'active'),
        isNotNull(companyPhoneNumbers.providerSid),
        isNotNull(textingRegistrations.subaccountSid),
        isNotNull(textingRegistrations.subaccountAuthTokenEncrypted),
        sql`${'voice'} = any(${companyPhoneNumbers.capabilities})`,
        sql`not (${VOICE_URL_MARKER} = any(${companyPhoneNumbers.capabilities}))`,
        companyId === null ? undefined : eq(companyPhoneNumbers.companyId, companyId),
      ),
    )
    .orderBy(asc(companyPhoneNumbers.createdAt), asc(companyPhoneNumbers.id))
    .limit(limit);
  const out: VoiceNumberToSet[] = [];
  for (const r of rows) {
    if (r.providerSid === null || r.subaccountSid === null || r.authTokenEncrypted === null) continue;
    out.push({
      companyId: r.companyId,
      numberId: r.numberId,
      providerSid: r.providerSid,
      subaccountSid: r.subaccountSid,
      authTokenEncrypted: r.authTokenEncrypted,
    });
  }
  return out;
}

/** Records the voice URL as set on a number: appends the marker unless it is already there. */
export async function markVoiceUrlSet(system: Db, numberId: string): Promise<void> {
  await system
    .update(companyPhoneNumbers)
    .set({ capabilities: sql`array_append(${companyPhoneNumbers.capabilities}, ${VOICE_URL_MARKER})` })
    .where(and(eq(companyPhoneNumbers.id, numberId), sql`not (${VOICE_URL_MARKER} = any(${companyPhoneNumbers.capabilities}))`));
}
