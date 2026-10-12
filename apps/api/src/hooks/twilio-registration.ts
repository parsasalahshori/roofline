import type { IncomingMessage } from 'node:http';
import express, { Router } from 'express';
import twilio from 'twilio';
import { companyIdForTextingSid, signingTokenFor } from '@roofline/db/system';
import { logErrorToConsole } from '../errors.ts';
import type { AppDeps } from '../app.ts';

/*
 * Twilio's registration callbacks (`/hooks/twilio-registration`), mounted ahead of the JSON parser,
 * so this router parses its own form or JSON bodies. A callback names the registration by a sid
 * (a brand, campaign, subaccount, ...) in its fields. It only wakes the registration: the job
 * `texting-registration` reads Twilio's status itself, so the statuses in the body are never used.
 *
 * 0. a request with no `X-Twilio-Signature` header is refused (403, empty body) before any lookup;
 * 1. routed: the string values at the top level of the body, and one level down, that are Twilio
 *    sids (AC, BU, BN, QE or MG and 32 lowercase hex digits) are tried in body order, at most
 *    MAX_SIDS_TRIED of them (a genuine callback names its sids first: the account, then the
 *    resource), so an unsigned body full of sids costs at most that many lookups. The first one a
 *    company owns names the company. None: 404, empty body;
 * 2. authenticated: `X-Twilio-Signature` must match Twilio's signature of PUBLIC_BASE_URL + the path
 *    and the body, made with that company's token (else TWILIO_AUTH_TOKEN). Else 403, empty body;
 * 3. then the job is queued (one per company, by singletonKey) and the answer is 200, empty body.
 */

/** A Twilio sid of a texting resource: AC, BU, BN, QE or MG and 32 lowercase hex digits. */
const TEXTING_SID = /^(AC|BU|BN|QE|MG)[0-9a-f]{32}$/;

/** How many distinct sids of a body are looked up at most, in body order. */
export const MAX_SIDS_TRIED = 3;

/** The request with the body as Twilio sent it, kept as text so a JSON body can be signature-checked. */
type RawBodyRequest = IncomingMessage & { rawBody?: string };

/** The string values of the body: the top-level ones, and those one level down (in objects and arrays). */
function stringsInBody(body: unknown): string[] {
  if (body === null || typeof body !== 'object') return [];
  const found: string[] = [];
  for (const value of Object.values(body)) {
    const items: unknown[] = typeof value === 'object' && value !== null ? Object.values(value) : [value];
    for (const item of items) {
      if (typeof item === 'string') found.push(item);
    }
  }
  return found;
}

/** The first MAX_SIDS_TRIED distinct texting sids in the body, in the order they appear. */
function textingSidsIn(body: unknown): string[] {
  return [...new Set(stringsInBody(body).filter((s) => TEXTING_SID.test(s)))].slice(0, MAX_SIDS_TRIED);
}

export function twilioRegistrationHooks(deps: AppDeps): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false, limit: '64kb' }));
  router.use(
    express.json({
      limit: '64kb',
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf.toString('utf8');
      },
    }),
  );

  router.post('/', async (req, res) => {
    try {
      const { system } = deps.pools;
      const body: unknown = req.body ?? {};
      // The cheap check first: without a signature nothing can pass, so nothing is looked up.
      const signature = req.get('X-Twilio-Signature');
      if (signature === undefined || signature === '') {
        res.status(403).end();
        return;
      }
      let companyId: string | null = null;
      for (const sid of textingSidsIn(body)) {
        companyId = await companyIdForTextingSid(system, sid);
        if (companyId !== null) break;
      }
      if (companyId === null) {
        res.status(404).end();
        return;
      }

      const token = await signingTokenFor(system, companyId, deps.config.TWILIO_AUTH_TOKEN, deps.config.ENCRYPTION_KEY);
      const url = deps.config.PUBLIC_BASE_URL + req.originalUrl;
      const valid =
        token !== null &&
        (req.is('application/json')
          ? twilio.validateRequestWithBody(token, signature, url, (req as RawBodyRequest).rawBody ?? '')
          : twilio.validateRequest(token, signature, url, body as Record<string, string>));
      if (!valid) {
        res.status(403).end();
        return;
      }

      await deps.jobs.send('texting-registration', { companyId }, { singletonKey: companyId });
      res.status(200).end();
    } catch (err) {
      (deps.logError ?? logErrorToConsole)(err, 'hooks/twilio-registration');
      res.status(500).end();
    }
  });

  return router;
}
