import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { agentTasks, setPaused } from '@roofline/db';
import { insertOmahaStorm, type Query } from '@roofline/db/testing';
import { draftStormPlan } from '../src/storm/plan.ts';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

let owner: pg.Pool;
let t: TestApp;

const q: Query = async (text, values) => (await owner.query(text, values)).rows;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
});
afterAll(async () => {
  await owner.end();
});

beforeEach(async () => {
  t = await makeTestApp();
});

const stormTasks = (companyId: string) =>
  inCompany(t, companyId, (tx) => tx.select().from(agentTasks).where(eq(agentTasks.agent, 'storm_scout')));

/** A company storm the plan can be drafted for (no hits: every step is drafted switched off). */
async function companyStorm(companyId: string): Promise<string> {
  const stormId = await insertOmahaStorm(q, '2026-10-11');
  const rows = await q(
    `insert into company_storms (company_id, storm_id, max_in, customers_hit, homes_hit) values ($1, $2, 1.5, 0, 0) returning id`,
    [companyId, stormId],
  );
  return rows[0]!.id as string;
}

describe('Storm Scout pause', () => {
  test('a paused Storm Scout drafts nothing', async () => {
    const companyId = t.seed.a.companyId;
    await inCompany(t, companyId, (tx) =>
      setPaused(tx, { companyId, userId: null, role: 'system', canApproveSpend: false }, 'storm_scout', true, t.clock.now()),
    );
    await expect(draftStormPlan(t.deps, companyId, randomUUID(), t.clock.now())).resolves.toBeNull();
    expect(await stormTasks(companyId)).toHaveLength(0);
  });

  // S1 Task 11 filled the drafting body: an unpaused Storm Scout drafts the plan task.
  test('an unpaused Storm Scout drafts the plan', async () => {
    const companyId = t.seed.a.companyId;
    const id = await companyStorm(companyId);
    const drafted = await draftStormPlan(t.deps, companyId, id, t.clock.now());
    expect(drafted).not.toBeNull();
    const tasks = await stormTasks(companyId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: drafted!.taskId, kind: 'storm_plan', status: 'draft' });
  });
});
