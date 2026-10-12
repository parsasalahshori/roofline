import { createHash, randomBytes } from 'node:crypto';
import type { CookieOptions, Request, Response } from 'express';
import type { Db } from '@roofline/db';
import {
  findLiveSession,
  insertSession,
  insertSessionIfPasswordUnchanged,
  renewSession,
  type SessionDetails,
} from '@roofline/db/system';
import type { CompanyStatus, Role } from '@roofline/shared';
import type { Config } from '../config.ts';

/**
 * The session cookie's name whenever it is set over https, and always in production. The `__Host-`
 * prefix makes the browser refuse the cookie unless it is Secure, has `Path=/` and no `Domain`, so a
 * sibling host on the same site cannot plant ("toss") a session cookie for the app.
 */
export const SESSION_COOKIE = '__Host-rl_session';
/**
 * The name used outside production over plain http (local development, tests, the end-to-end
 * stack): `__Host-` needs `Secure`, which a browser will not store from a plain-http origin like
 * http://127.0.0.1. Production never reads or writes this name.
 */
export const DEV_SESSION_COOKIE = 'rl_session';

/** Whether the session cookie is the Secure `__Host-` one: always in production, and on any https request. */
export function isSecureCookieContext(req: Pick<Request, 'secure'>, config: Pick<Config, 'NODE_ENV'>): boolean {
  return config.NODE_ENV === 'production' || req.secure;
}

/**
 * The one name a request's session cookie has, read and written: `SESSION_COOKIE` over https and in
 * production, `DEV_SESSION_COOKIE` otherwise. Everything that reads or sets the cookie goes through this.
 */
export function sessionCookieName(req: Pick<Request, 'secure'>, config: Pick<Config, 'NODE_ENV'>): string {
  return isSecureCookieContext(req, config) ? SESSION_COOKIE : DEV_SESSION_COOKIE;
}

const HOUR_MS = 60 * 60 * 1000;
/** A session lasts 30 days from the last time it was renewed. */
export const SESSION_TTL_MS = 30 * 24 * HOUR_MS;
/** A session is renewed (and its cookie refreshed) when it has not been seen for more than an hour. */
export const SESSION_RENEW_AFTER_MS = HOUR_MS;

/** 32 random bytes as base64url is always 43 characters from this alphabet. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** 32 random bytes, base64url. Session cookies and the emailed verification and reset links all use this. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** True for a string that could be a token from `generateToken`. A cheap check before any database lookup. */
export function isWellFormedToken(token: string): boolean {
  return TOKEN_SHAPE.test(token);
}

/**
 * Who is signed in and where. Everything but `sessionId` comes from the live membership row and
 * the company row, read on every request: `companyStatus` is the company's current status, so a
 * trial ending or a cancel applies without signing in again.
 */
export type SessionInfo = {
  sessionId: string;
  userId: string;
  companyId: string;
  role: Role;
  canApproveSpend: boolean;
  emailVerified: boolean;
  companyStatus: CompanyStatus;
};

/** The database keeps only this hash. A leaked sessions table cannot be replayed as cookies. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type NewSessionInput = {
  userId: string;
  companyId: string;
  ua: string | null;
  ip: string | null;
  /** The app clock's `now()`. Never `new Date()`: tests move the clock. */
  now: Date;
};

const MAX_USER_AGENT_LENGTH = 512;

/**
 * A new session's token and everything about it that does not depend on who the user is: the
 * token's hash, the expiry, the device details. For a transaction that already has the user (and
 * the company) in hand and saves the session itself (invite acceptance); `newSessionRow` adds them.
 */
export function prepareSession(input: Pick<NewSessionInput, 'ua' | 'ip' | 'now'>): {
  token: string;
  details: SessionDetails;
} {
  const token = generateToken();
  return {
    token,
    details: {
      tokenHash: hashToken(token),
      now: input.now,
      expiresAt: new Date(input.now.getTime() + SESSION_TTL_MS),
      userAgent: input.ua === null ? null : input.ua.slice(0, MAX_USER_AGENT_LENGTH),
      ip: input.ip,
    },
  };
}

function newSessionRow(input: NewSessionInput) {
  const { token, details } = prepareSession(input);
  return { token, row: { ...details, userId: input.userId, companyId: input.companyId } };
}

/** Starts a session and returns the raw token for the cookie. The token itself is never stored. */
export async function createSession(system: Db, input: NewSessionInput): Promise<{ token: string }> {
  const { token, row } = newSessionRow(input);
  await insertSession(system, row);
  return { token };
}

/**
 * Starts a session for a password login, but only if the user's password is still `passwordHash`,
 * the hash the password was just checked against; otherwise nothing is saved and the result is
 * null (see `insertSessionIfPasswordUnchanged`). Only password login uses this.
 */
export async function createSessionIfPasswordUnchanged(
  system: Db,
  input: NewSessionInput,
  passwordHash: string,
): Promise<{ token: string } | null> {
  const { token, row } = newSessionRow(input);
  return (await insertSessionIfPasswordUnchanged(system, row, passwordHash)) ? { token } : null;
}

export type ResolvedSession = {
  session: SessionInfo;
  /** True when this request pushed the expiry forward, so the cookie should be refreshed too. */
  renewed: boolean;
  tokenHash: string;
};

/**
 * Looks a cookie token up and, if the session is live, slides its expiry: when `last_seen_at` is
 * more than an hour old, `expires_at` becomes now + 30 days. Null for a token that is malformed,
 * unknown, expired, or whose membership is no longer active.
 */
export async function resolveSessionDetailed(system: Db, token: string, now: Date): Promise<ResolvedSession | null> {
  if (!isWellFormedToken(token)) return null;
  const tokenHash = hashToken(token);
  const found = await findLiveSession(system, tokenHash, now);
  if (!found) return null;

  const { lastSeenAt, ...session } = found;
  const staleBefore = new Date(now.getTime() - SESSION_RENEW_AFTER_MS);
  let renewed = false;
  if (lastSeenAt.getTime() < staleBefore.getTime()) {
    renewed = await renewSession(system, found.sessionId, {
      now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      staleBefore,
    });
  }
  return { session, renewed, tokenHash };
}

export async function resolveSession(system: Db, token: string, now: Date): Promise<SessionInfo | null> {
  return (await resolveSessionDetailed(system, token, now))?.session ?? null;
}

/**
 * The cookie's attributes. `Secure` with the `__Host-` name (production, and any https request);
 * neither over plain http outside production, so local development still works. Always `Path=/`
 * and never a `Domain`, as `__Host-` requires.
 */
function cookieOptions(req: Pick<Request, 'secure'>, config: Pick<Config, 'NODE_ENV'>): CookieOptions {
  return { httpOnly: true, secure: isSecureCookieContext(req, config), sameSite: 'lax', path: '/' };
}

export function setSessionCookie(res: Response, token: string, config: Pick<Config, 'NODE_ENV'>): void {
  res.cookie(sessionCookieName(res.req, config), token, { ...cookieOptions(res.req, config), maxAge: SESSION_TTL_MS });
}

export function clearSessionCookie(res: Response, config: Pick<Config, 'NODE_ENV'>): void {
  res.clearCookie(sessionCookieName(res.req, config), cookieOptions(res.req, config));
}

/**
 * The session token from the Cookie header, or undefined. Only the name this request uses counts
 * (see `sessionCookieName`): in production a plain `rl_session` cookie is ignored. (No
 * cookie-parser: this is the only cookie we read.)
 */
export function readSessionToken(
  req: Pick<Request, 'headers' | 'secure'>,
  config: Pick<Config, 'NODE_ENV'>,
): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const name = sessionCookieName(req, config);
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value === '' ? undefined : value;
  }
  return undefined;
}
