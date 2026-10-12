import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, MemoryStore, type Options, rateLimit } from 'express-rate-limit';
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
/** Failed logins for one email, from every address together, per hour (a soft lock on the account). */
const LOGIN_FAILURES_PER_EMAIL_PER_HOUR = 20;
/** Failed logins from one address, for every email together, per 15 minutes (password spraying). */
const LOGIN_FAILURES_PER_IP = 30;
/** Failed logins across the whole process per 10 minutes, after which every login is refused for the rest of the window. */
const LOGIN_FAILURES_GLOBAL = 2000;
const LOGIN_GLOBAL_WINDOW_MS = 10 * MINUTE_MS;
const GOOGLE_ATTEMPTS = 20;
const SIGNUP_PER_IP_PER_HOUR = 10;
/** "That email can't be used" answers per IP address per hour (Ruling SEC-1: they reveal an account exists). */
const SIGNUP_TAKEN_PER_IP_PER_HOUR = 3;
/** "Someone tried to sign up with your address" emails per address per hour. */
const SIGNUP_NOTICES_PER_EMAIL_PER_HOUR = 1;
const RESET_REQUEST_PER_IP_PER_HOUR = 20;
const RESET_REQUEST_PER_EMAIL_PER_HOUR = 5;
const RESEND_PER_USER_PER_HOUR = 3;
const INVITES_PER_COMPANY_PER_HOUR = 30;
/** A company made in the last day gets this many invites an hour instead (sign-up companies used to send spam). */
const INVITES_PER_NEW_COMPANY_PER_HOUR = 5;
/** Invites one person may send an hour, across every company they manage. */
const INVITES_PER_USER_PER_HOUR = 30;
/** Invites one IP address may send an hour, across every company and person. */
const INVITES_PER_IP_PER_HOUR = 30;
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

/** Requests a minute one IP address may make under `/api/public`. */
export const PUBLIC_RATE_LIMIT_PER_MIN = 60;

/**
 * `/api/public/*`: 60 requests a minute per IP address, never per session (the callers are signed
 * out customers). Mount it on `/api/public` ahead of the public routers.
 */
export function publicRateLimit(): RequestHandler {
  return rateLimit({
    windowMs: MINUTE_MS,
    limit: PUBLIC_RATE_LIMIT_PER_MIN,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`,
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

/** The login limits. Tests pass smaller numbers to `loginRateLimit`; the app uses these. */
export type LoginLimits = {
  /** Failed attempts per IP address + email, per 15 minutes. */
  perIpAndEmail: number;
  /** Failed attempts per email, from any address, per hour. */
  perEmail: number;
  /** Failed attempts per IP address, for any email, per 15 minutes. */
  perIp: number;
  /** Failed attempts in this process, per 10 minutes. */
  global: number;
};

export const LOGIN_LIMITS: LoginLimits = {
  perIpAndEmail: LOGIN_ATTEMPTS,
  perEmail: LOGIN_FAILURES_PER_EMAIL_PER_HOUR,
  perIp: LOGIN_FAILURES_PER_IP,
  global: LOGIN_FAILURES_GLOBAL,
};

/** A login failed when it was answered 401: a wrong password, an unknown email, or an account with no password. */
const loginFailed = (_req: unknown, res: { statusCode: number }): boolean => res.statusCode === 401;

/**
 * `POST /api/auth/login`, four limits, all answered with the same "too many sign-in attempts" 429
 * (whether or not the email has an account), in this order:
 * 1. 30 failed attempts per 15 minutes from one IP address, across every email (password spraying).
 * 2. 10 failed attempts per 15 minutes for one IP address + email.
 * 3. 20 failed attempts an hour for one email, from every address together: a soft lock on the
 *    account against guessing spread over many addresses. The key is the typed email, so an email
 *    with no account is locked the same way and the answer reveals nothing.
 * 4. 2000 failed attempts per 10 minutes across the whole process, a ceiling on the password
 *    checks a botnet can make us run.
 * Limits 1, 3 and 4 count only failures (401: a wrong password or an unknown email); limit 2 counts
 * every attempt that does not end in a sign-in. Sign-ins are never counted, so nobody is limited
 * by signing in on several devices; but once a budget is spent every attempt it covers, even
 * with the right password, is refused until the window passes, so the budget cannot be used to
 * test guesses. Returns the limiters in order; mount them after the JSON body parser.
 */
export function loginRateLimit(limits: LoginLimits = LOGIN_LIMITS): RequestHandler[] {
  const handler: RequestHandler = (_req, _res, next) => {
    next(new AppError(429, MESSAGES.tooManyLogins));
  };
  // The new limits send no RateLimit headers: the per-email and process-wide counts are nobody's business.
  const failuresOnly = {
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req: unknown, res: { statusCode: number }) => !loginFailed(req, res),
    standardHeaders: false,
    legacyHeaders: false,
    handler,
  } as const;
  return [
    rateLimit({
      ...failuresOnly,
      windowMs: LOGIN_WINDOW_MS,
      limit: limits.perIp,
      keyGenerator: (req) => `login-ip:${ipKeyGenerator(req.ip ?? 'unknown')}`,
    }),
    rateLimit({
      windowMs: LOGIN_WINDOW_MS,
      limit: limits.perIpAndEmail,
      skipSuccessfulRequests: true,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? 'unknown')}|${loginEmail(req.body)}`,
      handler,
    }),
    rateLimit({
      ...failuresOnly,
      windowMs: HOUR_MS,
      limit: limits.perEmail,
      // Only an email of a possible length gets a bucket; anything else is refused as invalid (400).
      skip: (req) => {
        const email = loginEmail(req.body);
        return email === '' || email.length > MAX_EMAIL_LENGTH;
      },
      keyGenerator: (req) => `login-email:${loginEmail(req.body)}`,
    }),
    rateLimit({
      ...failuresOnly,
      windowMs: LOGIN_GLOBAL_WINDOW_MS,
      limit: limits.global,
      keyGenerator: () => 'login-global',
    }),
  ];
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

/**
 * `POST /api/auth/signup`, after `signupRateLimit`: at most 3 answers an hour per IP address that
 * say the email cannot be used (the 409 for an email that already has an account). Only those
 * answers count, recorded when they are sent; once they are spent, every sign-up from the
 * address gets the ordinary "too many sign-ups" 429 until the window passes, so whether an
 * address has an account can be asked only a few times an hour. Mount it after the JSON body parser.
 */
export function signupTakenRateLimit(): RequestHandler {
  // Checked before the request and recorded only once it was answered 409, so sign-ups in flight at
  // the same moment (which may all succeed) never use up the budget.
  const store = new MemoryStore();
  // MemoryStore reads only windowMs from the options.
  store.init({ windowMs: HOUR_MS } as Options);
  return async (req, res, next) => {
    const key = `signup-taken:${ipKeyGenerator(req.ip ?? 'unknown')}`;
    if (((await store.get(key))?.totalHits ?? 0) >= SIGNUP_TAKEN_PER_IP_PER_HOUR) {
      next(new AppError(429, MESSAGES.tooManySignups));
      return;
    }
    res.once('finish', () => {
      if (res.statusCode === 409) void store.increment(key);
    });
    next();
  };
}

/**
 * A counter outside the request chain, in the same in-process store the limiters use: the
 * returned function answers true for the first `limit` calls with one key in each window of
 * `windowMs`, and false after that. For things a route does on the side, like a warning email.
 */
export function createAllowance(windowMs: number, limit: number): (key: string) => Promise<boolean> {
  const store = new MemoryStore();
  // MemoryStore reads only windowMs from the options.
  store.init({ windowMs } as Options);
  return async (key) => (await store.increment(key)).totalHits <= limit;
}

/**
 * The "someone tried to sign up with your address" email: at most 1 an hour per address
 * (lowercased), so failed sign-ups cannot be used to flood someone's inbox. True: send it.
 */
export function signupNoticeAllowance(): (email: string) => Promise<boolean> {
  return createAllowance(HOUR_MS, SIGNUP_NOTICES_PER_EMAIL_PER_HOUR);
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
 * `POST /api/team/invites`, three limits on invites SENT (refused requests, such as bad input, a
 * person already on the team, or a request over a limit, are not counted). In order:
 * 1. 30 an hour per IP address, across every company and person, so one machine cannot sign up a
 *    string of companies and invite from each.
 * 2. 30 an hour per person, across every company they can invite for.
 * 3. Per company, shared by everyone who can invite, so an owner cannot be used to flood addresses
 *    with email: 30 an hour, or 5 an hour while the company is less than a day old (a fresh sign-up
 *    is the cheap way to get an inviting owner). `isNewCompany` says which, for the request's company.
 * Mount them after the sign-in gate and the permission checks (so people who may not invite cannot
 * use up the budgets). Returns the limiters in order.
 */
export function inviteRateLimit(isNewCompany: (req: Request) => Promise<boolean>): RequestHandler[] {
  const common = { windowMs: HOUR_MS, skipFailedRequests: true, standardHeaders: 'draft-7', legacyHeaders: false } as const;
  const handler: RequestHandler = (_req, _res, next) => {
    next(new AppError(429, MESSAGES.tooManyInvites));
  };
  const ipKey = (req: Request) => `invite-ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
  return [
    rateLimit({ ...common, limit: INVITES_PER_IP_PER_HOUR, keyGenerator: ipKey, handler }),
    rateLimit({
      ...common,
      limit: INVITES_PER_USER_PER_HOUR,
      keyGenerator: (req) => {
        const session = req.session as SessionInfo | undefined;
        return session ? `invite-user:${session.userId}` : ipKey(req);
      },
      handler,
    }),
    rateLimit({
      ...common,
      limit: async (req) => {
        const session = req.session as SessionInfo | undefined;
        if (!session) return INVITES_PER_NEW_COMPANY_PER_HOUR;
        return (await isNewCompany(req)) ? INVITES_PER_NEW_COMPANY_PER_HOUR : INVITES_PER_COMPANY_PER_HOUR;
      },
      keyGenerator: (req) => {
        const session = req.session as SessionInfo | undefined;
        return session ? `invite:${session.companyId}` : ipKey(req);
      },
      handler,
    }),
  ];
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
