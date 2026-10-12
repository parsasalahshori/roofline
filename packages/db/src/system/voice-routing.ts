import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { companies, companyPhoneNumbers, memberships } from '../schema/index.ts';

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
