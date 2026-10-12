import { and, asc, eq } from 'drizzle-orm';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, describe, expect, inject, test } from 'vitest';
import { calls, companySettings, conversations, conversationTurns, customers, measurements, messages, proposals } from '@roofline/db';
import { insertFixtureProperty, OMAHA_BOX, OMAHA_CORE, setFixtureServiceArea, type Query } from '@roofline/db/testing';
import { DEFAULT_WORK_HOURS, type ProposalView } from '@roofline/shared';
import { DEMO_CALL_SUMMARY } from '../src/demo/script.ts';
import { endDemoOwnerPools } from '../src/demo/simulate.ts';
import { addressFor, Actors, inCompany, mustCreate } from './crm-helpers.ts';
import { loginAs, makeTestApp, type TestApp } from './helpers.ts';
import { DAYTIME } from './sms-helpers.ts';
import { dbSteps, seenOf } from './task-helpers.ts';

// Demo mode's routes (demo/routes.ts): the badge probe and the presenter's four simulations. DB-backed: CI runs it.

const owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
const q: Query = async (text, values) => (await owner.query(text, values)).rows as Record<string, unknown>[];

let t: TestApp;

afterEach(async () => {
  await t.close();
});

afterAll(async () => {
  await endDemoOwnerPools();
  await owner.end();
});

async function demoApp(): Promise<TestApp> {
  t = await makeTestApp({ DEMO_MODE: true, FAKE_PROVIDERS: true, DEMO_DATABASE_URL_OWNER: inject('dbUrls').owner });
  t.clock.set(DAYTIME);
  return t;
}

const origin = () => t.deps.config.APP_ORIGIN;
const simulate = async (kind: string, who: 'owner' | 'office' | 'rep' = 'owner') => {
  const agent = await loginAs(t.app, t.seed.a[who]);
  return agent.post(`/api/demo/simulate/${kind}`).set('Origin', origin()).send({});
};

/** Front Desk on for company A, the way the call-path tests set it. */
async function frontDeskOn(): Promise<void> {
  const companyId = t.seed.a.companyId;
  const settings = { frontDeskEnabled: true, frontDeskTexts: true, workHours: DEFAULT_WORK_HOURS };
  await inCompany(t, companyId, (tx) =>
    tx.insert(companySettings).values({ companyId, ...settings }).onConflictDoUpdate({ target: companySettings.companyId, set: settings }),
  );
}

/** A customer of company A with a mobile number who has agreed to texts. */
async function customerWithPhone(name: string, phone: string): Promise<string> {
  const companyId = t.seed.a.companyId;
  const [row] = await inCompany(t, companyId, (tx) =>
    tx
      .insert(customers)
      .values({ companyId, displayName: name, phones: [{ e164: phone, label: 'mobile', primary: true }], smsConsentStatus: 'express' })
      .returning({ id: customers.id }),
  );
  return row!.id;
}

describe('GET /api/demo', () => {
  test('is an ordinary 404 when DEMO_MODE is off', async () => {
    t = await makeTestApp();
    const agent = await loginAs(t.app, t.seed.a.owner);
    expect((await agent.get('/api/demo')).status).toBe(404);
    expect((await agent.post('/api/demo/simulate/text').set('Origin', origin()).send({})).status).toBe(404);
  });

  test('answers { demo: true } when DEMO_MODE is on, signed out too', async () => {
    await demoApp();
    const res = await request(t.app).get('/api/demo');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ demo: true });
  });
});

describe('POST /api/demo/simulate/*', () => {
  test('needs a signed-in owner or office member, and a same-site Origin', async () => {
    await demoApp();
    expect((await request(t.app).post('/api/demo/simulate/text').send({})).status).toBe(401);
    expect((await simulate('text', 'rep')).status).toBe(403);
    const agent = await loginAs(t.app, t.seed.a.owner);
    expect((await agent.post('/api/demo/simulate/text').set('Origin', 'https://evil.test').send({})).status).toBe(403);
    expect((await agent.post('/api/demo/simulate/nothing').set('Origin', origin()).send({})).status).toBe(404);
  });

  test('text: the homeowner text is stored in a Front Desk conversation and answered', async () => {
    await demoApp();
    await frontDeskOn();
    const customerId = await customerWithPhone('Dana Whitfield', '+14025550161');
    const res = await simulate('text', 'office');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, customerId });
    expect(res.body.message).toContain('Dana Whitfield');
    const conversationId = res.body.conversationId as string;
    const texts = await inCompany(t, t.seed.a.companyId, (tx) =>
      tx.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt)),
    );
    // The test clock stands still, so both texts carry the same time: compare them as a set.
    expect(texts.map((m) => m.direction).sort()).toEqual(['in', 'out']);
    expect(texts.find((m) => m.direction === 'out')!.body).toMatch(/thanks/i);
  });

  test('call: a scripted call leaves a transcript and the summary on its conversation', async () => {
    await demoApp();
    await frontDeskOn();
    const customerId = await customerWithPhone('Ray Okafor', '+14025550162');
    const res = await simulate('call');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, customerId });
    const { conversationId, callId } = res.body as { conversationId: string; callId: string };
    const companyId = t.seed.a.companyId;
    const [conversation] = await inCompany(t, companyId, (tx) => tx.select().from(conversations).where(eq(conversations.id, conversationId)));
    expect(conversation).toMatchObject({ channel: 'voice', status: 'ended', summary: DEMO_CALL_SUMMARY, customerId });
    const turns = await inCompany(t, companyId, (tx) =>
      tx.select().from(conversationTurns).where(eq(conversationTurns.conversationId, conversationId)).orderBy(asc(conversationTurns.position)),
    );
    expect(turns.filter((x) => x.speaker === 'caller')).toHaveLength(3);
    expect(turns.filter((x) => x.speaker === 'assistant').length).toBeGreaterThanOrEqual(3);
    const [call] = await inCompany(t, companyId, (tx) => tx.select().from(calls).where(eq(calls.id, callId)));
    expect(call).toMatchObject({ status: 'ended', conversationId });
  });

  test('storm: a hail storm over the service area becomes a company storm with the homes it hit', async () => {
    await demoApp();
    const companyId = t.seed.a.companyId;
    await setFixtureServiceArea(q, companyId, OMAHA_BOX);
    await insertFixtureProperty(q, companyId, OMAHA_CORE);
    const res = await simulate('storm');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, created: true });
    expect(res.body.companyStormId).toEqual(expect.any(String));
    expect(res.body.customersHit).toBeGreaterThanOrEqual(1);
    const list = await (await loginAs(t.app, t.seed.a.owner)).get('/api/storms');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain(res.body.companyStormId as string);
  });

  test('storm: 409 without a service area', async () => {
    await demoApp();
    await q(`update companies set service_area = null where id = $1`, [t.seed.a.companyId]);
    const res = await simulate('storm');
    expect(res.status).toBe(409);
  });

  test('sign: 409 with no sent proposal, then the most recent sent proposal is signed', async () => {
    await demoApp();
    expect((await simulate('sign')).status).toBe(409);

    const who = new Actors(t);
    const ownerAgent = await who.as('owner');
    const customer = await mustCreate(ownerAgent, '/api/customers', { displayName: 'Molly Lindgren' });
    const property = await mustCreate(ownerAgent, '/api/properties', { customerId: customer.id, ...addressFor(0) });
    const job = await mustCreate(ownerAgent, '/api/jobs', { customerId: customer.id, propertyId: property.id });
    const companyId = t.seed.a.companyId;
    const [m] = await inCompany(t, companyId, (tx) =>
      tx
        .insert(measurements)
        .values({ companyId, propertyId: property.id, jobId: job.id, kind: 'estimate', method: 'outline', surfaceSqFt: 2400, pitchX12: 6, edgeFt: 220, ridgeFt: 60, valleyFt: 20 })
        .returning({ id: measurements.id }),
    );
    await inCompany(t, companyId, (tx) =>
      tx
        .update(customers)
        .set({ phones: [{ e164: '+14025550163', label: 'mobile', primary: true }], smsConsentStatus: 'express' })
        .where(eq(customers.id, customer.id)),
    );
    const made = await ownerAgent.post('/api/proposals').set('Origin', origin()).send({ measurementId: m!.id });
    expect(made.status).toBe(201);
    const proposal = made.body as ProposalView;
    const ask = await ownerAgent.post(`/api/proposals/${proposal.id}/send`).set('Origin', origin());
    expect(ask.status).toBe(201);
    const taskId = ask.body.taskId as string;
    const approve = await ownerAgent.post(`/api/approvals/${taskId}/approve`).set('Origin', origin()).send(seenOf(await dbSteps(t, 'a', taskId)));
    expect(approve.status).toBe(200);
    await t.queue.drain(t.deps);

    const res = await simulate('sign');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, proposalId: proposal.id });
    expect(res.body.message).toContain('Molly Lindgren');
    const [row] = await inCompany(t, companyId, (tx) => tx.select().from(proposals).where(and(eq(proposals.id, proposal.id))));
    expect(row!.status).toBe('signed');
    expect((await simulate('sign')).status).toBe(409);
  });
});
