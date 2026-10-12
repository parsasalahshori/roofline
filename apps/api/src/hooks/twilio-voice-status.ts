import express, { Router } from 'express';
import { applyCallStatus, type TenantContext, withTenant } from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { routeVoice, validCallSid } from './twilio-voice-common.ts';
import { field, FORM_BODY_LIMIT } from './twilio.ts';

const TERMINAL = new Set(['completed', 'canceled', 'busy', 'no-answer', 'failed']);

/** POST /hooks/twilio/voice-status: Twilio's call status callback (To is the company's number). Answers 204. */
export function twilioVoiceStatusHooks(deps: AppDeps): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false, limit: FORM_BODY_LIMIT }));

  router.post('/', async (req, res) => {
    const route = await routeVoice(deps, req, res);
    if (!route) return;
    const callSid = validCallSid(req);
    const status = field(req, 'CallStatus');
    if (callSid === null || status === undefined) {
      res.status(400).end();
      return;
    }
    const ctx: TenantContext = { companyId: route.companyId, role: 'system', userId: null, canApproveSpend: false };
    const now = deps.clock.now();
    await withTenant(deps.pools, ctx, (tx) => applyCallStatus(tx, ctx, callSid, status, now));
    if (TERMINAL.has(status)) {
      try {
        await deps.jobs.send('fd-after-call', { companyId: route.companyId, callSid }, { singletonKey: `fd-after-call:${callSid}`, startAfter: 5 });
      } catch {
        // The status is saved; a lost enqueue must not make Twilio retry the callback. Ids only.
        console.error(`fd-after-call enqueue failed company=${route.companyId}`);
      }
    }
    res.status(204).end();
  });

  return router;
}
