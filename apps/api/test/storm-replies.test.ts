import { eq } from 'drizzle-orm';
import pg from 'pg';
import request from 'supertest';
import twilio from 'twilio';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { companyPhoneNumbers, encrypt, jobs, textingRegistrations } from '@roofline/db';
import { insertOmahaStorm, type Query } from '@roofline/db/testing';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from './helpers.ts';
import { addSmsCustomers, DAYTIME, MINUTE } from './sms-helpers.ts';

/*
 * YES replies to a storm text (S1 Task 21), through the real Twilio inbound hook. The storm, its
 * plan task and the sent texts are inserted through the owner connection. Needs Docker; CI only.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const A_NUMBER = '+14025550100';
const MARIA = '+14025550111';
const TOKEN = 'test-subaccount-token-a';
const BASE = 'https://app.roofline.test';
const SMS = '/hooks/twilio/sms';

let owner: pg.Pool;
let t: TestApp;
let customerId: string;
let sid = 0;

const q: Query = async (text, values) => (await owner.query(text, values)).rows;
const companyId = () => t.seed.a.companyId;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
});
afterAll(async () => {
  await owner.end();
});

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(DAYTIME);
  await t.deps.pools.system
    .insert(companyPhoneNumbers)
    .values({ companyId: companyId(), e164: A_NUMBER, capabilities: ['sms'], providerSid: 'PN_A' });
  await t.deps.pools.system
    .update(textingRegistrations)
    .set({ subaccountAuthTokenEncrypted: encrypt(TOKEN, TEST_ENCRYPTION_KEY) })
    .where(eq(textingRegistrations.companyId, companyId()));
  [customerId] = await addSmsCustomers(t, 'a', [{ firstName: 'Maria', phone: MARIA, consent: 'express', state: 'NE' }]);
});

/** A storm, its company_storms row, a storm_plan task with a send_sms_batch step, and a text sent to Maria at `sentAt`. */
async function stormText(sentAt: Date, day: string): Promise<string> {
  const stormId = await insertOmahaStorm(q, day);
  const cs = await q(
    `insert into company_storms (company_id, storm_id, max_in, customers_hit, homes_hit) values ($1, $2, 1.75, 1, 1) returning id`,
    [companyId(), stormId],
  );
  const task = await q(
    `insert into agent_tasks (company_id, agent, kind, title, subject_type, subject_id, status)
     values ($1, 'storm_scout', 'storm_plan', 'Storm plan', 'company_storm', $2, 'approved') returning id`,
    [companyId(), cs[0]!.id],
  );
  sid += 1;
  const step = await q(
    `insert into agent_task_steps (company_id, task_id, position, type, approval_class, idempotency_key)
     values ($1, $2, 1, 'send_sms_batch', 'message', $3) returning id`,
    [companyId(), task[0]!.id, `storm-replies-${sid}`],
  );
  await q(
    `insert into messages (company_id, customer_id, channel, direction, purpose, body, status, step_id, sent_at, to_e164)
     values ($1, $2, 'sms', 'out', 'marketing', 'Hail hit your street.', 'sent', $3, $4, $5)`,
    [companyId(), customerId, step[0]!.id, sentAt.toISOString(), MARIA],
  );
  return stormId;
}

/** Maria texts `body` to A's number, signed as Twilio would. */
async function reply(body: string) {
  sid += 1;
  const fields = { MessageSid: `SM${sid.toString(16).padStart(32, '0')}`, From: MARIA, To: A_NUMBER, Body: body, NumMedia: '0' };
  const signature = twilio.getExpectedTwilioSignature(TOKEN, BASE + SMS, fields);
  const res = await request(t.app).post(SMS).type('form').set('X-Twilio-Signature', signature).send(fields);
  expect(res.status).toBe(200);
}

const jobRows = () => inCompany(t, companyId(), (tx) => tx.select().from(jobs));

describe('YES replies to a storm text', () => {
  test('a YES to the newest storm text makes a Lead job with a Today follow-up', async () => {
    const stormId = await stormText(new Date(DAYTIME.getTime() - DAY_MS), '2026-10-10');
    await reply('YES');
    const rows = await jobRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      customerId,
      source: 'storm',
      stormId,
      stage: 'lead',
      nextStep: 'Maria replied YES to the storm text',
    });
    expect(rows[0]!.nextStepOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('a second YES makes no second job and no second follow-up', async () => {
    await stormText(new Date(DAYTIME.getTime() - DAY_MS), '2026-10-10');
    await reply('yes');
    const [first] = await jobRows();
    t.clock.advance(MINUTE);
    await reply('Yes!');
    const rows = await jobRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.updatedAt).toEqual(first!.updatedAt);
    expect(rows[0]!.nextStep).toBe(first!.nextStep);
  });

  test('a storm text older than 14 days is ignored', async () => {
    await stormText(new Date(DAYTIME.getTime() - 15 * DAY_MS), '2026-09-20');
    await reply('YES');
    expect(await jobRows()).toHaveLength(0);
  });

  test('STOP is never a YES', async () => {
    await stormText(new Date(DAYTIME.getTime() - DAY_MS), '2026-10-10');
    await reply('STOP');
    expect(await jobRows()).toHaveLength(0);
  });

  test('with two storms texted, the YES attaches to the newest storm only', async () => {
    await stormText(new Date(DAYTIME.getTime() - 5 * DAY_MS), '2026-10-05');
    const newest = await stormText(new Date(DAYTIME.getTime() - DAY_MS), '2026-10-10');
    await reply('YES');
    const rows = await jobRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stormId).toBe(newest);
  });

  test('"yes please call me" is not a YES', async () => {
    await stormText(new Date(DAYTIME.getTime() - DAY_MS), '2026-10-10');
    await reply('yes please call me');
    expect(await jobRows()).toHaveLength(0);
  });
});
