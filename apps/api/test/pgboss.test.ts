import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { type AppDeps, createApp } from '../src/app.ts';
import { SCHEDULES, startWorker } from '../src/jobs/worker.ts';
import { createBoss, ensureStepQueue, PgBossQueue, SENDER_OPTIONS, STEP_QUEUE } from '../src/tasks/pgboss-queue.ts';
import { registerStepHandler } from '../src/tasks/runner.ts';
import { loginAs, makeTestApp, type TestApp } from './helpers.ts';
import { dbSteps, dbTask, newTask, seenOf } from './task-helpers.ts';

/*
 * The real queue: pg-boss in the Testcontainer's `pgboss` schema, connecting as app_system (the
 * role the API and the worker use). The API side only sends; a worker started in this process
 * takes the jobs and runs each step with `runStep`.
 */

let sender: PgBoss;
let queue: PgBossQueue;
const bossErrors: unknown[] = [];
let t: TestApp;

beforeAll(async () => {
  sender = createBoss(inject('dbUrls').system, { ...SENDER_OPTIONS, logError: (err) => bossErrors.push(err) });
  await sender.start();
  await ensureStepQueue(sender);
  queue = new PgBossQueue(sender);
});

afterAll(async () => {
  await sender?.stop({ graceful: true, timeout: 5000 });
});

beforeEach(async () => {
  t = await makeTestApp();
  await sender.deleteAllJobs(STEP_QUEUE);
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Reads until `ok` holds or `ms` runs out, and returns the last value read. */
async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!ok(value) && Date.now() < deadline) {
    await sleep(100);
    value = await read();
  }
  return value;
}

/** The app as the server builds it: approvals hand their steps to pg-boss. */
function appWithPgBoss() {
  const deps: AppDeps = { ...t.deps, queue };
  return { deps, app: createApp(deps) };
}

/** The F2 demo task in company A, approved by the owner through the API wired to pg-boss. */
async function approvedDemo() {
  const { app } = appWithPgBoss();
  const { taskId } = await newTask(t, 'a');
  const steps = await dbSteps(t, 'a', taskId);
  const owner = await loginAs(app, t.seed.a.owner);
  const res = await owner.post(`/api/approvals/${taskId}/approve`).send(seenOf(steps));
  expect(res.status).toBe(200);
  return { taskId, steps };
}

/** Runs `fn` with a worker started in this process, and stops it afterwards. */
async function withWorker<T>(fn: (worker: PgBoss) => Promise<T>): Promise<T> {
  const worker = createBoss(inject('dbUrls').system, { schedule: false, logError: (err) => bossErrors.push(err) });
  await worker.start();
  try {
    await startWorker(worker, { ...t.deps, queue: new PgBossQueue(worker) }, { pollingIntervalSeconds: 0.5 });
    return await fn(worker);
  } finally {
    await worker.stop({ graceful: true, timeout: 5000 });
  }
}

describe('ensureStepQueue', () => {
  test('makes the queue with the short policy, and running it again changes nothing', async () => {
    await ensureStepQueue(sender);
    await ensureStepQueue(sender);
    expect(await sender.getQueue(STEP_QUEUE)).toMatchObject({ name: STEP_QUEUE, policy: 'short' });
  });

  // pg-boss only dedupes by singletonKey on a `short` queue; on `standard` every send is a new job,
  // and createQueue on an existing queue changes nothing. So a queue someone made earlier with the
  // wrong policy would silently double-run steps unless startup refuses it.
  test('a queue that already exists with another policy stops startup with a clear error', async () => {
    await sender.deleteQueue(STEP_QUEUE);
    await sender.createQueue(STEP_QUEUE, { policy: 'standard' });
    try {
      await expect(ensureStepQueue(sender)).rejects.toThrow('The agent-step queue has the wrong policy (standard); expected short.');
      // It only looks: the queue is left as it was.
      expect((await sender.getQueue(STEP_QUEUE))?.policy).toBe('standard');
    } finally {
      await sender.deleteQueue(STEP_QUEUE);
      await ensureStepQueue(sender);
    }
    expect((await sender.getQueue(STEP_QUEUE))?.policy).toBe('short');
  });
});

describe('PgBossQueue', () => {
  test('approving sends one agent-step job per step, keyed by the step id, with the retry settings', async () => {
    const { steps } = await approvedDemo();
    const jobs = await sender.findJobs<{ companyId: string; stepId: string }>(STEP_QUEUE, { queued: true });
    expect(jobs.map((j) => j.singletonKey).sort()).toEqual(steps.map((s) => s.id).sort());
    for (const job of jobs) {
      expect(job.data).toEqual({ companyId: t.seed.a.companyId, stepId: job.singletonKey });
      expect(job).toMatchObject({ retryLimit: 5, retryBackoff: true });
    }
  });

  test('sending a step that is already waiting adds no second job (the sweeper relies on this)', async () => {
    const { steps } = await approvedDemo();
    await queue.enqueueStep(t.seed.a.companyId, steps[0]!.id);
    await queue.enqueueStep(t.seed.a.companyId, steps[0]!.id);
    expect(await sender.findJobs(STEP_QUEUE, { key: steps[0]!.id, queued: true })).toHaveLength(1);
    expect(await sender.findJobs(STEP_QUEUE, { queued: true })).toHaveLength(3);
  });
});

describe('the worker', () => {
  test('an approved demo task runs to done through pg-boss within 10 seconds', async () => {
    const { taskId } = await approvedDemo();
    await withWorker(async () => {
      const task = await eventually(
        () => dbTask(t, 'a', taskId),
        (row) => row.status === 'done',
      );
      expect(task).toMatchObject({ status: 'done', minutesSaved: 15 });
    });
    expect((await dbSteps(t, 'a', taskId)).map((s) => [s.status, s.attempts])).toEqual([
      ['done', 1],
      ['done', 1],
      ['done', 1],
    ]);
    expect(bossErrors).toEqual([]);
  });

  test('a run that throws is retried by pg-boss (with backoff) until the step finishes', async () => {
    let calls = 0;
    const restore = registerStepHandler('demo_noop', async () => {
      calls += 1;
      if (calls === 1) throw new Error('provider timed out');
      return { status: 'done', result: { ok: 1 } };
    });
    try {
      const { taskId } = await approvedDemo();
      await withWorker(async () => {
        const task = await eventually(
          () => dbTask(t, 'a', taskId),
          (row) => row.status === 'done',
        );
        expect(task.status).toBe('done');
      });
      expect((await dbSteps(t, 'a', taskId)).map((s) => [s.type, s.status, s.attempts])).toEqual([
        ['demo_message', 'done', 1],
        ['demo_noop', 'done', 2],
        ['demo_spend', 'done', 1],
      ]);
    } finally {
      restore();
    }
  });

  test('a failed run leaves no SQL parameters or customer data in pg-boss: the job keeps only the safe description', async () => {
    const restore = registerStepHandler('demo_noop', async () => {
      throw new Error('Failed query: update "messages" set "body" = $1\nparams: Hi Molly,+14025550144');
    });
    try {
      const { steps } = await approvedDemo();
      const noop = steps[1]!;
      await withWorker(async (worker) => {
        const job = await eventually(
          async () => (await worker.findJobs(STEP_QUEUE, { key: noop.id }))[0],
          (j) => j?.state === 'retry',
        );
        expect(job?.state).toBe('retry');
        const stored = JSON.stringify(job!.output);
        expect(stored).toContain('Failed query: update');
        expect(stored).not.toContain('14025550144');
        expect(stored).not.toContain('Molly');
      });
    } finally {
      restore();
    }
  });

  test('it schedules expire-drafts every 5 minutes, sweep-queued, sweep-imports and dispatch-messages every minute, and prune-early-reports daily at 03:17', async () => {
    await withWorker(async (worker) => {
      const schedules = await worker.getSchedules();
      expect(schedules.map((s) => [s.name, s.cron]).sort()).toEqual([
        ['ad-spend-sync', '0 * * * *'],
        ['bill-monthly-fees', '0 9 1 * *'],
        ['calendar-pull', '*/5 * * * *'],
        ['dispatch-messages', '* * * * *'],
        ['end-trials', '*/5 * * * *'],
        ['exact-report-poll', '*/10 * * * *'],
        ['expire-drafts', '*/5 * * * *'],
        ['fd-health', '*/2 * * * *'],
        ['fd-retention', '47 3 * * *'],
        ['footprints-ensure', '*/15 * * * *'],
        ['hail-health', '*/15 * * * *'],
        ['poll-texting', '0 * * * *'],
        ['provision-texting', '* * * * *'],
        ['prune-early-reports', '17 3 * * *'],
        ['report-usage', '* * * * *'],
        ['signed-pdf-sweep', '*/15 * * * *'],
        ['spotter-sync', '*/30 * * * *'],
        ['storm-match', '*/10 * * * *'],
        ['sweep-imports', '* * * * *'],
        ['sweep-queued', '* * * * *'],
      ]);
    });
    expect(SCHEDULES.map((s) => s.name)).toEqual([
      'expire-drafts',
      'sweep-queued',
      'sweep-imports',
      'dispatch-messages',
      'end-trials',
      'report-usage',
      'provision-texting',
      'poll-texting',
      'bill-monthly-fees',
      'prune-early-reports',
      'calendar-pull',
      'footprints-ensure',
      'exact-report-poll',
      'signed-pdf-sweep',
      'spotter-sync',
      'storm-match',
      'ad-spend-sync',
      'hail-health',
      'fd-retention',
      'fd-health',
    ]);
  });
});
