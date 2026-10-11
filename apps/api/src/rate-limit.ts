import type { RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { Config } from './config.ts';
import { AppError, MESSAGES } from './errors.ts';

/*
 * Rate limiters. The counters live in this process's memory (express-rate-limit's default store),
 * which is right for one API instance; with several instances behind a load balancer each would
 * count on its own and a shared store would be needed.
 */

const MINUTE_MS = 60 * 1000;
const LOGIN_WINDOW_MS = 15 * MINUTE_MS;
const LOGIN_ATTEMPTS = 10;

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
