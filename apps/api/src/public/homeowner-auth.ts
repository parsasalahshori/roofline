import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, MemoryStore, type Options } from 'express-rate-limit';
import { getHomeownerRequest, type HomeownerRequestRow, type TenantContext, withTenant } from '@roofline/db';
import { HOMEOWNER_TOKEN_RE, type InstantQuoteSettings } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError } from '../errors.ts';
import { createAllowance } from '../rate-limit.ts';
import { UUID } from '../validate.ts';
import { pageFor } from './quote-access.ts';

/*
 * The homeowner API's bearer token. POST /requests makes it (32 random bytes, base64url, 43 characters) and shows it
 * once; the server keeps only its SHA-256 hash, so a database read cannot be turned into a way in. Every
 * /requests/:id/... call sends it as `Authorization: Bearer <token>`.
 *
 * What a caller can learn without the token: nothing. A missing, malformed or wrong token, an unknown id, a malformed
 * id, and another company's request are all the same 401 (so request ids cannot be probed), compared in constant time
 * against the stored hash (a dummy hash when there is no such request, so the work is the same). Only a token that
 * matches and is past its 60 days is told so (401 token_expired): it proves they held the token, so it leaks nothing.
 * Wrong tokens count against the caller's IP address (FAILED_PER_IP_PER_HOUR an hour); past that every call from that
 * address is a 429 until the window passes, even with a right token, so the limit cannot be used to test guesses.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** The limits (calls) of the homeowner API. Per IP address and per request (token). Hourly ones say so in their answer. */
export const HOMEOWNER_LIMITS = {
  ipPerMinute: 240,
  newRequestsPerIpPerHour: 10,
  slotsPerIpPerHour: 60,
  failedAuthPerIpPerHour: 30,
  tokenPerMinute: 120,
  uploadsPerTokenPerHour: 60,
  windowsPerTokenPerHour: 120,
  contactPerTokenPerHour: 5,
  bookPerTokenPerHour: 20,
  slotsPerTokenPerHour: 30,
} as const;

export const HOMEOWNER_TOO_MANY = "You're going a little fast. Please wait a moment and try again.";
/** What a call with no good token is told (the app has no sign-in; it starts a new estimate). */
export const HOMEOWNER_UNKNOWN_REQUEST = "We couldn't find your request. Please start a new estimate.";
export const HOMEOWNER_TOO_MANY_HOURLY = "That's a lot of tries from this connection. Please try again in an hour, or give us a call.";

/** A 429 of this API: `retryAfterSeconds` goes out as the `Retry-After` header (the router's error handler sets it), whichever limit it was. */
export class RateLimitedError extends AppError {
  constructor(
    readonly retryAfterSeconds: number,
    hourly: boolean,
  ) {
    super(429, hourly ? HOMEOWNER_TOO_MANY_HOURLY : HOMEOWNER_TOO_MANY);
    this.coded('rate_limited');
  }
}

/** `retryAfterSeconds` is how long the caller may be made to wait at most (the whole window, not what is left of it). */
export const rateLimited = (hourly: boolean, retryAfterSeconds: number): RateLimitedError => new RateLimitedError(retryAfterSeconds, hourly);

/** A new token: 32 random bytes in base64url. */
export function newHomeownerToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The hash stored for a token (SHA-256, hex). */
export function hashHomeownerToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A hash no token has: compared against when there is no such request, so the work does not tell. */
const NO_SUCH_HASH = Buffer.from(createHash('sha256').update('homeowner-no-such-request').digest('hex'), 'hex');

/** Whether a presented token's hash is the stored one, in constant time. */
function sameHash(presentedHex: string, storedHex: string | null): boolean {
  const presented = Buffer.from(presentedHex, 'hex');
  const stored = storedHex === null ? NO_SUCH_HASH : Buffer.from(storedHex, 'hex');
  // Equal lengths by construction (SHA-256); timingSafeEqual throws on unequal ones, which a corrupt row must not turn into a 500.
  return presented.length === stored.length && timingSafeEqual(presented, stored) && storedHex !== null;
}

/** The token in `Authorization: Bearer <token>`, or null when the header is absent or not shaped like a token. */
export function bearerToken(req: Request): string | null {
  const header = req.get('Authorization');
  if (header === undefined) return null;
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header.trim());
  const token = match?.[1];
  return token !== undefined && HOMEOWNER_TOKEN_RE.test(token) ? token : null;
}

/** Counts events per key without ever refusing; the caller asks `blocked` first. */
class Tally {
  private readonly store = new MemoryStore();
  constructor(
    windowMs: number,
    private readonly limit: number,
  ) {
    // MemoryStore reads only windowMs from the options.
    this.store.init({ windowMs } as Options);
  }
  async blocked(key: string): Promise<boolean> {
    const hit = await this.store.get(key);
    // The store keeps a count until the key's next hit or its own sweep, so the end of the window is checked here.
    return hit !== undefined && hit.totalHits >= this.limit && (hit.resetTime === undefined || hit.resetTime.getTime() > Date.now());
  }
  async add(key: string): Promise<void> {
    await this.store.increment(key);
  }
}

export type Authed = { ctx: TenantContext; settings: InstantQuoteSettings; request: HomeownerRequestRow };

/** The request an authenticated call is about, set by `authenticate` for the handlers behind it. */
export const authed = (res: { locals: Record<string, unknown> }): Authed => res.locals.homeowner as Authed;

export type TokenBudget = (key: string, scope: 'minute' | 'uploads' | 'windows' | 'contact' | 'book' | 'slots') => Promise<void>;

/**
 * The middleware for `/:slug/requests/:id/...`: the company by slug, the token against the request's stored hash, the
 * expiry, the failed-token limit per IP and the calls-a-minute limit per request. On success `res.locals.homeowner` is
 * `{ ctx, settings, request }`. `now` comes from the app clock, so tests move time.
 */
export function authenticate(deps: AppDeps): { middleware: RequestHandler; budget: TokenBudget } {
  const failed = new Tally(HOUR_MS, HOMEOWNER_LIMITS.failedAuthPerIpPerHour);
  const perMinute = createAllowance(MINUTE_MS, HOMEOWNER_LIMITS.tokenPerMinute);
  const budgets = {
    uploads: createAllowance(HOUR_MS, HOMEOWNER_LIMITS.uploadsPerTokenPerHour),
    windows: createAllowance(HOUR_MS, HOMEOWNER_LIMITS.windowsPerTokenPerHour),
    contact: createAllowance(HOUR_MS, HOMEOWNER_LIMITS.contactPerTokenPerHour),
    book: createAllowance(HOUR_MS, HOMEOWNER_LIMITS.bookPerTokenPerHour),
    slots: createAllowance(HOUR_MS, HOMEOWNER_LIMITS.slotsPerTokenPerHour),
  };
  const unauthorized = () => new AppError(401, HOMEOWNER_UNKNOWN_REQUEST).coded('unauthorized');

  const middleware: RequestHandler = (req, res, next) => {
    void (async () => {
      const ipKey = `ho-failed:${ipKeyGenerator(req.ip ?? 'unknown')}`;
      if (await failed.blocked(ipKey)) throw rateLimited(true, 3600);
      // An unknown slug is a 404 like everywhere else on this API; a page turned off still serves requests already made.
      const { ctx, settings } = await pageFor(deps, req.params.slug, { allowOff: true });
      const token = bearerToken(req);
      const id = typeof req.params.id === 'string' ? req.params.id.toLowerCase() : '';
      const row = token === null || !UUID.test(id) ? null : await withTenant(deps.pools, ctx, (tx) => getHomeownerRequest(tx, ctx, id));
      const matches = token !== null && sameHash(hashHomeownerToken(token), row?.tokenHash ?? null);
      if (!matches || row === null) {
        await failed.add(ipKey);
        throw unauthorized();
      }
      if (row.expiresAt.getTime() <= deps.clock.now().getTime()) throw new AppError(401, 'This request has expired. Please start a new one.').coded('token_expired');
      if (!(await perMinute(row.id))) throw rateLimited(false, 60);
      res.locals.homeowner = { ctx, settings, request: row } satisfies Authed;
      next();
    })().catch(next);
  };

  const budget: TokenBudget = async (key, scope) => {
    if (scope === 'minute') return;
    if (!(await budgets[scope](key))) throw rateLimited(true, 3600);
  };
  return { middleware, budget };
}
