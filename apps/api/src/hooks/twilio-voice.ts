import express, { Router } from 'express';
import { countLiveAiCalls, insertCall, isAgentPaused, screeningFacts, type TenantContext, updateCall, withTenant } from '@roofline/db';
import { teamDialNumbers } from '@roofline/db/system';
import { disclosureGreeting } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { forwardingTestArrived } from '../front-desk/forwarding-test.ts';
import { screenCall } from '../providers/call-screen.ts';
import { DIAL_TIMEOUT_SECONDS, relayConnectXml, routeVoice, sendVoiceTwiml, VOICEMAIL_XML } from './twilio-voice-common.ts';
import { E164, escapeXml, field, FORM_BODY_LIMIT } from './twilio.ts';

/*
 * POST /hooks/twilio/voice: a call came in to a company's number. Routed (404), signed (403), saved as a
 * call row, screened, then answered with TwiML: the Front Desk over ConversationRelay (the greeting always
 * carries the recording disclosure and cannot be interrupted), the team then voicemail (Front Desk off or
 * over a cap), or the team first (ring-first). Logs nothing: no numbers, no speech.
 */

function dialXml(url: string, mode: 'voicemail' | 'ring_first', timeout: number, numbers: string[]): string {
  const action = escapeXml(`${url}/hooks/twilio/voice-transfer/after-dial?mode=${mode}`);
  const legs = numbers.map((n) => `<Number>${escapeXml(n)}</Number>`).join('');
  return `<Dial timeout="${String(timeout)}" action="${action}">${legs}</Dial>`;
}

function voicemailXml(publicUrl: string, numbers: string[]): string {
  if (numbers.length === 0) return VOICEMAIL_XML;
  return `<Response>${dialXml(publicUrl, 'voicemail', DIAL_TIMEOUT_SECONDS, numbers)}</Response>`;
}

export function twilioVoiceHooks(deps: AppDeps): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false, limit: FORM_BODY_LIMIT }));

  router.post('/', async (req, res) => {
    const route = await routeVoice(deps, req, res);
    if (!route) return;
    // A forwarding test (Front Desk) is answered before anything else: the test caller's call proves forwarding.
    if (await forwardingTestArrived(deps, route.companyId, field(req, 'From') ?? '')) {
      sendVoiceTwiml(res, '<Response><Say>Forwarding works.</Say><Hangup/></Response>');
      return;
    }
    const callSid = field(req, 'CallSid');
    const to = field(req, 'To');
    if (callSid === undefined || callSid === '' || to === undefined) {
      res.status(400).end();
      return;
    }
    const rawFrom = (field(req, 'From') ?? '').slice(0, 32);
    const fromKnown = E164.test(rawFrom);
    const ctx: TenantContext = { companyId: route.companyId, role: 'system', userId: null, canApproveSpend: false };
    const now = deps.clock.now();
    const publicUrl = deps.config.PUBLIC_BASE_URL;

    const outcome = await withTenant(deps.pools, ctx, async (tx) => {
      const call = await insertCall(tx, ctx, {
        callSid,
        fromE164: rawFrom || 'anonymous',
        toE164: to,
        forwardedFrom: field(req, 'ForwardedFrom') ?? null,
        stirVerstat: field(req, 'StirVerstat') ?? null,
        now,
      });
      const facts = fromKnown ? await screeningFacts(tx, ctx, rawFrom, now) : { blocked: false, callsLastHour: 0, knownCustomer: false };
      const screen = screenCall({ from: rawFrom, stirVerstat: field(req, 'StirVerstat') ?? null, ...facts });
      if (screen.action === 'reject') {
        await updateCall(tx, ctx, callSid, { status: 'rejected', spamReason: screen.reason, endedAt: now });
        return { kind: 'reject' as const };
      }
      const liveAi = await countLiveAiCalls(tx, ctx);
      const paused = await isAgentPaused(tx, ctx, 'front_desk');
      return { kind: 'ok' as const, callId: call.id, liveAi, paused };
    });

    if (outcome.kind === 'reject') {
      sendVoiceTwiml(res, '<Response><Reject/></Response>');
      return;
    }

    const overCap =
      outcome.liveAi >= route.maxConcurrentAiCalls ||
      deps.relaySessions.size >= deps.config.FRONT_DESK_MAX_CALLS ||
      !deps.relaySessions.llmHealthy;

    if (!route.frontDeskEnabled || overCap || outcome.paused) {
      sendVoiceTwiml(res, voicemailXml(publicUrl, await teamDialNumbers(deps.pools.system, route.companyId)));
      return;
    }
    if (route.ringTeamFirstSeconds > 0) {
      const numbers = await teamDialNumbers(deps.pools.system, route.companyId);
      if (numbers.length > 0) {
        sendVoiceTwiml(res, `<Response>${dialXml(publicUrl, 'ring_first', route.ringTeamFirstSeconds, numbers)}</Response>`);
        return;
      }
    }
    sendVoiceTwiml(
      res,
      relayConnectXml(deps, route, outcome.callId, {
        greeting: disclosureGreeting(route.companyName),
        action: `${deps.config.PUBLIC_BASE_URL}/hooks/twilio/voice-transfer/after-relay`,
        messageOnly: false,
      }),
    );
  });

  return router;
}
