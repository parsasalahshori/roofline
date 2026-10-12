import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { CALENDAR_PROVIDERS, type CalendarProvider } from '@roofline/shared';

/*
 * The `state` value sent through a calendar provider's consent screen. It names the company, the
 * person and the provider, and expires ten minutes after it was made. It is signed with a key derived
 * from ENCRYPTION_KEY, so nobody can forge one. It is not single use here: each string carries a
 * random nonce, and the callback route remembers the strings it has already accepted.
 */

const LIFETIME_MS = 10 * 60 * 1000;
const PURPOSE = 'calendar-oauth-state';

type OAuthStatePayload = { c: string; u: string; p: CalendarProvider; n: string; exp: number };

/** The HMAC key for this purpose, derived from the base64 ENCRYPTION_KEY. */
function signingKey(key: string): Buffer {
  return createHmac('sha256', Buffer.from(key, 'base64')).update(PURPOSE).digest();
}

function sign(payloadB64: string, key: string): string {
  return createHmac('sha256', signingKey(key)).update(payloadB64).digest('base64url');
}

/** A signed state for one company, person and provider, valid for ten minutes from `now`. */
export function makeOAuthState(i: { companyId: string; userId: string; provider: CalendarProvider; now: Date }, key: string): string {
  const payload: OAuthStatePayload = {
    c: i.companyId,
    u: i.userId,
    p: i.provider,
    n: randomUUID(),
    exp: i.now.getTime() + LIFETIME_MS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${payloadB64}.${sign(payloadB64, key)}`;
}

/** The company, person and provider inside a valid, unexpired state; null for anything else. Never throws. */
export function readOAuthState(state: string, key: string, now: Date): { companyId: string; userId: string; provider: CalendarProvider } | null {
  try {
    if (typeof state !== 'string') return null;
    const parts = state.split('.');
    if (parts.length !== 2) return null;
    const [payloadB64, sig] = parts as [string, string];

    const given = Buffer.from(sig, 'utf8');
    const want = Buffer.from(sign(payloadB64, key), 'utf8');
    if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Partial<OAuthStatePayload> | null;
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.c !== 'string' || typeof payload.u !== 'string') return null;
    if (typeof payload.p !== 'string' || !(CALENDAR_PROVIDERS as readonly string[]).includes(payload.p)) return null;
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
    if (now.getTime() > payload.exp) return null;

    return { companyId: payload.c, userId: payload.u, provider: payload.p };
  } catch {
    return null;
  }
}
