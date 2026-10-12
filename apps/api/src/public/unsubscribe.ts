import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { companyForUnsubscribe, recordEmailOptOut } from '@roofline/db/system';
import type { EmailOptOutSource } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { escapeHtml } from './policy-text.ts';
import { unsubscribeKey } from './unsubscribe-key.ts';
import { type UnsubscribeClaim, verifyUnsubscribeToken } from './unsubscribe-token.ts';

/*
 * Email unsubscribe links, `/u/:token` on the app host (no session, outside /api).
 * GET shows a confirmation page and records nothing: mail scanners prefetch links.
 * POST records the opt-out. A mail provider's one-click post (List-Unsubscribe=One-Click) gets a
 * plain text answer; the page's own form gets an HTML page.
 */

const BODY_LIMIT = '8kb';
const ONE_CLICK_FIELD = 'List-Unsubscribe';
const ONE_CLICK_VALUE = 'One-Click';

const COPY = {
  notFoundTitle: 'Link not valid',
  notFoundText: 'This unsubscribe link is not valid. Reply to the email you received and we will remove you.',
  confirmTitle: 'Unsubscribe',
  confirmText: 'Stop receiving email at this address from',
  confirmButton: 'Unsubscribe',
  doneTitle: 'You are unsubscribed',
  doneText: 'You will not receive more email from',
  oneClickDone: 'Unsubscribed.',
} as const;

const PAGE_STYLE = `
:root { color-scheme: light dark; }
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  box-sizing: border-box;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 16px;
  line-height: 1.5;
  color: #1f2937;
  background: #ffffff;
}
main {
  width: 100%;
  max-width: 28rem;
  box-sizing: border-box;
  padding: 24px;
  border: 1px solid #d1d5db;
  border-radius: 12px;
  background: #ffffff;
}
h1 { margin: 0 0 12px; font-size: 1.25rem; line-height: 1.3; }
p { margin: 0 0 16px; overflow-wrap: anywhere; }
button {
  min-height: 40px;
  padding: 0 16px;
  border: 0;
  border-radius: 8px;
  font: inherit;
  font-weight: 600;
  color: #ffffff;
  background: #1d4ed8;
  cursor: pointer;
}
button:focus-visible { outline: 3px solid #93c5fd; outline-offset: 2px; }
@media (prefers-color-scheme: dark) {
  body { color: #f9fafb; background: #111827; }
  main { background: #1f2937; border-color: #4b5563; }
}
:root[data-theme="dark"] body { color: #f9fafb; background: #111827; }
:root[data-theme="dark"] main { background: #1f2937; border-color: #4b5563; }
`;

function page(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${PAGE_STYLE}</style>`,
    '</head>',
    '<body>',
    `<main>${body}</main>`,
    '</body>',
    '</html>',
  ].join('\n');
}

function notFoundPage(): string {
  return page(COPY.notFoundTitle, `<h1>${escapeHtml(COPY.notFoundTitle)}</h1>\n<p>${escapeHtml(COPY.notFoundText)}</p>`);
}

function confirmPage(token: string, companyName: string): string {
  const body = [
    `<h1>${escapeHtml(COPY.confirmTitle)}</h1>`,
    `<p>${escapeHtml(COPY.confirmText)} ${escapeHtml(companyName)}.</p>`,
    `<form method="post" action="/u/${escapeHtml(token)}">`,
    `<button type="submit">${escapeHtml(COPY.confirmButton)}</button>`,
    '</form>',
  ].join('\n');
  return page(COPY.confirmTitle, body);
}

function donePage(companyName: string): string {
  const body = `<h1>${escapeHtml(COPY.doneTitle)} from ${escapeHtml(companyName)}</h1>\n<p>${escapeHtml(COPY.doneText)} ${escapeHtml(companyName)}.</p>`;
  return page(COPY.doneTitle, body);
}

/** True when the body is a mail provider's one-click post. */
function isOneClick(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as Record<string, unknown>)[ONE_CLICK_FIELD] === ONE_CLICK_VALUE
  );
}

/** The `:token` path segment; empty when the route somehow carries none (never matches a token). */
function tokenOf(req: Request): string {
  const raw: unknown = req.params.token;
  return typeof raw === 'string' ? raw : '';
}

/** The claim and company for a token, or null for a forged or unknown token. */
async function resolveToken(
  deps: AppDeps,
  token: string,
): Promise<{ claim: UnsubscribeClaim; company: { id: string; name: string } } | null> {
  const claim = verifyUnsubscribeToken(unsubscribeKey(deps.config), token);
  if (claim === null) return null;
  const company = await companyForUnsubscribe(deps.pools.system, claim.companyId);
  return company === null ? null : { claim, company };
}

function sendHtml(res: Response, status: number, html: string): void {
  res.status(status).type('html').send(html);
}

export function unsubscribeRoutes(deps: AppDeps): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));
  router.use((_req: Request, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  router.get('/:token', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = tokenOf(req);
      const found = await resolveToken(deps, token);
      if (found === null) {
        sendHtml(res, 404, notFoundPage());
        return;
      }
      sendHtml(res, 200, confirmPage(token, found.company.name));
    } catch (err) {
      next(err);
    }
  });

  router.post('/:token', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const found = await resolveToken(deps, tokenOf(req));
      if (found === null) {
        sendHtml(res, 404, notFoundPage());
        return;
      }
      const oneClick = isOneClick(req.body);
      const source: EmailOptOutSource = oneClick ? 'one_click' : 'link';
      // A repeat adds no row, and the answer is the same either way.
      await recordEmailOptOut(deps.pools.system, {
        companyId: found.claim.companyId,
        email: found.claim.email,
        source,
      });
      if (oneClick) {
        res.status(200).type('text/plain').send(COPY.oneClickDone);
        return;
      }
      sendHtml(res, 200, donePage(found.company.name));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
