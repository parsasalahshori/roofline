import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getQuoteSettings, type TenantContext, withTenant } from '@roofline/db';
import { companyForQuoteSlug } from '@roofline/db/system';
import { type InstantQuoteSettings, QUOTE_SLUG_RE } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';

/*
 * What the company's public quote endpoints share: the instant quote page's API (quote.ts, /api/public/quote/:slug)
 * and the homeowner phone app's (homeowner.ts, /api/public/homeowner/:slug). The slug is the only key: it is resolved
 * through the system pool (app_system may read just the slug columns of company_settings), then everything runs
 * inside withTenant for that one company with a 'system' context.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A honeypot counts as filled when a bot has put anything in it. */
export function isFilled(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  return value !== undefined && value !== null && value !== false;
}

/** The body as an object, for the honeypot check that runs before the schema. */
export const raw = (req: Request): Record<string, unknown> =>
  typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};

export const systemCtx = (companyId: string): TenantContext => ({ companyId, userId: null, role: 'system', canApproveSpend: false });

export type Page = { ctx: TenantContext; settings: InstantQuoteSettings };

/**
 * The page for `:slug`, or a 404 for an unknown or malformed one; a turned-off one too, unless `allowOff` (a homeowner
 * who already has a request may keep looking at it after the company turned the page off). All look the same.
 */
export async function pageFor(deps: AppDeps, slugParam: unknown, options: { allowOff?: boolean } = {}): Promise<Page> {
  const slug = (typeof slugParam === 'string' ? slugParam : '').toLowerCase();
  if (!QUOTE_SLUG_RE.test(slug)) throw new AppError(404, MESSAGES.notFound);
  const company = await companyForQuoteSlug(deps.pools.system, slug, { includeOff: options.allowOff === true });
  if (company === null) throw new AppError(404, MESSAGES.notFound);
  const ctx = systemCtx(company.companyId);
  const settings = await withTenant(deps.pools, ctx, (tx) => getQuoteSettings(tx, ctx));
  if (!settings.enabled && options.allowOff !== true) throw new AppError(404, MESSAGES.notFound);
  return { ctx, settings };
}

/** The slug in a request path relative to the mount (`/<slug>` or `/<slug>/...`). */
const slugOfPath = (path: string): string | undefined => /^\/([^/]+)/.exec(path)?.[1]?.toLowerCase();

/** The origins a browser may call this page's API from: the app itself and the company's embed origins. */
async function allowedOrigins(deps: AppDeps, path: string): Promise<Set<string>> {
  const allowed = new Set([deps.config.APP_ORIGIN]);
  const slug = slugOfPath(path);
  if (slug === undefined || !QUOTE_SLUG_RE.test(slug)) return allowed;
  const company = await companyForQuoteSlug(deps.pools.system, slug);
  if (company === null) return allowed;
  const ctx = systemCtx(company.companyId);
  const settings = await withTenant(deps.pools, ctx, (tx) => getQuoteSettings(tx, ctx));
  for (const o of settings.embedOrigins) allowed.add(o);
  return allowed;
}

export type OriginGuardOptions = {
  /** Access-Control-Allow-Methods. */
  methods?: string;
  /** Access-Control-Allow-Headers. */
  headers?: string;
};

/**
 * CORS and the Origin check together. A browser request from an allowed origin gets the CORS headers (no
 * credentials: the page never uses cookies); a mutation from any other origin is refused. A request with no Origin
 * (a script, a server, a phone app) is not a cross-site browser request and passes to the limits and the bot checks.
 */
export function originGuard(deps: AppDeps, options: OriginGuardOptions = {}): RequestHandler {
  const methods = options.methods ?? 'GET, POST';
  const headers = options.headers ?? 'Content-Type, Accept';
  return (req, res, next) => {
    const origin = req.get('Origin');
    if (origin === undefined) {
      next();
      return;
    }
    allowedOrigins(deps, req.path).then((allowed) => {
      res.vary('Origin');
      if (allowed.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        if (req.method === 'OPTIONS') {
          res.setHeader('Access-Control-Allow-Methods', methods);
          res.setHeader('Access-Control-Allow-Headers', headers);
          res.setHeader('Access-Control-Max-Age', '600');
          res.status(204).end();
          return;
        }
        next();
        return;
      }
      if (SAFE_METHODS.has(req.method) && req.method !== 'OPTIONS') {
        next(); // a cross-site GET gets no CORS header, so the browser keeps the answer from the page
        return;
      }
      res.status(403).json({ error: MESSAGES.crossSite });
    }, next);
  };
}

/** An async route handler whose rejection goes to the error handler (Express 5 does this itself; the routers here are explicit). */
export const route = (fn: (req: Request, res: Response) => Promise<void>): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
};
