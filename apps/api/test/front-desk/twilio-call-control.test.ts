import { describe, expect, test } from 'vitest';
import type { Config } from '../../src/config.ts';
import { twilioCallControlFor } from '../../src/providers/twilio/voice.ts';

const MAIN = { sid: `AC${'a'.repeat(32)}`, token: 'main-token' };
const SUB = { accountSid: `AC${'b'.repeat(32)}`, authToken: 'sub-token' };
const basic = (sid: string, token: string) => `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;

type Seen = { url: string; method: string; auth: string; body: URLSearchParams };

function setup(reply: () => Response = () => Response.json({ sid: 'XX1' })) {
  const seen: Seen[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    seen.push({
      url: String(url),
      method: init?.method ?? 'GET',
      auth: headers.Authorization ?? '',
      body: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
    });
    return reply();
  }) as typeof fetch;
  const config = { TWILIO_ACCOUNT_SID: MAIN.sid, TWILIO_AUTH_TOKEN: MAIN.token } as Config;
  const control = twilioCallControlFor(config, { fetch: fakeFetch });
  if (!control) throw new Error('expected call control');
  return { control, seen };
}

describe('TwilioCallControl', () => {
  test('twilioCallControlFor is null without credentials', () => {
    expect(twilioCallControlFor({} as Config)).toBeNull();
    expect(twilioCallControlFor({ TWILIO_ACCOUNT_SID: MAIN.sid } as Config)).toBeNull();
    expect(twilioCallControlFor({ TWILIO_AUTH_TOKEN: 't' } as Config)).toBeNull();
  });

  test('setVoiceUrl posts VoiceUrl and StatusCallback to the subaccount phone number', async () => {
    const { control, seen } = setup();
    await control.setVoiceUrl(SUB, 'PN123', 'https://x.test/hooks/twilio/voice', 'https://x.test/hooks/twilio/voice-status');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SUB.accountSid}/IncomingPhoneNumbers/PN123.json`);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.auth).toBe(basic(SUB.accountSid, SUB.authToken));
    expect(seen[0]!.body.get('VoiceUrl')).toBe('https://x.test/hooks/twilio/voice');
    expect(seen[0]!.body.get('VoiceMethod')).toBe('POST');
    expect(seen[0]!.body.get('StatusCallback')).toBe('https://x.test/hooks/twilio/voice-status');
    expect(seen[0]!.body.get('StatusCallbackMethod')).toBe('POST');
  });

  test('startRecording returns the recording sid', async () => {
    const { control, seen } = setup(() => Response.json({ sid: 'RE999' }));
    expect(await control.startRecording(SUB, 'CA1')).toEqual({ recordingSid: 'RE999' });
    expect(seen[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SUB.accountSid}/Calls/CA1/Recordings.json`);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.auth).toBe(basic(SUB.accountSid, SUB.authToken));
    expect(seen[0]!.body.get('RecordingChannels')).toBe('dual');
  });

  test('stopRecording posts Status stopped', async () => {
    const { control, seen } = setup();
    await control.stopRecording(SUB, 'CA1', 'RE1');
    expect(seen[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SUB.accountSid}/Calls/CA1/Recordings/RE1.json`);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.auth).toBe(basic(SUB.accountSid, SUB.authToken));
    expect(seen[0]!.body.get('Status')).toBe('stopped');
  });

  test('deleteRecording sends DELETE', async () => {
    const { control, seen } = setup(() => new Response(null, { status: 204 }));
    await control.deleteRecording(SUB, 'RE1');
    expect(seen[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SUB.accountSid}/Recordings/RE1.json`);
    expect(seen[0]!.method).toBe('DELETE');
    expect(seen[0]!.auth).toBe(basic(SUB.accountSid, SUB.authToken));
  });

  test('placeTestCall uses the main account and returns the call sid', async () => {
    const { control, seen } = setup(() => Response.json({ sid: 'CA777' }));
    const out = await control.placeTestCall({ to: '+14025550100', from: '+14025550199', statusCallback: 'https://x.test/cb' });
    expect(out).toEqual({ callSid: 'CA777' });
    expect(seen[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${MAIN.sid}/Calls.json`);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.auth).toBe(basic(MAIN.sid, MAIN.token));
    expect(seen[0]!.body.get('To')).toBe('+14025550100');
    expect(seen[0]!.body.get('From')).toBe('+14025550199');
    expect(seen[0]!.body.get('StatusCallback')).toBe('https://x.test/cb');
    expect(seen[0]!.body.get('Twiml')).toContain('<Pause');
  });

  test('fetchRecording returns the mp3 bytes', async () => {
    const { control, seen } = setup(() => new Response(new Uint8Array([1, 2, 3, 4])));
    const bytes = await control.fetchRecording(SUB, 'RE1');
    expect([...bytes]).toEqual([1, 2, 3, 4]);
    expect(seen[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SUB.accountSid}/Recordings/RE1.mp3`);
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.auth).toBe(basic(SUB.accountSid, SUB.authToken));
  });
});
