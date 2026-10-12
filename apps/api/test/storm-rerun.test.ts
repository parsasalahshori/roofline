import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { setPaused } from '@roofline/db';
import { insertFixtureProperty, insertOmahaStorm, OMAHA_CORE, type Query } from '@roofline/db/testing';
import { expireDrafts } from '../src/jobs/scheduler/expire-drafts.ts';
import { draftStormPlan, STORM_OFF } from '../src/storm/plan.ts';
import { Actors, inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { dbSteps, dbTask } from './task-helpers.ts';

/*
 * A1 Task 20 (Ruling BC): rerunning an expired storm plan re-drafts it through draftStormPlan.
 * Needs Docker; runs on CI only.
 */

const NOW = new Date('2026-10-12T15:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let owner: pg.Pool;
let t: TestApp;
let actors: Actors;
let companyStormId: string;

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
  t.clock.set(NOW);
  actors = new Actors(t);
  const stormId = await insertOmahaStorm(q, '2026-10-11');
  await q(
    `update companies set address_street = '1200 Farnam St', address_city = 'Omaha', address_state = 'NE', address_zip = '68102' where id = $1`,
    [companyId()],
  );
  const rows = await q(
    `insert into company_storms (company_id, storm_id, max_in, customers_hit, homes_hit) values ($1, $2, 1.75, 1, 1) returning id`,
    [companyId(), stormId],
  );
  companyStormId = rows[0]!.id as string;
  const { propertyId, customerId } = await insertFixtureProperty(q, companyId(), OMAHA_CORE, { withCustomer: true });
  await q(`insert into storm_hits (company_id, company_storm_id, property_id, customer_id, hail_in) values ($1, $2, $3, $4, 1.75)`, [
    companyId(),
    companyStormId,
    propertyId,
    customerId,
  ]);
});

const planRow = async () => (await q(`select plan_task_id from company_storms where id = $1`, [companyStormId]))[0]!;
const stormTaskCount = async () =>
  Number((await q(`select count(*)::int as n from agent_tasks where company_id = $1 and agent = 'storm_scout'`, [companyId()]))[0]!.n);

/** A drafted plan that has since expired. */
async function expiredPlan(): Promise<string> {
  const drafted = (await draftStormPlan(t.deps, companyId(), companyStormId, NOW))!;
  t.clock.set(new Date(NOW.getTime() + 30 * DAY_MS));
  await expireDrafts(t.deps, t.clock.now());
  expect((await dbTask(t, 'a', drafted.taskId)).status).toBe('expired');
  return drafted.taskId;
}

const rerun = async (taskId: string) => (await actors.as('owner')).post(`/api/approvals/${taskId}/rerun`).send();

describe('storm plan rerun', () => {
  test('an expired storm plan with a switched-off step reruns into a fresh draft via draftStormPlan', async () => {
    const oldId = await expiredPlan();
    const res = await rerun(oldId);
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(oldId);
    expect(res.body).toMatchObject({ status: 'draft', kind: 'storm_plan' });
    const steps = await dbSteps(t, 'a', res.body.id);
    const off = steps.filter((s) => !s.enabled);
    expect(off.length).toBeGreaterThan(0);
    // No Meta ad account is connected, so that step is rebuilt switched off with its reason.
    expect(off.some((s) => s.errorPlain === STORM_OFF.noMeta)).toBe(true);
    expect((await planRow()).plan_task_id).toBe(res.body.id);
    expect((await dbTask(t, 'a', oldId)).status).toBe('expired');
  });

  test('a second rerun of the same expired plan is a 409 This plan was already run again.', async () => {
    const oldId = await expiredPlan();
    expect((await rerun(oldId)).status).toBe(201);
    const again = await rerun(oldId);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('This plan was already run again.');
  });

  test('a paused Storm Scout answers 409 with Storm Scout is paused. Turn it back on in Agents to draft a plan. and makes no task', async () => {
    const oldId = await expiredPlan();
    const before = await stormTaskCount();
    expect(before).toBe(1);
    await inCompany(t, companyId(), (tx) =>
      setPaused(tx, { companyId: companyId(), userId: null, role: 'system', canApproveSpend: false }, 'storm_scout', true, t.clock.now()),
    );
    const res = await rerun(oldId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Storm Scout is paused. Turn it back on in Agents to draft a plan.');
    expect(await stormTaskCount()).toBe(1);
    expect((await planRow()).plan_task_id).toBe(oldId);
  });

  test('a dismissed storm answers 409 This storm was dismissed, so no plan is drafted. and makes no task', async () => {
    const oldId = await expiredPlan();
    await q(`update company_storms set status = 'dismissed' where id = $1`, [companyStormId]);
    const before = await stormTaskCount();
    const res = await rerun(oldId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('This storm was dismissed, so no plan is drafted.');
    expect(await stormTaskCount()).toBe(before);
    expect((await planRow()).plan_task_id).toBe(oldId);
  });

  test('a non-expired storm plan is a 409 Only expired plans can be run again.', async () => {
    const drafted = (await draftStormPlan(t.deps, companyId(), companyStormId, NOW))!;
    const res = await rerun(drafted.taskId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Only expired plans can be run again.');
  });
});
