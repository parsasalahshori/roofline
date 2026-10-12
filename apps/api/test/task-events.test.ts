import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { listTaskEvents, reclaimExpiredLeases, timeBaselines, withTenant } from '@roofline/db';
import { type StepType, stepTypes } from '@roofline/shared';
import { expireDrafts } from '../src/jobs/scheduler/expire-drafts.ts';
import { AppError } from '../src/errors.ts';
import { registerStepHandler, runStep, type StepHandler, type StepOutcome } from '../src/tasks/runner.ts';
import { createTask } from '../src/tasks/service.ts';
import { Actors, inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { agentCtx, dbSteps, dbTask, newCustomers, newTask, seenOf, smsStep } from './task-helpers.ts';

const NOW = new Date('2026-10-12T15:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

let t: TestApp;
let actors: Actors;
const restores: (() => void)[] = [];

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
  actors = new Actors(t);
});

afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

/** Swaps in a handler for this test only. */
function use(type: Parameters<typeof registerStepHandler>[0], handler: StepHandler): void {
  restores.push(registerStepHandler(type, handler));
}

const idOf = () => t.seed.a.companyId;
const events = (taskId: string) => inCompany(t, idOf(), (tx) => listTaskEvents(tx, agentCtx(idOf()), taskId));
const kinds = async (taskId: string) => (await events(taskId)).map((e) => e.kind);
const approveAs = async (who: 'owner' | 'office', taskId: string) => {
  const steps = await dbSteps(t, 'a', taskId);
  const res = await (await actors.as(who)).post(`/api/approvals/${taskId}/approve`).send(seenOf(steps));
  expect(res.status).toBe(200);
};
const setOverride = (key: string, minutesPerUnit: number) =>
  withTenant(t.deps.pools, agentCtx(idOf()), async (tx) => {
    await tx
      .insert(timeBaselines)
      .values({ companyId: idOf(), key, minutesPerUnit })
      .onConflictDoUpdate({ target: [timeBaselines.companyId, timeBaselines.key], set: { minutesPerUnit } });
  });

/** A one-step send_sms_batch plan to 3 customers, approved by the owner and run with a handler that sends `sent` texts. */
async function smsPlan(result: Record<string, number>) {
  use('send_sms_batch', async () => ({ status: 'done', result }));
  const ids = await newCustomers(t, 'a', ['Ann', 'Ben', 'Cy']);
  const { taskId } = await newTask(t, 'a', { steps: [smsStep(ids)] });
  await approveAs('owner', taskId);
  await t.queue.drain(t.deps);
  return { taskId, step: (await dbSteps(t, 'a', taskId))[0]! };
}

async function oneDemoStep(handler: StepHandler) {
  use('demo_noop', handler);
  const { taskId } = await newTask(t, 'a', { steps: [{ type: 'demo_noop', payload: { label: 'Routes' } }] });
  await approveAs('owner', taskId);
  await t.queue.drain(t.deps);
  return { taskId, step: (await dbSteps(t, 'a', taskId))[0]! };
}

describe('task events', () => {
  test('createTask writes one created event with the agent as actor', async () => {
    const { taskId } = await newTask(t, 'a');
    const log = await events(taskId);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: 'created', actorType: 'agent', actorUserId: null });
  });

  test('approving a whole plan writes one approved event by the approver', async () => {
    const { taskId } = await newTask(t, 'a');
    await approveAs('owner', taskId);
    const approved = (await events(taskId)).filter((e) => e.kind === 'approved');
    expect(approved).toHaveLength(1);
    expect(approved[0]).toMatchObject({
      actorType: 'user',
      actorUserId: t.seed.a.owner.userId,
      data: { approvedSteps: 3, totalSteps: 3 },
    });
    expect((await kinds(taskId)).filter((k) => k === 'finished')).toEqual([]);
  });

  test('a plan with a step left for the owner is partly_approved', async () => {
    const { taskId } = await newTask(t, 'a');
    await approveAs('office', taskId);
    const log = (await events(taskId)).filter((e) => e.kind === 'partly_approved' || e.kind === 'approved');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      kind: 'partly_approved',
      actorType: 'user',
      actorUserId: t.seed.a.office.userId,
      data: { approvedSteps: 2, totalSteps: 3 },
    });
  });

  test('declining a plan writes one declined event by the user', async () => {
    const { taskId } = await newTask(t, 'a');
    const res = await (await actors.as('owner')).post(`/api/approvals/${taskId}/decline`).send({ reason: 'Not this storm' });
    expect(res.status).toBe(200);
    const declined = (await events(taskId)).filter((e) => e.kind === 'declined');
    expect(declined).toHaveLength(1);
    expect(declined[0]).toMatchObject({ actorType: 'user', actorUserId: t.seed.a.owner.userId });
  });

  test('a step that finishes writes step_done by the agent with units and minutes', async () => {
    const { taskId } = await newTask(t, 'a');
    await approveAs('owner', taskId);
    await t.queue.drain(t.deps);

    const log = await events(taskId);
    const done = log.filter((e) => e.kind === 'step_done');
    expect(done).toHaveLength(3);
    for (const e of done) {
      expect(e).toMatchObject({ actorType: 'agent', actorUserId: null, data: { units: 1, minutes: 5 } });
      expect(e.stepId).not.toBeNull();
    }
    const finished = log.filter((e) => e.kind === 'finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ actorType: 'system', data: { status: 'done', minutesSaved: 15 } });
    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'done', minutesSaved: 15 });
    for (const step of await dbSteps(t, 'a', taskId)) {
      expect(step).toMatchObject({ baselineKey: 'demo', units: 1, minutesPerUnit: 5, minutesSaved: 5 });
    }
  });

  test('a failed step writes step_failed and no snapshot', async () => {
    const { taskId, step } = await oneDemoStep(async () => ({ status: 'failed', result: {}, errorPlain: 'It did not work.' }));
    const log = await events(taskId);
    expect(log.filter((e) => e.kind === 'step_failed')).toHaveLength(1);
    expect(log.find((e) => e.kind === 'step_failed')).toMatchObject({ actorType: 'agent', stepId: step.id });
    expect(log.some((e) => e.kind === 'step_done')).toBe(false);
    expect(step).toMatchObject({ baselineKey: null, units: null, minutesSaved: null });
  });

  test('a step that needs attention writes step_attention and no snapshot', async () => {
    const { taskId, step } = await oneDemoStep(async () => ({ status: 'needs_attention', result: {}, errorPlain: 'Look at this.' }));
    const log = await events(taskId);
    expect(log.filter((e) => e.kind === 'step_attention')).toHaveLength(1);
    expect(log.find((e) => e.kind === 'step_attention')).toMatchObject({ actorType: 'agent', stepId: step.id });
    expect(log.some((e) => e.kind === 'step_done')).toBe(false);
    expect(step).toMatchObject({ baselineKey: null, units: null, minutesSaved: null });
  });
});

describe('time-saved snapshots', () => {
  test('the snapshot uses the override at that moment', async () => {
    await setOverride('text_sent', 2);
    const { step } = await smsPlan({ sent: 3 });
    expect(step).toMatchObject({ baselineKey: 'text_sent', units: 3, minutesPerUnit: 2, minutesSaved: 6 });
  });

  test('a later override change leaves old snapshots alone', async () => {
    await setOverride('text_sent', 2);
    const first = await smsPlan({ sent: 3 });
    expect(first.step.minutesSaved).toBe(6);

    await setOverride('text_sent', 4);
    const second = await smsPlan({ sent: 3 });

    expect((await dbSteps(t, 'a', first.taskId))[0]).toMatchObject({ minutesPerUnit: 2, minutesSaved: 6 });
    expect(second.step).toMatchObject({ minutesPerUnit: 4, units: 3, minutesSaved: 12 });
    expect((await dbTask(t, 'a', first.taskId)).minutesSaved).toBe(6);
    expect((await dbTask(t, 'a', second.taskId)).minutesSaved).toBe(12);
  });

  test('send_sms_batch counts sent texts only and caps at 120 minutes', async () => {
    const some = await smsPlan({ sent: 2, scheduled: 1, failed: 1 });
    expect(some.step).toMatchObject({ baselineKey: 'text_sent', units: 2, minutesSaved: 3 });

    const huge = await smsPlan({ sent: 5000 });
    expect(huge.step.minutesSaved).toBe(120);
    expect((await dbTask(t, 'a', huge.taskId)).minutesSaved).toBe(120);
  });

  test('a stale runner writes neither a snapshot nor an event', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const enteredP = new Promise<void>((resolve) => (entered = resolve));
    let calls = 0;
    use('demo_noop', async (): Promise<StepOutcome> => {
      calls += 1;
      if (calls > 1) return { status: 'failed', result: { fresh: 1 }, errorPlain: 'The newer run failed.' };
      entered();
      await released;
      return { status: 'done', result: { stale: 1 } };
    });
    const { taskId } = await newTask(t, 'a', { steps: [{ type: 'demo_noop', payload: { label: 'Routes' } }] });
    await approveAs('owner', taskId);
    const step = (await dbSteps(t, 'a', taskId))[0]!;

    const stale = runStep(t.deps, idOf(), step.id);
    await enteredP;
    try {
      t.clock.advance(11 * MINUTE);
      const reclaimed = await inCompany(t, idOf(), (tx) => reclaimExpiredLeases(tx, agentCtx(idOf()), t.clock.now()));
      expect(reclaimed).toEqual([step.id]);
      await runStep(t.deps, idOf(), step.id);
    } finally {
      release();
    }
    await stale;

    const log = await events(taskId);
    expect(log.some((e) => e.kind === 'step_done')).toBe(false);
    expect(log.filter((e) => e.kind === 'step_failed')).toHaveLength(1);
    expect((await dbSteps(t, 'a', taskId))[0]).toMatchObject({ status: 'failed', baselineKey: null, units: null, minutesSaved: null });
  });
});

describe('expiry and refused step types', () => {
  test('expiry writes one expired event by the system', async () => {
    const { taskId } = await newTask(t, 'a', { expiresAt: new Date(NOW.getTime() - MINUTE) });
    expect(await expireDrafts(t.deps, NOW)).toEqual({ expired: 1 });
    expect(await expireDrafts(t.deps, new Date(NOW.getTime() + HOUR))).toEqual({ expired: 0 });
    const expired = (await events(taskId)).filter((e) => e.kind === 'expired');
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ actorType: 'system', actorUserId: null });
  });

  test('createTask refuses front desk step types', async () => {
    const ctx = agentCtx(idOf());
    const attempt = withTenant(t.deps.pools, ctx, (tx) =>
      createTask(
        tx,
        ctx,
        {
          agent: 'storm_scout',
          kind: 'storm_plan',
          title: 'Front desk',
          summary: 'Not allowed.',
          steps: [{ type: 'front_desk_call', payload: { label: 'A call' } }],
        },
        { now: NOW, ip: '203.0.113.9' },
      ),
    );
    await expect(attempt).rejects.toMatchObject({ status: 400, message: "That kind of step isn't supported.", field: 'steps.0.type' });
    await expect(attempt).rejects.toBeInstanceOf(AppError);
  });
});


describe('finished events (Ruling AX-I)', () => {
  test('a task that lands in needs_attention writes no finished event', async () => {
    const { taskId } = await oneDemoStep(async () => ({ status: 'needs_attention', result: {}, errorPlain: 'Look at this.' }));
    expect((await dbTask(t, 'a', taskId)).status).toBe('needs_attention');
    expect((await kinds(taskId)).filter((k) => k === 'finished')).toEqual([]);
  });

  test('a task that reaches done writes exactly one finished event', async () => {
    const { taskId } = await oneDemoStep(async () => ({ status: 'done', result: {} }));
    expect((await dbTask(t, 'a', taskId)).status).toBe('done');
    const finished = (await events(taskId)).filter((e) => e.kind === 'finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ actorType: 'system', data: { status: 'done' } });
  });

  test('after attention then retry to done, finished is written once with status done', async () => {
    let calls = 0;
    const { taskId, step } = await oneDemoStep(async () => {
      calls += 1;
      return calls === 1 ? { status: 'needs_attention', result: {}, errorPlain: 'Look at this.' } : { status: 'done', result: {} };
    });
    expect((await dbTask(t, 'a', taskId)).status).toBe('needs_attention');
    expect((await kinds(taskId)).filter((k) => k === 'finished')).toEqual([]);

    const retry = await (await actors.as('owner')).post(`/api/approvals/${taskId}/steps/${step.id}/retry`).send();
    expect(retry.status).toBe(200);
    await t.queue.drain(t.deps);

    expect((await dbTask(t, 'a', taskId)).status).toBe('done');
    const finished = (await events(taskId)).filter((e) => e.kind === 'finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ data: { status: 'done' } });
  });
});

describe('rerun of internal step types (Ruling AX-I)', () => {
  test('rerunTask copies an expired plan whose steps are built-in front_desk_* types', async () => {
    const internal = (Object.values(stepTypes) as { type: StepType; userCreatable: boolean }[])
      .filter((def) => !def.userCreatable && def.type.startsWith('front_desk_'))
      .map((def) => def.type);
    expect(internal.length).toBeGreaterThan(0);

    const ctx = agentCtx(idOf());
    const { taskId } = await withTenant(t.deps.pools, ctx, (tx) =>
      createTask(
        tx,
        ctx,
        {
          agent: 'front_desk',
          kind: 'front_desk_day',
          title: 'Front desk day',
          summary: 'Calls and texts handled.',
          expiresAt: new Date(NOW.getTime() + HOUR),
          steps: internal.map((type) => ({ type, payload: { label: 'Handled by the front desk' } })),
        },
        { now: NOW, ip: '203.0.113.9', allowInternalStepTypes: true },
      ),
    );
    t.clock.set(new Date(NOW.getTime() + 2 * HOUR));
    await expireDrafts(t.deps, t.clock.now());
    expect((await dbTask(t, 'a', taskId)).status).toBe('expired');

    const owner = await actors.as('owner');
    const res = await owner.post(`/api/approvals/${taskId}/rerun`).send();
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(taskId);
    const copied = await dbSteps(t, 'a', res.body.id);
    expect(copied.map((s) => s.type)).toEqual(internal);
  });

  test('createTask without the option still refuses a front_desk_* step with AppError 400 on steps.0.type', async () => {
    const ctx = agentCtx(idOf());
    const attempt = withTenant(t.deps.pools, ctx, (tx) =>
      createTask(
        tx,
        ctx,
        {
          agent: 'front_desk',
          kind: 'front_desk_day',
          title: 'Front desk texts',
          steps: [{ type: 'front_desk_texts', payload: { label: 'Texts' } }],
        },
        { now: NOW, ip: '203.0.113.9' },
      ),
    );
    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(attempt).rejects.toMatchObject({ status: 400, field: 'steps.0.type' });
  });
});
