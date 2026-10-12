import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { withTenant, type TenantContext } from '@roofline/db';
import { insertFixtureProperty, insertOmahaStorm, OMAHA_CORE, type Query } from '@roofline/db/testing';
import { stormResults } from '../src/storm/results.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

/*
 * Storm results (S1 Task 21) against a real database: every number counted from rows seeded through the
 * owner connection. These tests need Docker and run on CI only.
 */

let owner: pg.Pool;
let t: TestApp;
let companyStormId: string;
let stormId: string;
let taskId: string;
let smsStepId: string;
let emailStepId: string;

const q: Query = async (text, values) => (await owner.query(text, values)).rows;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
});
afterAll(async () => {
  await owner.end();
});

const companyId = () => t.seed.a.companyId;
const ctxFor = (key: 'a' | 'b'): TenantContext => ({ companyId: t.seed[key].companyId, userId: null, role: 'system', canApproveSpend: false });
const results = (key: 'a' | 'b' = 'a', id = companyStormId) => withTenant(t.deps.pools, ctxFor(key), (tx) => stormResults(tx, ctxFor(key), id));

const ZEROS = {
  textsSent: 0,
  textsDelivered: 0,
  replies: 0,
  yesReplies: 0,
  emailsSent: 0,
  unsubscribes: 0,
  doorsKnocked: 0,
  wantsCheck: 0,
  adSpendCents: 0,
  adMaxCents: 0,
  adClicks: 0,
  landingRequests: 0,
  inspectionsBooked: 0,
};

beforeEach(async () => {
  t = await makeTestApp();
  stormId = await insertOmahaStorm(q, '2026-10-11');
  const cs = await q(
    `insert into company_storms (company_id, storm_id, max_in, customers_hit, homes_hit) values ($1, $2, 1.75, 3, 3) returning id`,
    [companyId(), stormId],
  );
  companyStormId = cs[0]!.id as string;
});

async function seedPlan(): Promise<void> {
  const task = await q(
    `insert into agent_tasks (company_id, agent, kind, title, status) values ($1, 'storm_scout', 'storm_plan', 'Plan', 'approved') returning id`,
    [companyId()],
  );
  taskId = task[0]!.id as string;
  const step = async (position: number, type: string, cls: string) =>
    (
      await q(
        `insert into agent_task_steps (company_id, task_id, position, type, approval_class, idempotency_key) values ($1, $2, $3, $4, $5, $6) returning id`,
        [companyId(), taskId, position, type, cls, `${taskId}-${position}`],
      )
    )[0]!.id as string;
  smsStepId = await step(1, 'send_sms_batch', 'message');
  emailStepId = await step(2, 'send_email_batch', 'message');
  await step(3, 'build_routes', 'internal');
  await q(`update company_storms set plan_task_id = $2 where id = $1`, [companyStormId, taskId]);
}

const customer = async () => (await insertFixtureProperty(q, companyId(), OMAHA_CORE, { withCustomer: true }));

describe('storm results', () => {
  test('counts every number from the rows', async () => {
    await seedPlan();
    const c1 = await customer();
    const c2 = await customer();
    const c3 = await customer();
    const sms = (customerId: string, status: string) =>
      q(
        `insert into messages (company_id, customer_id, channel, direction, purpose, body, status, step_id, sent_at, created_at, to_e164)
         values ($1, $2, 'sms', 'out', 'marketing', 'Hail hit', $3, $4, now() - interval '2 hours', now() - interval '2 hours', '+14025550100')`,
        [companyId(), customerId, status, smsStepId],
      );
    await sms(c1.customerId!, 'delivered');
    await sms(c2.customerId!, 'sent');
    await sms(c3.customerId!, 'failed');
    const reply = (customerId: string, body: string, ago = '1 hour') =>
      q(
        `insert into messages (company_id, customer_id, channel, direction, body, status, created_at, from_e164, to_e164)
         values ($1, $2, 'sms', 'in', $3, 'received', now() - $4::interval, '+14025550101', '+14025550100')`,
        [companyId(), customerId, body, ago],
      );
    await reply(c1.customerId!, 'YES');
    await reply(c2.customerId!, 'maybe later');
    // Before the plan text: not a reply to it. From a customer who got no plan text: not counted.
    await reply(c1.customerId!, 'YES', '3 hours');
    await reply(c3.customerId!, 'YES');
    await q(
      `update messages set created_at = now() - interval '5 minutes' where customer_id = $1 and direction = 'in' and company_id = $2`,
      [c3.customerId, companyId()],
    );

    const email = (to: string, status: string) =>
      q(
        `insert into messages (company_id, channel, direction, purpose, body, status, step_id, to_email, sent_at, created_at)
         values ($1, 'email', 'out', 'marketing', 'Hi', $2, $3, $4, now() - interval '2 hours', now() - interval '2 hours')`,
        [companyId(), status, emailStepId, to],
      );
    await email('a@example.com', 'delivered');
    await email('b@example.com', 'sent');
    await email('c@example.com', 'failed');
    await q(`insert into email_opt_outs (company_id, email, source) values ($1, 'A@example.com', 'link')`, [companyId()]);
    await q(`insert into email_opt_outs (company_id, email, source) values ($1, 'other@example.com', 'link')`, [companyId()]);

    const route = await q(
      `insert into door_routes (company_id, company_storm_id, user_id, name, stops) values ($1, $2, $3, 'R', 3) returning id`,
      [companyId(), companyStormId, t.seed.a.owner.userId],
    );
    const stop = (position: number, outcome: string | null) =>
      q(
        `insert into door_stops (company_id, route_id, position, point, outcome, outcome_at)
         values ($1, $2, $3, ST_SetSRID(ST_MakePoint(-95.92, 41.25), 4326), $4, case when $4::text is null then null else now() end)`,
        [companyId(), route[0]!.id, position, outcome],
      );
    await stop(1, 'wants_check');
    await stop(2, 'not_home');
    await stop(3, null);

    await q(
      `insert into ad_campaigns (company_id, company_storm_id, step_id, platform, daily_budget_cents, days, max_spend_cents, spend_cents, clicks)
       values ($1, $2, $3, 'google', 1000, 5, 5000, 1200, 7)`,
      [companyId(), companyStormId, emailStepId],
    );

    const page = await q(
      `insert into storm_pages (company_id, company_storm_id, code, active_until) values ($1, $2, 'results-code', now() + interval '7 days') returning id`,
      [companyId(), companyStormId],
    );
    for (const phone of ['+14025550111', '+14025550112']) {
      await q(`insert into storm_requests (company_id, storm_page_id, name, phone_e164, address) values ($1, $2, 'N', $3, '1 Main St')`, [
        companyId(),
        page[0]!.id,
        phone,
      ]);
    }

    const job = await q(
      `insert into jobs (company_id, customer_id, property_id, stage, source, storm_id) values ($1, $2, $3, 'lead', 'storm', $4) returning id`,
      [companyId(), c1.customerId, c1.propertyId, stormId],
    );
    const appt = (kind: string) =>
      q(
        `insert into appointments (company_id, kind, job_id, starts_at, ends_at) values ($1, $2, $3, now() + interval '1 day', now() + interval '1 day 1 hour')`,
        [companyId(), kind, job[0]!.id],
      );
    await appt('inspection');
    await appt('install');

    expect(await results()).toEqual({
      textsSent: 2,
      textsDelivered: 1,
      replies: 2,
      yesReplies: 1,
      emailsSent: 2,
      unsubscribes: 1,
      doorsKnocked: 2,
      wantsCheck: 1,
      adSpendCents: 1200,
      adMaxCents: 5000,
      adClicks: 7,
      landingRequests: 2,
      inspectionsBooked: 1,
    });
  });

  test('a storm with no plan returns zeros', async () => {
    expect(await results()).toEqual(ZEROS);
  });

  test('another company sees zeros for this storm', async () => {
    await seedPlan();
    const c1 = await customer();
    await q(
      `insert into messages (company_id, customer_id, channel, direction, purpose, body, status, step_id, sent_at, to_e164)
       values ($1, $2, 'sms', 'out', 'marketing', 'Hail hit', 'delivered', $3, now(), '+14025550100')`,
      [companyId(), c1.customerId, smsStepId],
    );
    expect((await results('a')).textsSent).toBe(1);
    expect(await results('b')).toEqual(ZEROS);
  });
});
