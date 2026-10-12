import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { agentTasks, setPaused } from '@roofline/db';
import { insertOmahaStorm, type Query } from '@roofline/db/testing';
import { draftStormPlan } from '../src/storm/plan.ts';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

/*
 * A1 Task 14 (Ruling AX-K): the Storm Scout pause check sits at the top of draftStormPlan, inside the
 * drafting transaction and before the draft task is created. Needs Docker; runs on CI only.
 */

const NOW = new Date('2026-10-12T15:00:00Z');

let owner: pg.Pool;
let t: TestApp;
let companyStormId: string;

const q: Query = async (text, values) => (await owner.query(text, values)).rows;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
});
afterAll(async () => {
  await owner.end();
});

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
  const stormId = await insertOmahaStorm(q, '2026-10-11');
  const rows = await q(
    `insert into company_storms (company_id, storm_id, max_in, customers_hit, homes_hit) values ($1, $2, 1.75, 0, 0) returning id`,
    [t.seed.a.companyId, stormId],
  );
  companyStormId = rows[0]!.id as string;
});

const stormTasks = (companyId: string) =>
  inCompany(t, companyId, (tx) => tx.select().from(agentTasks).where(eq(agentTasks.agent, 'storm_scout')));

describe('Storm Scout pause', () => {
  test('a paused Storm Scout drafts nothing', async () => {
    const companyId = t.seed.a.companyId;
    await inCompany(t, companyId, (tx) =>
      setPaused(tx, { companyId, userId: null, role: 'system', canApproveSpend: false }, 'storm_scout', true, t.clock.now()),
    );
    await expect(draftStormPlan(t.deps, companyId, companyStormId, NOW)).resolves.toBeNull();
    expect(await stormTasks(companyId)).toHaveLength(0);
    const [row] = await q(`select plan_task_id from company_storms where id = $1`, [companyStormId]);
    expect(row!.plan_task_id).toBeNull();
  });

  test('an unpaused Storm Scout drafts the storm plan as a draft task', async () => {
    const companyId = t.seed.a.companyId;
    const drafted = await draftStormPlan(t.deps, companyId, companyStormId, NOW);
    expect(drafted).not.toBeNull();
    const tasks = await stormTasks(companyId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: drafted!.taskId, status: 'draft', kind: 'storm_plan' });
  });
});
