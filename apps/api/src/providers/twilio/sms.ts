import type { Config } from '../../config.ts';
import { type OutboundSms, type SmsAdapter, type SmsSendResult, SmsRefusedError } from '@roofline/send-gate';
import { TWILIO_API, TwilioApiError, TwilioHttp } from './http.ts';

/** Twilio's code for a number that has opted out of texts from this sender. */
const OPTED_OUT_CODE = 21610;
/** Twilio's codes for a number that can never get texts (not a mobile, not reachable, and so on). */
const NEVER_DELIVERABLE_CODES = new Set([21211, 21612, 21614, 21408, 21265]);
const NOT_TAKEN = 'Twilio refused the text.';
const UNCONFIRMED = 'Twilio did not confirm the text.';
const NOT_SET_UP = "Texting isn't set up yet.";
const OPTED_OUT_REASON = 'This person turned off texts from your number, so we stopped texting them.';
const NO_TEXTS_REASON = "This number can't get texts.";

/**
 * Sends texts through Twilio, on the company's messaging service in its subaccount. The request goes
 * out on the master credentials, so the subaccount's SID is only ever a path segment.
 */
export class TwilioSmsAdapter implements SmsAdapter {
  private readonly http: TwilioHttp;
  private readonly statusCallbackUrl: string;

  constructor(o: { http: TwilioHttp; statusCallbackUrl: string }) {
    this.http = o.http;
    this.statusCallbackUrl = o.statusCallbackUrl;
  }

  async send(m: OutboundSms): Promise<SmsSendResult> {
    const sender = m.sender;
    if (!sender) throw new SmsRefusedError(NOT_SET_UP);
    try {
      const json = await this.http.request<{ sid?: unknown; num_segments?: unknown }>(
        'POST',
        `${TWILIO_API}/Accounts/${sender.accountSid}/Messages.json`,
        {
          To: m.to,
          MessagingServiceSid: sender.messagingServiceSid,
          Body: m.body,
          StatusCallback: this.statusCallbackUrl,
        },
      );
      if (typeof json.sid !== 'string') throw new Error(UNCONFIRMED);
      return {
        providerSid: json.sid,
        segments: Number.parseInt(String(json.num_segments), 10) || segmentsOf(m.body),
      };
    } catch (err) {
      throw refusalFor(err);
    }
  }
}

/** Maps a failed send to what the caller needs: a refusal (nothing went out) or an unconfirmed error. */
function refusalFor(err: unknown): Error {
  if (err instanceof TwilioApiError) {
    if (err.code === OPTED_OUT_CODE) {
      return new SmsRefusedError(NOT_TAKEN, { permanent: true, optedOut: true, reasonPlain: OPTED_OUT_REASON });
    }
    if (err.code !== null && NEVER_DELIVERABLE_CODES.has(err.code)) {
      return new SmsRefusedError(NOT_TAKEN, { permanent: true, reasonPlain: NO_TEXTS_REASON });
    }
    // Rate limits (429 or 20429) and every other 4xx: the text did not go out, and a later try may succeed.
    return new SmsRefusedError(NOT_TAKEN);
  }
  // No answer, a timeout, a 5xx or an unreadable reply: the provider may have sent it, so it is unknown.
  return new Error(UNCONFIRMED);
}

/**
 * Segments a body bills as: one up to 160 characters, then 153 per segment. The same GSM-7 count the
 * send gate uses (`countSegments` in @roofline/send-gate, which is not exported from its index).
 */
function segmentsOf(body: string): number {
  return body.length <= 160 ? 1 : Math.ceil(body.length / 153);
}

/** The Twilio adapter when both credentials are configured, else null (the caller falls back to disabled). */
export function twilioSmsFor(config: Config): SmsAdapter | null {
  const accountSid = config.TWILIO_ACCOUNT_SID;
  const authToken = config.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return null;
  return new TwilioSmsAdapter({
    http: new TwilioHttp({ accountSid, authToken }),
    statusCallbackUrl: `${config.PUBLIC_BASE_URL}/hooks/twilio/status`,
  });
}
