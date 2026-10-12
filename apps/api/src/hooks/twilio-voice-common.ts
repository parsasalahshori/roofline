import type { Request, Response } from 'express';
import { frontDeskCallSettings, type FrontDeskCallSettings, type TenantContext, withTenant } from '@roofline/db';
import { voiceRouteForNumber, type VoiceNumberRoute } from '@roofline/db/system';
import { DEFAULT_FRONT_DESK_VOICE, type FrontDeskVoiceId } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { mintRelayToken } from '../front-desk/relay-token.ts';
import { checkSignature, E164, escapeXml, field } from './twilio.ts';

export type VoiceRoute = VoiceNumberRoute & FrontDeskCallSettings;

export const systemCtx = (companyId: string): TenantContext => ({ companyId, role: 'system', userId: null, canApproveSpend: false });

export const TTS_PROVIDER = 'ElevenLabs';
export const STT_PROVIDER = 'Deepgram';

/** Voicemail for a call nobody on the team answers (or when there is no team to ring). */
export const VOICEMAIL_XML =
  '<Response><Say>Please leave a message after the tone.</Say><Record maxLength="120" playBeep="true"/><Hangup/></Response>';
export const DIAL_TIMEOUT_SECONDS = 20;
/** Answer for a replayed or already-finished call: no relay token is minted. */
export const HANGUP_XML = '<Response><Hangup/></Response>';

/** A Twilio CallSid: CA plus 32 lowercase hex characters. */
export const CALL_SID = /^CA[0-9a-f]{32}$/;

/** The request's CallSid when it has the Twilio shape, else null. */
export function validCallSid(req: Request): string | null {
  const value = field(req, 'CallSid');
  return value !== undefined && CALL_SID.test(value) ? value : null;
}

/** Placeholder ElevenLabs voice ids until the owner picks the real voices (owner to-do). */
export const FRONT_DESK_VOICE_IDS: Record<FrontDeskVoiceId, string> = {
  maya: 'maya-voice-id',
  claire: 'claire-voice-id',
  daniel: 'daniel-voice-id',
  marcus: 'marcus-voice-id',
};

export function voiceIdFor(voice: string): string {
  return FRONT_DESK_VOICE_IDS[voice as FrontDeskVoiceId] ?? FRONT_DESK_VOICE_IDS[DEFAULT_FRONT_DESK_VOICE];
}

/** The ConversationRelay TwiML (inbound, ring-first fall-through, or message mode). */
export function relayConnectXml(
  deps: AppDeps,
  route: VoiceRoute,
  callId: string,
  o: { greeting: string; action: string; messageOnly: boolean },
): string {
  const voice = escapeXml(voiceIdFor(route.frontDeskVoice));
  const token = mintRelayToken(deps.config.RELAY_TOKEN_SECRET, { callId, companyId: route.companyId }, deps.clock.now());
  const url = `${deps.config.RELAY_PUBLIC_URL}?t=${encodeURIComponent(token)}`;
  const mode = o.messageOnly ? '<Parameter name="mode" value="message_only"/>' : '';
  return (
    `<Response><Connect action="${escapeXml(o.action)}"><ConversationRelay url="${escapeXml(url)}" ` +
    `welcomeGreeting="${escapeXml(o.greeting)}" welcomeGreetingInterruptible="none" interruptible="speech" ` +
    `ttsProvider="${TTS_PROVIDER}" voice="${voice}" transcriptionProvider="${STT_PROVIDER}" language="en-US">` +
    `<Parameter name="callId" value="${escapeXml(callId)}"/>${mode}</ConversationRelay></Connect></Response>`
  );
}

/** Steps shared by every voice hook: route `To` -> company (404, empty body), then the signature (403). Returns the route or null (response already sent). */
export async function routeVoice(deps: AppDeps, req: Request, res: Response): Promise<VoiceRoute | null> {
  const to = field(req, 'To');
  const route = to !== undefined && E164.test(to) ? await voiceRouteForNumber(deps.pools.system, to) : null;
  if (route === null) {
    res.status(404).end();
    return null;
  }
  const ok = await checkSignature(deps, req, res, route.companyId);
  if (ok === null) return null;
  const ctx = systemCtx(route.companyId);
  const settings = await withTenant(deps.pools, ctx, (tx) => frontDeskCallSettings(tx, ctx));
  return { ...route, ...settings };
}

/** TwiML out: 200 text/xml with the XML declaration. */
export function sendVoiceTwiml(res: Response, xml: string): void {
  res.status(200).type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>${xml}`);
}
