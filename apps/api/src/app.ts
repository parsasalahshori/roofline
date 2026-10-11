import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import type { Pools } from '@roofline/db';
import type { Clock } from './clock.ts';
import type { Config } from './config.ts';
import { errorHandler, MESSAGES, notFoundHandler } from './errors.ts';
import type { Mailer } from './mailer.ts';

/**
 * Everything the app reaches outside itself through. Tests pass fakes for all of it.
 * Later tasks add the Google verifier, the step queue and the SMS adapter here.
 */
export type AppDeps = {
  pools: Pools;
  config: Config;
  mailer: Mailer;
  clock: Clock;
};

export type AppOptions = {
  /** Mounts extra routes after the body parser and before the 404. For tests. */
  extraRoutes?: (app: Express) => void;
  /** Called with every unexpected error (the ones answered with a 500). Defaults to console.error. */
  logError?: (err: unknown, path: string) => void;
};

/** JSON bodies are capped at 256 KB. */
export const JSON_BODY_LIMIT = '256kb';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function defaultLogError(err: unknown, path: string): void {
  console.error(`Unhandled error on ${path}:`, err);
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

  // Routers are mounted here as later tasks add them.

  options.extraRoutes?.(app);

  app.use(notFoundHandler);
  app.use(errorHandler(options.logError ?? defaultLogError));
  return app;
}
