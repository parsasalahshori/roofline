import request from 'supertest';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { createPools, type Pools, type TenantContext, type Tx, withTenant } from '@roofline/db';
import { createApp } from '../src/app.ts';
import { AppError } from '../src/errors.ts';
import type { StepQueue } from '../src/tasks/queue.ts';
import { approveTask, editStep } from '../src/tasks/service.ts';
import { Actors, dbAudit, NO_UUID, NOT_FOUND } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import {
  dbSteps,
  dbTask,
  delegateSpendToOffice,
  enqueued,
  EXPIRED,
  HANDLED,
  newCustomers,
  newTask,
  NOT_ALLOWED,
  seenOf,
  setStep,
  setTask,
  smsStep,
  STALE,
} from './task-helpers.ts';

const MARKETING = 'Marketing texts must include your company name and "Reply STOP to opt out".';
const NOW = new Date('2026-10-12T15:00:00.000Z');
const HOUR = 60 * 60 * 1000;

let t: TestApp;
let actors: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
  actors = new Actors(t);
});

const idOf = (company: 'a' | 'b') => t.seed[company].companyId;
const approveUrl = (taskId: string) => `/api/approvals/${taskId}/approve`;
const declineUrl = (taskId: string) => `/api/approvals/${taskId}/decline`;
const stepDeclineUrl = (taskId: string, stepId: string) => `/api/approvals/${taskId}/steps/${stepId}/decline`;

/** A task with the three demo steps (message, internal, spend), returning its id and step rows. */
async function demo(company: 'a' | 'b' = 'a') {
  const { taskId } = await newTask(t, company);
  const steps = await dbSteps(t, company, taskId);
  return { taskId, steps, message: steps[0]!, noop: steps[1]!, spend: steps[2]! };
}

/** A two-step task: a text and an ad, the partial-approval case. */
async function messageAndSpend() {
  const { taskId } = await newTask(t, 'a', {
    steps: [
      { type: 'demo_message', payload: { label: 'Text 31 customers' } },
      { type: 'demo_spend', payload: { label: 'Google + Facebook ads on the swath', maxSpendCents: 27000 } },
    ],
  });
  const steps = await dbSteps(t, 'a', taskId);
  return { taskId, steps, message: steps[0]!, spend: steps[1]! };
}

const statuses = async (taskId: string) => (await dbSteps(t, 'a', taskId)).map((s) => s.status);

// ---------------------------------------------------------------------------------------------

describe('POST /api/approvals/:taskId/approve', () => {
  test('the owner approves the 3 demo steps: the task runs, and after the queue drains it is done with 15 minutes saved', async () => {
    const { taskId, steps } = await demo();
    t.clock.advance(5 * 60_000);
    const owner = await actors.as('owner');

    const res = await owner.post(approveUrl(taskId)).send(seenOf(steps));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: taskId, status: 'running', expired: false });
    expect(res.body.steps.map((s: { status: string }) => s.status)).toEqual(['queued', 'queued', 'queued']);
    // The response is the detail TaskView, payloads included.
    expect(res.body.steps[0].payload).toEqual({ label: 'Text 31 customers' });

    // Each step is handed to the queue once, in position order, and the queue has not run anything yet.
    expect(enqueued(t)).toEqual(steps.map((s) => s.id));
    expect(t.queue.calls.every((c) => c.companyId === idOf('a'))).toBe(true);
    expect(await statuses(taskId)).toEqual(['queued', 'queued', 'queued']);

    const approvedAt = t.clock.now();
    const task = await dbTask(t, 'a', taskId);
    expect(task).toMatchObject({ status: 'running', approvedByUserId: t.seed.a.owner.userId, approvedAt, minutesSaved: null });
    for (const step of await dbSteps(t, 'a', taskId)) {
      expect(step).toMatchObject({ approvedByUserId: t.seed.a.owner.userId, approvedAt, attempts: 0, version: 1 });
    }

    // Before anything ran, the views say so.
    expect(res.body.minutesSaved).toBeNull();
    expect(res.body.steps[0]).toMatchObject({ attempts: 0, result: null, errorPlain: null });

    await t.queue.drain(t.deps);

    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'done', minutesSaved: 15 });
    // The detail view and the feed carry the minutes saved and each step's result.
    const detail = await owner.get(`/api/approvals/${taskId}`);
    expect(detail.body).toMatchObject({ status: 'done', minutesSaved: 15 });
    for (const step of detail.body.steps) expect(step).toMatchObject({ status: 'done', attempts: 1, result: { ok: 1 }, errorPlain: null });
    const feed = await owner.get('/api/tasks');
    expect(feed.body.tasks[0]).toMatchObject({ id: taskId, minutesSaved: 15 });
    expect(feed.body.tasks[0].steps.map((s: { result: unknown }) => s.result)).toEqual([{ ok: 1 }, { ok: 1 }, { ok: 1 }]);
    const done = await dbSteps(t, 'a', taskId);
    expect(done.map((s) => [s.status, s.attempts, s.result, s.errorPlain])).toEqual([
      ['done', 1, { ok: 1 }, null],
      ['done', 1, { ok: 1 }, null],
      ['done', 1, { ok: 1 }, null],
    ]);
    // The idempotency keys never change.
    expect(done.map((s) => s.idempotencyKey)).toEqual(steps.map((s) => s.idempotencyKey));

    const audits = await dbAudit(t, idOf('a'), 'task.approve');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: t.seed.a.owner.userId,
      targetType: 'agent_task',
      targetId: taskId,
      after: { approvedStepIds: steps.map((s) => s.id), awaitingOwnerStepIds: [], skippedStepIds: [] },
      at: approvedAt,
    });
  });

  test('partial approval: the office approves a text and an ad; the text runs, the ad and the task wait for the owner', async () => {
    const { taskId, steps, message, spend } = await messageAndSpend();
    const office = await actors.as('office');

    const res = await office.post(approveUrl(taskId)).send(seenOf(steps));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('awaiting_owner');
    expect(res.body.steps.map((s: { status: string }) => s.status)).toEqual(['queued', 'awaiting_owner']);
    expect(enqueued(t)).toEqual([message.id]);

    await t.queue.drain(t.deps);
    expect(await statuses(taskId)).toEqual(['done', 'awaiting_owner']);
    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'awaiting_owner', approvedByUserId: t.seed.a.office.userId });

    const audit = (await dbAudit(t, idOf('a'), 'task.approve'))[0]!;
    expect(audit.after).toEqual({ approvedStepIds: [message.id], awaitingOwnerStepIds: [spend.id], skippedStepIds: [] });

    // The owner's approvals list has the task; the office user's does not.
    const ownerList = await (await actors.as('owner')).get('/api/approvals');
    expect(ownerList.body.tasks.map((x: { id: string }) => x.id)).toEqual([taskId]);
    expect(ownerList.body.count).toBe(1);
    const officeList = await office.get('/api/approvals');
    expect(officeList.body).toEqual({ count: 0, tasks: [] });

    // The owner approves with the versions the screen shows now.
    const detail = await (await actors.as('owner')).get(`/api/approvals/${taskId}`);
    t.clock.advance(HOUR);
    const second = await (await actors.as('owner')).post(approveUrl(taskId)).send(seenOf(detail.body.steps));
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('running');
    expect(enqueued(t)).toEqual([message.id, spend.id]);

    await t.queue.drain(t.deps);
    expect(await statuses(taskId)).toEqual(['done', 'done']);
    const task = await dbTask(t, 'a', taskId);
    expect(task).toMatchObject({ status: 'done', minutesSaved: 10 });
    // The task records the first approval; each step records who approved it.
    expect(task).toMatchObject({ approvedByUserId: t.seed.a.office.userId, approvedAt: NOW });
    const [m, s] = await dbSteps(t, 'a', taskId);
    expect(m).toMatchObject({ approvedByUserId: t.seed.a.office.userId, approvedAt: NOW });
    expect(s).toMatchObject({ approvedByUserId: t.seed.a.owner.userId, approvedAt: new Date(NOW.getTime() + HOUR) });
    expect(await dbAudit(t, idOf('a'), 'task.approve')).toHaveLength(2);
  });

  test('the office with spend delegation approves everything in one go', async () => {
    await delegateSpendToOffice(t, actors);
    const { taskId, steps } = await demo();
    const res = await (await actors.as('office')).post(approveUrl(taskId)).send(seenOf(steps));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('running');
    expect(enqueued(t)).toEqual(steps.map((s) => s.id));
  });

  test('a disabled step is skipped: the task ends done with 10 minutes saved', async () => {
    const { taskId, noop } = await demo();
    const owner = await actors.as('owner');
    const off = await owner.patch(`/api/approvals/${taskId}/steps/${noop.id}`).send({ version: 1, enabled: false });
    expect(off.status).toBe(200);

    const steps = await dbSteps(t, 'a', taskId);
    const res = await owner.post(approveUrl(taskId)).send(seenOf(steps));
    expect(res.status).toBe(200);
    expect(enqueued(t)).toEqual([steps[0]!.id, steps[2]!.id]);
    expect(res.body.steps.map((s: { status: string }) => s.status)).toEqual(['queued', 'skipped', 'queued']);

    await t.queue.drain(t.deps);
    expect(await statuses(taskId)).toEqual(['done', 'skipped', 'done']);
    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'done', minutesSaved: 10 });
    expect((await dbSteps(t, 'a', taskId))[1]).toMatchObject({ approvedByUserId: null, approvedAt: null, attempts: 0 });
    expect((await dbAudit(t, idOf('a'), 'task.approve'))[0]!.after).toEqual({
      approvedStepIds: [steps[0]!.id, steps[2]!.id],
      awaitingOwnerStepIds: [],
      skippedStepIds: [noop.id],
    });
  });

  test('every step switched off: nothing to run, so the task is done at once with 0 minutes saved', async () => {
    const { taskId, steps } = await demo();
    for (const step of steps) await setStep(t, 'a', step.id, { enabled: false });
    const res = await (await actors.as('owner')).post(approveUrl(taskId)).send(seenOf(steps));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('done');
    expect(enqueued(t)).toEqual([]);
    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'done', minutesSaved: 0, approvedAt: null });
  });

  test('a stale version: 409 with the latest TaskView (payloads included), and nothing is queued', async () => {
    const { taskId, steps, message } = await demo();
    const owner = await actors.as('owner');
    expect((await owner.patch(`/api/approvals/${taskId}/steps/${message.id}`).send({ version: 1, enabled: false })).status).toBe(200);

    const res = await owner.post(approveUrl(taskId)).send(seenOf(steps)); // still says version 1
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(STALE);
    expect(res.body.latest).toMatchObject({ id: taskId, status: 'draft' });
    expect(res.body.latest.steps[0]).toMatchObject({ id: message.id, version: 2, enabled: false, payload: { label: 'Text 31 customers' } });
    expect(res.body.latest.steps[2].payload).toEqual({ label: 'Google + Facebook ads on the swath', maxSpendCents: 27000 });

    expect(enqueued(t)).toEqual([]);
    expect(await statuses(taskId)).toEqual(['pending', 'pending', 'pending']);
    expect((await dbTask(t, 'a', taskId)).status).toBe('draft');
    expect(await dbAudit(t, idOf('a'), 'task.approve')).toHaveLength(0);
  });

  test('a step the screen did not show is stale too: approving without it is a 409', async () => {
    const { taskId, steps } = await demo();
    const res = await (await actors.as('owner')).post(approveUrl(taskId)).send(seenOf(steps.slice(0, 2)));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(STALE);
    expect(enqueued(t)).toEqual([]);
  });

  test('versions of steps that are no longer waiting for approval are not checked', async () => {
    const { taskId, steps } = await messageAndSpend();
    expect((await (await actors.as('office')).post(approveUrl(taskId)).send(seenOf(steps))).status).toBe(200);
    await t.queue.drain(t.deps);
    // The text step is done; whatever version the screen sends for it does not matter. The ad's must match.
    const res = await (await actors.as('owner'))
      .post(approveUrl(taskId))
      .send({ steps: [{ id: steps[0]!.id, version: 99 }, { id: steps[1]!.id, version: 1 }] });
    expect(res.status).toBe(200);
    const stale = await (await actors.as('owner'))
      .post(approveUrl(taskId))
      .send({ steps: [{ id: steps[1]!.id, version: 2 }] });
    expect(stale.status).toBe(409);
  });

  test('the owner\'s approval of a waiting step checks its version as well', async () => {
    const { taskId, steps } = await messageAndSpend();
    expect((await (await actors.as('office')).post(approveUrl(taskId)).send(seenOf(steps))).status).toBe(200);
    const res = await (await actors.as('owner')).post(approveUrl(taskId)).send({ steps: [{ id: steps[1]!.id, version: 7 }] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(STALE);
    expect(res.body.latest.steps.map((s: { status: string }) => s.status)).toEqual(['queued', 'awaiting_owner']);
    expect(enqueued(t)).toEqual([steps[0]!.id]);
  });

  test('a draft past its expiry cannot be approved, even before the expiry job marks it: 409, nothing changes', async () => {
    const { taskId } = await newTask(t, 'a', { expiresAt: new Date(NOW.getTime() + HOUR) });
    const steps = await dbSteps(t, 'a', taskId);
    t.clock.advance(HOUR + 1);
    const res = await (await actors.as('owner')).post(approveUrl(taskId)).send(seenOf(steps));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: EXPIRED });
    expect(await statuses(taskId)).toEqual(['pending', 'pending', 'pending']);
    expect((await dbTask(t, 'a', taskId)).status).toBe('draft');
    expect(enqueued(t)).toEqual([]);
  });

  test('a task the expiry job marked expired gets the same answer', async () => {
    const { taskId, steps } = await demo();
    await setTask(t, 'a', taskId, { status: 'expired' });
    const res = await (await actors.as('owner')).post(approveUrl(taskId)).send(seenOf(steps));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: EXPIRED });
  });

  test('a draft whose expiry has not come yet can be approved', async () => {
    const { taskId } = await newTask(t, 'a', { expiresAt: new Date(NOW.getTime() + HOUR) });
    const steps = await dbSteps(t, 'a', taskId);
    t.clock.advance(HOUR - 1);
    expect((await (await actors.as('owner')).post(approveUrl(taskId)).send(seenOf(steps))).status).toBe(200);
  });

  test('a plan already waiting on the owner does not expire: the owner can approve it after its expiry', async () => {
    const { taskId } = await newTask(t, 'a', {
      expiresAt: new Date(NOW.getTime() + HOUR),
      steps: [{ type: 'demo_spend', payload: { label: 'Ads', maxSpendCents: 100 } }],
    });
    const steps = await dbSteps(t, 'a', taskId);
    expect((await (await actors.as('office')).post(approveUrl(taskId)).send(seenOf(steps))).status).toBe(200);
    expect((await dbTask(t, 'a', taskId)).status).toBe('awaiting_owner');
    t.clock.advance(2 * HOUR);
    const res = await (await actors.as('owner')).post(approveUrl(taskId)).send(seenOf(steps));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('running');
  });

  test('a task that is not waiting for approval: 409 "This was already handled."', async () => {
    for (const status of ['approved', 'declined', 'running', 'done', 'partly_done', 'needs_attention'] as const) {
      const { taskId, steps } = await demo();
      await setTask(t, 'a', taskId, { status });
      const res = await (await actors.as('owner')).post(approveUrl(taskId)).send(seenOf(steps));
      expect(res.status, status).toBe(409);
      expect(res.body, status).toEqual({ error: HANDLED });
    }
    expect(enqueued(t)).toEqual([]);
  });

  test('the office approving a plan that only waits on the owner changes nothing: 409, and nothing is audited', async () => {
    const { taskId, steps } = await messageAndSpend();
    const office = await actors.as('office');
    expect((await office.post(approveUrl(taskId)).send(seenOf(steps))).status).toBe(200);
    const again = await office.post(approveUrl(taskId)).send(seenOf(steps));
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: HANDLED });
    expect(await statuses(taskId)).toEqual(['queued', 'awaiting_owner']);
    expect(await dbAudit(t, idOf('a'), 'task.approve')).toHaveLength(1);
    expect(enqueued(t)).toEqual([steps[0]!.id]);
  });

  // -- re-validation -------------------------------------------------------------------------

  test('each step is checked again on approval: a text that named the old company name is refused after a rename', async () => {
    const [id] = await newCustomers(t, 'a', ['Molly']);
    const literal = 'Acme Roofing here: free roof checks this week. Reply STOP to opt out.';
    const { taskId } = await newTask(t, 'a', {
      steps: [{ type: 'demo_noop', payload: { label: 'Routes' } }, smsStep([id!], { body: literal })],
    });
    const steps = await dbSteps(t, 'a', taskId);
    const owner = await actors.as('owner');
    expect((await owner.patch('/api/company').send({ name: 'Zenith Roofing' })).status).toBe(200);

    const res = await owner.post(approveUrl(taskId)).send(seenOf(steps));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: MARKETING, field: `steps.${steps[1]!.id}.payload` });
    // Nothing was approved, not even the step that passed.
    expect(await statuses(taskId)).toEqual(['pending', 'pending']);
    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'draft', approvedAt: null });
    expect(enqueued(t)).toEqual([]);
    expect(await dbAudit(t, idOf('a'), 'task.approve')).toHaveLength(0);
  });

  test('a text that uses {company} still passes after a rename', async () => {
    const [id] = await newCustomers(t, 'a', ['Molly']);
    const { taskId } = await newTask(t, 'a', { steps: [smsStep([id!])] });
    const steps = await dbSteps(t, 'a', taskId);
    const owner = await actors.as('owner');
    expect((await owner.patch('/api/company').send({ name: 'Zenith Roofing' })).status).toBe(200);
    expect((await owner.post(approveUrl(taskId)).send(seenOf(steps))).status).toBe(200);
    expect(enqueued(t)).toEqual([steps[0]!.id]);
  });

  test('a disabled step is not checked again (it is skipped, not run)', async () => {
    const [id] = await newCustomers(t, 'a', ['Molly']);
    const literal = 'Acme Roofing here: free roof checks this week. Reply STOP to opt out.';
    const { taskId } = await newTask(t, 'a', {
      steps: [{ type: 'demo_noop', payload: { label: 'Routes' } }, smsStep([id!], { body: literal })],
    });
    const owner = await actors.as('owner');
    const [, sms] = await dbSteps(t, 'a', taskId);
    expect((await owner.patch(`/api/approvals/${taskId}/steps/${sms!.id}`).send({ version: 1, enabled: false })).status).toBe(200);
    expect((await owner.patch('/api/company').send({ name: 'Zenith Roofing' })).status).toBe(200);
    const res = await owner.post(approveUrl(taskId)).send(seenOf(await dbSteps(t, 'a', taskId)));
    expect(res.status).toBe(200);
    expect(await statuses(taskId)).toEqual(['queued', 'skipped']);
  });

  test('a stale version wins over a failing payload: the screen must refresh first', async () => {
    const [id] = await newCustomers(t, 'a', ['Molly']);
    const literal = 'Acme Roofing here: free roof checks this week. Reply STOP to opt out.';
    const { taskId } = await newTask(t, 'a', { steps: [smsStep([id!], { body: literal })] });
    const owner = await actors.as('owner');
    expect((await owner.patch('/api/company').send({ name: 'Zenith Roofing' })).status).toBe(200);
    const res = await owner.post(approveUrl(taskId)).send({ steps: [] });
    expect(res.status).toBe(409);
  });

  // -- who may approve ------------------------------------------------------------------------

  test('a rep gets 404, whatever the task, and nothing changes', async () => {
    const { taskId, steps } = await demo();
    const rep = await actors.as('rep');
    const res = await rep.post(approveUrl(taskId)).send(seenOf(steps));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_FOUND });
    expect((await rep.post(approveUrl(taskId)).send({ nonsense: true })).status).toBe(404);
    expect(await statuses(taskId)).toEqual(['pending', 'pending', 'pending']);
  });

  test('another company\'s task, an unknown id and a malformed id are all the same 404', async () => {
    const { taskId, steps } = await demo('b');
    const owner = await actors.as('owner');
    for (const id of [taskId, NO_UUID, 'not-a-uuid']) {
      const res = await owner.post(approveUrl(id)).send(seenOf(steps));
      expect(res.status, id).toBe(404);
      expect(res.body).toEqual({ error: NOT_FOUND });
    }
    expect((await dbTask(t, 'b', taskId)).status).toBe('draft');
    expect(enqueued(t)).toEqual([]);
  });

  test('an upper-case task id works', async () => {
    const { taskId, steps } = await demo();
    const res = await (await actors.as('owner')).post(approveUrl(taskId.toUpperCase())).send({
      steps: steps.map((s) => ({ id: s.id.toUpperCase(), version: s.version })),
    });
    expect(res.status).toBe(200);
  });

  test('you must be signed in', async () => {
    const { taskId } = await demo();
    expect((await request(t.app).post(approveUrl(taskId)).send({ steps: [] })).status).toBe(401);
  });

  test('the body is checked: steps is a list of {id, version}', async () => {
    const { taskId } = await demo();
    const owner = await actors.as('owner');
    const bad: unknown[] = [
      {},
      { steps: 'all' },
      { steps: [{ id: 'nope', version: 1 }] },
      { steps: [{ id: NO_UUID, version: 0 }] },
      { steps: [{ id: NO_UUID, version: 1.5 }] },
      { steps: [{ id: NO_UUID }] },
      { steps: [{ id: NO_UUID, version: 1 }, { id: NO_UUID, version: 1 }] },
      { steps: [], extra: true },
    ];
    for (const body of bad) {
      const res = await owner.post(approveUrl(taskId)).send(body as object);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(typeof res.body.error).toBe('string');
    }
    expect((await owner.post(approveUrl(taskId)).send({ steps: [], extra: true })).body).toEqual({
      error: 'Please check this field.',
      field: 'extra',
    });
    expect(await statuses(taskId)).toEqual(['pending', 'pending', 'pending']);
  });

  // -- the queue is told after the commit, and only then -------------------------------------

  test('steps are handed to the queue only after the approval has committed', async () => {
    const { taskId, steps } = await demo();
    const seenByQueue: string[] = [];
    const watching: StepQueue = {
      async enqueueStep(companyId, stepId) {
        // Read on another connection: an uncommitted approval would still show the step pending.
        const [row] = (await dbSteps(t, 'a', taskId)).filter((s) => s.id === stepId);
        seenByQueue.push(`${companyId === idOf('a')}:${row!.status}`);
      },
    };
    const app = createApp({ ...t.deps, queue: watching });
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: t.seed.a.owner.email, password: t.seed.a.owner.password });
    expect((await agent.post(approveUrl(taskId)).send(seenOf(steps))).status).toBe(200);
    expect(seenByQueue).toEqual(['true:queued', 'true:queued', 'true:queued']);
  });

  test('a queue that fails to take a step does not undo the approval: 200, the steps stay queued, the failure is logged', async () => {
    const { taskId, steps } = await demo();
    const logged: string[] = [];
    const broken: StepQueue = {
      async enqueueStep() {
        throw new Error('queue is down');
      },
    };
    const app = createApp({ ...t.deps, queue: broken }, { logError: (err) => logged.push((err as Error).message) });
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: t.seed.a.owner.email, password: t.seed.a.owner.password });
    const res = await agent.post(approveUrl(taskId)).send(seenOf(steps));
    expect(res.status).toBe(200);
    expect(await statuses(taskId)).toEqual(['queued', 'queued', 'queued']);
    // Every step was offered to the queue, not just the first.
    expect(logged).toEqual(['queue is down', 'queue is down', 'queue is down']);
  });

  // -- two at once ------------------------------------------------------------------------------

  test('double-click: two approvals with the same versions at once: one 200, one 409, each step queued once', async () => {
    const { taskId, steps } = await demo();
    const owner = await actors.as('owner');
    const results = await Promise.all([
      owner.post(approveUrl(taskId)).send(seenOf(steps)),
      owner.post(approveUrl(taskId)).send(seenOf(steps)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body).toEqual({ error: HANDLED });
    expect([...enqueued(t)].sort()).toEqual(steps.map((s) => s.id).sort());
    expect(await dbAudit(t, idOf('a'), 'task.approve')).toHaveLength(1);

    await t.queue.drain(t.deps);
    expect((await dbTask(t, 'a', taskId)).status).toBe('done');
  });

  test('double-click by the office on a plan with an ad: one 200, one 409, the text queued once', async () => {
    const { taskId, steps } = await messageAndSpend();
    const office = await actors.as('office');
    const results = await Promise.all([
      office.post(approveUrl(taskId)).send(seenOf(steps)),
      office.post(approveUrl(taskId)).send(seenOf(steps)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(enqueued(t)).toEqual([steps[0]!.id]);
  });

  test('the owner and the office approve at once: one wins, every step is queued exactly once', async () => {
    const { taskId, steps } = await demo();
    const [owner, office] = [await actors.as('owner'), await actors.as('office')];
    const results = await Promise.all([
      owner.post(approveUrl(taskId)).send(seenOf(steps)),
      office.post(approveUrl(taskId)).send(seenOf(steps)),
    ]);
    const codes = results.map((r) => r.status);
    expect(codes).toContain(200);
    const ids = enqueued(t);
    expect(new Set(ids).size).toBe(ids.length);
    // Office first leaves the ad for the owner, whose approval then queues it; owner first queues all three.
    expect([...ids].sort()).toEqual(steps.map((s) => s.id).sort());
    await t.queue.drain(t.deps);
    expect((await dbTask(t, 'a', taskId)).status).toBe('done');
  });
});

// ---------------------------------------------------------------------------------------------

describe('POST /api/approvals/:taskId/decline', () => {
  test('decline with a reason: the task is declined, its steps skipped, the reason stored', async () => {
    const { taskId } = await demo();
    t.clock.advance(60_000);
    const owner = await actors.as('owner');
    const res = await owner.post(declineUrl(taskId)).send({ reason: 'Not this storm' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: taskId, status: 'declined' });
    expect(res.body.steps.map((s: { status: string }) => s.status)).toEqual(['skipped', 'skipped', 'skipped']);

    expect(await dbTask(t, 'a', taskId)).toMatchObject({
      status: 'declined',
      declineReason: 'Not this storm',
      declinedByUserId: t.seed.a.owner.userId,
      declinedAt: t.clock.now(),
      approvedAt: null,
    });
    expect(await statuses(taskId)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(enqueued(t)).toEqual([]);

    const audits = await dbAudit(t, idOf('a'), 'task.decline');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: t.seed.a.owner.userId, targetType: 'agent_task', targetId: taskId });
    expect(audits[0]!.after).toMatchObject({ reason: 'Not this storm' });
  });

  test('the reason is optional, trimmed, and blank means none', async () => {
    const owner = await actors.as('owner');
    for (const body of [{}, { reason: '   ' }, { reason: null }]) {
      const { taskId } = await demo();
      const res = await owner.post(declineUrl(taskId)).send(body);
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect((await dbTask(t, 'a', taskId)).declineReason).toBeNull();
    }
    const { taskId } = await demo();
    expect((await owner.post(declineUrl(taskId)).send({ reason: '  Too far out  ' })).status).toBe(200);
    expect((await dbTask(t, 'a', taskId)).declineReason).toBe('Too far out');
  });

  test('a decline with no body at all works', async () => {
    const { taskId } = await demo();
    const res = await (await actors.as('owner')).post(declineUrl(taskId));
    expect(res.status).toBe(200);
  });

  test('the reason is at most 500 characters; unknown fields are refused', async () => {
    const { taskId } = await demo();
    const owner = await actors.as('owner');
    const long = await owner.post(declineUrl(taskId)).send({ reason: 'x'.repeat(501) });
    expect(long.status).toBe(400);
    expect(long.body).toEqual({ error: 'Please keep the reason to 500 characters or fewer.', field: 'reason' });
    expect((await owner.post(declineUrl(taskId)).send({ reason: 5 })).status).toBe(400);
    expect((await owner.post(declineUrl(taskId)).send({ why: 'x' })).body).toEqual({ error: 'Please check this field.', field: 'why' });
    expect((await dbTask(t, 'a', taskId)).status).toBe('draft');
    expect((await owner.post(declineUrl(taskId)).send({ reason: 'x'.repeat(500) })).status).toBe(200);
  });

  test('the office may decline; a rep gets 404', async () => {
    const { taskId } = await demo();
    expect((await (await actors.as('rep')).post(declineUrl(taskId)).send({})).status).toBe(404);
    expect((await dbTask(t, 'a', taskId)).status).toBe('draft');
    expect((await (await actors.as('office')).post(declineUrl(taskId)).send({})).status).toBe(200);
    expect((await dbTask(t, 'a', taskId)).status).toBe('declined');
  });

  test('only a plan waiting for approval can be declined: anything else is 409 "This was already handled."', async () => {
    const owner = await actors.as('owner');
    for (const status of ['declined', 'expired', 'running', 'done', 'partly_done', 'needs_attention'] as const) {
      const { taskId } = await demo();
      await setTask(t, 'a', taskId, { status });
      const res = await owner.post(declineUrl(taskId)).send({ reason: 'no' });
      expect(res.status, status).toBe(409);
      expect(res.body).toEqual({ error: HANDLED });
      expect((await dbTask(t, 'a', taskId)).declineReason).toBeNull();
    }
  });

  test('declining a plan the office half-approved skips what waits on the owner; what was already approved still runs', async () => {
    const { taskId, steps } = await messageAndSpend();
    expect((await (await actors.as('office')).post(approveUrl(taskId)).send(seenOf(steps))).status).toBe(200);
    const res = await (await actors.as('owner')).post(declineUrl(taskId)).send({ reason: 'No ads this time' });
    expect(res.status).toBe(200);
    expect(await statuses(taskId)).toEqual(['queued', 'skipped']);
    expect((await dbAudit(t, idOf('a'), 'task.decline'))[0]!.after).toMatchObject({ skippedStepIds: [steps[1]!.id] });

    await t.queue.drain(t.deps);
    expect(await statuses(taskId)).toEqual(['done', 'skipped']);
    // The owner's no is kept; the minutes the text saved are still counted.
    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'declined', minutesSaved: 5, declineReason: 'No ads this time' });
  });

  test('another company\'s task is a 404 and is left alone', async () => {
    const { taskId } = await demo('b');
    expect((await (await actors.as('owner')).post(declineUrl(taskId)).send({})).status).toBe(404);
    expect((await dbTask(t, 'b', taskId)).status).toBe('draft');
  });

  test('approve and decline at once: exactly one wins', async () => {
    const { taskId, steps } = await demo();
    const owner = await actors.as('owner');
    const results = await Promise.all([
      owner.post(approveUrl(taskId)).send(seenOf(steps)),
      owner.post(declineUrl(taskId)).send({ reason: 'no' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const task = await dbTask(t, 'a', taskId);
    if (results[0]!.status === 200) {
      expect(task.status).toBe('running');
      expect(enqueued(t)).toHaveLength(3);
    } else {
      expect(task.status).toBe('declined');
      expect(enqueued(t)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('POST /api/approvals/:taskId/steps/:stepId/decline', () => {
  /** The office approves the text and the ad, so the ad waits for the owner; then the text has run. */
  async function waitingAd() {
    const plan = await messageAndSpend();
    expect((await (await actors.as('office')).post(approveUrl(plan.taskId)).send(seenOf(plan.steps))).status).toBe(200);
    return plan;
  }

  test('the owner declines the waiting ad: it is skipped, and once the text has run the task is done', async () => {
    const { taskId, spend } = await waitingAd();
    await t.queue.drain(t.deps);
    t.clock.advance(60_000);
    const res = await (await actors.as('owner')).post(stepDeclineUrl(taskId, spend.id));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('done');
    expect(await statuses(taskId)).toEqual(['done', 'skipped']);
    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'done', minutesSaved: 5, declineReason: null });

    const audits = await dbAudit(t, idOf('a'), 'step.decline');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: t.seed.a.owner.userId, targetType: 'agent_task_step', targetId: spend.id, at: t.clock.now() });
  });

  test('declining the ad while the text is still queued leaves the task running (no longer waiting on the owner)', async () => {
    const { taskId, spend } = await waitingAd();
    const res = await (await actors.as('owner')).post(stepDeclineUrl(taskId, spend.id));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('running');
    expect((await (await actors.as('owner')).get('/api/approvals')).body.count).toBe(0);
    await t.queue.drain(t.deps);
    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'done', minutesSaved: 5 });
  });

  test('it takes the spend approval: the office gets 403, with delegation it may', async () => {
    const { taskId, spend } = await waitingAd();
    const office = await actors.as('office');
    const res = await office.post(stepDeclineUrl(taskId, spend.id));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: NOT_ALLOWED });
    expect(await statuses(taskId)).toEqual(['queued', 'awaiting_owner']);
    await delegateSpendToOffice(t, actors);
    expect((await office.post(stepDeclineUrl(taskId, spend.id))).status).toBe(200);
  });

  test('only a step waiting on the owner can be declined this way: 409 otherwise', async () => {
    const { taskId, message, spend } = await waitingAd();
    const owner = await actors.as('owner');
    const res = await owner.post(stepDeclineUrl(taskId, message.id));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: HANDLED });
    expect((await owner.post(stepDeclineUrl(taskId, spend.id))).status).toBe(200);
    expect((await owner.post(stepDeclineUrl(taskId, spend.id))).status).toBe(409);

    const { taskId: draftId, spend: draftSpend } = await demo();
    expect((await owner.post(stepDeclineUrl(draftId, draftSpend.id))).status).toBe(409);
  });

  test('a rep, another company, an unknown step, or a step of another task: 404', async () => {
    const { taskId, spend } = await waitingAd();
    expect((await (await actors.as('rep')).post(stepDeclineUrl(taskId, spend.id))).status).toBe(404);
    expect((await (await actors.as('owner', 'b')).post(stepDeclineUrl(taskId, spend.id))).status).toBe(404);
    const owner = await actors.as('owner');
    expect((await owner.post(stepDeclineUrl(taskId, NO_UUID))).status).toBe(404);
    expect((await owner.post(stepDeclineUrl(taskId, 'bad'))).status).toBe(404);
    const { taskId: otherTask } = await demo();
    expect((await owner.post(stepDeclineUrl(otherTask, spend.id))).status).toBe(404);
    expect(await statuses(taskId)).toEqual(['queued', 'awaiting_owner']);
  });
});

// ---------------------------------------------------------------------------------------------

describe('GET /api/approvals count leaves out expired plans', () => {
  test('a draft past its expiry is listed, marked expired, but not counted', async () => {
    await newTask(t, 'a', { title: 'lapsed', expiresAt: new Date(NOW.getTime() - HOUR) });
    t.clock.advance(1000);
    await newTask(t, 'a', { title: 'fresh', expiresAt: new Date(NOW.getTime() + HOUR) });
    const res = await (await actors.as('owner')).get('/api/approvals');
    expect(res.body.tasks.map((x: { title: string; expired: boolean }) => [x.title, x.expired])).toEqual([
      ['fresh', false],
      ['lapsed', true],
    ]);
    expect(res.body.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe('two approvals that really overlap', () => {
  // As in approvals-edit.test.ts: the first transaction does its work and stays open, the second
  // runs into its lock on the task row, and only then does the first commit.

  let ownerPools: Pools | undefined;
  afterAll(async () => {
    await ownerPools?.end();
  });

  async function waitUntilSomeoneIsBlocked(timeoutMs = 5000): Promise<boolean> {
    const urls = inject('dbUrls');
    ownerPools ??= createPools({ tenant: urls.owner, system: urls.owner });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { rows } = await ownerPools.system.$client.query(
        "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
      );
      if ((rows[0] as { n: number }).n > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  }

  async function overlapped<A, B>(
    ctx: TenantContext,
    first: (tx: Tx) => Promise<A>,
    second: (tx: Tx) => Promise<B>,
  ): Promise<{ first: PromiseSettledResult<A>; second: PromiseSettledResult<B>; secondWaited: boolean }> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let worked!: () => void;
    const firstWorked = new Promise<void>((resolve) => (worked = resolve));

    const p1 = withTenant(t.deps.pools, ctx, async (tx) => {
      const out = await first(tx);
      worked();
      await gate;
      return out;
    });
    p1.catch(() => worked());
    await firstWorked;
    const p2 = withTenant(t.deps.pools, ctx, second);
    const secondWaited = await waitUntilSomeoneIsBlocked();
    release();
    const [r1, r2] = await Promise.allSettled([p1, p2]);
    return { first: r1!, second: r2!, secondWaited };
  }

  const ownerCtx = (): TenantContext => ({ companyId: idOf('a'), userId: t.seed.a.owner.userId, role: 'owner', canApproveSpend: false });

  test('the second approval waits for the first, then finds the task already handled: only the first hands out steps', async () => {
    const { taskId, steps } = await demo();
    const ctx = ownerCtx();
    const approve = (tx: Tx) => approveTask(tx, ctx, taskId, seenOf(steps).steps, { now: t.clock.now() });

    const out = await overlapped(ctx, approve, approve);

    expect(out.secondWaited).toBe(true);
    expect(out.first.status).toBe('fulfilled');
    const won = (out.first as PromiseFulfilledResult<Awaited<ReturnType<typeof approveTask>>>).value!;
    expect(won.toEnqueue).toEqual(steps.map((s) => s.id));
    expect(out.second.status).toBe('rejected');
    const err = (out.second as PromiseRejectedResult).reason as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status: 409, message: HANDLED });
    expect(await statuses(taskId)).toEqual(['queued', 'queued', 'queued']);
    expect(await dbAudit(t, idOf('a'), 'task.approve')).toHaveLength(1);
  });

  test('an approval that waits on an edit finds the version moved: 409 with the latest, nothing approved', async () => {
    const { taskId, steps, message } = await demo();
    const ctx = ownerCtx();
    const out = await overlapped(
      ctx,
      (tx) => editStep(tx, ctx, taskId, message.id, { version: 1, enabled: false }, { now: t.clock.now() }),
      (tx) => approveTask(tx, ctx, taskId, seenOf(steps).steps, { now: t.clock.now() }),
    );
    expect(out.secondWaited).toBe(true);
    expect(out.first.status).toBe('fulfilled');
    const err = (out.second as PromiseRejectedResult).reason as AppError;
    expect(err).toMatchObject({ status: 409, message: STALE });
    expect((err.latest as { steps: { version: number }[] }).steps[0]!.version).toBe(2);
    expect(await statuses(taskId)).toEqual(['pending', 'pending', 'pending']);
  });
});

// ---------------------------------------------------------------------------------------------

describe('what F2 added to the approvals API', () => {
  const rerunUrl = (taskId: string) => `/api/approvals/${taskId}/rerun`;

  test('carries the plan it was rerun from', async () => {
    const { taskId } = await demo();
    await setTask(t, 'a', taskId, { status: 'expired' });
    const owner = await actors.as('owner');

    const rerun = await owner.post(rerunUrl(taskId)).send();
    expect(rerun.status).toBe(201);
    expect(rerun.body.id).not.toBe(taskId);
    expect(rerun.body.rerunOfTaskId).toBe(taskId);

    // The same link on the detail view and on the list the Approvals window reads.
    expect((await owner.get(`/api/approvals/${rerun.body.id}`)).body.rerunOfTaskId).toBe(taskId);
    const { taskId: ordinaryId } = await demo();
    const list = (await owner.get('/api/approvals')).body.tasks as { id: string; rerunOfTaskId: string | null }[];
    expect(list.find((x) => x.id === rerun.body.id)?.rerunOfTaskId).toBe(taskId);
    // An ordinary task, and the expired plan itself, have no link.
    expect(list.find((x) => x.id === ordinaryId)?.rerunOfTaskId).toBeNull();
    expect((await owner.get(`/api/approvals/${ordinaryId}`)).body.rerunOfTaskId).toBeNull();
    expect((await owner.get(`/api/approvals/${taskId}`)).body.rerunOfTaskId).toBeNull();
  });

  test('accepts an edit body over 256 KB on approvals', async () => {
    const { taskId } = await newTask(t, 'a');
    const [message] = await dbSteps(t, 'a', taskId);
    // 300 KB of one string: past the global 256 KB limit, so only the approvals' own 1 MB limit lets it reach the step's validation.
    const res = await (await actors.as('owner'))
      .patch(`/api/approvals/${taskId}/steps/${message!.id}`)
      .send({ version: 1, payload: { label: 'x'.repeat(300 * 1024) } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Please keep the label to 200 characters or fewer.' });
    expect(res.body.field).toMatch(/^payload/);
    expect((await dbSteps(t, 'a', taskId))[0]).toMatchObject({ version: 1 });
  });

  test('still refuses a body over 1 MB on approvals, and over 256 KB everywhere else', async () => {
    const { taskId } = await newTask(t, 'a');
    const [message] = await dbSteps(t, 'a', taskId);
    const owner = await actors.as('owner');

    const huge = await owner
      .patch(`/api/approvals/${taskId}/steps/${message!.id}`)
      .send({ version: 1, payload: { label: 'x'.repeat(1100 * 1024) } });
    expect(huge.status).toBe(413);
    expect(huge.body).toEqual({ error: 'That request was too large.' });

    const elsewhere = await owner.post('/api/customers').send({ displayName: 'x'.repeat(300 * 1024) });
    expect(elsewhere.status).toBe(413);
  });

  test('a signed-out request is refused before its body is read', async () => {
    const zero = '00000000-0000-0000-0000-000000000000';
    const server = createServer(t.app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP test server');

    // Send the JSON upload headers but withhold every body byte. Authentication must answer
    // without waiting for an upload. Sending a full oversized body with Supertest races the
    // server's early connection close and can produce EPIPE/ECONNRESET instead of its 401.
    const beforeBody = (method: string, path: string, length: number) =>
      new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const req = httpRequest({
          hostname: '127.0.0.1', port: address.port, method, path, agent: false,
          headers: { 'Content-Type': 'application/json', 'Content-Length': length },
        }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => { body += chunk; });
          res.on('error', reject);
          res.on('end', () => {
            resolve({ status: res.statusCode, body });
            req.destroy();
          });
        });
        req.on('error', reject);
        req.setTimeout(3000, () => req.destroy(new Error('Authentication waited for the request body')));
        req.flushHeaders();
      });
    try {
      // Over 1 MB: a parser ahead of authentication would reject or wait, not answer 401.
      const big = await beforeBody('PATCH', `/api/approvals/${zero}/steps/${zero}`, 1100 * 1024);
      expect(big.status).toBe(401);
      expect(JSON.parse(big.body)).toEqual({ error: 'Please sign in.' });

      // Over 256 KB, under 1 MB: also answered before any body arrives.
      const mid = await beforeBody('POST', rerunUrl(zero), 300 * 1024);
      expect(mid.status).toBe(401);
      expect(JSON.parse(mid.body)).toEqual({ error: 'Please sign in.' });
    } finally {
      const closed = new Promise<void>((resolve) => { server.close(() => resolve()); });
      server.closeAllConnections();
      await closed;
    }
  });
});
