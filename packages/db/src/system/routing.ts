import { and, eq } from 'drizzle-orm';
import { decrypt } from '../crypto.ts';
import type { Db } from '../pools.ts';
import { companyPhoneNumbers, textingRegistrations } from '../schema/index.ts';

/*
 * Webhook routing, on the app_system pool: which company a provider's request is for, and the secret
 * its signature is checked with. These are all global tables, read before any company is known. The
 * work a webhook then does for the company runs as app_tenant inside `withTenant`. Only
 * apps/api/src/hooks/** imports this module.
 */

/**
 * The company that owns this texting number. By default only while the number is active; null for
 * any other number. With `includeInactive: true` the number's status is not checked, so an inactive
 * number of a company also counts (e164 is unique, so at most one row matches).
 */
export async function companyIdForNumber(
  system: Db,
  e164: string,
  options?: { includeInactive?: boolean },
): Promise<string | null> {
  const [row] = await system
    .select({ companyId: companyPhoneNumbers.companyId })
    .from(companyPhoneNumbers)
    .where(
      options?.includeInactive
        ? eq(companyPhoneNumbers.e164, e164)
        : and(eq(companyPhoneNumbers.e164, e164), eq(companyPhoneNumbers.status, 'active')),
    )
    .limit(1);
  return row?.companyId ?? null;
}

/**
 * The company whose texting registration owns this messaging service (`messaging_service_sid`);
 * null when no registration has it. Used to route a delivery report that carries no usable `From`.
 */
export async function companyIdForMessagingService(system: Db, messagingServiceSid: string): Promise<string | null> {
  const [row] = await system
    .select({ companyId: textingRegistrations.companyId })
    .from(textingRegistrations)
    .where(eq(textingRegistrations.messagingServiceSid, messagingServiceSid))
    .limit(1);
  return row?.companyId ?? null;
}

/**
 * The auth token the provider signs this company's webhooks with: the company's own subaccount
 * token (`texting_registrations.subaccount_auth_token_encrypted`, decrypted with `encryptionKeyB64`)
 * when it has one, else `fallback` (the platform account's TWILIO_AUTH_TOKEN), else null.
 *
 * A stored token that does not decrypt (a wrong key, a damaged value) throws: the request then
 * fails rather than being checked against some other secret.
 */
export async function signingTokenFor(
  system: Db,
  companyId: string,
  fallback: string | undefined,
  encryptionKeyB64: string,
): Promise<string | null> {
  const [row] = await system
    .select({ token: textingRegistrations.subaccountAuthTokenEncrypted })
    .from(textingRegistrations)
    .where(eq(textingRegistrations.companyId, companyId))
    .limit(1);
  if (row?.token) return decrypt(row.token, encryptionKeyB64);
  return fallback !== undefined && fallback !== '' ? fallback : null;
}
