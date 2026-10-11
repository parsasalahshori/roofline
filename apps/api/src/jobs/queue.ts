import type { PgBoss } from 'pg-boss';
import type { AppDeps } from '../app.ts';
import { JOB_HANDLERS } from './handlers.ts';

// The job queues: the names, what a job carries, and where jobs go. The worker (worker.ts) runs
// them on pg-boss; the tests use `InlineJobs` below. handlers.ts imports only types from here.
export const JOB_NAMES = ['import-customers', 'texting-registration'] as const; export type JobName = (typeof JOB_NAMES)[number];
export type JobData = { companyId: string; importId?: string };
export type JobMeta = { attempt: number; lastAttempt: boolean };
export interface JobQueue { send(name: JobName, data: JobData, opts?: { singletonKey?: string }): Promise<void> }
export const JOB_QUEUE_OPTIONS = { policy: 'stately', retryLimit: 4, retryBackoff: true, retryDelay: 30 } as const;   // 5 attempts

/** The app's job queue on pg-boss. The boss must be started and the queues made (`ensureJobQueues`). */
export class PgBossJobs implements JobQueue {
  constructor(private readonly boss: PgBoss) {}
  async send(name: JobName, data: JobData, opts?: { singletonKey?: string }): Promise<void> {
    await this.boss.send(name, data, opts ?? {});
  }
}

/**
 * Makes each job queue if it is not there yet, then checks that the queue has the policy
 * `JOB_QUEUE_OPTIONS` asks for. Creating an existing queue changes nothing, and a policy cannot be
 * changed afterwards, so a queue made with another policy would keep it: startup stops with a clear
 * error instead (the same check `ensureStepQueue` makes). The check only reads.
 */
export async function ensureJobQueues(boss: PgBoss): Promise<void> {
  for (const name of JOB_NAMES) {
    await boss.createQueue(name, JOB_QUEUE_OPTIONS);
    const existing = await boss.getQueue(name);
    if (existing === null) throw new Error(`The ${name} queue could not be found after it was created.`);
    if (existing.policy !== JOB_QUEUE_OPTIONS.policy) {
      throw new Error(`The ${name} queue has the wrong policy (${existing.policy}); expected ${JOB_QUEUE_OPTIONS.policy}.`);
    }
  }
}

/** How many attempts a job gets: its first run and its retries. */
const MAX_ATTEMPTS = JOB_QUEUE_OPTIONS.retryLimit + 1;

/** A job waiting to run (or to run again after a throw). */
type WaitingJob = { name: JobName; data: JobData; singletonKey?: string; attempt: number };

/** A handler map: one handler per job name. */
export type JobHandlers = Record<JobName, (deps: AppDeps, data: JobData, meta: JobMeta) => Promise<void>>;

/**
 * The tests' job queue: it records every `send` call and runs nothing until `drain` is called. A
 * send whose `singletonKey` matches a job still waiting is recorded but not queued (the way pg-boss
 * drops a duplicate on a singleton-key policy). `drain` runs the waiting jobs in order, including
 * any sent while it drains. A job that throws goes to the back of the line with its next attempt
 * number, the way pg-boss retries it. Its fifth run is the last (`lastAttempt` is true there); a
 * throw on it goes to `errors`. It stops with an error after `maxRuns` runs, so a job that never
 * settles cannot hang a test.
 */
export class InlineJobs implements JobQueue {
  /** Every `send` call, in order. Retries are not calls. */
  readonly sent: { name: JobName; data: JobData; singletonKey?: string }[] = [];
  /** The errors of jobs whose last attempt threw. */
  readonly errors: unknown[] = [];
  private readonly waiting: WaitingJob[] = [];

  async send(name: JobName, data: JobData, opts?: { singletonKey?: string }): Promise<void> {
    const singletonKey = opts?.singletonKey;
    this.sent.push(singletonKey === undefined ? { name, data } : { name, data, singletonKey });
    if (singletonKey !== undefined && this.waiting.some((job) => job.singletonKey === singletonKey)) return;
    this.waiting.push(singletonKey === undefined ? { name, data, attempt: 1 } : { name, data, singletonKey, attempt: 1 });
  }

  async drain(deps: AppDeps, handlers: JobHandlers = JOB_HANDLERS, maxRuns = 100): Promise<void> {
    let lastError: unknown;
    for (let runs = 0; this.waiting.length > 0; runs++) {
      if (runs >= maxRuns) {
        throw new Error(`InlineJobs.drain stopped after ${maxRuns} runs with ${this.waiting.length} still waiting.`, {
          cause: lastError,
        });
      }
      const job = this.waiting.shift()!;
      const meta: JobMeta = { attempt: job.attempt, lastAttempt: job.attempt >= MAX_ATTEMPTS };
      try {
        await handlers[job.name](deps, job.data, meta);
      } catch (err) {
        lastError = err;
        if (meta.lastAttempt) {
          this.errors.push(err);
        } else {
          this.waiting.push({ ...job, attempt: job.attempt + 1 });
        }
      }
    }
  }
}
