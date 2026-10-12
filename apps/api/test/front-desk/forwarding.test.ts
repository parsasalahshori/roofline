import pg from 'pg';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import twilio from 'twilio';
import { beforeEach, describe, expect, inject, it, test } from 'vitest';
import { companyPhoneNumbers, companySettings, encrypt, textingRegistrations, withTenant, type TenantContext } from '@roofline/db';
import type { ForwardingTestView, SetupView } from '@roofline/shared';
import { loginAs, makeTestApp, type SuperAgent, TEST_ENCRYPTION_KEY, type TestApp } from '../helpers.ts';

/*
 * D1 Task 17: the number's voice setup is out of scope here; this file covers the forwarding test.
 * The test call is a calls row from Roofline's test caller number. The voice hook recognises the
 * arrival, and the 30 s job fails a test that never arrives. Every call goes through FakeCallControl.
 */

const TEST_CALLER = '+14025550100';
const A_NUMBER = '+14025550200';
const B_NUMBER = '+14025550300';
const A_PHONE = '+14025550199'; // Acme's companies.phone_e164 (seeded)
const TOKEN_A = 'test-subaccount-token-a';
const TOKEN_B = 'test-subaccount-token-b';
const BASE = 'https://app.roofline.test';
const VOICE = '/hooks/twilio/voice';
const FORWARDING = '/api/front-desk/forwarding-test';
const VERIFIED_TWIML = '<Say>Forwarding works.</Say><Hangup/>';
const PHONE_FIRST = 'Add your business phone number in Settings → Company first.';
const WAIT = 'Wait a minute before testing again.';
const NOT_ALLOWED = "Your role can't do that. Ask the owner.";
const NOT_FOUND = "We couldn't find that.";

let t: TestApp;

const idOf = (company: 'a' | 'b') => t.seed[company].companyId;
const ctxOf = (company: 'a' | 'b'): TenantContext => ({ companyId: idOf(company), role: 'system', userId: null, canApproveSpend: false });

beforeEach(async () => {
  t = await makeTestApp({ TWILIO_TEST_CALLER_NUMBER: TEST_CALLER });
  const { system } = t.deps.pools;
  await system.insert(companyPhoneNumbers).values([
    { companyId: idOf('a'), e164: A_NUMBER, capabilities: ['sms', 'voice'], providerSid: 'PN_A' },
    { companyId: idOf('b'), e164: B_NUMBER, capabilities: ['sms', 'voice'], providerSid: 'PN_B' },
  ]);
  for (const [company, token] of [
    ['a', TOKEN_A],
    ['b', TOKEN_B],
  ] as const) {
    await system
      .update(textingRegistrations)
      .set({ subaccountAuthTokenEncrypted: encrypt(token, TEST_ENCRYPTION_KEY) })
      .where(eq(textingRegistrations.companyId, idOf(company)));
  }
});

/** Raw SQL as the table owner (the same helper setup.test.ts uses), for the one company column the tenant role may not write. */
async function ownerSql(text: string, params: unknown[] = []): Promise<void> {
  const client = new pg.Client({ connectionString: inject('dbUrls').owner });
  await client.connect();
  try {
    await client.query(text, params);
  } finally {
    await client.end();
  }
}

/** A signed Twilio webhook, the way Twilio signs it with the company's subaccount token. */
function post(path: string, fields: Record<string, string>, token: string) {
  const signature = twilio.getExpectedTwilioSignature(token, BASE + path, fields);
  return request(t.app).post(path).type('form').set('X-Twilio-Signature', signature).send(fields);
}

let inboundCounter = 0;
/** An inbound call to a company's number. Its CallSid never collides with the fake's own `CA0…` test sids. */
function inbound(to: string, from: string) {
  const CallSid = `CAee${String(++inboundCounter).padStart(30, '0')}`;
  return post(VOICE, { CallSid, From: from, To: to }, to === A_NUMBER ? TOKEN_A : TOKEN_B);
}

async function startTest(agent: SuperAgent) {
  return agent.post(FORWARDING);
}

async function viewOf(agent: SuperAgent, id: string) {
  return agent.get(`${FORWARDING}/${id}`);
}

function placedTests() {
  return t.callControl.calls.filter((c) => c.method === 'placeTestCall');
}

describe('POST /api/front-desk/forwarding-test', () => {
  test('the test call is placed at most once a minute per company', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);

    const first = await startTest(owner);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ id: expect.any(String) });
    expect(placedTests()).toHaveLength(1);
    expect(placedTests()[0]!.args[0]).toEqual({ to: A_PHONE, from: TEST_CALLER, statusCallback: `${BASE}/hooks/twilio/voice-status` });

    const second = await startTest(owner);
    expect(second.status).toBe(429);
    expect(second.body).toEqual({ error: WAIT });
    expect(placedTests()).toHaveLength(1);

    t.clock.advance(61_000);
    const third = await startTest(owner);
    expect(third.status).toBe(200);
    expect(placedTests()).toHaveLength(2);
  });

  test('a company without a business phone number is asked to add one (422, field phone)', async () => {
    await ownerSql('update companies set phone_e164 = null where id = $1', [idOf('a')]);
    const owner = await loginAs(t.app, t.seed.a.owner);

    const res = await startTest(owner);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: PHONE_FIRST, field: 'phone' });
    expect(placedTests()).toHaveLength(0);
  });

  test('a rep cannot start the test (403); an office member can', async () => {
    const rep = await loginAs(t.app, t.seed.a.rep);
    const denied = await startTest(rep);
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ error: NOT_ALLOWED });
    expect(placedTests()).toHaveLength(0);

    const office = await loginAs(t.app, t.seed.a.office);
    const allowed = await startTest(office);
    expect(allowed.status).toBe(200);
  });
});

describe('GET /api/front-desk/forwarding-test/:id', () => {
  test('a new test is calling until its call arrives', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const { body } = await startTest(owner);
    const view = await viewOf(owner, body.id as string);
    expect(view.status).toBe(200);
    expect(view.body as ForwardingTestView).toMatchObject({ id: body.id, status: 'calling', finishedAt: null });
  });

  test('a call from the test caller to the company line marks forwarding verified and the setup item done', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const { body } = await startTest(owner);

    const arrival = await inbound(A_NUMBER, TEST_CALLER);
    expect(arrival.status).toBe(200);
    expect(arrival.text).toContain(VERIFIED_TWIML);

    const view = await viewOf(owner, body.id as string);
    expect(view.body).toMatchObject({ id: body.id, status: 'verified' });

    const [settings] = await withTenant(t.deps.pools, ctxOf('a'), (tx) =>
      tx.select({ at: companySettings.forwardingVerifiedAt }).from(companySettings).where(eq(companySettings.companyId, idOf('a'))),
    );
    expect(settings?.at).toBeInstanceOf(Date);

    const setupRes = await owner.get('/api/setup');
    const setup = setupRes.body as SetupView;
    expect(setup.items.find((i) => i.key === 'phone_number')).toMatchObject({ status: 'done', comingWith: null });
  });

  test('no arrival by the 30 s timeout fails the test with the likely cause', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const { body } = await startTest(owner);
    expect((await viewOf(owner, body.id as string)).body).toMatchObject({ status: 'calling' });

    t.clock.advance(31_000);
    await t.jobs.drain(t.deps);

    const view = await viewOf(owner, body.id as string);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ id: body.id, status: 'not_received' });
    expect((view.body as ForwardingTestView).finishedAt).not.toBeNull();
  });

  test("another company's pending test is not matched by a call to a different company's line", async () => {
    const ownerA = await loginAs(t.app, t.seed.a.owner);
    const { body } = await startTest(ownerA);

    const arrivalAtB = await inbound(B_NUMBER, TEST_CALLER);
    expect(arrivalAtB.status).toBe(200);
    expect(arrivalAtB.text).not.toContain(VERIFIED_TWIML);

    const view = await viewOf(ownerA, body.id as string);
    expect(view.body).toMatchObject({ id: body.id, status: 'calling' });
  });

  test("another company's test is not found", async () => {
    const ownerA = await loginAs(t.app, t.seed.a.owner);
    const { body } = await startTest(ownerA);

    const ownerB = await loginAs(t.app, t.seed.b.owner);
    const res = await viewOf(ownerB, body.id as string);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_FOUND });
  });
});

describe('forwarding test (Task 18 dependency)', () => {
  it.todo('Front Desk cannot be enabled before verification unless override: true from the owner (Task 18)');
});
