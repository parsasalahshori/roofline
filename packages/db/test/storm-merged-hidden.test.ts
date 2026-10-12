import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { createPools, type Pools } from '../src/pools.ts';
import { upsertCompanyStorm } from '../src/repos/company-storms.ts';
import { getCompanyStormSummary, listCompanyStorms } from '../src/repos/storm-api.ts';
import { loadStormPlanFacts } from '../src/repos/storm-plans.ts';
import { getAlertFacts, listSettleCandidates, listUnalertedMatched } from '../src/repos/storm-alerts.ts';
import { type Tx, withTenant } from '../src/tenant.ts';
import { resetDb, type SeededCompany, seedTwoCompanies } from '../src/testing/index.ts';
import { insertOmahaStorm, type Query } from './fixtures/storms.ts';

const urls = inject('dbUrls');

let owner: pg.Pool;
let pools: Pools;
let seed: { a: SeededCompany; b: SeededCompany };

const q: Query = async (text, values) => (await owner.query(text, values)).rows;

const asCompany = <T>(companyId: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(pools, { companyId, userId: null, role: 'system', canApproveSpend: false }, fn);

const DAY = '2026-05-01';
const NOW = new Date('2026-05-02T12:00:00Z');

/** Makes a storm on DAY and the company's storm row for it; created_at is set to now() so the 3-day bound is stable. */
async function matchStorm(companyId: string) {
  const stormId = await insertOmahaStorm(q, DAY);
  const { companyStorm } = await asCompany(companyId, (tx) =>
    upsertCompanyStorm(tx, { stormId, maxIn: 1.5, customersHit: 3, homesHit: 7, now: NOW }),
  );
  await q(`update company_storms set created_at = now() where id = $1`, [companyStorm.id]);
  return { stormId, companyStormId: companyStorm.id };
}

/** Marks the storm as merged into a second storm. */
async function mergeAway(stormId: string): Promise<void> {
  const survivor = await insertOmahaStorm(q, DAY);
  await q(`update storms set merged_into = $1 where id = $2`, [survivor, stormId]);
}

async function planTask(companyId: string): Promise<string> {
  const rows = await q(
    `insert into agent_tasks (company_id, agent, kind, title, status) values ($1, 'system', 'storm_plan', 't', 'draft') returning id`,
    [companyId],
  );
  return rows[0]!.id as string;
}

beforeAll(async () => {
  owner = new pg.Pool({ connectionString: urls.owner });
  pools = createPools({ tenant: urls.tenant, system: urls.system });
  await owner.query('select 1');
});

afterAll(async () => {
  await pools?.end();
  await owner?.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
  seed = await seedTwoCompanies(urls.owner);
});

describe('merged storms are hidden from company reads', () => {
  test('a merged storm with no plan is not listed', async () => {
    const { stormId, companyStormId } = await matchStorm(seed.a.companyId);
    const ctx = { companyId: seed.a.companyId, userId: null, role: 'system' as const, canApproveSpend: false };
    const read = () =>
      asCompany(seed.a.companyId, async (tx) => ({
        list: await listCompanyStorms(tx, ctx),
        one: await getCompanyStormSummary(tx, ctx, companyStormId),
      }));
    const before = await read();
    expect(before.list.map((r) => r.id)).toEqual([companyStormId]);
    expect(before.one?.id).toBe(companyStormId);

    await mergeAway(stormId);
    const after = await read();
    expect(after.list).toEqual([]);
    expect(after.one).toBeNull();
  });

  test('a merged storm with a plan stays listed', async () => {
    const { stormId, companyStormId } = await matchStorm(seed.a.companyId);
    const taskId = await planTask(seed.a.companyId);
    await q(`update company_storms set plan_task_id = $2 where id = $1`, [companyStormId, taskId]);
    await mergeAway(stormId);
    const ctx = { companyId: seed.a.companyId, userId: null, role: 'system' as const, canApproveSpend: false };
    const { list, one } = await asCompany(seed.a.companyId, async (tx) => ({
      list: await listCompanyStorms(tx, ctx),
      one: await getCompanyStormSummary(tx, ctx, companyStormId),
    }));
    expect(list.map((r) => r.id)).toEqual([companyStormId]);
    expect(one?.planTaskId).toBe(taskId);
  });
});

describe('draft and alert facts ignore merged storms', () => {
  const ctx = (companyId: string) => ({ companyId, userId: null, role: 'system' as const, canApproveSpend: false });

  test('a merged storm with no plan has no draft or alert facts', async () => {
    const { stormId, companyStormId } = await matchStorm(seed.a.companyId);
    await mergeAway(stormId);
    const { plan, alert } = await asCompany(seed.a.companyId, async (tx) => ({
      plan: await loadStormPlanFacts(tx, ctx(seed.a.companyId), companyStormId),
      alert: await getAlertFacts(tx, companyStormId),
    }));
    expect(plan).toBeNull();
    expect(alert).toBeNull();
  });

  test('a merged storm with a plan keeps its draft and alert facts', async () => {
    const { stormId, companyStormId } = await matchStorm(seed.a.companyId);
    const taskId = await planTask(seed.a.companyId);
    await q(`update company_storms set plan_task_id = $2 where id = $1`, [companyStormId, taskId]);
    await mergeAway(stormId);
    const { plan, alert } = await asCompany(seed.a.companyId, async (tx) => ({
      plan: await loadStormPlanFacts(tx, ctx(seed.a.companyId), companyStormId),
      alert: await getAlertFacts(tx, companyStormId),
    }));
    expect(plan?.planTaskId).toBe(taskId);
    expect(alert?.planTaskId).toBe(taskId);
  });
});

describe('alert and settle reads ignore merged storms', () => {
  test('listUnalertedMatched skips a merged storm', async () => {
    const kept = await matchStorm(seed.a.companyId);
    const merged = await matchStorm(seed.a.companyId);
    await mergeAway(merged.stormId);
    const ids = await asCompany(seed.a.companyId, (tx) => listUnalertedMatched(tx));
    expect(ids).toEqual([kept.companyStormId]);
  });

  test('listUnalertedMatched skips rows older than 3 days', async () => {
    const old = await matchStorm(seed.a.companyId);
    const recent = await matchStorm(seed.a.companyId);
    await q(`update company_storms set created_at = now() - interval '4 days' where id = $1`, [old.companyStormId]);
    await q(`update company_storms set created_at = now() - interval '2 days' where id = $1`, [recent.companyStormId]);
    const ids = await asCompany(seed.a.companyId, (tx) => listUnalertedMatched(tx));
    expect(ids).toEqual([recent.companyStormId]);
  });

  test('listSettleCandidates skips a merged storm', async () => {
    const kept = await matchStorm(seed.a.companyId);
    const merged = await matchStorm(seed.a.companyId);
    await mergeAway(merged.stormId);
    const rows = await asCompany(seed.a.companyId, (tx) => listSettleCandidates(tx, [DAY]));
    expect(rows.map((r) => r.companyStormId)).toEqual([kept.companyStormId]);
  });
});
