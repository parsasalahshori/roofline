import express, { Router } from 'express';
import { countLiveCallsInWindow, insertCall, isAgentPaused, lockAiCap, screeningFacts, type TenantContext, updateCall, withTenant } from '@roofline/db';
import { teamDialNumbers } from '@roofline/db/system';
import { disclosureGreeting } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { forwardingTestArrived } from '../front-desk/forwarding-test.ts';
import { screenCall } from '../providers/call-screen.ts';
import { DIAL_TIMEOUT_SECONDS, HANGUP_XML, relayConnectXml, routeVoice, sendVoiceTwiml, validCallSid, VOICEMAIL_XML } from './twilio-voice-common.ts';
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
    const callSid = validCallSid(req);
    const to = field(req, 'To');
    if (callSid === null || to === undefined) {
      res.status(400).end();
      return;
    }
    // A forwarding test (Front Desk) is answered before anything else: the test caller's call proves forwarding.
    if (
      await forwardingTestArrived(deps, route.companyId, field(req, 'From') ?? '', {
        forwardedFrom: field(req, 'ForwardedFrom') ?? null,
        stirVerstat: field(req, 'StirVerstat') ?? null,
      })
    ) {
      sendVoiceTwiml(res, '<Response><Say>Forwarding works.</Say><Hangup/></Response>');
      return;
    }
    const rawFrom = (field(req, 'From') ?? '').slice(0, 32);
    const fromKnown = E164.test(rawFrom);
    const ctx: TenantContext = { companyId: route.companyId, role: 'system', userId: null, canApproveSpend: false };
    const now = deps.clock.now();
    const publicUrl = deps.config.PUBLIC_BASE_URL;

    // Whether this call may go to the AI at all, before the per-company cap (no database needed).
    const aiAllowed =
      route.frontDeskEnabled &&
      !route.readOnly &&
      deps.relaySessions.size < deps.config.FRONT_DESK_MAX_CALLS &&
      deps.relaySessions.isLlmHealthy(now);

    const outcome = await withTenant(deps.pools, ctx, async (tx) => {
      const call = await insertCall(tx, ctx, {
        callSid,
        fromE164: rawFrom || 'anonymous',
        toE164: to,
        forwardedFrom: field(req, 'ForwardedFrom') ?? null,
        stirVerstat: field(req, 'StirVerstat') ?? null,
        now,
      });
      // A repeated CallSid returns the existing row: only a new or still-ringing call may get relay TwiML.
      if (call.status !== 'ringing') return { kind: 'replay' as const };
      const facts = fromKnown ? await screeningFacts(tx, ctx, rawFrom, now) : { blocked: false, callsLastHour: 0, knownCustomer: false };
      const screen = screenCall({ from: rawFrom, stirVerstat: field(req, 'StirVerstat') ?? null, ...facts });
      if (screen.action === 'reject') {
        await updateCall(tx, ctx, callSid, { status: 'rejected', spamReason: screen.reason, endedAt: now });
        return { kind: 'reject' as const };
      }
      // The cap decision is made under a per-company lock held until this transaction ends, so two calls
      // arriving together cannot both see room for one more. Only calls bound for the AI count: 'ai', and
      // 'ringing' calls of the last 35 minutes (relay TwiML sent, relay not yet set up). Every other path
      // (Front Desk off, read-only, over a cap, ring the team first) is marked 'ringing_team' here, so a
      // call the team answers or that goes to voicemail never holds an AI slot.
      await lockAiCap(tx, ctx);
      const liveAi = await countLiveCallsInWindow(tx, ctx, now, call.id);
      const paused = await isAgentPaused(tx, ctx, 'front_desk');
      const overCompanyCap = liveAi >= route.maxConcurrentAiCalls;
      if (!aiAllowed || paused || overCompanyCap || route.ringTeamFirstSeconds > 0) {
        await updateCall(tx, ctx, callSid, { status: 'ringing_team' });
      }
      return { kind: 'ok' as const, callId: call.id, overCompanyCap, paused };
    });

    if (outcome.kind === 'replay') {
      sendVoiceTwiml(res, HANGUP_XML);
      return;
    }
    if (outcome.kind === 'reject') {
      sendVoiceTwiml(res, '<Response><Reject/></Response>');
      return;
    }

    // A read-only company (trial ended, plan canceled) gets no AI calls: the team, then voicemail (Ruling BG).
    // A paused Front Desk (A1) is handled like Front Desk off: the team, then voicemail.
    if (!aiAllowed || outcome.overCompanyCap || outcome.paused) {
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
