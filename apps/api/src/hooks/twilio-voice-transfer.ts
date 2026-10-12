import express, { Router } from 'express';
import {
  countLiveCallsInWindow,
  findCallBySid,
  findCallConversationId,
  hasUrgentNoticeFor,
  isAgentPaused,
  lockAiCap,
  recordModelFailureHandoff,
  updateCall,
  withTenant,
} from '@roofline/db';
import { onCallMembers } from '@roofline/db/system';
import { disclosureGreeting, transferPlan, workIntervals, type TransferReason } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { aiAllowedNow, DIAL_TIMEOUT_SECONDS, relayConnectXml, routeVoice, sendVoiceTwiml, systemCtx, validCallSid, VOICEMAIL_XML, type VoiceRoute } from './twilio-voice-common.ts';
import { checkSignature, escapeXml, field, FORM_BODY_LIMIT } from './twilio.ts';

/*
 * /hooks/twilio/voice-transfer: what happens after the Front Desk hands a call over, and after a
 * team dial. /after-relay (HandoffData -> dial the on-call team, or a message), /whisper and
 * /whisper-result (the team member presses 1 to take the call), /after-dial (answered, or back to
 * the AI). Logs nothing: no numbers, no speech, no hand-off summary.
 */

const MESSAGE_GREETING = "Nobody could pick up right now. I'll take a message.";
const HANGUP = '<Response><Hangup/></Response>';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS: readonly TransferReason[] = ['asked', 'leak', 'danger', 'angry', 'trade_caller', 'not_understood', 'model_failure'];

type EndReason = 'spam' | 'silence' | 'goodbye' | 'limit';
const END_REASONS: readonly EndReason[] = ['spam', 'silence', 'goodbye', 'limit'];
type Handoff = { kind: 'transfer'; reason: TransferReason; urgent: boolean } | { kind: 'end'; reason: TransferReason | EndReason };

/** HandoffData -> kind and reason; anything missing, invalid or unknown is an end (reason unknown -> asked). The summary is not read here. */
function parseHandoff(raw: string | undefined): Handoff {
  if (raw === undefined) return { kind: 'end', reason: 'asked' };
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return { kind: 'end', reason: 'asked' };
    const { kind, reason, urgent } = data as { kind?: unknown; reason?: unknown; urgent?: unknown };
    if (kind !== 'transfer') return { kind: 'end', reason: END_REASONS.find((r) => r === reason) ?? 'asked' };
    return { kind: 'transfer', reason: REASONS.find((r) => r === reason) ?? 'asked', urgent: urgent === true };
  } catch {
    return { kind: 'end', reason: 'asked' };
  }
}

/** Best-effort: queue the after-call work for a finished call. Same key as the status hook, so a repeat is harmless. */
async function enqueueAfterCall(deps: AppDeps, companyId: string, callSid: string): Promise<void> {
  try {
    await deps.jobs.send('fd-after-call', { companyId, callSid }, { singletonKey: `fd-after-call:${callSid}`, startAfter: 5 });
  } catch {
    console.error(`fd-after-call enqueue failed company=${companyId}`);
  }
}

function transferUrl(deps: AppDeps, path: string): string {
  return `${deps.config.PUBLIC_BASE_URL}/hooks/twilio/voice-transfer${path}`;
}

/** Message mode: back to the AI to take a message; its relay ends the call whatever it hands back. */
function messageModeXml(deps: AppDeps, route: VoiceRoute, callId: string): string {
  return relayConnectXml(deps, route, callId, {
    greeting: MESSAGE_GREETING,
    action: transferUrl(deps, '/after-relay?mode=message_only'),
    messageOnly: true,
  });
}

/** One Number leg whose whisper asks the member to press 1. */
function numberXml(deps: AppDeps, route: VoiceRoute, callId: string, phone: string): string {
  const url = transferUrl(
    deps,
    `/whisper?company=${route.companyId}&call=${encodeURIComponent(callId)}&name=${encodeURIComponent(route.companyName)}`,
  );
  return `<Number url="${escapeXml(url)}">${escapeXml(phone)}</Number>`;
}

/** The Dial for a transfer. `rest` are the user ids to try after these (ring_each), carried in the action URL. */
function dialXml(deps: AppDeps, route: VoiceRoute, callId: string, targets: { phone: string }[], rest: string[]): string {
  const query = rest.length > 0 ? `&rest=${rest.join(',')}` : '';
  const action = transferUrl(deps, `/after-dial?mode=transfer${query}`);
  const legs = targets.map((target) => numberXml(deps, route, callId, target.phone)).join('');
  return `<Response><Dial timeout="${String(DIAL_TIMEOUT_SECONDS)}" action="${escapeXml(action)}">${legs}</Dial></Response>`;
}

function inWorkHours(route: VoiceRoute, now: Date): boolean {
  return workIntervals(route.workHours, now, new Date(now.getTime() + 1), route.timezone).length > 0;
}

/** `rest` query value -> user ids; anything that is not a UUID is dropped. */
function restOf(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value.split(',').filter((id) => UUID.test(id));
}

/** The company named by ?company= (a uuid), else null (404 sent). */
function queryCompany(req: express.Request, res: express.Response): string | null {
  const value = req.query.company;
  if (typeof value !== 'string' || !UUID.test(value)) {
    res.status(404).end();
    return null;
  }
  return value;
}

export function twilioVoiceTransferHooks(deps: AppDeps): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false, limit: FORM_BODY_LIMIT }));

  router.post('/after-relay', async (req, res) => {
    const route = await routeVoice(deps, req, res);
    if (!route) return;
    const callSid = validCallSid(req);
    if (callSid === null) {
      res.status(400).end();
      return;
    }
    const ctx = systemCtx(route.companyId);
    const now = deps.clock.now();
    const handoff: Handoff = req.query.mode === 'message_only' ? { kind: 'end', reason: 'asked' } : parseHandoff(field(req, 'HandoffData'));

    if (handoff.kind === 'end') {
      await withTenant(deps.pools, ctx, (tx) => updateCall(tx, ctx, callSid, { status: 'ended', endedAt: now }));
      await enqueueAfterCall(deps, route.companyId, callSid);
      sendVoiceTwiml(res, HANGUP);
      return;
    }

    const onCall = (await onCallMembers(deps.pools.system, route.companyId)).map((m) => ({ userId: m.userId, phone: m.phone }));

    const decided = await withTenant(deps.pools, ctx, async (tx) => {
      const call = await findCallBySid(tx, ctx, callSid);
      if (call === null) return null;
      // Urgency is decided here too, not only from HandoffData: a hand-off (DTMF 0) made while an urgent take_message
      // was in flight carries urgent false, but the notice is on the conversation once that commits (the conversation
      // lock in hasUrgentNoticeFor waits for it). The conversation is locked before the call row is updated.
      const conversationId = handoff.urgent ? null : await findCallConversationId(tx, ctx, call.id);
      const urgent = handoff.urgent || (conversationId !== null && (await hasUrgentNoticeFor(tx, ctx, conversationId)));
      const plan = transferPlan({ reason: handoff.reason, urgent, inWorkHours: inWorkHours(route, now), onCall });
      if (plan.mode === 'message') await updateCall(tx, ctx, callSid, { transferResult: 'no_answer' });
      else await updateCall(tx, ctx, callSid, { status: 'ringing_team' });
      return { callId: call.id, plan };
    });
    if (decided !== null && handoff.reason === 'model_failure') {
      try {
        await withTenant(deps.pools, ctx, async (tx) => {
          const conversationId = await findCallConversationId(tx, ctx, decided.callId);
          if (conversationId !== null) await recordModelFailureHandoff(tx, ctx, conversationId);
        });
      } catch {
        console.error(`model_failure marker failed call=${decided.callId} company=${route.companyId}`);
      }
    }
    if (decided === null) {
      sendVoiceTwiml(res, HANGUP);
      return;
    }
    const { callId, plan } = decided;
    if (plan.mode === 'message') {
      sendVoiceTwiml(res, messageModeXml(deps, route, callId));
      return;
    }
    if (plan.mode === 'ring_all') {
      sendVoiceTwiml(res, dialXml(deps, route, callId, plan.targets, []));
      return;
    }
    const [first, ...others] = plan.targets;
    sendVoiceTwiml(res, dialXml(deps, route, callId, first ? [first] : [], others.map((o) => o.userId)));
  });

  /** The team member's leg: asks to press 1. Routed by ?company= (To is the member's phone here). */
  router.post('/whisper', async (req, res) => {
    const companyId = queryCompany(req, res);
    if (companyId === null || (await checkSignature(deps, req, res, companyId)) === null) return;
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    const action = transferUrl(deps, `/whisper-result?company=${companyId}`);
    sendVoiceTwiml(
      res,
      `<Response><Gather numDigits="1" timeout="8" action="${escapeXml(action)}">` +
        `<Say>Roofline call from ${escapeXml(name)}. Press 1 to take it.</Say></Gather><Hangup/></Response>`,
    );
  });

  /** 1 lets the Dial connect (an empty response); any other digit hangs up that leg. */
  router.post('/whisper-result', async (req, res) => {
    const companyId = queryCompany(req, res);
    if (companyId === null || (await checkSignature(deps, req, res, companyId)) === null) return;
    sendVoiceTwiml(res, field(req, 'Digits') === '1' ? '<Response/>' : HANGUP);
  });

  router.post('/after-dial', async (req, res) => {
    const route = await routeVoice(deps, req, res);
    if (!route) return;
    const callSid = validCallSid(req);
    if (callSid === null) {
      res.status(400).end();
      return;
    }
    const ctx = systemCtx(route.companyId);
    const now = deps.clock.now();
    const dialStatus = field(req, 'DialCallStatus');
    const answered = dialStatus === 'completed' || dialStatus === 'answered';
    const mode = req.query.mode;

    if (answered) {
      await withTenant(deps.pools, ctx, (tx) => updateCall(tx, ctx, callSid, { status: 'ended', transferResult: 'answered', endedAt: now }));
      await enqueueAfterCall(deps, route.companyId, callSid);
      sendVoiceTwiml(res, '<Response/>');
      return;
    }
    if (mode === 'voicemail') {
      sendVoiceTwiml(res, VOICEMAIL_XML);
      return;
    }

    if (mode === 'ring_first') {
      // The team did not pick up: the call goes to the AI only under the same checks and cap as a new call at /voice
      // (taken under the per-company lock), and is then relay-bound ('ringing'); otherwise voicemail.
      const aiAllowed = aiAllowedNow(deps, route, now);
      const decided = await withTenant(deps.pools, ctx, async (tx) => {
        const call = await findCallBySid(tx, ctx, callSid);
        if (call === null) return null;
        if (!aiAllowed) return { callId: call.id, toAi: false };
        // A Front Desk paused while the team was ringing is handled like Front Desk off (A1): voicemail.
        if (await isAgentPaused(tx, ctx, 'front_desk')) return { callId: call.id, toAi: false };
        await lockAiCap(tx, ctx);
        const liveAi = await countLiveCallsInWindow(tx, ctx, now, call.id);
        if (liveAi >= route.maxConcurrentAiCalls) return { callId: call.id, toAi: false };
        await updateCall(tx, ctx, callSid, { status: 'ringing' });
        return { callId: call.id, toAi: true };
      });
      if (decided === null) {
        sendVoiceTwiml(res, HANGUP);
        return;
      }
      if (!decided.toAi) {
        sendVoiceTwiml(res, VOICEMAIL_XML);
        return;
      }
      const callId = decided.callId;
      sendVoiceTwiml(
        res,
        relayConnectXml(deps, route, callId, {
          greeting: disclosureGreeting(route.companyName),
          action: transferUrl(deps, '/after-relay'),
          messageOnly: false,
        }),
      );
      return;
    }
    const callId = await withTenant(deps.pools, ctx, async (tx) => (await findCallBySid(tx, ctx, callSid))?.id ?? null);
    if (callId === null) {
      sendVoiceTwiml(res, HANGUP);
      return;
    }
    if (mode === 'transfer') {
      const rest = restOf(req.query.rest);
      const [nextId, ...others] = rest;
      if (nextId !== undefined) {
        const next = (await onCallMembers(deps.pools.system, route.companyId)).find((m) => m.userId === nextId);
        if (next) {
          sendVoiceTwiml(res, dialXml(deps, route, callId, [next], others));
          return;
        }
      }
      await withTenant(deps.pools, ctx, (tx) => updateCall(tx, ctx, callSid, { transferResult: 'no_answer' }));
      sendVoiceTwiml(res, messageModeXml(deps, route, callId));
      return;
    }
    sendVoiceTwiml(res, '<Response/>');
  });

  return router;
}
