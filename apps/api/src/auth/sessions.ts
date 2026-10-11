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

export const SESSION_COOKIE = 'rl_session';

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

/** The cookie's attributes. `Secure` only in production, so plain-http local development still works. */
function cookieOptions(config: Pick<Config, 'NODE_ENV'>): CookieOptions {
  return { httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'lax', path: '/' };
}

export function setSessionCookie(res: Response, token: string, config: Pick<Config, 'NODE_ENV'>): void {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(config), maxAge: SESSION_TTL_MS });
}

export function clearSessionCookie(res: Response, config: Pick<Config, 'NODE_ENV'>): void {
  res.clearCookie(SESSION_COOKIE, cookieOptions(config));
}

/** The session token from the Cookie header, or undefined. (No cookie-parser: this is the only cookie we read.) */
export function readSessionToken(req: Pick<Request, 'headers'>): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return value === '' ? undefined : value;
  }
  return undefined;
}
