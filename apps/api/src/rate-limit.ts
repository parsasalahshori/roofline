import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { SessionInfo } from './auth/sessions.ts';
import type { Config } from './config.ts';
import { AppError, MESSAGES } from './errors.ts';
import { MAX_EMAIL_LENGTH } from './validate.ts';

/*
 * Rate limiters. The counters live in this process's memory (express-rate-limit's default store),
 * which is right for one API instance; with several instances behind a load balancer each would
 * count on its own and a shared store would be needed.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const LOGIN_WINDOW_MS = 15 * MINUTE_MS;
const LOGIN_ATTEMPTS = 10;
const GOOGLE_ATTEMPTS = 20;
const SIGNUP_PER_IP_PER_HOUR = 10;
const RESET_REQUEST_PER_IP_PER_HOUR = 20;
const RESET_REQUEST_PER_EMAIL_PER_HOUR = 5;
const RESEND_PER_USER_PER_HOUR = 3;
const INVITES_PER_COMPANY_PER_HOUR = 30;
const ACCEPT_INVITE_PER_IP = 30;
const ACCEPT_INVITE_FAILURES = 10;

/**
 * `/api/*`: `API_RATE_LIMIT_PER_MIN` requests a minute per session. The key is the session's token
 * hash (recorded by `attachSession`, so only a live session gets a bucket of its own); everything
 * else, including requests with invented cookies, shares one bucket per IP address.
 * Mount it on `/api` after `attachSession`. `/health` and `/hooks/*` are outside `/api`, so they
 * are never limited.
 */
export function apiRateLimit(config: Pick<Config, 'API_RATE_LIMIT_PER_MIN'>): RequestHandler {
  return rateLimit({
    windowMs: MINUTE_MS,
    limit: config.API_RATE_LIMIT_PER_MIN,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req, res) => {
      const { sessionKey } = res.locals;
      // ipKeyGenerator groups IPv6 addresses by subnet, so one network cannot mint unlimited buckets.
      return sessionKey === undefined ? `ip:${ipKeyGenerator(req.ip ?? 'unknown')}` : `session:${sessionKey}`;
    },
    handler: (_req, _res, next) => {
      next(new AppError(429, MESSAGES.tooFast));
    },
  });
}

/** The email a login attempt names, as the limiter keys it: trimmed and lowercased. */
function loginEmail(body: unknown): string {
  const email = (body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/**
 * `POST /api/auth/login`: 10 failed attempts per 15 minutes for one IP address + email. Attempts
 * that end in a sign-in are not counted, so nobody is locked out by signing in on several devices;
 * but once the budget is spent every attempt, even with the right password, is refused until the
 * window passes, so the budget cannot be used to test guesses. Mount it after the JSON body parser.
 */
export function loginRateLimit(): RequestHandler {
  return rateLimit({
    windowMs: LOGIN_WINDOW_MS,
    limit: LOGIN_ATTEMPTS,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? 'unknown')}|${loginEmail(req.body)}`,
    handler: (_req, _res, next) => {
      next(new AppError(429, MESSAGES.tooManyLogins));
    },
  });
}

/**
 * `POST /api/auth/google`: 20 attempts per 15 minutes per IP address. Every attempt counts,
 * whether it signs in, creates an account or is refused, so the limit also caps how fast an
 * address can try credentials or probe which emails have accounts. Same sentence as login.
 * Mount it after the JSON body parser.
 */
export function googleRateLimit(): RequestHandler {
  return rateLimit({
    windowMs: LOGIN_WINDOW_MS,
    limit: GOOGLE_ATTEMPTS,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `google:${ipKeyGenerator(req.ip ?? 'unknown')}`,
    handler: (_req, _res, next) => {
      next(new AppError(429, MESSAGES.tooManyLogins));
    },
  });
}

/**
 * `POST /api/auth/signup`: 10 an hour per IP address. Every attempt counts, including refused ones
 * (an email that is already taken, bad input), so the "that email already has an account" answer
 * cannot be asked in bulk and a script cannot flood addresses with verification emails.
 * Mount it after the JSON body parser.
 */
export function signupRateLimit(): RequestHandler {
  return rateLimit({
    windowMs: HOUR_MS,
    limit: SIGNUP_PER_IP_PER_HOUR,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `signup:${ipKeyGenerator(req.ip ?? 'unknown')}`,
    handler: (_req, _res, next) => {
      next(new AppError(429, MESSAGES.tooManySignups));
    },
  });
}

/** What `POST /api/auth/reset-request` answers, to everyone, whatever happened behind it. */
const answerOk: RequestHandler = (_req, res) => {
  res.json({ ok: true });
};

/**
 * `POST /api/auth/reset-request`: two limits, 20 an hour per IP address and 5 an hour per email
 * (trimmed, lowercased; the email limit applies only to a request that names an email address of
 * a possible length, since anything else is refused as invalid before it matters).
 * Over a limit the answer is the normal `200 {ok: true}` with no headers that say "throttled",
 * and the route is not run, so no email goes out. Answering 429 would tell a stranger which
 * addresses are being asked about; staying silent tells them nothing. The IP limit comes first,
 * so a script cannot grow the per-email table faster than 20 entries an hour per address.
 * Returns the two limiters in order; mount them both, after the JSON body parser.
 */
export function resetRequestRateLimit(): RequestHandler[] {
  const common = { windowMs: HOUR_MS, standardHeaders: false, legacyHeaders: false, handler: answerOk } as const;
  return [
    rateLimit({
      ...common,
      limit: RESET_REQUEST_PER_IP_PER_HOUR,
      keyGenerator: (req) => `reset-ip:${ipKeyGenerator(req.ip ?? 'unknown')}`,
    }),
    rateLimit({
      ...common,
      limit: RESET_REQUEST_PER_EMAIL_PER_HOUR,
      skip: (req) => {
        const email = loginEmail(req.body);
        return email === '' || email.length > MAX_EMAIL_LENGTH;
      },
      keyGenerator: (req) => `reset-email:${loginEmail(req.body)}`,
    }),
  ];
}

/**
 * `POST /api/auth/resend-verification`: 3 an hour per user, across all of their sessions (the key
 * is the user id the sign-in gate found, so signing in again does not reset the count).
 * Mount it after the sign-in gate.
 */
export function resendVerificationRateLimit(): RequestHandler {
  return rateLimit({
    windowMs: HOUR_MS,
    limit: RESEND_PER_USER_PER_HOUR,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => {
      const session = req.session as SessionInfo | undefined;
      return session ? `resend:${session.userId}` : `resend-ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
    },
    handler: (_req, _res, next) => {
      next(new AppError(429, MESSAGES.tooManyEmails));
    },
  });
}

/**
 * `POST /api/team/invites`: 30 an hour per company, shared by everyone who can invite, so an owner
 * cannot be used to flood addresses with email. Every attempt counts. Mount it after the sign-in
 * gate and the permission checks (so people who may not invite cannot use up the company's budget).
 */
export function inviteRateLimit(): RequestHandler {
  return rateLimit({
    windowMs: HOUR_MS,
    limit: INVITES_PER_COMPANY_PER_HOUR,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => {
      const session = req.session as SessionInfo | undefined;
      return session ? `invite:${session.companyId}` : `invite-ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
    },
    handler: (_req, _res, next) => {
      next(new AppError(429, MESSAGES.tooManyInvites));
    },
  });
}

/**
 * `POST /api/auth/accept-invite`, public, so two limits like login's:
 * - 30 attempts per 15 minutes per IP address, of any kind;
 * - 10 FAILED attempts per 15 minutes for one IP address + invite link. Someone who has an invite
 *   link for an existing account can try passwords against it; this caps the guesses. Once the
 *   budget is spent every attempt, even a right one, is refused until the window passes.
 * The IP limit comes first, so a script cannot grow the per-link table faster than that.
 * Returns both limiters in order; mount them after the JSON body parser.
 */
export function acceptInviteRateLimit(): RequestHandler[] {
  const common = { windowMs: LOGIN_WINDOW_MS, standardHeaders: 'draft-7', legacyHeaders: false } as const;
  const handler: RequestHandler = (_req, _res, next) => {
    next(new AppError(429, MESSAGES.tooManyLogins));
  };
  return [
    rateLimit({
      ...common,
      limit: ACCEPT_INVITE_PER_IP,
      keyGenerator: (req) => `accept-ip:${ipKeyGenerator(req.ip ?? 'unknown')}`,
      handler,
    }),
    rateLimit({
      ...common,
      limit: ACCEPT_INVITE_FAILURES,
      skipSuccessfulRequests: true,
      keyGenerator: (req) => {
        const token = (req.body as { token?: unknown } | undefined)?.token;
        const digest = createHash('sha256').update(typeof token === 'string' ? token : '').digest('hex');
        return `accept:${ipKeyGenerator(req.ip ?? 'unknown')}|${digest}`;
      },
      handler,
    }),
  ];
}
