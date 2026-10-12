import type { RequestHandler } from 'express';
import type { TenantContext } from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { readSessionToken, resolveSessionDetailed, type SessionInfo, setSessionCookie } from './sessions.ts';

declare global {
  // Express documents this namespace as the place to add request properties.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Who is making the request. Set by the sign-in gate on every /api route that is not a public
       * auth route, so a handler behind it can rely on it. Handlers of public routes must not read it.
       */
      ctx: TenantContext;
      /** The signed-in session. Same rule as `ctx`. */
      session: SessionInfo;
    }
    interface Locals {
      /** sha256 of the session token, when the request carried a live session. The rate limiter keys on it. */
      sessionKey?: string;
    }
  }
}

/** Auth routes that work without a session. Method and path (relative to /api), lowercase. */
const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  ...[
    'signup',
    'login',
    'verify-email',
    'reset-request',
    'reset',
    // Added by the tasks that build them; listed now so the sign-in gate never needs to change.
    'google',
    'accept-invite',
  ].map((name) => `POST /auth/${name}`),
  // The sign-in page's public settings (the Google client id). Nothing about the caller is needed.
  'GET /auth/config',
]);

/**
 * Whether a request needs no session. `path` is relative to /api and is Express's `req.path`, which
 * is not percent-decoded, so `/%70ublic/x` is not public. Public when the method and path are one
 * of PUBLIC_ROUTES, or when the lowercased path starts with `/public/` (any method): the customer
 * pages for proposals live there. `/public` and `/publicx` are not public.
 */
export function isPublicRoute(method: string, path: string): boolean {
  const lower = path.toLowerCase();
  return lower.startsWith('/public/') || PUBLIC_ROUTES.has(`${method} ${lower.replace(/\/+$/, '')}`);
}

/** The TenantContext every repository takes, for the member behind a session. */
export function tenantContextOf(session: SessionInfo): TenantContext {
  return {
    companyId: session.companyId,
    userId: session.userId,
    role: session.role,
    canApproveSpend: session.canApproveSpend,
  };
}

/**
 * First half of the sign-in gate. Reads the session cookie (named by `sessionCookieName`), and when
 * it names a live session with an active membership, sets `req.session` and `req.ctx`, slides the
 * expiry (refreshing the cookie when it moved), and records the token hash for the rate limiter.
 * A missing or dead cookie is not an error here: `requireSession` decides what that means for the route.
 * It is a separate step so the per-session rate limiter can run between the two: requests with
 * cookies that name no live session fall into the shared per-IP bucket, and inventing cookie
 * values buys no extra budget.
 */
export function attachSession(deps: AppDeps): RequestHandler {
  return async (req, res, next) => {
    const token = readSessionToken(req, deps.config);
    if (token === undefined) {
      next();
      return;
    }
    const resolved = await resolveSessionDetailed(deps.pools.system, token, deps.clock.now());
    if (resolved) {
      req.session = resolved.session;
      req.ctx = tenantContextOf(resolved.session);
      res.locals.sessionKey = resolved.tokenHash;
      if (resolved.renewed) setSessionCookie(res, token, deps.config);
    }
    next();
  };
}

/**
 * Second half of the gate: no live session means 401 "Please sign in.", except on the public auth
 * routes (sign-up, login, email verification, password reset and, later, Google sign-in and invite
 * acceptance). Mounted once on /api, so every route added later is behind it by default.
 */
export const requireSession: RequestHandler = (req, _res, next) => {
  if ((req.session as SessionInfo | undefined) !== undefined || isPublicRoute(req.method, req.path)) {
    next();
    return;
  }
  next(new AppError(401, MESSAGES.signIn));
};

/**
 * For routes that need a confirmed email address (inviting teammates, in Task 9). Mount it after
 * the sign-in gate. An unconfirmed address → 403 "Please confirm your email first. We sent you a
 * link." The check reads `req.session.emailVerified`, which the gate refreshes from the database
 * on every request, so confirming the email lifts the block on the very next request.
 */
export const requireVerifiedEmail: RequestHandler = (req, _res, next) => {
  const session = req.session as SessionInfo | undefined;
  if (!session) {
    // Behind the gate this cannot happen; if a route is ever mounted without it, say what is true.
    next(new AppError(401, MESSAGES.signIn));
    return;
  }
  next(session.emailVerified ? undefined : new AppError(403, MESSAGES.verifyEmailFirst));
};
