import { createHmac, timingSafeEqual } from 'node:crypto';

export const RELAY_TOKEN_TTL_MS = 10 * 60 * 1000;
export type RelayTokenClaims = { callId: string; companyId: string };

const SHAPE = /^(\d+)\.([0-9a-f]{64})$/;

const mac = (secret: string, c: RelayTokenClaims, expMs: number): string =>
  createHmac('sha256', secret).update(`${c.callId}.${c.companyId}.${expMs}`).digest('hex');

/** `<expMs>.<hex hmac-sha256 over "callId.companyId.expMs">` under the secret (an opaque string key, Ruling DP). */
export function mintRelayToken(secret: string, claims: RelayTokenClaims, now: Date): string {
  const expMs = now.getTime() + RELAY_TOKEN_TTL_MS;
  return `${expMs}.${mac(secret, claims, expMs)}`;
}

/** Constant-time check. False when malformed, expired, or the MAC does not match this call and company. Never throws. */
export function verifyRelayToken(secret: string, token: string, claims: RelayTokenClaims, now: Date): boolean {
  try {
    const m = SHAPE.exec(token);
    if (m === null) return false;
    const expMs = Number(m[1]);
    if (!Number.isSafeInteger(expMs) || expMs <= now.getTime()) return false;
    const given = Buffer.from(m[2] as string, 'hex');
    const want = Buffer.from(mac(secret, claims, expMs), 'hex');
    return given.length === want.length && timingSafeEqual(given, want);
  } catch {
    return false;
  }
}
