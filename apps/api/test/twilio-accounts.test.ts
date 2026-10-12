import { describe, expect, test } from 'vitest';
import { RegistrarUnavailableError } from '../src/providers/registrar.ts';
import { TwilioAccounts } from '../src/providers/twilio/accounts.ts';
import { TWILIO_API, TWILIO_MESSAGING, TwilioHttp } from '../src/providers/twilio/http.ts';
import { fixtureFetch } from './twilio-fixtures.ts';

/** Master credentials (the ones we hold) and a company's subaccount (the one its setup runs as). */
const master = { accountSid: 'AC00000000000000000000000000000000', authToken: 'master-token' };
const sub = { accountSid: 'AC11111111111111111111111111111111', authToken: 'sub-auth-token' };
const MG = 'MG22222222222222222222222222222222';
const urls = {
  inbound: 'https://app.roofline.test/hooks/twilio/sms',
  status: 'https://app.roofline.test/hooks/twilio/status',
};
const companyId = '00000000-0000-4000-8000-0000000000c1';
const AVAIL = `${TWILIO_API}/Accounts/${sub.accountSid}/AvailablePhoneNumbers/US/Local.json`;
const INCOMING = `${TWILIO_API}/Accounts/${sub.accountSid}/IncomingPhoneNumbers.json`;
const SERVICE_NUMBERS = `${TWILIO_MESSAGING}/Services/${MG}/PhoneNumbers`;

function basic(sid: string, token: string): string {
  return `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
}

function make(routes: Record<string, string | string[]>) {
  const f = fixtureFetch(routes);
  const accounts = new TwilioAccounts({ http: new TwilioHttp({ ...master, fetch: f }) });
  return { f, accounts };
}

describe('TwilioAccounts', () => {
  test('creates a subaccount once', async () => {
    const created = make({
      [`GET ${TWILIO_API}/Accounts.json`]: 'accounts-empty',
      [`POST ${TWILIO_API}/Accounts.json`]: 'account-create',
    });
    expect(await created.accounts.ensureSubaccount(companyId)).toEqual({
      accountSid: sub.accountSid,
      authToken: 'sub-auth-token',
    });
    const posts = created.f.requests.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.form?.get('FriendlyName')).toBe(`roofline:${companyId}`);
    const list = created.f.requests.find((r) => r.method === 'GET');
    expect(list?.url).toContain('Status=active');

    const listed = make({
      [`GET ${TWILIO_API}/Accounts.json`]: '{"accounts":[{"sid":"ACexisting","auth_token":"tok"}]}',
      [`POST ${TWILIO_API}/Accounts.json`]: 'account-create',
    });
    expect(await listed.accounts.ensureSubaccount(companyId)).toEqual({
      accountSid: 'ACexisting',
      authToken: 'tok',
    });
    expect(listed.f.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  test('the messaging service points at our hooks', async () => {
    const created = make({
      [`GET ${TWILIO_MESSAGING}/Services`]: 'services-empty',
      [`POST ${TWILIO_MESSAGING}/Services`]: 'service-create',
    });
    expect(await created.accounts.ensureMessagingService(sub, companyId, urls)).toEqual({
      messagingServiceSid: MG,
    });
    const posts = created.f.requests.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe(`${TWILIO_MESSAGING}/Services`);
    expect(posts[0]?.form?.get('InboundRequestUrl')).toBe(urls.inbound);
    expect(posts[0]?.form?.get('StatusCallback')).toBe(urls.status);
    expect(posts[0]?.form?.get('UseInboundWebhookOnNumber')).toBe('false');
    expect(posts[0]?.form?.get('InboundMethod')).toBe('POST');
    expect(posts[0]?.form?.get('FriendlyName')).toBe(`Roofline ${companyId}`);

    const existing = make({
      [`GET ${TWILIO_MESSAGING}/Services`]: `{"services":[{"sid":"${MG}","friendly_name":"Roofline ${companyId}"}]}`,
      [`POST ${TWILIO_MESSAGING}/Services/${MG}`]: 'service-create',
    });
    expect(await existing.accounts.ensureMessagingService(sub, companyId, urls)).toEqual({
      messagingServiceSid: MG,
    });
    const updates = existing.f.requests.filter((r) => r.method === 'POST');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.url).toBe(`${TWILIO_MESSAGING}/Services/${MG}`);
    expect(updates[0]?.form?.get('InboundRequestUrl')).toBe(urls.inbound);
    expect(updates[0]?.form?.get('StatusCallback')).toBe(urls.status);
  });

  test("a number in the company's area code", async () => {
    const { f, accounts } = make({
      [`GET ${SERVICE_NUMBERS}`]: 'service-numbers-empty',
      [`GET ${AVAIL}`]: 'available-402',
      [`GET ${INCOMING}`]: 'incoming-numbers-empty',
      [`POST ${INCOMING}`]: 'incoming-create',
      [`POST ${SERVICE_NUMBERS}`]: 'service-number-add',
    });
    expect(
      await accounts.ensureNumber(sub, { messagingServiceSid: MG, areaCode: '402', state: 'NE' }),
    ).toEqual({
      e164: '+14025550123',
      phoneNumberSid: 'PN44444444444444444444444444444444',
      capabilities: ['sms', 'voice'],
    });
    const search = f.requests.find((r) => r.method === 'GET' && r.url.startsWith(AVAIL));
    expect(search?.url).toContain('AreaCode=402');
    const purchase = f.requests.find((r) => r.method === 'POST' && r.url === INCOMING);
    expect(purchase?.form?.get('PhoneNumber')).toBe('+14025550123');
    const attach = f.requests.find((r) => r.method === 'POST' && r.url === SERVICE_NUMBERS);
    expect(attach?.form?.get('PhoneNumberSid')).toBe('PN44444444444444444444444444444444');
  });

  test('falls back to the state, then anywhere', async () => {
    const { f, accounts } = make({
      [`GET ${SERVICE_NUMBERS}`]: 'service-numbers-empty',
      [`GET ${AVAIL}`]: ['available-empty', 'available-empty', 'available-402'],
      [`GET ${INCOMING}`]: 'incoming-numbers-empty',
      [`POST ${INCOMING}`]: 'incoming-create',
      [`POST ${SERVICE_NUMBERS}`]: 'service-number-add',
    });
    expect(
      await accounts.ensureNumber(sub, { messagingServiceSid: MG, areaCode: '402', state: 'NE' }),
    ).toEqual({
      e164: '+14025550123',
      phoneNumberSid: 'PN44444444444444444444444444444444',
      capabilities: ['sms', 'voice'],
    });
    const searches = f.requests.filter((r) => r.method === 'GET' && r.url.startsWith(AVAIL));
    expect(searches).toHaveLength(3);
    expect(searches[0]?.url).toContain('AreaCode=402');
    expect(searches[1]?.url).toContain('InRegion=NE');
    expect(searches[1]?.url).not.toContain('AreaCode');
    expect(searches[2]?.url).not.toContain('AreaCode');
    expect(searches[2]?.url).not.toContain('InRegion');

    const none = make({
      [`GET ${SERVICE_NUMBERS}`]: 'service-numbers-empty',
      [`GET ${AVAIL}`]: 'available-empty',
      [`GET ${INCOMING}`]: 'incoming-numbers-empty',
      [`POST ${INCOMING}`]: 'incoming-create',
      [`POST ${SERVICE_NUMBERS}`]: 'service-number-add',
    });
    await expect(
      none.accounts.ensureNumber(sub, { messagingServiceSid: MG, areaCode: '402', state: 'NE' }),
    ).rejects.toThrow(RegistrarUnavailableError);
    await expect(
      none.accounts.ensureNumber(sub, { messagingServiceSid: MG, areaCode: '402', state: 'NE' }),
    ).rejects.toThrow('No numbers were available.');
    expect(none.f.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  test('an attach that failed is retried without a second purchase', async () => {
    const args = { messagingServiceSid: MG, areaCode: '402', state: 'NE' };
    const first = fixtureFetch({
      [`GET ${SERVICE_NUMBERS}`]: 'service-numbers-empty',
      [`GET ${INCOMING}`]: 'incoming-numbers-empty',
      [`GET ${AVAIL}`]: 'available-402',
      [`POST ${INCOMING}`]: 'incoming-create',
    });
    const firstFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if ((init?.method ?? 'GET') === 'POST' && url === SERVICE_NUMBERS) {
        return Promise.resolve(new Response('{"code":20500}', { status: 500 }));
      }
      return first(input, init);
    }) as unknown as typeof fetch;
    const one = new TwilioAccounts({ http: new TwilioHttp({ ...master, fetch: firstFetch }) });
    await expect(one.ensureNumber(sub, args)).rejects.toBeInstanceOf(RegistrarUnavailableError);

    const second = make({
      [`GET ${SERVICE_NUMBERS}`]: 'service-numbers-empty',
      [`GET ${INCOMING}`]: 'incoming-numbers-one',
      [`POST ${SERVICE_NUMBERS}`]: 'service-number-add',
    });
    const result = await second.accounts.ensureNumber(sub, args);
    expect(result.phoneNumberSid).toBe('PN44444444444444444444444444444444');

    const purchases = [...first.requests, ...second.f.requests].filter((r) => r.method === 'POST' && r.url === INCOMING);
    expect(purchases).toHaveLength(1);
    expect(second.f.requests.some((r) => r.url.startsWith(AVAIL))).toBe(false);
    const attach = second.f.requests.find((r) => r.method === 'POST' && r.url === SERVICE_NUMBERS);
    expect(attach?.form?.get('PhoneNumberSid')).toBe('PN44444444444444444444444444444444');
  });

  test('an attach refused with 21710 counts as attached', async () => {
    const base = fixtureFetch({
      [`GET ${SERVICE_NUMBERS}`]: 'service-numbers-empty',
      [`GET ${INCOMING}`]: 'incoming-numbers-one',
    });
    const f = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if ((init?.method ?? 'GET') === 'POST' && url === SERVICE_NUMBERS) {
        return Promise.resolve(new Response('{"code":21710}', { status: 400 }));
      }
      return base(input, init);
    }) as unknown as typeof fetch;
    const accounts = new TwilioAccounts({ http: new TwilioHttp({ ...master, fetch: f }) });
    expect(await accounts.ensureNumber(sub, { messagingServiceSid: MG, areaCode: null, state: null })).toEqual({
      e164: '+14025550123',
      phoneNumberSid: 'PN44444444444444444444444444444444',
      capabilities: ['sms', 'voice'],
    });
  });

  test('reuses a number already on the service', async () => {
    const { f, accounts } = make({
      [`GET ${SERVICE_NUMBERS}`]: 'service-numbers-one',
    });
    expect(
      await accounts.ensureNumber(sub, { messagingServiceSid: MG, areaCode: '402', state: 'NE' }),
    ).toEqual({
      e164: '+14025550199',
      phoneNumberSid: 'PN33333333333333333333333333333333',
      capabilities: ['sms', 'voice'],
    });
    expect(f.requests).toHaveLength(1);
  });

  test("messaging calls use the subaccount's own credentials", async () => {
    const { f, accounts } = make({
      [`GET ${TWILIO_API}/Accounts.json`]: 'accounts-empty',
      [`POST ${TWILIO_API}/Accounts.json`]: 'account-create',
      [`GET ${TWILIO_MESSAGING}/Services`]: 'services-empty',
      [`POST ${TWILIO_MESSAGING}/Services`]: 'service-create',
    });
    await accounts.ensureSubaccount(companyId);
    await accounts.ensureMessagingService(sub, companyId, urls);

    const masterCalls = f.requests.filter((r) => r.url.startsWith(`${TWILIO_API}/Accounts.json`));
    expect(masterCalls).toHaveLength(2);
    for (const call of masterCalls) {
      expect(call.auth).toBe(basic(master.accountSid, master.authToken));
    }
    const serviceCalls = f.requests.filter((r) => r.url.startsWith(`${TWILIO_MESSAGING}/Services`));
    expect(serviceCalls).toHaveLength(2);
    for (const call of serviceCalls) {
      expect(call.auth).toBe(basic(sub.accountSid, sub.authToken));
    }
  });

  test("number calls use the subaccount's own credentials too", async () => {
    const { f, accounts } = make({
      [`GET ${SERVICE_NUMBERS}`]: 'service-numbers-empty',
      [`GET ${AVAIL}`]: 'available-402',
      [`GET ${INCOMING}`]: 'incoming-numbers-empty',
      [`POST ${INCOMING}`]: 'incoming-create',
      [`POST ${SERVICE_NUMBERS}`]: 'service-number-add',
    });
    await accounts.ensureNumber(sub, { messagingServiceSid: MG, areaCode: '402', state: 'NE' });

    const subCalls = f.requests.filter(
      (r) => r.url.startsWith(AVAIL) || r.url === INCOMING || r.url.startsWith(`${TWILIO_MESSAGING}/Services`),
    );
    expect(subCalls.length).toBeGreaterThanOrEqual(3);
    for (const call of subCalls) {
      expect(call.auth).toBe(basic(sub.accountSid, sub.authToken));
    }
  });

  test('errors carry no Twilio text', async () => {
    const unreachable = new TwilioAccounts({
      http: new TwilioHttp({
        ...master,
        fetch: (async () => new Response('{"message":"+14025550123 is bad"}', { status: 500 })) as unknown as typeof fetch,
      }),
    });
    await expect(unreachable.ensureSubaccount(companyId)).rejects.toThrow(RegistrarUnavailableError);
    await expect(unreachable.ensureSubaccount(companyId)).rejects.toThrow("Twilio didn't answer.");

    const refused = new TwilioAccounts({
      http: new TwilioHttp({
        ...master,
        fetch: (async () =>
          new Response('{"code":21211,"message":"Invalid To +14025550123"}', { status: 400 })) as unknown as typeof fetch,
      }),
    });
    const error = await refused.ensureSubaccount(companyId).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(RegistrarUnavailableError);
    expect((error as Error).message).not.toContain('+1402');
    expect((error as Error).message).not.toContain('Invalid To');
  });
});
