import { insertOmahaStorm, type Query } from '@roofline/db/testing';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { adSpendSync } from '../src/jobs/scheduler/ad-spend-sync.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { dbSteps, newTask } from './task-helpers.ts';

const owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
const q: Query = async (text, values) => (await owner.query(text, values)).rows;
const NOW = new Date('2026-10-12T15:00:00Z');

let t: TestApp;
let a: string;
let b: string;

async function insertAccount(companyId: string, status: string, platform = 'google', externalId = '1234567890'): Promise<void> {
  await owner.query(`insert into ad_accounts (company_id, platform, external_account_id, status) values ($1, $2, $3, $4)`, [
    companyId,
    platform,
    externalId,
    status,
  ]);
}

/** An active campaign row (with the company storm and agent step it needs) for the company. */
async function insertActiveCampaign(company: 'a' | 'b'): Promise<void> {
  const companyId = t.seed[company].companyId;
  const stormId = await insertOmahaStorm(q, company === 'a' ? '2026-10-11' : '2026-10-10');
  const storm = await owner.query(
    `insert into company_storms (company_id, storm_id, max_in, customers_hit, homes_hit) values ($1, $2, 1.5, 0, 0) returning id`,
    [companyId, stormId],
  );
  const { taskId } = await newTask(t, company);
  const stepId = (await dbSteps(t, company, taskId))[0]!.id;
  await owner.query(
    `insert into ad_campaigns (company_id, company_storm_id, step_id, platform, external_campaign_id, status,
                               daily_budget_cents, days, max_spend_cents, creative)
     values ($1, $2, $3, 'google', $4, 'active', 3857, 7, 27000, '{"endDate":"2026-10-18"}')`,
    [companyId, storm.rows[0].id, stepId, `g-sched-${company}`],
  );
}

afterAll(async () => {
  await owner.end();
});

beforeEach(async () => {
  t = await makeTestApp();
  a = t.seed.a.companyId;
  b = t.seed.b.companyId;
  await owner.query(`delete from ad_accounts where company_id in ($1, $2)`, [a, b]);
});

describe('ad spend sync schedule', () => {
  test('queues ad-sync-company with singletonKey = companyId for a company with a pending account', async () => {
    await insertAccount(a, 'pending');
    await adSpendSync(t.deps, NOW);
    expect(t.jobs.sent).toEqual([{ name: 'ad-sync-company', data: { companyId: a }, singletonKey: a }]);
  });

  test('queues nothing when no account is pending', async () => {
    await adSpendSync(t.deps, NOW);
    expect(t.jobs.sent).toEqual([]);
  });

  test('an active row and a revoked row do not queue', async () => {
    await insertAccount(a, 'active');
    await insertAccount(b, 'revoked');
    await adSpendSync(t.deps, NOW);
    expect(t.jobs.sent).toEqual([]);
  });

  test('two companies with pending accounts queue two jobs, ordered by company id', async () => {
    await insertAccount(a, 'pending');
    await insertAccount(b, 'pending');
    await adSpendSync(t.deps, NOW);
    const ids = [a, b].sort();
    expect(t.jobs.sent).toEqual(ids.map((id) => ({ name: 'ad-sync-company', data: { companyId: id }, singletonKey: id })));
  });

  test('a failing send for one company is logged and the other company is still queued', async () => {
    await insertAccount(a, 'pending');
    await insertAccount(b, 'pending');
    const [first, second] = [a, b].sort() as [string, string];
    const original = t.deps.jobs.send.bind(t.deps.jobs);
    let failed = false;
    t.deps.jobs.send = (async (...args: Parameters<typeof original>) => {
      if (!failed) {
        failed = true;
        throw new Error('queue down');
      }
      return original(...args);
    }) as typeof original;
    try {
      await adSpendSync(t.deps, NOW);
    } finally {
      t.deps.jobs.send = original;
    }
    expect(t.logged.map((l) => l.where)).toEqual([`ad-spend-sync: company ${first}`]);
    expect(t.jobs.sent).toEqual([{ name: 'ad-sync-company', data: { companyId: second }, singletonKey: second }]);
  });

  test('a company with an active campaign and no pending account is queued', async () => {
    await insertActiveCampaign('a');
    await adSpendSync(t.deps, NOW);
    expect(t.jobs.sent).toEqual([{ name: 'ad-sync-company', data: { companyId: a }, singletonKey: a }]);
  });

  test('a company with both a pending account and an active campaign is queued once', async () => {
    await insertAccount(a, 'pending');
    await insertActiveCampaign('a');
    await adSpendSync(t.deps, NOW);
    expect(t.jobs.sent).toEqual([{ name: 'ad-sync-company', data: { companyId: a }, singletonKey: a }]);
  });
});
