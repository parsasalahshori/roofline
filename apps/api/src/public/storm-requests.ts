import express, { Router, type ErrorRequestHandler, type RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { STORM_PAGE_CODE_RE } from '@roofline/db';
import { stormPageForCode } from '@roofline/db/system';
import type { AppDeps } from '../app.ts';
import type { Config } from '../config.ts';
import { publicRateLimit } from '../rate-limit.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { stormFormErrorKey, submitStormRequest } from '../storm/landing.ts';
import { STORM_REQUEST_LIMITS } from '../storm/landing-copy.ts';

/*
 * POST /api/public/storm-requests/:code: the storm landing page's form (S1 Task 20). The company's
 * page is on its own host, so the browser's Origin is that host, not the app's; the router is
 * mounted in app.ts ahead of blockCrossSiteMutations and checks its own Origin here. The router also
 * owns the public rate limit and the body parsers, so its error handler sees their errors too.
 * Plain HTML forms post urlencoded and get a 303 redirect to the thank-you page; scripts post JSON
 * and get `{ ok: true }`. A failed urlencoded form gets a 303 back to the page: with `?error=<key>`
 * on a 422, 429 or 503 (the key names the sentence the page shows), and to the page itself on a 404,
 * where the page shows its not-found text. A body the parsers refuse (too large, unreadable) goes back
 * with `?error=invalid`. JSON posts keep their `{ error, field? }` body.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const HOUR_MS = 60 * 60 * 1000;
const BODY_LIMIT = '8kb';
const CODE = STORM_PAGE_CODE_RE;

/**
 * The origin a company's landing page is served from: `<protocol>//<slug>.<POLICY_PAGES_DOMAIN>`,
 * with the port of PUBLIC_BASE_URL when it has one. Null when no policy pages domain is set, since
 * then no company host exists and no page can be posted to from one.
 */
export function companyOriginFor(config: Pick<Config, 'PUBLIC_BASE_URL' | 'POLICY_PAGES_DOMAIN'>, slug: string): string | null {
  const domain = config.POLICY_PAGES_DOMAIN;
  if (!domain) return null;
  const base = new URL(config.PUBLIC_BASE_URL);
  return `${base.protocol}//${slug}.${domain}${base.port ? `:${base.port}` : ''}`;
}

/** The origin the company page for `path` (`/<code>`, relative to the mount) must come from, or null. */
async function expectedOriginFor(deps: AppDeps, path: string): Promise<string | null> {
  const code = /^\/([^/]+?)\/?$/.exec(path)?.[1]?.toLowerCase();
  if (code === undefined || !CODE.test(code)) return null;
  const page = await stormPageForCode(deps.pools.system, code);
  return page === null ? null : companyOriginFor(deps.config, page.company.slug);
}

/**
 * Refuses a browser POST whose Origin is not the company host of the page it posts to. A request
 * with no Origin (a script, or a server) is not a cross-site browser request and passes; the
 * honeypot and the form checks happen in the handler.
 */
export function stormRequestOriginGuard(deps: AppDeps): RequestHandler {
  return (req, res, next) => {
    const origin = req.get('Origin');
    if (origin === undefined || SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    void expectedOriginFor(deps, req.path).then((expected) => {
      if (expected !== null && origin === expected) {
        next();
        return;
      }
      res.status(403).json({ error: MESSAGES.crossSite });
    }, next);
  };
}

/** Requests an hour one IP address may make to the storm form, however many pages it names. */
function perIpLimit(): RequestHandler {
  return rateLimit({
    windowMs: HOUR_MS,
    limit: STORM_REQUEST_LIMITS.perIpPerHour,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`,
    handler: (_req, _res, next) => {
      next(new AppError(429, MESSAGES.tooFast));
    },
  });
}

/** An error from a body parser (body-parser sets a string `type` and a 4xx `status` on its errors). */
function isBodyParserError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { status, type } = err as { status?: unknown; type?: unknown };
  return typeof type === 'string' && typeof status === 'number' && status >= 400 && status < 500;
}

export function stormRequestRoutes(deps: AppDeps): Router {
  const router = Router();

  // Inside the router (not ahead of it in app.ts), so a no-JS visitor who trips the public limit
  // gets the same redirect as any other form error instead of a JSON 429.
  router.use(publicRateLimit());
  router.use(stormRequestOriginGuard(deps));

  router.post(
    '/:code',
    perIpLimit(),
    express.json({ limit: BODY_LIMIT }),
    express.urlencoded({ extended: false, limit: BODY_LIMIT }),
    async (req, res, next) => {
      try {
        const code = String(req.params.code).toLowerCase();
        if (!CODE.test(code)) throw new AppError(404, MESSAGES.notFound);
        await submitStormRequest(deps, {
          code,
          body: req.body,
          ip: req.ip ?? 'unknown',
          now: deps.clock.now(),
          findPage: (c) => stormPageForCode(deps.pools.system, c),
        });
        if (req.is('urlencoded')) {
          res.redirect(303, `/storm/${code}/thanks`);
          return;
        }
        res.status(201).json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  // Router-level, so it also sees the 429s from both limiters and the body parsers' errors.
  const browserFormErrors: ErrorRequestHandler = (err, req, res, next) => {
    const code = /^\/([^/]+?)\/?$/.exec(req.path)?.[1]?.toLowerCase();
    if (!req.is('urlencoded') || code === undefined || !CODE.test(code)) {
      next(err);
      return;
    }
    if (isBodyParserError(err)) {
      res.redirect(303, `/storm/${code}?error=invalid`);
      return;
    }
    if (!(err instanceof AppError)) {
      next(err);
      return;
    }
    if (err.status === 404) {
      res.redirect(303, `/storm/${code}`);
      return;
    }
    if (err.status === 422 || err.status === 429 || err.status === 503) {
      res.redirect(303, `/storm/${code}?error=${encodeURIComponent(stormFormErrorKey(err.message))}`);
      return;
    }
    next(err);
  };
  router.use(browserFormErrors);

  return router;
}
