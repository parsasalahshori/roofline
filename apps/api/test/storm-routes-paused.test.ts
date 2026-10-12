import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test, vi } from 'vitest';
import { insertOmahaStorm, type Query } from '@roofline/db/testing';
import { PLAN_DISMISSED, PLAN_PAUSED } from '../src/storm/plan-errors.ts';
import { Actors } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

/*
 * POST /api/storms/:id/plan when draftStormPlan answers null (Storm Scout paused) or throws a mapped error.
 * draftStormPlan is mocked, so these only prove the route mapping. They need Docker and run on CI only.
 */

const drafter = vi.hoisted(() => ({ draftStormPlan: vi.fn() }));

vi.mock('../src/storm/plan.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/storm/plan.ts')>()),
  draftStormPlan: drafter.draftStormPlan,
}));

let owner: pg.Pool;
let t: TestApp;
let who: Actors;

const q: Query = async (text, values) => (await owner.query(text, values)).rows;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
});
afterAll(async () => {
  await owner.end();
});

beforeEach(async () => {
  drafter.draftStormPlan.mockReset();
  t = await makeTestApp();
  who = new Actors(t);
});

async function addStorm(): Promise<string> {
  const stormId = await insertOmahaStorm(q, '2026-10-11');
  const rows = await q(
    `insert into company_storms (company_id, storm_id, max_in, customers_hit, homes_hit) values ($1, $2, 1.5, 3, 10) returning id`,
    [t.seed.a.companyId, stormId],
  );
  return rows[0]!.id as string;
}

describe('POST /api/storms/:id/plan with a mocked drafter', () => {
  test('a paused Storm Scout (null) is a 409 with the paused text', async () => {
    drafter.draftStormPlan.mockResolvedValue(null);
    const id = await addStorm();
    const res = await (await who.as('owner')).post(`/api/storms/${id}/plan`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(PLAN_PAUSED);
    expect(drafter.draftStormPlan).toHaveBeenCalledTimes(1);
  });

  test('a dismissed error from the drafter is a 409 with its message', async () => {
    drafter.draftStormPlan.mockRejectedValue(new Error(PLAN_DISMISSED));
    const id = await addStorm();
    const res = await (await who.as('owner')).post(`/api/storms/${id}/plan`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(PLAN_DISMISSED);
  });

  test('a drafted plan keeps the { taskId } answer', async () => {
    drafter.draftStormPlan.mockResolvedValue({ taskId: 'task-1' });
    const id = await addStorm();
    const res = await (await who.as('owner')).post(`/api/storms/${id}/plan`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ taskId: 'task-1' });
  });
});
