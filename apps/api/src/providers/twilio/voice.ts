import type { Config } from '../../config.ts';
import type { CallControl } from '../call-control.ts';
import type { SubaccountRef } from '../registrar.ts';
import { TWILIO_API, TwilioHttp, TwilioUnreachableError } from './http.ts';

/** Held open for a few seconds, so the test call is answered and the forwarding check can see it. */
const TEST_CALL_TWIML = '<Response><Pause length="5"/></Response>';
const BYTES_TIMEOUT_MS = 30_000;

/**
 * Twilio call control: recordings and voice URLs on the company's subaccount, the forwarding test
 * call on Roofline's own account. Never logs phone numbers.
 */
export class TwilioCallControl implements CallControl {
  readonly configured = true;
  private readonly main: TwilioHttp;
  private readonly mainSid: string;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(o: { accountSid: string; authToken: string; fetch?: typeof fetch }) {
    this.mainSid = o.accountSid;
    this.fetchImpl = o.fetch;
    this.main = new TwilioHttp({ accountSid: o.accountSid, authToken: o.authToken, fetch: o.fetch });
  }

  private sub(sub: SubaccountRef): TwilioHttp {
    return this.main.as({ accountSid: sub.accountSid, authToken: sub.authToken });
  }

  async startRecording(sub: SubaccountRef, callSid: string): Promise<{ recordingSid: string }> {
    const body = await this.sub(sub).request<{ sid?: unknown }>(
      'POST',
      `${TWILIO_API}/Accounts/${sub.accountSid}/Calls/${callSid}/Recordings.json`,
      { RecordingChannels: 'dual' },
    );
    if (typeof body.sid !== 'string') throw new TwilioUnreachableError();
    return { recordingSid: body.sid };
  }

  async stopRecording(sub: SubaccountRef, callSid: string, recordingSid: string): Promise<void> {
    await this.sub(sub).request(
      'POST',
      `${TWILIO_API}/Accounts/${sub.accountSid}/Calls/${callSid}/Recordings/${recordingSid}.json`,
      { Status: 'stopped' },
    );
  }

  async fetchRecording(sub: SubaccountRef, recordingSid: string): Promise<Uint8Array> {
    const send = this.fetchImpl ?? globalThis.fetch;
    let res: Response;
    try {
      res = await send(`${TWILIO_API}/Accounts/${sub.accountSid}/Recordings/${recordingSid}.mp3`, {
        method: 'GET',
        headers: { Authorization: `Basic ${Buffer.from(`${sub.accountSid}:${sub.authToken}`).toString('base64')}` },
        signal: AbortSignal.timeout(BYTES_TIMEOUT_MS),
      });
    } catch {
      throw new TwilioUnreachableError();
    }
    if (!res.ok) throw new TwilioUnreachableError();
    return new Uint8Array(await res.arrayBuffer());
  }

  async deleteRecording(sub: SubaccountRef, recordingSid: string): Promise<void> {
    await this.sub(sub).request('DELETE', `${TWILIO_API}/Accounts/${sub.accountSid}/Recordings/${recordingSid}.json`);
  }

  async placeTestCall(i: { to: string; from: string; statusCallback: string }): Promise<{ callSid: string }> {
    const body = await this.main.request<{ sid?: unknown }>('POST', `${TWILIO_API}/Accounts/${this.mainSid}/Calls.json`, {
      To: i.to,
      From: i.from,
      Twiml: TEST_CALL_TWIML,
      StatusCallback: i.statusCallback,
    });
    if (typeof body.sid !== 'string') throw new TwilioUnreachableError();
    return { callSid: body.sid };
  }

  async setVoiceUrl(sub: SubaccountRef, phoneNumberSid: string, url: string, statusCallback: string): Promise<void> {
    await this.sub(sub).request(
      'POST',
      `${TWILIO_API}/Accounts/${sub.accountSid}/IncomingPhoneNumbers/${phoneNumberSid}.json`,
      { VoiceUrl: url, VoiceMethod: 'POST', StatusCallback: statusCallback, StatusCallbackMethod: 'POST' },
    );
  }
}

/** The real call control when both Twilio master credentials are set, else null. */
export function twilioCallControlFor(config: Config, opts?: { fetch?: typeof fetch }): CallControl | null {
  if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) return null;
  return new TwilioCallControl({ accountSid: config.TWILIO_ACCOUNT_SID, authToken: config.TWILIO_AUTH_TOKEN, fetch: opts?.fetch });
}
