import type { Config } from '../../config.ts';
import type { LineLookup } from '../line-lookup.ts';
import { TwilioHttp } from './http.ts';

const LOOKUP_BASE = 'https://lookups.twilio.com/v2/PhoneNumbers';

type LineKind = Awaited<ReturnType<LineLookup['lineType']>>;

function mapType(type: unknown): LineKind {
  switch (type) {
    case 'mobile':
      return 'mobile';
    case 'landline':
      return 'landline';
    case 'nonFixedVoip':
    case 'fixedVoip':
    case 'voip':
      return 'voip';
    default:
      return 'unknown';
  }
}

/** Twilio Lookup v2 line type intelligence. Never throws and never logs the number: any trouble is 'unknown'. */
export class TwilioLineLookup implements LineLookup {
  private readonly http: TwilioHttp;

  constructor(o: { accountSid: string; authToken: string; fetch?: typeof fetch; http?: TwilioHttp }) {
    this.http =
      o.http ?? new TwilioHttp({ accountSid: o.accountSid, authToken: o.authToken, ...(o.fetch !== undefined && { fetch: o.fetch }) });
  }

  async lineType(e164: string): Promise<LineKind> {
    try {
      const body = await this.http.request<{ line_type_intelligence?: { type?: unknown } | null } | undefined>(
        'GET',
        `${LOOKUP_BASE}/${encodeURIComponent(e164)}`,
        { Fields: 'line_type_intelligence' },
      );
      return mapType(body?.line_type_intelligence?.type);
    } catch {
      return 'unknown';
    }
  }
}

/** The real adapter, or null without the master credentials. */
export function twilioLookupFor(config: Config, fetchImpl?: typeof fetch): LineLookup | null {
  if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) return null;
  return new TwilioLineLookup({
    accountSid: config.TWILIO_ACCOUNT_SID,
    authToken: config.TWILIO_AUTH_TOKEN,
    ...(fetchImpl !== undefined && { fetch: fetchImpl }),
  });
}
