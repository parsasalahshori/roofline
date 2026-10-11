import { describe, expect, test } from 'vitest';
import { isSmsRefusedError, type SmsRefusedError } from '@roofline/send-gate';
import type { Config } from '../src/config.ts';
import { TwilioHttp, TwilioUnreachableError } from '../src/providers/twilio/http.ts';
import { TwilioSmsAdapter, twilioSmsFor } from '../src/providers/twilio/sms.ts';

/** Master credentials (the ones we hold) and a company's subaccount (where the text is sent from). */
const MASTER_SID = `AC${'9'.repeat(32)}`;
const MASTER_TOKEN = 'master_token_value';
const SUB_SID = `AC${'1'.repeat(32)}`;
const MESSAGING_SID = `MG${'2'.repeat(32)}`;
const STATUS_URL = 'https://app.example.test/hooks/twilio/status';

const PHONE = '+14025550123';
const BODY = 'Hi Pat, your roof estimate is ready.';
const SENDER = { accountSid: SUB_SID, messagingServiceSid: MESSAGING_SID };
const SEND = { companyId: '00000000-0000-4000-8000-000000000001', to: PHONE, body: BODY, sender: SENDER };
const MESSAGES_URL = `https://api.twilio.com/2010-04-01/Accounts/${SUB_SID}/Messages.json`;

type Recorded = { method: string; url: string; headers: Headers; body: string | null };

/** A fake `fetch` that records every call and answers with `respond`. */
function fakeFetch(respond: (call: Recorded) => Response | Promise<Response>): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fake = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call: Recorded = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetch: fake, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function adapterWith(fetchImpl: typeof fetch, timeoutMs?: number): TwilioSmsAdapter {
  const http = new TwilioHttp({ accountSid: MASTER_SID, authToken: MASTER_TOKEN, fetch: fetchImpl, timeoutMs });
  return new TwilioSmsAdapter({ http, statusCallbackUrl: STATUS_URL });
}

/** The error a rejected promise carries, or a failing assertion if it resolved. */
async function errorOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the send to be rejected');
}

/** Asserts nothing a provider said (its phone number or the text body) reached the message. */
function expectNoLeak(err: unknown): void {
  const message = (err as Error).message;
  expect(message).not.toContain('+1402');
  expect(message).not.toContain('roof estimate');
}

describe('TwilioSmsAdapter.send', () => {
  test('a sent text returns the provider id and its segments', async () => {
    const { fetch, calls } = fakeFetch(() => json(201, { sid: `SM${'a'.repeat(32)}`, num_segments: '2' }));
    const result = await adapterWith(fetch).send(SEND);
    expect(result).toEqual({ providerSid: `SM${'a'.repeat(32)}`, segments: 2 });
    expect(calls).toHaveLength(1);
  });

  test('posts to the subaccount messages URL with the master credentials', async () => {
    const { fetch, calls } = fakeFetch(() => json(201, { sid: `SM${'a'.repeat(32)}`, num_segments: '1' }));
    await adapterWith(fetch).send(SEND);
    const [call] = calls;
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(MESSAGES_URL);
    const expected = `Basic ${Buffer.from(`${MASTER_SID}:${MASTER_TOKEN}`).toString('base64')}`;
    expect(call?.headers.get('authorization')).toBe(expected);
    expect(call?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
  });

  test('sends exactly the To, MessagingServiceSid, Body and StatusCallback form fields', async () => {
    const { fetch, calls } = fakeFetch(() => json(201, { sid: `SM${'a'.repeat(32)}`, num_segments: '1' }));
    await adapterWith(fetch).send(SEND);
    const form = new URLSearchParams(calls[0]?.body ?? '');
    expect([...form.keys()].sort()).toEqual(['Body', 'MessagingServiceSid', 'StatusCallback', 'To']);
    expect(form.get('To')).toBe(PHONE);
    expect(form.get('MessagingServiceSid')).toBe(MESSAGING_SID);
    expect(form.get('Body')).toBe(BODY);
    expect(form.get('StatusCallback')).toBe(STATUS_URL);
  });

  test('falls back to counting segments when the provider gives none', async () => {
    const { fetch } = fakeFetch(() => json(201, { sid: `SM${'a'.repeat(32)}` }));
    const result = await adapterWith(fetch).send({ ...SEND, body: 'x'.repeat(200) });
    expect(result.segments).toBe(2);
  });

  test('code 21610 is a permanent opt-out refusal with the reason', async () => {
    const { fetch } = fakeFetch(() => json(400, { code: 21610, message: `Unsubscribed ${PHONE}` }));
    const err = await errorOf(adapterWith(fetch).send(SEND));
    expect(isSmsRefusedError(err)).toBe(true);
    const refusal = err as SmsRefusedError;
    expect(refusal.permanent).toBe(true);
    expect(refusal.optedOut).toBe(true);
    expect(refusal.reasonPlain).toBe('This person turned off texts from your number, so we stopped texting them.');
    expectNoLeak(err);
  });

  test('code 21614 is a permanent refusal that is not an opt-out', async () => {
    const { fetch } = fakeFetch(() => json(400, { code: 21614, message: `To ${PHONE} is not a mobile number` }));
    const err = await errorOf(adapterWith(fetch).send(SEND));
    expect(isSmsRefusedError(err)).toBe(true);
    const refusal = err as SmsRefusedError;
    expect(refusal.permanent).toBe(true);
    expect(refusal.optedOut).toBe(false);
    expect(refusal.reasonPlain).toBe("This number can't get texts.");
    expectNoLeak(err);
  });

  test('429 with code 20429 is a refusal that can be retried', async () => {
    const { fetch } = fakeFetch(() => json(429, { code: 20429, message: 'Too many requests' }));
    const err = await errorOf(adapterWith(fetch).send(SEND));
    expect(isSmsRefusedError(err)).toBe(true);
    expect((err as SmsRefusedError).permanent).toBe(false);
    expect((err as SmsRefusedError).reasonPlain).toBeNull();
  });

  test('a 500 is an unconfirmed send, a plain error and not a refusal', async () => {
    const { fetch } = fakeFetch(() => json(500, { message: `Could not text ${PHONE}` }));
    const err = await errorOf(adapterWith(fetch).send(SEND));
    expect(isSmsRefusedError(err)).toBe(false);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Twilio did not confirm the text.');
    expectNoLeak(err);
  });

  test('a request that never answers in time is an unconfirmed send', async () => {
    const hangs = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;
    const err = await errorOf(adapterWith(hangs, 50).send(SEND));
    expect(isSmsRefusedError(err)).toBe(false);
    expect((err as Error).message).toBe('Twilio did not confirm the text.');
    expectNoLeak(err);
  });

  test('a text with no sender is refused, and nothing is sent', async () => {
    const { fetch, calls } = fakeFetch(() => json(201, { sid: `SM${'a'.repeat(32)}`, num_segments: '1' }));
    const err = await errorOf(adapterWith(fetch).send({ ...SEND, sender: null }));
    expect(isSmsRefusedError(err)).toBe(true);
    expect((err as SmsRefusedError).message).toBe("Texting isn't set up yet.");
    expect((err as SmsRefusedError).permanent).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('twilioSmsFor', () => {
  test('returns null unless both the account SID and the auth token are set', () => {
    expect(twilioSmsFor({ TWILIO_ACCOUNT_SID: MASTER_SID } as unknown as Config)).toBeNull();
    expect(twilioSmsFor({ TWILIO_AUTH_TOKEN: MASTER_TOKEN } as unknown as Config)).toBeNull();
    expect(twilioSmsFor({} as unknown as Config)).toBeNull();
  });

  test('returns a Twilio adapter when both credentials are set', () => {
    const config = {
      TWILIO_ACCOUNT_SID: MASTER_SID,
      TWILIO_AUTH_TOKEN: MASTER_TOKEN,
      PUBLIC_BASE_URL: 'https://app.example.test',
    } as unknown as Config;
    expect(twilioSmsFor(config)).toBeInstanceOf(TwilioSmsAdapter);
  });
});

describe('TwilioHttp', () => {
  test('a GET puts its parameters in the query string and sends no body', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, { ok: true }));
    const http = new TwilioHttp({ accountSid: MASTER_SID, authToken: MASTER_TOKEN, fetch });
    await http.request('GET', 'https://api.twilio.com/2010-04-01/Accounts.json', { Status: 'active', Skip: undefined, Sid: ['a', 'b'] });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.body).toBeNull();
    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.getAll('Sid')).toEqual(['a', 'b']);
    expect(url.searchParams.get('Status')).toBe('active');
    expect(url.searchParams.has('Skip')).toBe(false);
  });

  test('a 204 answer gives undefined', async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 204 }));
    const http = new TwilioHttp({ accountSid: MASTER_SID, authToken: MASTER_TOKEN, fetch });
    await expect(http.request('DELETE', 'https://api.twilio.com/2010-04-01/x.json')).resolves.toBeUndefined();
  });

  test('an unreadable 2xx body is an unreachable error', async () => {
    const { fetch } = fakeFetch(() => new Response('<html>oops</html>', { status: 200 }));
    const http = new TwilioHttp({ accountSid: MASTER_SID, authToken: MASTER_TOKEN, fetch });
    const err = await errorOf(http.request('GET', 'https://api.twilio.com/2010-04-01/x.json'));
    expect(err).toBeInstanceOf(TwilioUnreachableError);
  });

  test('as() keeps the fetch and the timeout but uses the other credentials', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, {}));
    const master = new TwilioHttp({ accountSid: MASTER_SID, authToken: MASTER_TOKEN, fetch });
    await master.as({ accountSid: SUB_SID, authToken: 'sub_token' }).request('GET', 'https://api.twilio.com/x.json');
    expect(calls[0]?.headers.get('authorization')).toBe(`Basic ${Buffer.from(`${SUB_SID}:sub_token`).toString('base64')}`);
  });
});
