import express, { Router } from 'express';
import { applyCallStatus, type TenantContext, withTenant } from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { routeVoice } from './twilio-voice-common.ts';
import { field, FORM_BODY_LIMIT } from './twilio.ts';

/** POST /hooks/twilio/voice-status: Twilio's call status callback (To is the company's number). Answers 204. */
export function twilioVoiceStatusHooks(deps: AppDeps): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false, limit: FORM_BODY_LIMIT }));

  router.post('/', async (req, res) => {
    const route = await routeVoice(deps, req, res);
    if (!route) return;
    const callSid = field(req, 'CallSid');
    const status = field(req, 'CallStatus');
    if (callSid === undefined || callSid === '' || status === undefined) {
      res.status(400).end();
      return;
    }
    const ctx: TenantContext = { companyId: route.companyId, role: 'system', userId: null, canApproveSpend: false };
    const now = deps.clock.now();
    await withTenant(deps.pools, ctx, (tx) => applyCallStatus(tx, ctx, callSid, status, now));
    res.status(204).end();
  });

  return router;
}
