import type { PgBoss } from 'pg-boss';
import type { AppDeps } from '../app.ts';
import { describeErrorForLog } from '../errors.ts';
import { ensureStepQueue, STEP_QUEUE, type StepJobData } from '../tasks/pgboss-queue.ts';
import { runStep } from '../tasks/runner.ts';
import { UUID } from '../validate.ts';
import { dispatchDueMessages } from './scheduler/dispatch-messages.ts';
import { expireDrafts } from './scheduler/expire-drafts.ts';
import { reportJobError } from './scheduler/report.ts';
import { sweepQueued } from './scheduler/sweep-queued.ts';

/*
 * What the worker process does with pg-boss (apps/worker starts it): run each `agent-step` job
 * with `runStep`, and run the scheduler's jobs on their crons. Kept here, beside the code it runs,
 * so the tests can start a worker in-process.
 */

/** A job the worker runs on a cron, with the app's deps and the clock's time. */
export type ScheduledJob = {
  /** The pg-boss queue and schedule name. */
  name: string;
  /** A cron expression, evaluated in UTC. */
  cron: string;
  run: (deps: AppDeps, now: Date) => Promise<unknown>;
};

/**
 * The worker's recurring jobs: draft expiry, the queued-step sweeper, and the scheduled-text
 * dispatcher (texts waiting out quiet hours, and the batch steps they belong to). A schedule
 * dropped from this list is unscheduled the next time a worker starts.
 */
export const SCHEDULES: readonly ScheduledJob[] = [
  { name: 'expire-drafts', cron: '*/5 * * * *', run: expireDrafts },
  { name: 'sweep-queued', cron: '* * * * *', run: sweepQueued },
  { name: 'dispatch-messages', cron: '* * * * *', run: dispatchDueMessages },
];

/** How many steps one worker process runs at once. */
export const STEP_CONCURRENCY = 4;

export type WorkerOptions = {
  /** How often an idle worker looks for jobs, in seconds (pg-boss's default is 2). */
  pollingIntervalSeconds?: number;
  /** Steps run at once by this process (default `STEP_CONCURRENCY`). */
  localConcurrency?: number;
  /** The recurring jobs (default `SCHEDULES`). */
  schedules?: readonly ScheduledJob[];
};

/**
 * The error a failed run hands back to pg-boss, which keeps it on the job (its `output`) until the
 * job is cleaned up. Only `describeErrorForLog`'s safe form goes in: a database error's message
 * carries its SQL parameters, which can be customer data.
 */
class JobFailed extends Error {
  constructor(cause: unknown) {
    super(describeErrorForLog(cause));
    this.name = 'JobFailed';
  }
}

function isStepJob(data: unknown): data is StepJobData {
  if (typeof data !== 'object' || data === null) return false;
  const { companyId, stepId } = data as Record<string, unknown>;
  return typeof companyId === 'string' && UUID.test(companyId) && typeof stepId === 'string' && UUID.test(stepId);
}

/**
 * Starts working pg-boss's queues on a started boss:
 * - `agent-step`: each job runs its step with `runStep(deps, companyId, stepId)`. A run that throws
 *   fails the job (with the error in its safe form), and pg-boss tries it again with backoff; the
 *   runner has already put the step back to `queued` for that next try. A job whose data is not a
 *   company and step id is logged and dropped.
 * - each of `schedules`: its own queue (one waiting job at most, no retries: the next tick is the
 *   retry), worked by `run(deps, deps.clock.now())`, and scheduled on its cron. A failure is logged
 *   through `deps.logError`.
 * Schedules no longer in the list are removed. Returns once everything is registered.
 */
export async function startWorker(boss: PgBoss, deps: AppDeps, options: WorkerOptions = {}): Promise<void> {
  const polling = { pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2 };
  const schedules = options.schedules ?? SCHEDULES;

  await ensureStepQueue(boss);
  await boss.work<unknown>(
    STEP_QUEUE,
    { ...polling, localConcurrency: options.localConcurrency ?? STEP_CONCURRENCY },
    async ([job]) => {
      if (!job) return;
      if (!isStepJob(job.data)) {
        reportJobError(deps, new Error(`An ${STEP_QUEUE} job did not name a company and a step.`), `${STEP_QUEUE} job ${job.id}`);
        return;
      }
      try {
        await runStep(deps, job.data.companyId, job.data.stepId);
      } catch (err) {
        throw new JobFailed(err);
      }
    },
  );

  const wanted = new Set(schedules.map((s) => s.name));
  for (const old of await boss.getSchedules()) {
    if (!wanted.has(old.name)) await boss.unschedule(old.name, old.key);
  }
  for (const job of schedules) {
    await boss.createQueue(job.name, { policy: 'short', retryLimit: 0 });
    await boss.work(job.name, polling, async () => {
      try {
        await job.run(deps, deps.clock.now());
      } catch (err) {
        reportJobError(deps, err, job.name);
        throw new JobFailed(err);
      }
    });
    await boss.schedule(job.name, job.cron);
  }
}
