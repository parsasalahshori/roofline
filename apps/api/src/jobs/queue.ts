import type { PgBoss } from 'pg-boss';
import type { AppDeps } from '../app.ts';
import { JOB_HANDLERS } from './handlers.ts';

// The job queues: the names, what a job carries, and where jobs go. The worker (worker.ts) runs
// them on pg-boss; the tests use `InlineJobs` below. handlers.ts imports only types from here.
export const JOB_NAMES = ['import-customers', 'texting-registration', 'calendar-push', 'footprints-load', 'signed-pdf', 'storm-match-company', 'storm-draft', 'storm-alert', 'ad-sync-company'] as const; export type JobName = (typeof JOB_NAMES)[number];
// 'footprints-load' is global work, but the worker requires a company id on every job: its data is
// `{ companyId: <the requesting company>, state }` with singletonKey = state.
// Storm Scout: 'storm-match-company' is `{ companyId }`, sent with singletonKey companyId; 'storm-draft' is
// `{ companyId, companyStormId }`; 'storm-alert' is `{ companyId, companyStormId, kind }`; 'ad-sync-company' is `{ companyId }`.
export type JobData = { companyId: string; importId?: string; appointmentId?: string; state?: string; proposalId?: string; companyStormId?: string; kind?: 'now' | 'plan' };
export type JobMeta = { attempt: number; lastAttempt: boolean };
export interface JobQueue { send(name: JobName, data: JobData, opts?: { singletonKey?: string }): Promise<void> }
export const JOB_QUEUE_OPTIONS = { policy: 'stately', retryLimit: 4, retryBackoff: true, retryDelay: 30 } as const;   // 5 attempts
/**
 * Queues whose jobs may run longer than pg-boss's default 15 minutes. A state's footprint load (a large
 * download and millions of rows) gets about the time a loading claim stays fresh (STALE_LOADING_MS, 6 h),
 * so pg-boss never times it out and retries it while the first run is still going.
 */
export const JOB_EXPIRE_SECONDS: Partial<Record<JobName, number>> = { 'footprints-load': 6 * 60 * 60 };

/** The pg-boss options for one queue: the shared policy, plus its own expiry when it has one. */
export function jobQueueOptions(name: JobName) {
  const expireInSeconds = JOB_EXPIRE_SECONDS[name];
  return expireInSeconds === undefined ? { ...JOB_QUEUE_OPTIONS } : { ...JOB_QUEUE_OPTIONS, expireInSeconds };
}

/** The app's job queue on pg-boss. The boss must be started and the queues made (`ensureJobQueues`). */
export class PgBossJobs implements JobQueue {
  constructor(private readonly boss: PgBoss) {}
  async send(name: JobName, data: JobData, opts?: { singletonKey?: string }): Promise<void> {
    // The expiry is sent with each job as well, so a queue made before it was set still gets it.
    const expireInSeconds = JOB_EXPIRE_SECONDS[name];
    await this.boss.send(name, data, { ...(opts ?? {}), ...(expireInSeconds !== undefined && { expireInSeconds }) });
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
    await boss.createQueue(name, jobQueueOptions(name));
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
 * send whose `singletonKey` matches a job of the same name still waiting is recorded but not queued
 * (the way pg-boss drops a duplicate: its singleton key is per queue, so the same key on another
 * queue still queues). `drain` runs the waiting jobs in order, including
 * any sent while it drains. A job that throws goes to the back of the line with its next attempt
 * number, the way pg-boss retries it. Every throw goes to `errors`. Its fifth run is the last
 * (`lastAttempt` is true there); a job that throws on it is dropped. It stops with an error after `maxRuns` runs, so a job that never
 * settles cannot hang a test.
 */
export class InlineJobs implements JobQueue {
  /** Every `send` call, in order. Retries are not calls. */
  readonly sent: { name: JobName; data: JobData; singletonKey?: string }[] = [];
  /** Every error a handler threw, one per failed attempt. */
  readonly errors: unknown[] = [];
  private readonly waiting: WaitingJob[] = [];

  async send(name: JobName, data: JobData, opts?: { singletonKey?: string }): Promise<void> {
    const singletonKey = opts?.singletonKey;
    this.sent.push(singletonKey === undefined ? { name, data } : { name, data, singletonKey });
    if (singletonKey !== undefined && this.waiting.some((job) => job.name === name && job.singletonKey === singletonKey)) {
      return;
    }
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
        this.errors.push(err);
        if (!meta.lastAttempt) this.waiting.push({ ...job, attempt: job.attempt + 1 });
      }
    }
  }
}
