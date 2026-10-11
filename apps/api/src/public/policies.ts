import { companyForPolicyPage } from '@roofline/db/system';
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { AppDeps } from '../app.ts';
import { notFoundHtml, privacyPolicyHtml, termsHtml } from './policy-text.ts';

/** Slugs are lowercase letters, digits and hyphens. Anything else cannot be a company, so no lookup. */
const SLUG = /^[a-z0-9-]+$/;
/** `/policies/<slug>/<page>` on any host. */
const PATH_FORM = /^\/policies\/([^/]+)\/(privacy|terms)$/;

/** The lowercased hostname of a URL (no port), or null when the URL does not parse. */
function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The company slug when the request is for `<slug>.<POLICY_PAGES_DOMAIN>` (port stripped, case
 * folded, exactly one label before the domain). The app host (PUBLIC_BASE_URL / APP_ORIGIN
 * hostname) is never a company host. Null for every other host.
 */
function hostSlug(
  req: Request,
  domain: string | undefined,
  appHosts: ReadonlySet<string>,
): string | null {
  if (!domain) return null;
  const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
  if (appHosts.has(host)) return null;
  const suffix = `.${domain}`;
  if (!host.endsWith(suffix)) return null;
  const prefix = host.slice(0, -suffix.length);
  return prefix !== '' && !prefix.includes('.') ? prefix : null;
}

/**
 * The public policy pages (privacy and terms), served without a session. Company hosts answer
 * `/privacy` and `/terms`; the path form works on any host. Everything else passes through.
 */
export function policyPages(deps: AppDeps): Router {
  const router = Router();
  const domain = deps.config.POLICY_PAGES_DOMAIN;
  const appHosts = new Set(
    [deps.config.PUBLIC_BASE_URL, deps.config.APP_ORIGIN]
      .map(hostnameOf)
      .filter((h): h is string => h !== null),
  );

  function send(res: Response, status: number, html: string): void {
    res.status(status);
    res.set('Content-Type', 'text/html; charset=utf-8');
    if (status === 200) res.set('Cache-Control', 'public, max-age=300');
    res.send(html);
  }

  function sendNotFound(res: Response): void {
    send(res, 404, notFoundHtml());
  }

  async function servePage(
    res: Response,
    next: NextFunction,
    slug: string,
    page: 'privacy' | 'terms',
  ): Promise<void> {
    if (!SLUG.test(slug)) {
      sendNotFound(res);
      return;
    }
    try {
      const company = await companyForPolicyPage(deps.pools.system, slug);
      if (company === null) {
        sendNotFound(res);
        return;
      }
      send(res, 200, page === 'privacy' ? privacyPolicyHtml(company) : termsHtml(company));
    } catch (err) {
      next(err);
    }
  }

  router.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }

    const companyHost = hostSlug(req, domain, appHosts);
    if (companyHost !== null) {
      if (req.path === '/privacy' || req.path === '/terms') {
        void servePage(res, next, companyHost, req.path === '/privacy' ? 'privacy' : 'terms');
      } else {
        sendNotFound(res);
      }
      return;
    }

    const match = PATH_FORM.exec(req.path);
    if (match) {
      const [, rawSlug, page] = match;
      void servePage(res, next, (rawSlug ?? '').toLowerCase(), page === 'privacy' ? 'privacy' : 'terms');
      return;
    }

    next();
  });

  return router;
}
