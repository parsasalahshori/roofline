import type { PgBoss } from 'pg-boss';
import type { AppDeps } from '../app.ts';
import { describeErrorForLog } from '../errors.ts';
import { ensureStepQueue, STEP_QUEUE, type StepJobData } from '../tasks/pgboss-queue.ts';
import { runStep } from '../tasks/runner.ts';
import { UUID } from '../validate.ts';
import { JOB_HANDLERS } from './handlers.ts';
import { ensureJobQueues, JOB_NAMES, type JobData, type JobMeta } from './queue.ts';
import { adSpendSync } from './scheduler/ad-spend-sync.ts';
import { billMonthlyFees } from './scheduler/bill-monthly-fees.ts';
import { pullCalendars } from './scheduler/calendar-pull.ts';
import { dispatchDueMessages } from './scheduler/dispatch-messages.ts';
import { ensureFootprints } from './scheduler/footprints-ensure.ts';
import { pollExactReports } from './scheduler/exact-report-poll.ts';
import { endTrials } from './scheduler/end-trials.ts';
import { expireDrafts } from './scheduler/expire-drafts.ts';
import { hailHealth } from './scheduler/hail-health.ts';
import { fdHealth } from './scheduler/fd-health.ts';
import { fdRetention } from './scheduler/fd-retention.ts';
import { pollTexting } from './scheduler/poll-texting.ts';
import { pruneEarlyReports } from './scheduler/prune-early-reports.ts';
import { provisionTexting } from './scheduler/provision-texting.ts';
import { reportJobError } from './scheduler/report.ts';
import { reportUsage } from './scheduler/report-usage.ts';
import { spotterSync } from './scheduler/spotter-sync.ts';
import { stormMatch } from './scheduler/storm-match.ts';
import { sweepImports } from './scheduler/sweep-imports.ts';
import { sweepQueued } from './scheduler/sweep-queued.ts';

/*
 * What the worker process does with pg-boss (apps/worker starts it): run each `agent-step` job
 * with `runStep`, run each job-queue job (JOB_NAMES) with its handler in JOB_HANDLERS, and run the
 * scheduler's jobs on their crons. Kept here, beside the code it runs, so the tests can start a
 * worker in-process.
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
 * The worker's recurring jobs: draft expiry, the queued-step sweeper, the import sweeper (imports
 * stranded queued or processing), the scheduled-text
 * dispatcher (texts waiting out quiet hours, and the batch steps they belong to), then the trial
 * end, usage reporting, texting provisioning and polling, the monthly fees, calendar pulls, the footprints top-up, the exact-report poll, Storm Scout's Spotter sync, storm matching, ad-spend sync and hail-feed health check, and Front Desk's retention and health checks. A schedule dropped
 * from this list is unscheduled the next time a worker starts.
 */
export const SCHEDULES: readonly ScheduledJob[] = [
  { name: 'expire-drafts', cron: '*/5 * * * *', run: expireDrafts },
  { name: 'sweep-queued', cron: '* * * * *', run: sweepQueued },
  { name: 'sweep-imports', cron: '* * * * *', run: sweepImports },
  { name: 'dispatch-messages', cron: '* * * * *', run: dispatchDueMessages },
  { name: 'end-trials', cron: '*/5 * * * *', run: endTrials },
  { name: 'report-usage', cron: '* * * * *', run: reportUsage },
  { name: 'provision-texting', cron: '* * * * *', run: provisionTexting },
  { name: 'poll-texting', cron: '0 * * * *', run: pollTexting },
  { name: 'bill-monthly-fees', cron: '0 9 1 * *', run: billMonthlyFees },
  { name: 'prune-early-reports', cron: '17 3 * * *', run: pruneEarlyReports },
  { name: 'calendar-pull', cron: '*/5 * * * *', run: pullCalendars },
  { name: 'footprints-ensure', cron: '*/15 * * * *', run: ensureFootprints },
  { name: 'exact-report-poll', cron: '*/10 * * * *', run: pollExactReports },
  { name: 'spotter-sync', cron: '*/30 * * * *', run: spotterSync },
  { name: 'storm-match', cron: '*/10 * * * *', run: stormMatch },
  { name: 'ad-spend-sync', cron: '0 * * * *', run: adSpendSync },
  { name: 'hail-health', cron: '*/15 * * * *', run: hailHealth },
  // D1 Front Desk
  { name: 'fd-retention', cron: '17 3 * * *', run: fdRetention },
  { name: 'fd-health', cron: '*/2 * * * *', run: fdHealth },
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

/**
 * A job-queue job's data: a company id, plus an import id for an import or an appointment id for a
 * calendar push, or a state for a footprints load (which carries the requesting company's id), or a proposal id for a signed PDF, or a storm id (and an alert kind) for the storm jobs. Checked before a handler runs.
 */
function isJobData(data: unknown): data is JobData {
  if (typeof data !== 'object' || data === null) return false;
  const { companyId } = data as Record<string, unknown>;
  return typeof companyId === 'string' && UUID.test(companyId);
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
 * - each of JOB_NAMES (the job queues, made by `ensureJobQueues`): each job runs its handler in
 *   JOB_HANDLERS with its data and `meta` (`attempt` counted from 1, and `lastAttempt` on the last
 *   try that pg-boss allows). A job whose data has no company id that is a UUID is logged and
 *   dropped; a handler that throws fails the job (as `JobFailed`), and pg-boss retries it.
 * - each of `schedules`: its own queue (one waiting job at most, no retries: the next tick is the
 *   retry), worked by `run(deps, deps.clock.now())`, and scheduled on its cron. A failure is logged
 *   through `deps.logError`.
 * Schedules no longer in the list are removed. Returns once everything is registered.
 */
export async function startWorker(boss: PgBoss, deps: AppDeps, options: WorkerOptions = {}): Promise<void> {
  const polling = { pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2 };
  const schedules = options.schedules ?? SCHEDULES;

  await ensureStepQueue(boss);
  await ensureJobQueues(boss);
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

  for (const name of JOB_NAMES) {
    await boss.work(name, { ...polling, includeMetadata: true }, async ([job]) => {
      if (!job) return;
      if (!isJobData(job.data)) {
        reportJobError(deps, new Error(`A ${name} job did not name a company.`), `${name} job ${job.id}`);
        return;
      }
      const meta: JobMeta = { attempt: job.retryCount + 1, lastAttempt: job.retryCount >= job.retryLimit };
      try {
        await JOB_HANDLERS[name](deps, job.data, meta);
      } catch (err) {
        throw new JobFailed(err);
      }
    });
  }

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
