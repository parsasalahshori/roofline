import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import type { TaskStatus } from '@roofline/shared';
import { createPools, type Pools } from '../src/pools.ts';
import { replaceDraftPlan } from '../src/repos/storm-plans.ts';
import { sql } from 'drizzle-orm';
import { type Tx, withTenant } from '../src/tenant.ts';
import { resetDb, type SeededCompany, seedTwoCompanies } from '../src/testing/index.ts';
import { insertOmahaStorm, type Query } from './fixtures/storms.ts';

const urls = inject('dbUrls');

let owner: pg.Pool;
let pools: Pools;
let seed: { a: SeededCompany; b: SeededCompany };

const q: Query = async (text, values) => (await owner.query(text, values)).rows;

const NOW = new Date('2026-05-02T12:00:00Z');
const LATER = new Date('2026-05-03T12:00:00Z');
const EARLIER = new Date('2026-05-02T08:00:00Z');

const asCompany = <T>(companyId: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(pools, { companyId, userId: null, role: 'system', canApproveSpend: false }, fn);

const ctxOf = (companyId: string) => ({ companyId, userId: null, role: 'system' as const, canApproveSpend: false });

let stormSeq = 0;

/** Inserts a task (created at EARLIER) in the given status; returns its id. */
async function insertTask(companyId: string, status: TaskStatus): Promise<string> {
  const rows = await q(
    `insert into agent_tasks (company_id, agent, kind, title, status, created_at, updated_at)
     values ($1, 'storm_scout', 'storm_plan', 'Storm plan', $2, $3, $3) returning id`,
    [companyId, status, EARLIER],
  );
  return rows[0]!.id as string;
}

let stepSeq = 0;

async function insertStep(companyId: string, taskId: string, position: number, status: string): Promise<string> {
  stepSeq += 1;
  const rows = await q(
    `insert into agent_task_steps (company_id, task_id, position, type, approval_class, status, idempotency_key)
     values ($1, $2, $3, 'demo_noop', 'internal', $4, $5) returning id`,
    [companyId, taskId, position, status, `r2a-step-${stepSeq}-${taskId}`],
  );
  return rows[0]!.id as string;
}

/** A company storm for company A whose plan points at `planTaskId` (or null). */
async function insertCompanyStorm(planTaskId: string | null): Promise<string> {
  stormSeq += 1;
  const day = `2026-04-${String(stormSeq).padStart(2, '0')}`;
  const stormId = await insertOmahaStorm(q, day);
  const rows = await q(
    `insert into company_storms (company_id, storm_id, max_in, customers_hit, homes_hit, status, plan_task_id)
     values ($1, $2, 1.5, 0, 0, $3, $4) returning id`,
    [seed.a.companyId, stormId, planTaskId === null ? 'new' : 'planned', planTaskId],
  );
  return rows[0]!.id as string;
}

const pointerOf = async (csId: string) =>
  ((await q(`select plan_task_id from company_storms where id = $1`, [csId]))[0]!.plan_task_id as string | null) ?? null;

const taskRow = async (id: string) =>
  (await q(`select status, updated_at, declined_at, decline_reason from agent_tasks where id = $1`, [id]))[0]!;

const replace = (csId: string, newTaskId: string) =>
  asCompany(seed.a.companyId, (tx) => replaceDraftPlan(tx, ctxOf(seed.a.companyId), csId, newTaskId, LATER));

beforeAll(async () => {
  owner = new pg.Pool({ connectionString: urls.owner });
  pools = createPools({ tenant: urls.tenant, system: urls.system });
});

afterAll(async () => {
  await pools?.end();
  await owner?.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
  seed = await seedTwoCompanies(urls.owner);
});

describe('replaceDraftPlan', () => {
  test('replaces a draft plan: old task becomes declined with reason "Replaced by a newer plan.", its pending steps skipped, company_storms.plan_task_id = new task, returns true', async () => {
    const oldId = await insertTask(seed.a.companyId, 'draft');
    const pending = await insertStep(seed.a.companyId, oldId, 1, 'pending');
    const awaiting = await insertStep(seed.a.companyId, oldId, 2, 'awaiting_owner');
    const newId = await insertTask(seed.a.companyId, 'draft');
    const csId = await insertCompanyStorm(oldId);

    expect(await replace(csId, newId)).toBe(true);

    const old = await taskRow(oldId);
    expect(old.status).toBe('declined');
    expect(old.decline_reason).toBe('Replaced by a newer plan.');
    expect(old.declined_at).toEqual(LATER);
    const steps = await q(`select id, status from agent_task_steps where task_id = $1`, [oldId]);
    expect(steps.find((s) => s.id === pending)!.status).toBe('skipped');
    expect(steps.find((s) => s.id === awaiting)!.status).toBe('skipped');
    expect(await pointerOf(csId)).toBe(newId);
    expect((await taskRow(newId)).status).toBe('draft');
  });

  test('sets a new storm to planned when there was no plan', async () => {
    const newId = await insertTask(seed.a.companyId, 'draft');
    const csId = await insertCompanyStorm(null);
    expect(await replace(csId, newId)).toBe(true);
    expect(await pointerOf(csId)).toBe(newId);
    const [cs] = await q(`select status from company_storms where id = $1`, [csId]);
    expect(cs!.status).toBe('planned');
  });

  for (const status of ['expired', 'declined'] as const) {
    test(`replaces an ${status} plan: the old task and its steps are left as they were`, async () => {
      const oldId = await insertTask(seed.a.companyId, status);
      const step = await insertStep(seed.a.companyId, oldId, 1, 'pending');
      const before = await taskRow(oldId);
      const newId = await insertTask(seed.a.companyId, 'draft');
      const csId = await insertCompanyStorm(oldId);

      expect(await replace(csId, newId)).toBe(true);

      const after = await taskRow(oldId);
      expect(after.status).toBe(status);
      expect(after.updated_at).toEqual(before.updated_at);
      expect(after.decline_reason).toBe(before.decline_reason);
      const [s] = await q(`select status from agent_task_steps where id = $1`, [step]);
      expect(s!.status).toBe('pending');
      expect(await pointerOf(csId)).toBe(newId);
    });
  }

  for (const status of ['approved', 'running', 'awaiting_owner', 'partly_done', 'needs_attention', 'done'] as const) {
    test(`returns false and changes nothing when the plan is ${status}`, async () => {
      const oldId = await insertTask(seed.a.companyId, status);
      const before = await taskRow(oldId);
      const newId = await insertTask(seed.a.companyId, 'draft');
      const csId = await insertCompanyStorm(oldId);

      expect(await replace(csId, newId)).toBe(false);

      expect(await pointerOf(csId)).toBe(oldId);
      const after = await taskRow(oldId);
      expect(after.status).toBe(status);
      expect(after.updated_at).toEqual(before.updated_at);
    });
  }

  test('returns false and changes nothing when the storm id is unknown', async () => {
    const newId = await insertTask(seed.a.companyId, 'draft');
    expect(await replace('00000000-0000-4000-8000-000000000001', newId)).toBe(false);
    expect((await taskRow(newId)).status).toBe('draft');
  });

  test('returns false when an approve holding the task lock commits first', async () => {
    const oldId = await insertTask(seed.a.companyId, 'draft');
    const newId = await insertTask(seed.a.companyId, 'draft');
    const csId = await insertCompanyStorm(oldId);
    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query('select id from agent_tasks where id = $1 for update', [oldId]);
      const pending = replace(csId, newId);
      await client.query(`update agent_tasks set status = 'approved' where id = $1`, [oldId]);
      await client.query('commit');
      expect(await pending).toBe(false);
    } finally {
      client.release();
    }
    expect(await pointerOf(csId)).toBe(oldId);
    expect((await taskRow(oldId)).status).toBe('approved');
  });

  test('locks the task row: a re-draft that waits behind an approve returns false', async () => {
    const oldId = await insertTask(seed.a.companyId, 'draft');
    const newId = await insertTask(seed.a.companyId, 'draft');
    const csId = await insertCompanyStorm(oldId);

    let tx1Locked!: () => void;
    const locked = new Promise<void>((resolve) => (tx1Locked = resolve));
    let releaseTx1!: () => void;
    const release = new Promise<void>((resolve) => (releaseTx1 = resolve));

    // tx1 plays the approve: lock the task first, flip it to approved, hold the transaction open.
    const tx1 = asCompany(seed.a.companyId, async (tx) => {
      await tx.execute(sql`select id from agent_tasks where id = ${oldId}::uuid for update`);
      await tx.execute(sql`update agent_tasks set status = 'approved', updated_at = ${NOW} where id = ${oldId}::uuid`);
      tx1Locked();
      await release;
    });
    await locked;

    // tx2 is the re-draft; it must block on the task lock rather than read the stale 'draft'.
    const tx2 = replace(csId, newId);
    let settled = false;
    void tx2.then(
      () => (settled = true),
      () => (settled = true),
    );

    const deadline = Date.now() + 10_000;
    let waiting = false;
    while (!waiting && Date.now() < deadline) {
      const rows = await q(
        `select 1 from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%agent_tasks%for update%' and pid <> pg_backend_pid()`,
      );
      waiting = rows.length > 0;
      if (!waiting) await new Promise((r) => setTimeout(r, 25));
    }
    expect(waiting).toBe(true);
    expect(settled).toBe(false);

    releaseTx1();
    await tx1;
    expect(await tx2).toBe(false);

    expect((await taskRow(oldId)).status).toBe('approved');
    expect(await pointerOf(csId)).toBe(oldId);
  });
});
