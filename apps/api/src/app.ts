import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import type { Pools } from '@roofline/db';
import type { Clock } from './clock.ts';
import type { Config } from './config.ts';
import type { GoogleVerifier } from './auth/google.ts';
import { attachSession, requireSession } from './auth/middleware.ts';
import { authRoutes } from './auth/routes.ts';
import { describeErrorForLog, errorHandler, MESSAGES, notFoundHandler } from './errors.ts';
import type { Mailer } from './mailer.ts';
import { apiRateLimit } from './rate-limit.ts';
import { companyRoutes } from './routes/company.ts';
import { teamRoutes } from './routes/team.ts';

/**
 * Everything the app reaches outside itself through. Tests pass fakes for all of it.
 * Later tasks add the step queue and the SMS adapter here.
 */
export type AppDeps = {
  pools: Pools;
  config: Config;
  mailer: Mailer;
  clock: Clock;
  /** Checks the credential Google's sign-in button produces. Tests pass a fake that maps strings to claims. */
  google: GoogleVerifier;
  /**
   * Called with the promise of every piece of work the app starts after it has already answered
   * (the emails behind reset-request, for example). The promise never rejects: failures are logged.
   * The server leaves this unset; tests collect the promises and await them instead of sleeping.
   */
  onBackgroundTask?: (task: Promise<void>) => void;
};

export type AppOptions = {
  /**
   * Mounts extra routes after the body parser and before the /api sign-in gate and the 404. For
   * tests: routes mounted here need no session and are not rate limited.
   */
  extraRoutes?: (app: Express) => void;
  /**
   * Called with every unexpected error (the ones answered with a 500). Defaults to console.error
   * of `describeErrorForLog`, which never prints SQL parameters.
   */
  logError?: (err: unknown, path: string) => void;
};

/** JSON bodies are capped at 256 KB. */
export const JSON_BODY_LIMIT = '256kb';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function defaultLogError(err: unknown, path: string): void {
  console.error(`Unhandled error on ${path}: ${describeErrorForLog(err)}`);
}

/**
 * A browser that sends an Origin header on a mutation is telling us which site the request came
 * from. Anything other than the web app's own origin is refused. Requests with no Origin (scripts,
 * Twilio's webhooks) are not browser cross-site requests and pass; the session cookie is
 * SameSite=Lax as well.
 */
function blockCrossSiteMutations(appOrigin: string): RequestHandler {
  return (req, res, next) => {
    const origin = req.get('Origin');
    if (origin !== undefined && !SAFE_METHODS.has(req.method) && origin !== appOrigin) {
      res.status(403).json({ error: MESSAGES.crossSite });
      return;
    }
    next();
  };
}

export function createApp(deps: AppDeps, options: AppOptions = {}): Express {
  const { config } = deps;
  const app = express();

  app.set('trust proxy', config.TRUST_PROXY);
  app.use(helmet());

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(blockCrossSiteMutations(config.APP_ORIGIN));
  // JSON only. `express.urlencoded` is deliberately not mounted here: Twilio's webhooks are the
  // one form-encoded caller, and /hooks/twilio/* adds it for itself.
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  options.extraRoutes?.(app);

  // Everything under /api: find the session, rate limit (per session, else per IP), then refuse
  // anyone who is not signed in. The public auth routes are the only exceptions (middleware.ts).
  // /health and /hooks/* are not under /api, so they are never limited.
  const logError = options.logError ?? defaultLogError;
  app.use('/api', attachSession(deps), apiRateLimit(config), requireSession);

  // Routers are mounted here as later tasks add them.
  app.use('/api/auth', authRoutes(deps, logError));
  app.use('/api/company', companyRoutes(deps));
  app.use('/api/team', teamRoutes(deps, logError));

  app.use(notFoundHandler);
  app.use(errorHandler(logError));
  return app;
}
