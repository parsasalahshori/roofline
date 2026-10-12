import { createHmac, timingSafeEqual } from 'node:crypto';

/** What an unsubscribe token names: one company and one address. */
export type UnsubscribeClaim = { companyId: string; email: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(`unsubscribe:${payload}`).digest('base64url');
}

/** `<base64url(companyId|email)>.<base64url HMAC-SHA256>`, signed with unsubscribeKey(config) (unsubscribe-key.ts). Shared with the storm email task. */
export function signUnsubscribeToken(secret: string, claim: UnsubscribeClaim): string {
  const payload = Buffer.from(`${claim.companyId}|${claim.email.toLowerCase()}`, 'utf8').toString('base64url');
  return `${payload}.${mac(secret, payload)}`;
}

/** The claim when the token's signature is ours and its parts are well formed; else null. Never throws. */
export function verifyUnsubscribeToken(secret: string, token: string): UnsubscribeClaim | null {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = Buffer.from(mac(secret, parts[0]));
  const given = Buffer.from(parts[1]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const decoded = Buffer.from(parts[0], 'base64url').toString('utf8');
  const bar = decoded.indexOf('|');
  if (bar < 0) return null;
  const companyId = decoded.slice(0, bar);
  const email = decoded.slice(bar + 1);
  if (!UUID.test(companyId) || !email.includes('@')) return null;
  return { companyId, email };
}
