import { describe, expect, it } from 'vitest';
import { TwilioLineLookup, twilioLookupFor } from '../../src/providers/twilio/lookup.ts';
import { testConfig } from '../helpers.ts';

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: () => Response | Promise<Response>, calls: Call[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const adapter = (f: typeof fetch) => new TwilioLineLookup({ accountSid: 'ACtest', authToken: 'tok', fetch: f });

describe('Twilio line lookup', () => {
  it('calls Lookup v2 with Basic auth', async () => {
    const calls: Call[] = [];
    const lookup = adapter(fakeFetch(() => json({ line_type_intelligence: { type: 'mobile' } }), calls));
    expect(await lookup.lineType('+15125550100')).toBe('mobile');
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://lookups.twilio.com/v2/PhoneNumbers/%2B15125550100');
    expect(url.searchParams.get('Fields')).toBe('line_type_intelligence');
    expect(calls[0]!.init.method).toBe('GET');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('ACtest:tok').toString('base64')}`);
  });

  it.each([
    ['mobile', 'mobile'],
    ['landline', 'landline'],
    ['nonFixedVoip', 'voip'],
    ['fixedVoip', 'voip'],
    ['tollFree', 'unknown'],
    [null, 'unknown'],
  ])('maps %s to %s', async (type, expected) => {
    const lookup = adapter(fakeFetch(() => json({ line_type_intelligence: { type } })));
    expect(await lookup.lineType('+15125550100')).toBe(expected);
  });

  it('maps a missing line_type_intelligence to unknown', async () => {
    expect(await adapter(fakeFetch(() => json({}))).lineType('+15125550100')).toBe('unknown');
  });

  it('answers unknown on a 500, a 404 and a thrown fetch', async () => {
    expect(await adapter(fakeFetch(() => json({}, 500))).lineType('+15125550100')).toBe('unknown');
    expect(await adapter(fakeFetch(() => json({ code: 20404 }, 404))).lineType('+15125550100')).toBe('unknown');
    const boom = fakeFetch(() => {
      throw new Error('network');
    });
    expect(await adapter(boom).lineType('+15125550100')).toBe('unknown');
  });

  it('twilioLookupFor needs both credentials', () => {
    const urls = { tenant: 'postgres://x', system: 'postgres://y' };
    expect(twilioLookupFor(testConfig(urls))).toBeNull();
    expect(twilioLookupFor(testConfig(urls, { TWILIO_ACCOUNT_SID: 'ACtest' }))).toBeNull();
    expect(twilioLookupFor(testConfig(urls, { TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tok' }))).toBeInstanceOf(TwilioLineLookup);
  });
});
