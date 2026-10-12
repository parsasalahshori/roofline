import { stormPageForCode } from '@roofline/db/system';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { AppDeps } from '../app.ts';
import { stormFormErrorMessage } from '../storm/landing.ts';
import { stormPageHtml, stormPageNotFoundHtml } from './storm-page-html.ts';

/** An 8-character base32 code (a-z, 2-7), in any letter case. Anything else cannot be a page. */
const CODE = /^[a-z2-7]{8}$/i;
/** `/storm/<code>` and `/storm/<code>/thanks`. */
const PATH = /^\/storm\/([^/]+)(\/thanks)?$/;

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
 * hostname) is never a company host. Null for every other host. Same rule as policies.ts.
 */
function hostSlug(req: Request, domain: string | undefined, appHosts: ReadonlySet<string>): string | null {
  if (!domain) return null;
  const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
  if (appHosts.has(host)) return null;
  const suffix = `.${domain}`;
  if (!host.endsWith(suffix)) return null;
  const prefix = host.slice(0, -suffix.length);
  return prefix !== '' && !prefix.includes('.') ? prefix : null;
}

/**
 * The storm landing page, `GET /storm/:code` and `GET /storm/:code/thanks`, on a company host only.
 * Every other request (any other host, any method but GET and HEAD, any other path) passes on, so
 * the web app's own /storm routes still load on the app host.
 */
export function stormPage(deps: AppDeps): Router {
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
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    // helmet's default no-referrer makes a browser send `Origin: null` on the form's POST, which the Origin
    // guard in storm-requests.ts refuses. same-origin keeps the Origin and sends nothing off the site.
    res.set('Referrer-Policy', 'same-origin');
    res.send(html);
  }

  /** Answers one page request. Every 404 is the same generic page; nothing says whose page it was. */
  async function serve(res: Response, slug: string, code: string, thanks: boolean, error: string | undefined): Promise<void> {
    if (!CODE.test(code)) {
      send(res, 404, stormPageNotFoundHtml());
      return;
    }
    const page = await stormPageForCode(deps.pools.system, code.toLowerCase());
    if (
      page === null ||
      page.company.slug !== slug ||
      deps.clock.now().getTime() >= page.activeUntil.getTime()
    ) {
      send(res, 404, stormPageNotFoundHtml());
      return;
    }
    send(
      res,
      200,
      stormPageHtml({
        companyName: page.company.name,
        phoneE164: page.company.phoneE164,
        code: page.code,
        thanks,
        ...(error !== undefined ? { error } : {}),
      }),
    );
  }

  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const slug = hostSlug(req, domain, appHosts);
    if (slug === null) {
      next();
      return;
    }
    const match = PATH.exec(req.path);
    if (match === null) {
      next();
      return;
    }
    const code = match[1] ?? '';
    const thanks = match[2] !== undefined;
    const error = thanks ? undefined : stormFormErrorMessage(req.query.error);
    serve(res, slug, code, thanks, error).catch(next);
  });

  return router;
}
