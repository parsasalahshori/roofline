import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, inject, test } from 'vitest';
import { agentTasks, agentTaskSteps, createPools, type Pools, type TenantContext, withTenant } from '@roofline/db';
import { companiesWithExpiredDrafts, companiesWithExpiredLeases, stepsQueuedLongerThan } from '@roofline/db/system';
import type { AppDeps } from '../src/app.ts';
import { expireDrafts } from '../src/jobs/scheduler/expire-drafts.ts';
import { QUEUED_TOO_LONG_MS, sweepQueued } from '../src/jobs/scheduler/sweep-queued.ts';
import type { QueuedStep, StepQueue } from '../src/tasks/queue.ts';
import { rerunTask } from '../src/tasks/service.ts';
import { Actors, dbAudit, inCompany, NO_UUID, NOT_FOUND } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { DEMO_STEPS, dbSteps, dbTask, newCustomers, newTask, seenOf, setStep, setTask, smsStep } from './task-helpers.ts';

/*
 * The scheduler's jobs (draft expiry and the queued-step sweeper) and "run it again" for an expired
 * plan. The jobs find the companies with work through app_system (ids and statuses only) and do
 * the work for each company in its own app_tenant transaction.
 */

const NOW = new Date('2026-10-12T15:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const RERUN_ONLY_EXPIRED = 'Only expired plans can be run again.';
const ALREADY_RERUN = 'This plan was already run again.';
const MARKETING = 'Marketing texts must include your company name and "Reply STOP to opt out".';

let t: TestApp;
let actors: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
  actors = new Actors(t);
});

const idOf = (company: 'a' | 'b') => t.seed[company].companyId;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
const rerunUrl = (taskId: string) => `/api/approvals/${taskId}/rerun`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The promise's outcome, or 'timeout' if it has not settled within `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([promise, sleep(ms).then(() => 'timeout' as const)]);
}

/** A one-step task whose step is put straight into `set` (bypassing approval), with the task running. */
async function stepIn(company: 'a' | 'b', set: Partial<typeof agentTaskSteps.$inferInsert>, label = 'Routes') {
  const { taskId } = await newTask(t, company, { steps: [{ type: 'demo_noop', payload: { label } }] });
  const [step] = await dbSteps(t, company, taskId);
  await setTask(t, company, taskId, { status: 'running', updatedAt: NOW });
  await setStep(t, company, step!.id, set);
  return { taskId, stepId: step!.id };
}

const stepRow = async (company: 'a' | 'b', stepId: string) =>
  inCompany(t, idOf(company), async (tx) => (await tx.select().from(agentTaskSteps).where(eq(agentTaskSteps.id, stepId)))[0]!);

const allTasks = (company: 'a' | 'b') => inCompany(t, idOf(company), (tx) => tx.select().from(agentTasks));

// ---------------------------------------------------------------------------------------------

describe('expireDrafts', () => {
  test('a draft past its expiry becomes expired; a draft of company B with a future expiry is untouched', async () => {
    const { taskId: aTask } = await newTask(t, 'a', { expiresAt: at(-MINUTE) });
    const { taskId: bTask } = await newTask(t, 'b', { expiresAt: at(HOUR) });

    expect(await expireDrafts(t.deps, NOW)).toEqual({ expired: 1 });

    expect(await dbTask(t, 'a', aTask)).toMatchObject({ status: 'expired', updatedAt: NOW });
    expect((await dbTask(t, 'b', bTask)).status).toBe('draft');
    // Only the task: the steps of an expired plan stay pending (nothing of it was approved).
    expect((await dbSteps(t, 'a', aTask)).map((s) => s.status)).toEqual(['pending', 'pending', 'pending']);
  });

  test('only drafts whose time has passed: one with no expiry, one expiring right now, or a plan already past the draft stage is left alone', async () => {
    const draft = async (expiresAt: Date | undefined, status?: 'awaiting_owner' | 'running' | 'declined') => {
      const { taskId } = await newTask(t, 'a', { ...(expiresAt && { expiresAt }) });
      if (status) await setTask(t, 'a', taskId, { status });
      return taskId;
    };
    const noExpiry = await draft(undefined);
    const rightNow = await draft(NOW);
    const waiting = await draft(at(-HOUR), 'awaiting_owner');
    const running = await draft(at(-HOUR), 'running');
    const declined = await draft(at(-HOUR), 'declined');
    const due = await draft(at(-1));

    expect(await expireDrafts(t.deps, NOW)).toEqual({ expired: 1 });
    const status = async (id: string) => (await dbTask(t, 'a', id)).status;
    expect(await status(due)).toBe('expired');
    expect([await status(noExpiry), await status(rightNow), await status(waiting), await status(running), await status(declined)]).toEqual([
      'draft',
      'draft',
      'awaiting_owner',
      'running',
      'declined',
    ]);
  });

  test('every company with an expired draft is reached, each once; a second pass finds nothing', async () => {
    await newTask(t, 'a', { expiresAt: at(-HOUR) });
    await newTask(t, 'a', { expiresAt: at(-MINUTE) });
    await newTask(t, 'b', { expiresAt: at(-MINUTE) });

    expect((await companiesWithExpiredDrafts(t.deps.pools.system, NOW)).sort()).toEqual([idOf('a'), idOf('b')].sort());
    expect(await expireDrafts(t.deps, NOW)).toEqual({ expired: 3 });
    expect(await companiesWithExpiredDrafts(t.deps.pools.system, NOW)).toEqual([]);
    expect(await expireDrafts(t.deps, NOW)).toEqual({ expired: 0 });
  });

  test('an expired plan can no longer be approved, and the list still shows it without counting it', async () => {
    const { taskId } = await newTask(t, 'a', { expiresAt: at(-MINUTE) });
    await expireDrafts(t.deps, NOW);
    const owner = await actors.as('owner');
    const res = await owner.post(`/api/approvals/${taskId}/approve`).send(seenOf(await dbSteps(t, 'a', taskId)));
    expect(res.status).toBe(409);
    const list = await owner.get('/api/approvals');
    expect(list.body.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe('POST /api/approvals/:taskId/rerun', () => {
  /** A demo plan made at NOW with a 48-hour window, then left to expire: the clock is 49 hours on. */
  async function expiredDemo() {
    const { taskId } = await newTask(t, 'a', { expiresAt: at(48 * HOUR) });
    t.clock.set(at(49 * HOUR));
    await expireDrafts(t.deps, t.clock.now());
    expect((await dbTask(t, 'a', taskId)).status).toBe('expired');
    return { taskId, steps: await dbSteps(t, 'a', taskId) };
  }

  test('a fresh draft with the same steps and payloads, new ids and keys, and the same 48-hour window from now', async () => {
    const { taskId, steps } = await expiredDemo();
    const owner = await actors.as('owner');

    const res = await owner.post(rerunUrl(taskId)).send();
    expect(res.status).toBe(201);
    const view = res.body;
    expect(view.id).not.toBe(taskId);
    expect(view).toMatchObject({
      agent: 'storm_scout',
      kind: 'storm_plan',
      title: 'Storm plan: Elm Street',
      summary: 'Three steps for the Elm Street hail swath.',
      status: 'draft',
      expired: false,
      createdAt: t.clock.now().toISOString(),
      expiresAt: new Date(t.clock.now().getTime() + 48 * HOUR).toISOString(),
    });
    expect(view.steps.map((s: { type: string; payload: unknown }) => [s.type, s.payload])).toEqual(
      DEMO_STEPS.map((s) => [s.type, s.payload]),
    );
    expect(view.steps.map((s: { status: string; enabled: boolean; version: number }) => [s.status, s.enabled, s.version])).toEqual([
      ['pending', true, 1],
      ['pending', true, 1],
      ['pending', true, 1],
    ]);

    const fresh = await dbSteps(t, 'a', view.id);
    const oldIds = new Set(steps.map((s) => s.id));
    const oldKeys = new Set(steps.map((s) => s.idempotencyKey));
    expect(fresh.every((s) => !oldIds.has(s.id) && !oldKeys.has(s.idempotencyKey))).toBe(true);
    expect(fresh.map((s) => s.preview)).toEqual(steps.map((s) => s.preview));

    // The old plan stays as it was; the new one waits in the queue.
    expect((await dbTask(t, 'a', taskId)).status).toBe('expired');
    expect((await dbSteps(t, 'a', taskId)).map((s) => s.status)).toEqual(['pending', 'pending', 'pending']);
    const list = await owner.get('/api/approvals');
    expect(list.body.count).toBe(1);
    expect(list.body.tasks.map((x: { id: string }) => x.id)).toEqual([view.id]);

    const [audit] = await dbAudit(t, idOf('a'), 'task.rerun');
    expect(audit).toMatchObject({ actorUserId: t.seed.a.owner.userId, targetType: 'agent_task', targetId: view.id, after: { fromTaskId: taskId } });
    expect(await dbAudit(t, idOf('a'), 'task.create')).toHaveLength(2);

    // The new draft can be approved and run like any other.
    const approved = await owner.post(`/api/approvals/${view.id}/approve`).send(seenOf(fresh));
    expect(approved.status).toBe(200);
    await t.queue.drain(t.deps);
    expect((await dbTask(t, 'a', view.id)).status).toBe('done');
  });

  test('the agent, kind, title, summary, subject and mode are copied; a plan that had no window gets none', async () => {
    const subjectId = '11111111-1111-4111-8111-111111111111';
    const { taskId } = await newTask(t, 'a', {
      agent: 'follow_up',
      kind: 'proposal_nudge',
      title: 'Nudge the Hendersons',
      summary: 'One text.',
      subjectType: 'job',
      subjectId,
      mode: 'live',
    });
    await setTask(t, 'a', taskId, { status: 'expired' });
    const res = await (await actors.as('owner')).post(rerunUrl(taskId)).send();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ agent: 'follow_up', kind: 'proposal_nudge', title: 'Nudge the Hendersons', summary: 'One text.', expiresAt: null });
    expect(await dbTask(t, 'a', res.body.id)).toMatchObject({ subjectType: 'job', subjectId, mode: 'live', status: 'draft', expiresAt: null });
  });

  test('a draft past its time that the expiry job has not reached yet counts as expired, and is marked so', async () => {
    // Made 49 hours ago with a 48-hour window: it ran out an hour ago.
    t.clock.set(at(-49 * HOUR));
    const { taskId } = await newTask(t, 'a', { expiresAt: at(-HOUR) });
    t.clock.set(NOW);
    expect((await dbTask(t, 'a', taskId)).status).toBe('draft');

    const res = await (await actors.as('owner')).post(rerunUrl(taskId)).send();
    expect(res.status).toBe(201);
    expect(res.body.expiresAt).toBe(at(48 * HOUR).toISOString());
    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'expired', updatedAt: NOW });
  });

  test('a plan that is not expired → 409 "Only expired plans can be run again.", and no new plan is made', async () => {
    const owner = await actors.as('owner');
    for (const status of ['draft', 'awaiting_owner', 'running', 'done', 'partly_done', 'needs_attention', 'declined'] as const) {
      const { taskId } = await newTask(t, 'a', { expiresAt: at(HOUR) });
      if (status !== 'draft') await setTask(t, 'a', taskId, { status });
      const res = await owner.post(rerunUrl(taskId)).send();
      expect(res.status, status).toBe(409);
      expect(res.body, status).toEqual({ error: RERUN_ONLY_EXPIRED });
    }
    expect(await allTasks('a')).toHaveLength(7);
    expect(await dbAudit(t, idOf('a'), 'task.rerun')).toEqual([]);
  });

  test('payloads are checked again, as when a plan is made: a text naming the old company name is refused after a rename', async () => {
    const [id] = await newCustomers(t, 'a', ['Molly']);
    const literal = 'Acme Roofing here: free roof checks this week. Reply STOP to opt out.';
    const { taskId } = await newTask(t, 'a', { steps: [{ type: 'demo_noop', payload: { label: 'Routes' } }, smsStep([id!], { body: literal })] });
    await setTask(t, 'a', taskId, { status: 'expired' });
    const owner = await actors.as('owner');
    expect((await owner.patch('/api/company').send({ name: 'Zenith Roofing' })).status).toBe(200);

    const res = await owner.post(rerunUrl(taskId)).send();
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: MARKETING, field: 'steps.1.payload' });
    expect(await allTasks('a')).toHaveLength(1);
    expect(await dbAudit(t, idOf('a'), 'task.rerun')).toEqual([]);
  });

  test('the office may run a plan again; a rep, another company, or an unknown or malformed id gets a 404', async () => {
    const { taskId } = await newTask(t, 'a', { expiresAt: at(-MINUTE) });
    await expireDrafts(t.deps, NOW);
    for (const [who, company, id] of [
      ['rep', 'a', taskId],
      ['owner', 'b', taskId],
      ['owner', 'a', NO_UUID],
      ['owner', 'a', 'not-a-uuid'],
    ] as const) {
      const res = await (await actors.as(who, company)).post(rerunUrl(id)).send();
      expect(res.status, `${who} ${company} ${id}`).toBe(404);
      expect(res.body).toEqual({ error: NOT_FOUND });
    }
    expect(await allTasks('a')).toHaveLength(1);
    const office = await (await actors.as('office')).post(rerunUrl(taskId)).send();
    expect(office.status).toBe(201);
    expect((await dbAudit(t, idOf('a'), 'task.rerun'))[0]).toMatchObject({ actorUserId: t.seed.a.office.userId });
  });
});

describe('a plan is run again once', () => {
  const ownerCtx = (): TenantContext => ({ companyId: idOf('a'), userId: t.seed.a.owner.userId, role: 'owner', canApproveSpend: true });

  async function expiredPlan() {
    const { taskId } = await newTask(t, 'a', { expiresAt: at(-MINUTE) });
    await expireDrafts(t.deps, NOW);
    return taskId;
  }

  let owner: pg.Client | undefined;
  afterEach(async () => {
    await owner?.query('rollback').catch(() => undefined);
    await owner?.end();
    owner = undefined;
  });

  test('the new draft records which plan it came from; asking again → 409 "This plan was already run again."', async () => {
    const taskId = await expiredPlan();
    const agent = await actors.as('owner');
    const first = await agent.post(rerunUrl(taskId)).send();
    expect(first.status).toBe(201);
    expect(await dbTask(t, 'a', first.body.id)).toMatchObject({ rerunOfTaskId: taskId, status: 'draft' });
    expect((await dbTask(t, 'a', taskId)).rerunOfTaskId).toBeNull();

    const again = await (await actors.as('office')).post(rerunUrl(taskId)).send();
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: ALREADY_RERUN });
    expect(await allTasks('a')).toHaveLength(2);
    expect(await dbAudit(t, idOf('a'), 'task.rerun')).toHaveLength(1);

    // The new draft can itself be run again once it expires; that makes a third plan, not a second copy of the first.
    await setTask(t, 'a', first.body.id, { status: 'expired' });
    const third = await agent.post(rerunUrl(first.body.id)).send();
    expect(third.status).toBe(201);
    expect(await dbTask(t, 'a', third.body.id)).toMatchObject({ rerunOfTaskId: first.body.id });
  });

  test('two clicks at once: one 201 and one 409, and exactly one new plan', async () => {
    const taskId = await expiredPlan();
    const [ownerAgent, officeAgent] = [await actors.as('owner'), await actors.as('office')];
    const results = await Promise.all([ownerAgent.post(rerunUrl(taskId)).send(), officeAgent.post(rerunUrl(taskId)).send()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body).toEqual({ error: ALREADY_RERUN });
    const copies = (await allTasks('a')).filter((row) => row.rerunOfTaskId === taskId);
    expect(copies).toHaveLength(1);
    expect(await dbAudit(t, idOf('a'), 'task.rerun')).toHaveLength(1);
  });

  test('two reruns that really overlap: the second waits for the first\'s lock on the old plan, then finds it already run again', async () => {
    const taskId = await expiredPlan();
    const ctx = ownerCtx();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let worked!: () => void;
    const firstWorked = new Promise<void>((resolve) => (worked = resolve));

    const first = withTenant(t.deps.pools, ctx, async (tx) => {
      const view = await rerunTask(tx, ctx, taskId, { now: NOW });
      worked();
      await gate;
      return view;
    });
    first.catch(() => worked());
    await firstWorked;
    const second = withTenant(t.deps.pools, ctx, (tx) => rerunTask(tx, ctx, taskId, { now: NOW }));
    const waited = await waitUntilSomeoneIsBlocked();
    release();
    const [r1, r2] = await Promise.allSettled([first, second]);

    expect(waited).toBe(true);
    expect(r1.status).toBe('fulfilled');
    expect(r2.status).toBe('rejected');
    expect((r2 as PromiseRejectedResult).reason).toMatchObject({ status: 409, message: ALREADY_RERUN });
    expect((await allTasks('a')).filter((row) => row.rerunOfTaskId === taskId)).toHaveLength(1);
  });

  test('the unique index is the backstop: a rerun that collides with a copy not yet committed gets the 409, never a 500', async () => {
    const taskId = await expiredPlan();
    owner = new pg.Client({ connectionString: inject('dbUrls').owner });
    await owner.connect();
    await owner.query('begin');
    // A copy of the plan made by some other path that skipped the check, still uncommitted.
    await owner.query(
      `insert into agent_tasks (company_id, agent, kind, title, rerun_of_task_id) values ($1, 'storm_scout', 'storm_plan', 'Copy', $2)`,
      [idOf('a'), taskId],
    );
    const pending = (await actors.as('owner')).post(rerunUrl(taskId)).send().then((r) => r);
    expect(await waitUntilSomeoneIsBlocked()).toBe(true);
    await owner.query('commit');
    const res = await pending;
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: ALREADY_RERUN });
    expect((await allTasks('a')).filter((row) => row.rerunOfTaskId === taskId).map((row) => row.title)).toEqual(['Copy']);
    expect(t.logged).toEqual([]);
  });

  test('the database keeps one copy per plan per company; plans that are not copies are not limited', async () => {
    const aTask = await expiredPlan();
    owner = new pg.Client({ connectionString: inject('dbUrls').owner });
    await owner.connect();
    const insert = (companyId: string, rerunOf: string | null) =>
      owner!.query(`insert into agent_tasks (company_id, agent, kind, title, rerun_of_task_id) values ($1, 'storm_scout', 'storm_plan', 'Copy', $2)`, [
        companyId,
        rerunOf,
      ]);
    await insert(idOf('a'), aTask);
    await expect(insert(idOf('a'), aTask)).rejects.toMatchObject({ code: '23505', constraint: 'agent_tasks_company_rerun_of_uniq' });
    await insert(idOf('a'), null);
    await insert(idOf('a'), null);
  });
});

let lockPools: Pools | undefined;
afterAll(async () => {
  await lockPools?.end();
});

/** True once some query is waiting on a lock (seen from the table owner, who can see every session). */
async function waitUntilSomeoneIsBlocked(timeoutMs = 5000): Promise<boolean> {
  const urls = inject('dbUrls');
  lockPools ??= createPools({ tenant: urls.owner, system: urls.owner });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await lockPools.system.$client.query(
      "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
    );
    if ((rows[0] as { n: number }).n > 0) return true;
    await sleep(20);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------

describe('sweepQueued: steps left in the queue', () => {
  test('re-enqueues a step stuck in queued for 3 minutes and leaves a 1-minute-old one alone', async () => {
    const stuck = await stepIn('a', { status: 'queued', updatedAt: at(-3 * MINUTE) });
    const fresh = await stepIn('a', { status: 'queued', updatedAt: at(-MINUTE) });

    expect(await sweepQueued(t.deps, NOW)).toEqual({ resent: 1, reclaimed: 0 });
    expect(t.queue.calls).toEqual([{ companyId: idOf('a'), stepId: stuck.stepId }]);
    // Re-sending changes nothing on the step itself.
    expect(await stepRow('a', stuck.stepId)).toMatchObject({ status: 'queued', updatedAt: at(-3 * MINUTE) });
    expect(await stepRow('a', fresh.stepId)).toMatchObject({ status: 'queued' });
    expect(QUEUED_TOO_LONG_MS).toBe(2 * MINUTE);
  });

  test('every company\'s stuck steps are re-sent under their own company; steps in any other status are not', async () => {
    const a = await stepIn('a', { status: 'queued', updatedAt: at(-10 * MINUTE) });
    const b = await stepIn('b', { status: 'queued', updatedAt: at(-10 * MINUTE) });
    for (const status of ['pending', 'awaiting_owner', 'skipped', 'done', 'failed', 'needs_attention'] as const) {
      await stepIn('a', { status, updatedAt: at(-HOUR) });
    }
    await stepIn('a', { status: 'running', leaseExpiresAt: null, updatedAt: at(-HOUR) }); // parked

    const found = await stepsQueuedLongerThan(t.deps.pools.system, QUEUED_TOO_LONG_MS, NOW);
    expect(found.sort((x, y) => x.stepId.localeCompare(y.stepId))).toEqual(
      [
        { companyId: idOf('a'), stepId: a.stepId },
        { companyId: idOf('b'), stepId: b.stepId },
      ].sort((x, y) => x.stepId.localeCompare(y.stepId)),
    );
    await sweepQueued(t.deps, NOW);
    expect([...t.queue.calls].sort((x, y) => x.stepId.localeCompare(y.stepId))).toEqual(
      found.sort((x, y) => x.stepId.localeCompare(y.stepId)),
    );
  });

  test('a re-sent step runs normally', async () => {
    const { taskId, stepId } = await stepIn('a', { status: 'queued', updatedAt: at(-3 * MINUTE) });
    await sweepQueued(t.deps, NOW);
    await t.queue.drain(t.deps);
    expect(await stepRow('a', stepId)).toMatchObject({ status: 'done', attempts: 1 });
    expect((await dbTask(t, 'a', taskId)).status).toBe('done');
  });
});

describe('sweepQueued: runs that died (expired leases)', () => {
  test('a running step whose lease has passed goes back to queued and is enqueued; a parked step and a live lease are untouched', async () => {
    const deadA = await stepIn('a', { status: 'running', attempts: 2, runSeq: 2, leaseExpiresAt: at(-MINUTE), updatedAt: at(-11 * MINUTE) });
    const deadB = await stepIn('b', { status: 'running', attempts: 1, runSeq: 1, leaseExpiresAt: at(-1), updatedAt: at(-11 * MINUTE) });
    const parked = await stepIn('a', { status: 'running', attempts: 1, leaseExpiresAt: null, updatedAt: at(-HOUR) });
    const live = await stepIn('a', { status: 'running', attempts: 1, leaseExpiresAt: at(5 * MINUTE), updatedAt: at(-5 * MINUTE) });

    expect((await companiesWithExpiredLeases(t.deps.pools.system, NOW)).sort()).toEqual([idOf('a'), idOf('b')].sort());
    expect(await sweepQueued(t.deps, NOW)).toEqual({ resent: 0, reclaimed: 2 });

    expect(await stepRow('a', deadA.stepId)).toMatchObject({ status: 'queued', attempts: 2, runSeq: 2, leaseExpiresAt: null, updatedAt: NOW });
    expect(await stepRow('b', deadB.stepId)).toMatchObject({ status: 'queued', attempts: 1, leaseExpiresAt: null, updatedAt: NOW });
    expect(await stepRow('a', parked.stepId)).toMatchObject({ status: 'running', leaseExpiresAt: null, updatedAt: at(-HOUR) });
    expect(await stepRow('a', live.stepId)).toMatchObject({ status: 'running', leaseExpiresAt: at(5 * MINUTE) });
    expect([...t.queue.calls].sort((x, y) => x.stepId.localeCompare(y.stepId))).toEqual(
      [
        { companyId: idOf('a'), stepId: deadA.stepId },
        { companyId: idOf('b'), stepId: deadB.stepId },
      ].sort((x, y) => x.stepId.localeCompare(y.stepId)),
    );
    expect(await companiesWithExpiredLeases(t.deps.pools.system, NOW)).toEqual([]);

    // A month on, the live run's lease has passed too, but a parked step is never reclaimed, however long it waits.
    expect(await sweepQueued(t.deps, at(30 * 24 * HOUR))).toMatchObject({ reclaimed: 1 });
    expect(await stepRow('a', live.stepId)).toMatchObject({ status: 'queued', leaseExpiresAt: null });
    expect(await stepRow('a', parked.stepId)).toMatchObject({ status: 'running', leaseExpiresAt: null, updatedAt: at(-HOUR) });
  });

  test('a reclaimed step runs again and finishes', async () => {
    const { taskId, stepId } = await stepIn('a', { status: 'running', attempts: 1, runSeq: 1, leaseExpiresAt: at(-MINUTE), updatedAt: at(-11 * MINUTE) });
    await sweepQueued(t.deps, NOW);
    await t.queue.drain(t.deps);
    expect(await stepRow('a', stepId)).toMatchObject({ status: 'done', attempts: 2, runSeq: 2, leaseExpiresAt: null });
    expect((await dbTask(t, 'a', taskId)).status).toBe('done');
  });

  test('steps are handed to the queue only after the reclaim has committed', async () => {
    const dead = await stepIn('a', { status: 'running', attempts: 1, leaseExpiresAt: at(-MINUTE), updatedAt: at(-11 * MINUTE) });
    const seenAtEnqueue: string[] = [];
    const queue: StepQueue = {
      async enqueueStep(companyId, stepId) {
        // Read on another connection: only a committed change is visible here.
        const row = await inCompany(t, companyId, async (tx) => (await tx.select().from(agentTaskSteps).where(eq(agentTaskSteps.id, stepId)))[0]!);
        seenAtEnqueue.push(row.status);
      },
    };
    await sweepQueued({ ...t.deps, queue }, NOW);
    expect(seenAtEnqueue).toEqual(['queued']);
    expect(await stepRow('a', dead.stepId)).toMatchObject({ status: 'queued' });
  });

  describe('locks', () => {
    let owner: pg.Client | undefined;
    afterEach(async () => {
      await owner?.query('rollback').catch(() => undefined);
      await owner?.end();
      owner = undefined;
    });

    test('a step someone else has locked is skipped, not waited for; the next sweep picks it up', async () => {
      const locked = await stepIn('a', { status: 'running', attempts: 1, leaseExpiresAt: at(-MINUTE), updatedAt: at(-11 * MINUTE) }, 'Locked');
      const other = await stepIn('a', { status: 'running', attempts: 1, leaseExpiresAt: at(-MINUTE), updatedAt: at(-11 * MINUTE) }, 'Other');
      owner = new pg.Client({ connectionString: inject('dbUrls').owner });
      await owner.connect();
      await owner.query('begin');
      await owner.query('select id from agent_task_steps where id = $1 for update', [locked.stepId]);

      expect(await within(sweepQueued(t.deps, NOW), 5000)).toEqual({ resent: 0, reclaimed: 1 });
      expect(await stepRow('a', other.stepId)).toMatchObject({ status: 'queued' });
      expect(await stepRow('a', locked.stepId)).toMatchObject({ status: 'running' });

      await owner.query('commit');
      expect(await sweepQueued(t.deps, NOW)).toEqual({ resent: 0, reclaimed: 1 });
      expect(await stepRow('a', locked.stepId)).toMatchObject({ status: 'queued', leaseExpiresAt: null });
      expect(t.queue.calls.map((c) => c.stepId)).toEqual([other.stepId, locked.stepId]);
    });

    test('three sweepers at once: no deadlock, every dead step is reclaimed once and enqueued at least once', async () => {
      const dead: QueuedStep[] = [];
      for (const company of ['a', 'b'] as const) {
        const { taskId } = await newTask(t, company, {
          steps: Array.from({ length: 8 }, (_, i) => ({ type: 'demo_noop' as const, payload: { label: `Step ${i}` } })),
        });
        await setTask(t, company, taskId, { status: 'running' });
        for (const step of await dbSteps(t, company, taskId)) {
          await setStep(t, company, step.id, { status: 'running', attempts: 1, leaseExpiresAt: at(-MINUTE), updatedAt: at(-11 * MINUTE) });
          dead.push({ companyId: idOf(company), stepId: step.id });
        }
      }

      const results = await within(Promise.all([sweepQueued(t.deps, NOW), sweepQueued(t.deps, NOW), sweepQueued(t.deps, NOW)]), 15_000);
      expect(results).not.toBe('timeout');
      const reclaimed = (results as { reclaimed: number }[]).reduce((n, r) => n + r.reclaimed, 0);
      expect(reclaimed).toBe(16);
      const enqueued = new Map(t.queue.calls.map((c) => [c.stepId, c.companyId]));
      expect([...enqueued.entries()].sort()).toEqual(dead.map((d) => [d.stepId, d.companyId]).sort());
      for (const company of ['a', 'b'] as const) {
        const rows = await inCompany(t, idOf(company), (tx) => tx.select().from(agentTaskSteps));
        expect(rows.every((r) => r.status === 'queued' && r.leaseExpiresAt === null), company).toBe(true);
      }
    });
  });

  test('a queue that refuses one step does not stop the others; the refusal is logged', async () => {
    const a = await stepIn('a', { status: 'queued', updatedAt: at(-3 * MINUTE) });
    const deadB = await stepIn('b', { status: 'running', attempts: 1, leaseExpiresAt: at(-MINUTE), updatedAt: at(-11 * MINUTE) });
    const handed: string[] = [];
    const queue: StepQueue = {
      async enqueueStep(companyId, stepId) {
        if (companyId === idOf('a')) throw new Error('queue is down');
        handed.push(stepId);
      },
    };
    const deps: AppDeps = { ...t.deps, queue };
    expect(await sweepQueued(deps, NOW)).toEqual({ resent: 0, reclaimed: 1 });
    expect(handed).toEqual([deadB.stepId]);
    expect(t.logged.map((l) => [(l.err as Error).message, l.where])).toEqual([['queue is down', `sweep-queued: step ${a.stepId}`]]);
    // The reclaim itself stands: the step is queued, so the next sweep re-sends it.
    expect(await stepRow('b', deadB.stepId)).toMatchObject({ status: 'queued' });
  });
});

describe('the system queries read only what app_system may see', () => {
  test('they run as app_system (column grants only) and return ids, never content', async () => {
    await stepIn('a', { status: 'queued', updatedAt: at(-3 * MINUTE) });
    await newTask(t, 'a', { expiresAt: at(-MINUTE) });
    // The pool really is app_system: it cannot read a payload.
    await expect(t.deps.pools.system.$client.query('select payload from agent_task_steps')).rejects.toThrow(/permission denied/);
    const queued = await stepsQueuedLongerThan(t.deps.pools.system, QUEUED_TOO_LONG_MS, NOW);
    expect(Object.keys(queued[0]!).sort()).toEqual(['companyId', 'stepId']);
    expect(await companiesWithExpiredDrafts(t.deps.pools.system, NOW)).toEqual([idOf('a')]);
    // withTenant still keeps the per-company write to that company.
    expect(await withTenant(t.deps.pools, { companyId: idOf('b'), userId: null, role: 'system', canApproveSpend: false }, (tx) => tx.select().from(agentTasks))).toEqual([]);
  });
});
