import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { audit, type StepRow, type TenantContext } from '@roofline/db';
import { ImmediateQueue } from '../src/tasks/queue.ts';
import { registerStepHandler, runStep, type StepHandler } from '../src/tasks/runner.ts';
import { createTask } from '../src/tasks/service.ts';
import { Actors, dbAudit, inCompany, NO_UUID, NOT_FOUND } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import {
  agentCtx,
  CANT_RUN,
  dbSteps,
  dbTask,
  enqueued,
  GAVE_UP,
  HANDLED,
  newCustomers,
  newTask,
  NOT_ALLOWED,
  seenOf,
  setStep,
  setTask,
  smsStep,
} from './task-helpers.ts';

const NOW = new Date('2026-10-12T15:00:00.000Z');
const HOUR = 60 * 60 * 1000;

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

const idOf = (company: 'a' | 'b') => t.seed[company].companyId;
const retryUrl = (taskId: string, stepId: string) => `/api/approvals/${taskId}/steps/${stepId}/retry`;

/** A one-step task (a demo_noop by default), approved by the owner: its step is queued and handed to the queue. */
async function approvedOneStep(type: 'demo_noop' | 'demo_message' | 'demo_spend' = 'demo_noop') {
  const payload = type === 'demo_spend' ? { label: 'Ads', maxSpendCents: 500 } : { label: 'Routes' };
  const { taskId } = await newTask(t, 'a', { steps: [{ type, payload }] });
  const steps = await dbSteps(t, 'a', taskId);
  const res = await (await actors.as('owner')).post(`/api/approvals/${taskId}/approve`).send(seenOf(steps));
  expect(res.status).toBe(200);
  return { taskId, step: steps[0]! };
}

const stepNow = async (taskId: string) => (await dbSteps(t, 'a', taskId))[0]!;

const throwing = (): StepHandler => async () => {
  throw new Error('provider timed out');
};

// ---------------------------------------------------------------------------------------------

describe('runStep', () => {
  test('a handler that throws twice and then succeeds: the queue runs it three times, attempts 3, done', async () => {
    let calls = 0;
    use('demo_noop', async () => {
      calls += 1;
      if (calls <= 2) throw new Error('provider timed out');
      return { status: 'done', result: { ok: 1 } };
    });
    const { taskId } = await approvedOneStep();

    await t.queue.drain(t.deps);

    expect(calls).toBe(3);
    expect(await stepNow(taskId)).toMatchObject({ status: 'done', attempts: 3, result: { ok: 1 }, errorPlain: null });
    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'done', minutesSaved: 5 });
  });

  test('a handler that always throws: after exactly 5 attempts the step needs attention, with the plain reason', async () => {
    let calls = 0;
    use('demo_noop', async () => {
      calls += 1;
      throw new Error('provider timed out');
    });
    const { taskId } = await approvedOneStep();

    await t.queue.drain(t.deps);

    expect(calls).toBe(5);
    expect(await stepNow(taskId)).toMatchObject({ status: 'needs_attention', attempts: 5, errorPlain: GAVE_UP });
    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'needs_attention', minutesSaved: 0 });
  });

  test('a give-up is logged once, with the handler\'s own error; the step keeps only the plain sentence', async () => {
    const thrown: Error[] = [];
    use('demo_noop', async () => {
      const err = new Error(`provider timed out (try ${thrown.length + 1}) token=sk_live_123`);
      thrown.push(err);
      throw err;
    });
    const { taskId, step } = await approvedOneStep();

    await t.queue.drain(t.deps);

    // The four earlier failures went back to the queue; only the last one is the runner's to log.
    expect(t.logged).toHaveLength(1);
    expect(t.logged[0]!.err).toBe(thrown[4]);
    expect(t.logged[0]!.where).toBe(`step ${step.id} (gave up after 5 attempts)`);
    const row = await stepNow(taskId);
    expect(row.errorPlain).toBe(GAVE_UP);
    expect(JSON.stringify(row)).not.toContain('provider timed out');
    expect(JSON.stringify(row)).not.toContain('sk_live_123');
  });

  test('without a logger in deps, a give-up is one console line in the R14 form: name, first line without SQL params, pg code', async () => {
    use('demo_noop', async () => {
      const err = new Error('Failed query: update "agent_task_steps" set "result" = $1\nparams: {"secret":"sk_live_123"}', {
        cause: Object.assign(new Error('duplicate key'), { code: '23505' }),
      });
      err.name = 'DrizzleQueryError';
      throw err;
    });
    const { step } = await approvedOneStep();
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      await t.queue.drain({ ...t.deps, logError: undefined });
    } finally {
      spy.mockRestore();
    }
    expect(lines).toEqual([
      `Unhandled error on step ${step.id} (gave up after 5 attempts): DrizzleQueryError: Failed query: update "agent_task_steps" set "result" = $1 (pg 23505)`,
    ]);
    expect(lines.join('\n')).not.toContain('sk_live_123');
  });

  test('a logger that throws does not stop the step being marked as needing attention', async () => {
    use('demo_noop', throwing());
    const { taskId } = await approvedOneStep();
    await t.queue.drain({
      ...t.deps,
      logError: () => {
        throw new Error('log sink is down');
      },
    });
    expect(await stepNow(taskId)).toMatchObject({ status: 'needs_attention', errorPlain: GAVE_UP });
  });

  test('nothing is logged for a step that succeeds after retries, or one whose type cannot run yet', async () => {
    let calls = 0;
    use('demo_noop', async () => {
      calls += 1;
      if (calls <= 4) throw new Error('provider timed out');
      return { status: 'done', result: { ok: 1 } };
    });
    const { taskId } = await approvedOneStep();
    const [id] = await newCustomers(t, 'a', ['Molly']);
    const { taskId: sms } = await newTask(t, 'a', { steps: [smsStep([id!])] });
    await (await actors.as('owner')).post(`/api/approvals/${sms}/approve`).send(seenOf(await dbSteps(t, 'a', sms)));

    await t.queue.drain(t.deps);

    expect(await stepNow(taskId)).toMatchObject({ status: 'done', attempts: 5 });
    expect((await dbSteps(t, 'a', sms))[0]!.status).toBe('needs_attention');
    expect(t.logged).toEqual([]);
  });

  test('a throw rolls back what the handler wrote in its transaction; the attempt itself is still counted', async () => {
    use('demo_noop', async (_deps, tx, ctx, step) => {
      await audit(tx, ctx, { action: 'handler.wrote', targetType: 'agent_task_step', targetId: step.id });
      throw new Error('boom');
    });
    const { taskId, step } = await approvedOneStep();
    await expect(runStep(t.deps, idOf('a'), step.id)).rejects.toThrow('boom');
    expect(await dbAudit(t, idOf('a'), 'handler.wrote')).toEqual([]);
    expect(await stepNow(taskId)).toMatchObject({ status: 'running', attempts: 1 });
  });

  test('what the handler writes on success is saved with the outcome', async () => {
    use('demo_noop', async (_deps, tx, ctx, step) => {
      await audit(tx, ctx, { action: 'handler.wrote', targetType: 'agent_task_step', targetId: step.id });
      return { status: 'done', result: { ok: 1 } };
    });
    const { step } = await approvedOneStep();
    await runStep(t.deps, idOf('a'), step.id);
    expect(await dbAudit(t, idOf('a'), 'handler.wrote')).toHaveLength(1);
  });

  test('the handler gets the app deps, the company\'s system context, and the claimed step with its payload', async () => {
    const seen: { ctx: TenantContext; step: StepRow; sameDeps: boolean }[] = [];
    use('demo_noop', async (deps, _tx, ctx, step) => {
      seen.push({ ctx, step, sameDeps: deps === t.deps });
      return { status: 'done', result: { ok: 1 } };
    });
    const { step } = await approvedOneStep();
    await t.queue.drain(t.deps);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.sameDeps).toBe(true);
    expect(seen[0]!.ctx).toEqual({ companyId: idOf('a'), userId: null, role: 'system', canApproveSpend: false });
    expect(seen[0]!.step).toMatchObject({ id: step.id, status: 'running', attempts: 1, payload: { label: 'Routes' } });
  });

  test('the demo handlers finish with {ok: 1}', async () => {
    const { taskId } = await newTask(t, 'a');
    const steps = await dbSteps(t, 'a', taskId);
    await (await actors.as('owner')).post(`/api/approvals/${taskId}/approve`).send(seenOf(steps));
    await t.queue.drain(t.deps);
    expect((await dbSteps(t, 'a', taskId)).map((s) => [s.type, s.status, s.result])).toEqual([
      ['demo_message', 'done', { ok: 1 }],
      ['demo_noop', 'done', { ok: 1 }],
      ['demo_spend', 'done', { ok: 1 }],
    ]);
  });

  test('a step type with no handler yet (send_sms_batch) needs attention at once, without retries', async () => {
    const [id] = await newCustomers(t, 'a', ['Molly']);
    const { taskId } = await newTask(t, 'a', { steps: [smsStep([id!])] });
    const steps = await dbSteps(t, 'a', taskId);
    expect((await (await actors.as('owner')).post(`/api/approvals/${taskId}/approve`).send(seenOf(steps))).status).toBe(200);

    await t.queue.drain(t.deps);

    expect(await stepNow(taskId)).toMatchObject({ status: 'needs_attention', attempts: 1, errorPlain: CANT_RUN });
    expect((await dbTask(t, 'a', taskId)).status).toBe('needs_attention');
  });

  test('a handler can report a failure: the step is failed with its reason, and the task is partly done', async () => {
    use('demo_noop', async () => ({ status: 'failed', result: { placed: 0 }, errorPlain: 'The ad account is closed.' }));
    const { taskId } = await newTask(t, 'a');
    const steps = await dbSteps(t, 'a', taskId);
    await (await actors.as('owner')).post(`/api/approvals/${taskId}/approve`).send(seenOf(steps));
    await t.queue.drain(t.deps);

    expect((await dbSteps(t, 'a', taskId)).map((s) => [s.status, s.errorPlain])).toEqual([
      ['done', null],
      ['failed', 'The ad account is closed.'],
      ['done', null],
    ]);
    expect((await dbSteps(t, 'a', taskId))[1]!.result).toEqual({ placed: 0 });
    // A failed step saves nothing.
    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'partly_done', minutesSaved: 10 });
  });

  test('needs_attention outranks failed when the task finishes', async () => {
    use('demo_noop', async () => ({ status: 'failed', result: {} }));
    use('demo_message', async () => ({ status: 'needs_attention', result: {}, errorPlain: 'Check the number.' }));
    const { taskId } = await newTask(t, 'a');
    const steps = await dbSteps(t, 'a', taskId);
    await (await actors.as('owner')).post(`/api/approvals/${taskId}/approve`).send(seenOf(steps));
    await t.queue.drain(t.deps);
    expect((await dbSteps(t, 'a', taskId)).map((s) => s.status)).toEqual(['needs_attention', 'failed', 'done']);
    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'needs_attention', minutesSaved: 5 });
  });

  test('a step that reports it is still running keeps the task running', async () => {
    use('demo_noop', async () => ({ status: 'running', result: { sent: 0 } }));
    const { taskId } = await approvedOneStep();
    await t.queue.drain(t.deps);
    expect(await stepNow(taskId)).toMatchObject({ status: 'running', result: { sent: 0 } });
    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'running', minutesSaved: null });
  });

  test('minutes saved add up each done step\'s own minutes, rounded to a whole number', async () => {
    use('send_sms_batch', async () => ({ status: 'done', result: { sent: 3 } }));
    const [id] = await newCustomers(t, 'a', ['Molly']);
    const { taskId } = await newTask(t, 'a', {
      steps: [smsStep([id!]), { type: 'demo_noop', payload: { label: 'Routes' } }],
    });
    const steps = await dbSteps(t, 'a', taskId);
    await (await actors.as('owner')).post(`/api/approvals/${taskId}/approve`).send(seenOf(steps));
    await t.queue.drain(t.deps);
    // 1.5 x 3 sent + 5 = 9.5, rounded to 10.
    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'done', minutesSaved: 10 });
  });

  test('runStep does nothing to a step that is not queued or running, or that it cannot find', async () => {
    let calls = 0;
    use('demo_noop', async () => {
      calls += 1;
      return { status: 'done', result: { ok: 1 } };
    });
    const { taskId } = await newTask(t, 'a', { steps: [{ type: 'demo_noop', payload: { label: 'Routes' } }] });
    const [step] = await dbSteps(t, 'a', taskId);

    await runStep(t.deps, idOf('a'), step!.id); // pending: not approved
    for (const status of ['done', 'skipped', 'failed', 'needs_attention', 'awaiting_owner'] as const) {
      await setStep(t, 'a', step!.id, { status });
      await runStep(t.deps, idOf('a'), step!.id);
      expect((await stepNow(taskId)).status).toBe(status);
    }
    await runStep(t.deps, idOf('a'), NO_UUID);
    // Company B's runner cannot reach company A's step.
    await setStep(t, 'a', step!.id, { status: 'queued' });
    await runStep(t.deps, idOf('b'), step!.id);

    expect(calls).toBe(0);
    expect(await stepNow(taskId)).toMatchObject({ status: 'queued', attempts: 0 });
  });

  test('a step left running by a crash is picked up again and counts the attempt', async () => {
    const { taskId, step } = await approvedOneStep();
    await setStep(t, 'a', step.id, { status: 'running', attempts: 2 });
    await runStep(t.deps, idOf('a'), step.id);
    expect(await stepNow(taskId)).toMatchObject({ status: 'done', attempts: 3 });
  });

  test('a step that already used its 5 attempts (a crash on the last one) is not run a sixth time', async () => {
    let calls = 0;
    use('demo_noop', async () => {
      calls += 1;
      return { status: 'done', result: { ok: 1 } };
    });
    const { taskId, step } = await approvedOneStep();
    await setStep(t, 'a', step.id, { status: 'running', attempts: 5 });
    await runStep(t.deps, idOf('a'), step.id);
    expect(calls).toBe(0);
    expect(await stepNow(taskId)).toMatchObject({ status: 'needs_attention', errorPlain: GAVE_UP });
    expect((await dbTask(t, 'a', taskId)).status).toBe('needs_attention');
  });

  test('a step that finishes while another step waits on the owner leaves the task waiting on the owner', async () => {
    const { taskId } = await newTask(t, 'a', {
      steps: [
        { type: 'demo_message', payload: { label: 'Text' } },
        { type: 'demo_spend', payload: { label: 'Ads', maxSpendCents: 500 } },
      ],
    });
    const steps = await dbSteps(t, 'a', taskId);
    await (await actors.as('office')).post(`/api/approvals/${taskId}/approve`).send(seenOf(steps));
    await t.queue.drain(t.deps);
    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'awaiting_owner', minutesSaved: null });
  });

  test('two steps of one task finishing at the same time: the last one to finish closes the task', async () => {
    const { taskId } = await newTask(t, 'a');
    const steps = await dbSteps(t, 'a', taskId);
    await (await actors.as('owner')).post(`/api/approvals/${taskId}/approve`).send(seenOf(steps));
    await Promise.all(steps.map((s) => runStep(t.deps, idOf('a'), s.id)));
    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'done', minutesSaved: 15 });
  });

  test('a step finishing while the owner approves the rest of its task: no deadlock, and the task ends done', async () => {
    const { taskId } = await newTask(t, 'a', {
      steps: [
        { type: 'demo_message', payload: { label: 'Text' } },
        { type: 'demo_spend', payload: { label: 'Ads', maxSpendCents: 500 } },
      ],
    });
    const steps = await dbSteps(t, 'a', taskId);
    await (await actors.as('office')).post(`/api/approvals/${taskId}/approve`).send(seenOf(steps));
    const owner = await actors.as('owner');
    const [, approved] = await Promise.all([
      runStep(t.deps, idOf('a'), steps[0]!.id),
      owner.post(`/api/approvals/${taskId}/approve`).send(seenOf(steps)),
    ]);
    expect(approved.status).toBe(200);
    await t.queue.drain(t.deps);
    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'done', minutesSaved: 10 });
  });
});

// ---------------------------------------------------------------------------------------------

describe('the queues', () => {
  test('InlineQueue.drain stops after 50 runs instead of looping forever', async () => {
    // Each step asks for itself again after every run. The runner stops each one after its sixth
    // claim, but nine of them need 54 runs, more than drain allows.
    use('demo_noop', async (_deps, _tx, ctx, step) => {
      await t.queue.enqueueStep(ctx.companyId, step.id);
      return { status: 'running', result: {} };
    });
    const { taskId } = await newTask(t, 'a', {
      steps: Array.from({ length: 9 }, (_, i) => ({ type: 'demo_noop' as const, payload: { label: `Step ${i}` } })),
    });
    const steps = await dbSteps(t, 'a', taskId);
    expect((await (await actors.as('owner')).post(`/api/approvals/${taskId}/approve`).send(seenOf(steps))).status).toBe(200);
    await expect(t.queue.drain(t.deps)).rejects.toThrow('InlineQueue.drain stopped after 50 runs');
  });

  test('InlineQueue.drain takes a smaller limit too', async () => {
    use('demo_noop', async (_deps, _tx, ctx, step) => {
      await t.queue.enqueueStep(ctx.companyId, step.id);
      return { status: 'running', result: {} };
    });
    await approvedOneStep();
    await expect(t.queue.drain(t.deps, 3)).rejects.toThrow('InlineQueue.drain stopped after 3 runs with 1 still waiting.');
  });

  test('InlineQueue.drain also runs what is enqueued while it drains', async () => {
    const { taskId: second } = await newTask(t, 'a', { steps: [{ type: 'demo_message', payload: { label: 'Later' } }] });
    const [later] = await dbSteps(t, 'a', second);
    await setStep(t, 'a', later!.id, { status: 'queued' });
    await setTask(t, 'a', second, { status: 'running' });
    use('demo_noop', async (_deps, _tx, ctx) => {
      await t.queue.enqueueStep(ctx.companyId, later!.id);
      return { status: 'done', result: { ok: 1 } };
    });
    await approvedOneStep();
    await t.queue.drain(t.deps);
    expect((await dbSteps(t, 'a', second))[0]!.status).toBe('done');
  });

  test('ImmediateQueue runs the step in this process soon after it is enqueued', async () => {
    const { taskId, step } = await approvedOneStep();
    const errors: unknown[] = [];
    const queue = new ImmediateQueue(() => t.deps, (err) => errors.push(err));
    await queue.enqueueStep(idOf('a'), step.id);
    const deadline = Date.now() + 5000;
    while ((await stepNow(taskId)).status !== 'done' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(await stepNow(taskId)).toMatchObject({ status: 'done', attempts: 1 });
    expect(errors).toEqual([]);
  });

  test('ImmediateQueue logs a run that throws instead of letting it escape', async () => {
    use('demo_noop', throwing());
    const { step } = await approvedOneStep();
    const errors: { err: unknown; stepId: string }[] = [];
    const queue = new ImmediateQueue(() => t.deps, (err, stepId) => errors.push({ err, stepId }));
    await queue.enqueueStep(idOf('a'), step.id);
    const deadline = Date.now() + 5000;
    while (errors.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(errors).toHaveLength(1);
    expect((errors[0]!.err as Error).message).toBe('provider timed out');
    expect(errors[0]!.stepId).toBe(step.id);
  });
});

// ---------------------------------------------------------------------------------------------

describe('POST /api/approvals/:taskId/steps/:stepId/retry', () => {
  /** A one-step task whose handler always threw, so the step needs attention after 5 attempts. */
  async function gaveUp(type: 'demo_noop' | 'demo_message' | 'demo_spend' = 'demo_noop') {
    const restore = registerStepHandler(type, throwing());
    try {
      const out = await approvedOneStep(type);
      await t.queue.drain(t.deps);
      return out;
    } finally {
      restore();
    }
  }

  test('a step that needs attention goes back to queued with the same idempotency key; once it runs the task is done', async () => {
    const { taskId, step } = await gaveUp();
    expect((await dbTask(t, 'a', taskId)).status).toBe('needs_attention');
    t.clock.advance(HOUR);

    const res = await (await actors.as('owner')).post(retryUrl(taskId, step.id));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: taskId, status: 'running' });
    expect(res.body.steps[0]).toMatchObject({ id: step.id, status: 'queued' });

    const row = await stepNow(taskId);
    expect(row).toMatchObject({ status: 'queued', attempts: 0, errorPlain: null, idempotencyKey: step.idempotencyKey });
    expect((await dbTask(t, 'a', taskId)).status).toBe('running');
    expect(enqueued(t)).toEqual([step.id, step.id]);

    const audits = await dbAudit(t, idOf('a'), 'step.retry');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: t.seed.a.owner.userId, targetType: 'agent_task_step', targetId: step.id, at: t.clock.now() });

    // The handler works now.
    await t.queue.drain(t.deps);
    expect(await stepNow(taskId)).toMatchObject({ status: 'done', attempts: 1, idempotencyKey: step.idempotencyKey });
    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'done', minutesSaved: 5 });
  });

  test('a failed step can be retried too', async () => {
    const restore = registerStepHandler('demo_noop', async () => ({ status: 'failed', result: {}, errorPlain: 'Nope.' }));
    const { taskId, step } = await approvedOneStep();
    await t.queue.drain(t.deps);
    restore();
    expect((await dbTask(t, 'a', taskId)).status).toBe('partly_done');
    expect((await (await actors.as('owner')).post(retryUrl(taskId, step.id))).status).toBe(200);
    await t.queue.drain(t.deps);
    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'done', minutesSaved: 5 });
  });

  test('only a failed or needs-attention step: anything else is 409 "This was already handled."', async () => {
    const { taskId, step } = await approvedOneStep();
    const owner = await actors.as('owner');
    const queued = await owner.post(retryUrl(taskId, step.id));
    expect(queued.status).toBe(409);
    expect(queued.body).toEqual({ error: HANDLED });
    await t.queue.drain(t.deps);
    expect((await owner.post(retryUrl(taskId, step.id))).status).toBe(409); // done
    for (const status of ['pending', 'awaiting_owner', 'skipped', 'running'] as const) {
      await setStep(t, 'a', step.id, { status });
      expect((await owner.post(retryUrl(taskId, step.id))).status, status).toBe(409);
    }
    expect(enqueued(t)).toEqual([step.id]);
  });

  test('a double-click on retry queues the step once', async () => {
    const { taskId, step } = await gaveUp();
    const owner = await actors.as('owner');
    const results = await Promise.all([owner.post(retryUrl(taskId, step.id)), owner.post(retryUrl(taskId, step.id))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(enqueued(t)).toEqual([step.id, step.id]); // the approval, then one retry
  });

  test('retrying needs the approve capability of the step\'s class: the office may retry a text, not an ad', async () => {
    const office = await actors.as('office');
    const text = await gaveUp('demo_message');
    expect((await office.post(retryUrl(text.taskId, text.step.id))).status).toBe(200);

    const ad = await gaveUp('demo_spend');
    const refused = await office.post(retryUrl(ad.taskId, ad.step.id));
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: NOT_ALLOWED });
    expect((await dbSteps(t, 'a', ad.taskId))[0]!.status).toBe('needs_attention');
    expect((await (await actors.as('owner')).post(retryUrl(ad.taskId, ad.step.id))).status).toBe(200);
  });

  test('a rep, another company, an unknown or malformed id, or a step of another task: 404', async () => {
    const { taskId, step } = await gaveUp();
    const rep = await actors.as('rep');
    const res = await rep.post(retryUrl(taskId, step.id));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_FOUND });
    expect((await (await actors.as('owner', 'b')).post(retryUrl(taskId, step.id))).status).toBe(404);
    const owner = await actors.as('owner');
    expect((await owner.post(retryUrl(taskId, NO_UUID))).status).toBe(404);
    expect((await owner.post(retryUrl('nope', step.id))).status).toBe(404);
    const { taskId: other } = await newTask(t, 'a');
    expect((await owner.post(retryUrl(other, step.id))).status).toBe(404);
    expect((await stepNow(taskId)).status).toBe('needs_attention');
  });

  test('retrying while another step still waits on the owner keeps the task waiting on the owner', async () => {
    const { taskId } = await newTask(t, 'a', {
      steps: [
        { type: 'demo_message', payload: { label: 'Text' } },
        { type: 'demo_spend', payload: { label: 'Ads', maxSpendCents: 500 } },
      ],
    });
    const steps = await dbSteps(t, 'a', taskId);
    const restore = registerStepHandler('demo_message', throwing());
    await (await actors.as('office')).post(`/api/approvals/${taskId}/approve`).send(seenOf(steps));
    await t.queue.drain(t.deps);
    restore();
    expect((await dbSteps(t, 'a', taskId)).map((s) => s.status)).toEqual(['needs_attention', 'awaiting_owner']);
    expect((await dbTask(t, 'a', taskId)).status).toBe('awaiting_owner');

    const res = await (await actors.as('office')).post(retryUrl(taskId, steps[0]!.id));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('awaiting_owner');
    await t.queue.drain(t.deps);
    expect((await dbTask(t, 'a', taskId)).status).toBe('awaiting_owner');
  });
});

// ---------------------------------------------------------------------------------------------

describe('what the views show of a run', () => {
  test('a step that gave up: attempts, the plain reason and no result, on the detail and on the feed', async () => {
    use('demo_noop', throwing());
    const { taskId, step } = await approvedOneStep();
    await t.queue.drain(t.deps);

    const owner = await actors.as('owner');
    const detail = await owner.get(`/api/approvals/${taskId}`);
    expect(detail.body).toMatchObject({ status: 'needs_attention', minutesSaved: 0 });
    expect(detail.body.steps[0]).toMatchObject({ id: step.id, status: 'needs_attention', attempts: 5, result: null, errorPlain: GAVE_UP });

    const feed = await owner.get('/api/tasks');
    expect(feed.body.tasks[0]).toMatchObject({ id: taskId, minutesSaved: 0 });
    expect(feed.body.tasks[0].steps[0]).toEqual({ ...detail.body.steps[0], payload: undefined });
    expect(feed.body.tasks[0].steps[0]).not.toHaveProperty('payload');
  });

  test('a retried step shows attempts back at 0 and no error until it runs again', async () => {
    const restore = registerStepHandler('demo_noop', throwing());
    const { taskId, step } = await approvedOneStep();
    await t.queue.drain(t.deps);
    restore();
    const res = await (await actors.as('owner')).post(retryUrl(taskId, step.id));
    expect(res.body.steps[0]).toMatchObject({ status: 'queued', attempts: 0, errorPlain: null });
  });

  test('a send that reported counts shows them on the list, never the payload\'s customer ids', async () => {
    use('send_sms_batch', async () => ({ status: 'done', result: { sent: 2, blocked: { do_not_contact: 1 } } }));
    const ids = await newCustomers(t, 'a', ['Molly', 'Ann', 'Bo']);
    const { taskId } = await newTask(t, 'a', { steps: [smsStep(ids)] });
    await (await actors.as('owner')).post(`/api/approvals/${taskId}/approve`).send(seenOf(await dbSteps(t, 'a', taskId)));
    await t.queue.drain(t.deps);

    const feed = await (await actors.as('owner')).get('/api/tasks');
    expect(feed.body.tasks[0]).toMatchObject({ status: 'done', minutesSaved: 3 });
    expect(feed.body.tasks[0].steps[0]).toMatchObject({ attempts: 1, result: { sent: 2, blocked: { do_not_contact: 1 } }, errorPlain: null });
    for (const id of ids) expect(JSON.stringify(feed.body)).not.toContain(id);
  });
});

describe('GET /api/tasks/summary', () => {
  test('working counts the tasks with a step queued or running', async () => {
    const owner = await actors.as('owner');
    expect((await owner.get('/api/tasks/summary')).body).toEqual({ working: 0 });

    const { taskId } = await approvedOneStep();
    expect((await owner.get('/api/tasks/summary')).body).toEqual({ working: 1 });

    // A task with three queued steps is one task working.
    const { taskId: three } = await newTask(t, 'a');
    await (await actors.as('owner')).post(`/api/approvals/${three}/approve`).send(seenOf(await dbSteps(t, 'a', three)));
    expect((await owner.get('/api/tasks/summary')).body).toEqual({ working: 2 });

    // Running counts as working too.
    await setStep(t, 'a', (await stepNow(taskId)).id, { status: 'running' });
    expect((await owner.get('/api/tasks/summary')).body).toEqual({ working: 2 });

    await t.queue.drain(t.deps);
    expect((await owner.get('/api/tasks/summary')).body).toEqual({ working: 0 });
  });

  test('a plan waiting for approval or for the owner is not working', async () => {
    await newTask(t, 'a');
    const { taskId } = await newTask(t, 'a', { steps: [{ type: 'demo_spend', payload: { label: 'Ads', maxSpendCents: 1 } }] });
    await (await actors.as('office')).post(`/api/approvals/${taskId}/approve`).send(seenOf(await dbSteps(t, 'a', taskId)));
    expect((await (await actors.as('owner')).get('/api/tasks/summary')).body).toEqual({ working: 0 });
  });

  test('the office sees the count; a rep always gets 0; another company\'s work is not counted', async () => {
    await approvedOneStep();
    expect((await (await actors.as('office')).get('/api/tasks/summary')).body).toEqual({ working: 1 });
    expect((await (await actors.as('rep')).get('/api/tasks/summary')).body).toEqual({ working: 0 });
    expect((await (await actors.as('owner', 'b')).get('/api/tasks/summary')).body).toEqual({ working: 0 });
  });

  test('you must be signed in', async () => {
    expect((await request(t.app).get('/api/tasks/summary')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------

describe('GET /api/tasks', () => {
  test('every task of the company, newest first, as TaskViews without payloads', async () => {
    const { taskId: first } = await newTask(t, 'a', { title: 'first' });
    t.clock.advance(60_000);
    const { taskId: second } = await newTask(t, 'a', { title: 'second', agent: 'estimator' });
    await setTask(t, 'a', second, { status: 'done' });
    await newTask(t, 'b', { title: 'Bolt only' });

    const res = await (await actors.as('owner')).get('/api/tasks');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['tasks']);
    expect(res.body.tasks.map((x: { id: string }) => x.id)).toEqual([second, first]);
    expect(res.body.tasks[0]).toMatchObject({ title: 'second', agent: 'estimator', status: 'done', expired: false });
    for (const task of res.body.tasks) for (const step of task.steps) expect(step).not.toHaveProperty('payload');
    expect(res.body.tasks[1].steps).toHaveLength(3);
  });

  test('filters: agent, status and since (created at or after), together', async () => {
    const { taskId: old } = await newTask(t, 'a', { title: 'old' });
    t.clock.advance(HOUR);
    const cutoff = t.clock.now();
    const { taskId: scout } = await newTask(t, 'a', { title: 'scout' });
    t.clock.advance(1000);
    const { taskId: desk } = await newTask(t, 'a', { title: 'desk', agent: 'front_desk' });
    await setTask(t, 'a', desk, { status: 'done' });

    const owner = await actors.as('owner');
    const ids = async (query: string) => (await owner.get(`/api/tasks${query}`)).body.tasks.map((x: { id: string }) => x.id);
    expect(await ids('?agent=storm_scout')).toEqual([scout, old]);
    expect(await ids('?status=done')).toEqual([desk]);
    expect(await ids(`?since=${cutoff.toISOString()}`)).toEqual([desk, scout]);
    expect(await ids(`?since=${encodeURIComponent(cutoff.toISOString())}&agent=storm_scout&status=draft`)).toEqual([scout]);
    expect(await ids('?agent=claims')).toEqual([]);
  });

  test('limit: 50 by default, as asked, and never more than 200', async () => {
    await inCompany(t, idOf('a'), async (tx) => {
      const ctx = agentCtx(idOf('a'));
      for (let i = 0; i < 201; i++) {
        await createTask(tx, ctx, { agent: 'system', kind: 'k', title: `t${i}`, steps: [{ type: 'demo_noop', payload: { label: 'x' } }] }, { now: t.clock.now() });
      }
    });
    const owner = await actors.as('owner');
    expect((await owner.get('/api/tasks')).body.tasks).toHaveLength(50);
    expect((await owner.get('/api/tasks?limit=3')).body.tasks).toHaveLength(3);
    expect((await owner.get('/api/tasks?limit=500')).body.tasks).toHaveLength(200);
  });

  test('bad filters are a 400 naming the field', async () => {
    const owner = await actors.as('owner');
    for (const [query, field] of [
      ['?agent=nobody', 'agent'],
      ['?status=finished', 'status'],
      ['?since=yesterday', 'since'],
      ['?limit=0', 'limit'],
      ['?limit=ten', 'limit'],
    ] as const) {
      const res = await owner.get(`/api/tasks${query}`);
      expect(res.status, query).toBe(400);
      expect(res.body.field, query).toBe(field);
    }
  });

  test('the office sees the feed; a rep gets an empty list', async () => {
    await newTask(t, 'a');
    expect((await (await actors.as('office')).get('/api/tasks')).body.tasks).toHaveLength(1);
    expect((await (await actors.as('rep')).get('/api/tasks')).body).toEqual({ tasks: [] });
  });

  test('you must be signed in', async () => {
    expect((await request(t.app).get('/api/tasks')).status).toBe(401);
  });
});
