import type { RequestHandler } from 'express';
import { getQuoteSettings, withTenant } from '@roofline/db';
import { companyForQuoteSlug } from '@roofline/db/system';
import { QUOTE_SLUG_RE } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { turnstileOn } from '../quote/guards.ts';

/*
 * The instant quote page itself, GET /q/:slug (the web app's own index.html, served by web.ts after this). The app's
 * Content-Security-Policy says frame-ancestors 'none'; this page may be framed by the company's own sites, so for
 * a known, turned-on slug the policy is rewritten to `frame-ancestors 'self' <the company's embed origins>` and
 * X-Frame-Options is dropped (frame-ancestors replaces it). With Turnstile set up, its script and frame host is
 * allowed too. An unknown slug keeps the strict headers. Never cached; not indexed.
 */

const PAGE = /^\/q\/([^/]+)\/?$/i;
const TURNSTILE_HOST = 'https://challenges.cloudflare.com';

function addSource(policy: string, directive: string, source: string): string {
  const re = new RegExp(`(^|;)\\s*${directive}\\s+([^;]*)`);
  if (re.test(policy)) return policy.replace(re, (_m, lead: string, sources: string) => `${lead}${directive} ${sources.trim()} ${source}`);
  return `${policy};${directive} ${source}`;
}

export function quotePage(deps: AppDeps): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const slug = PAGE.exec(req.path)?.[1]?.toLowerCase();
    if (slug === undefined) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    if (!QUOTE_SLUG_RE.test(slug)) {
      next();
      return;
    }
    void (async () => {
      const company = await companyForQuoteSlug(deps.pools.system, slug);
      if (company === null) return;
      const ctx = { companyId: company.companyId, userId: null, role: 'system' as const, canApproveSpend: false };
      const settings = await withTenant(deps.pools, ctx, (tx) => getQuoteSettings(tx, ctx));
      if (!settings.enabled) return;
      const current = res.getHeader('Content-Security-Policy');
      if (typeof current !== 'string') return;
      let policy = current.replace(/frame-ancestors [^;]*/, ['frame-ancestors', "'self'", ...settings.embedOrigins].join(' '));
      if (turnstileOn(deps.config)) {
        policy = addSource(policy, 'script-src', TURNSTILE_HOST);
        policy = addSource(policy, 'frame-src', TURNSTILE_HOST);
        policy = addSource(policy, 'connect-src', TURNSTILE_HOST);
      }
      res.setHeader('Content-Security-Policy', policy);
      res.removeHeader('X-Frame-Options');
    })().then(() => next(), next);
  };
}
