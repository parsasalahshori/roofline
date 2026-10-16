import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.ts';

/*
 * The instant quote page's bot checks: a form token that proves the form was on screen for a few seconds, the
 * requester's IP kept only as a keyed hash, and Cloudflare Turnstile when the server has a secret for it.
 */

function keyFor(config: Pick<Config, 'ENCRYPTION_KEY'>, info: string): Buffer {
  const ikm = Buffer.from(config.ENCRYPTION_KEY, 'base64');
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32));
}

/** The stored hash of a requester's IP for one company (the same IP hashes differently per company). */
export function quoteIpHash(config: Pick<Config, 'ENCRYPTION_KEY'>, ip: string, companyId: string): string {
  return createHmac('sha256', keyFor(config, 'quote-ip')).update(`${companyId}:${ip}`).digest('hex');
}

/** How long a form token stays good: an hour on the page is plenty. */
const TOKEN_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** A token naming the time it was issued and the quote it belongs to, signed. Issued with each estimate. */
export function issueFormToken(config: Pick<Config, 'ENCRYPTION_KEY'>, quoteId: string, now: Date): string {
  const at = now.getTime().toString(36);
  const sig = createHmac('sha256', keyFor(config, 'quote-form')).update(`${quoteId}.${at}`).digest('base64url');
  return `${at}.${sig}`;
}

export type FormTokenCheck = 'ok' | 'invalid' | 'too_fast' | 'expired';

/** Checks a form token for this quote: signed by us, at least `minFillMs` old and not older than two hours. */
export function checkFormToken(config: Pick<Config, 'ENCRYPTION_KEY'>, quoteId: string, token: unknown, now: Date, minFillMs: number): FormTokenCheck {
  if (typeof token !== 'string' || token.length > 100) return 'invalid';
  const [at, sig] = token.split('.');
  if (at === undefined || sig === undefined || !/^[0-9a-z]{1,12}$/.test(at)) return 'invalid';
  const want = createHmac('sha256', keyFor(config, 'quote-form')).update(`${quoteId}.${at}`).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return 'invalid';
  const age = now.getTime() - parseInt(at, 36);
  if (age < minFillMs) return 'too_fast';
  if (age > TOKEN_MAX_AGE_MS) return 'expired';
  return 'ok';
}

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** True when the server checks Turnstile (a secret and a site key are both set). */
export function turnstileOn(config: Pick<Config, 'TURNSTILE_SECRET' | 'TURNSTILE_SITE_KEY'>): boolean {
  return (config.TURNSTILE_SECRET ?? '') !== '' && (config.TURNSTILE_SITE_KEY ?? '') !== '';
}

/**
 * Asks Cloudflare whether the widget's token is good. Server side only; the secret never leaves the server. Any
 * failure (no token, Cloudflare down, a bad answer) is false: the page then asks the person to try again.
 */
export async function verifyTurnstile(
  config: Pick<Config, 'TURNSTILE_SECRET'>,
  token: unknown,
  ip: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (typeof token !== 'string' || token === '' || token.length > 2048) return false;
  try {
    const body = new URLSearchParams({ secret: config.TURNSTILE_SECRET ?? '', response: token, remoteip: ip });
    const res = await fetchImpl(SITEVERIFY, { method: 'POST', body, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const answer = (await res.json()) as { success?: unknown };
    return answer.success === true;
  } catch {
    return false;
  }
}
