import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler, type Request, type Response, Router } from 'express';
import { recordEmailOptOut } from '@roofline/db/system';
import type { AppDeps } from '../app.ts';
import { POSTMARK_HOOK_RATE_LIMIT_PER_MIN, publicPageRateLimit } from '../rate-limit.ts';
import { unsubscribeKey } from '../public/unsubscribe-key.ts';
import { verifyUnsubscribeToken } from '../public/unsubscribe-token.ts';

/*
 * Postmark's bounce and spam-complaint webhook, mounted at /hooks/postmark ahead of the /api session
 * gate. Postmark calls with HTTP basic auth: any user name, and POSTMARK_WEBHOOK_SECRET as the
 * password. Unset, the hook refuses every call.
 * A spam complaint or a hard bounce opts the address out of that company's email. The company and the
 * address come from the unsubscribe token our broadcast adapter puts in `Metadata.unsubscribe`, never
 * from the payload's own address. Anything else, or a token that is not ours, is answered 200 with
 * nothing done, so the reply never says why. Provider text (Description, Details, Message) is never
 * read, stored or echoed.
 */

/** Postmark webhook bodies are small JSON objects. */
export const POSTMARK_BODY_LIMIT = '256kb';

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** True when the Authorization header is Basic auth with our secret as the password (any user name). */
function authorized(req: Request, secret: string | undefined): boolean {
  if (secret === undefined || secret === '') return false;
  const header = req.get('authorization');
  if (header === undefined) return false;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header.trim());
  if (match === null || match[1] === undefined) return false;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return false;
  return timingSafeEqual(sha256(decoded.slice(colon + 1)), sha256(secret));
}

function unauthorized(res: Response): void {
  res.status(401).set('WWW-Authenticate', 'Basic realm="postmark"').end();
}

/** Whether the event is one that opts an address out: a spam complaint or a hard bounce. */
function optsOut(body: Record<string, unknown>): boolean {
  if (body.RecordType === 'SpamComplaint') return true;
  return body.RecordType === 'Bounce' && body.Type === 'HardBounce';
}

export function postmarkHooks(deps: AppDeps): Router {
  const router = Router();

  // Per IP, ahead of the authentication so wrong secrets are limited too.
  router.use(publicPageRateLimit('postmark', POSTMARK_HOOK_RATE_LIMIT_PER_MIN));
  // Authenticate before reading the body.
  router.use((req, res, next) => {
    if (!authorized(req, deps.config.POSTMARK_WEBHOOK_SECRET)) {
      unauthorized(res);
      return;
    }
    next();
  });
  router.use(express.json({ limit: POSTMARK_BODY_LIMIT }));

  router.post('/', async (req: Request, res: Response, next) => {
    try {
      const body: unknown = req.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        res.status(400).end();
        return;
      }
      const event = body as Record<string, unknown>;
      if (optsOut(event)) {
        const metadata = event.Metadata;
        const token =
          typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
            ? (metadata as Record<string, unknown>).unsubscribe
            : undefined;
        const claim = typeof token === 'string' ? verifyUnsubscribeToken(unsubscribeKey(deps.config), token) : null;
        if (claim !== null) {
          await recordEmailOptOut(deps.pools.system, {
            companyId: claim.companyId,
            email: claim.email,
            source: 'complaint',
          });
        }
      }
      res.status(200).end();
    } catch (err) {
      next(err);
    }
  });

  // A body that is not JSON (or is too large) is the sender's mistake: an empty 400, no stack text.
  const bodyErrors: ErrorRequestHandler = (err, _req, res, next) => {
    const status = (err as { status?: unknown } | null)?.status;
    if (status === 413) {
      res.status(413).end();
      return;
    }
    if (status === 429) {
      next(err);
      return;
    }
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(400).end();
      return;
    }
    next(err);
  };
  router.use(bodyErrors);

  return router;
}
