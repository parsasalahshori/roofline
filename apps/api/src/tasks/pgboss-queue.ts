import { type ConstructorOptions, PgBoss, type Queue } from 'pg-boss';
import { describeErrorForLog, logErrorToConsole } from '../errors.ts';
import type { StepQueue } from './queue.ts';

/*
 * The step queue on pg-boss (installed version 12): jobs live in Postgres, in the `pgboss`
 * schema, and pg-boss connects as app_system (the 0002 migration made the schema and gave it to
 * that role). The API only sends; the worker process (apps/worker) runs the jobs, through
 * `startWorker` in jobs/worker.ts.
 */

/** The queue every approved step goes to. One job runs one step (`runStep`). */
export const STEP_QUEUE = 'agent-step';

/** pg-boss's schema, owned by app_system. */
export const PGBOSS_SCHEMA = 'pgboss';

/** What an `agent-step` job carries: which step, of which company. Ids only, never content. */
export type StepJobData = { companyId: string; stepId: string };

/**
 * How a step's job retries: up to 5 more runs, with exponential backoff. The runner itself gives a
 * step 5 runs before it needs a person, and it returns normally on the fifth, so the job's own
 * limit is only reached when ending a run fails (the database was unreachable, for example).
 */
const STEP_RETRIES = { retryLimit: 5, retryBackoff: true } as const;

/**
 * The step queue's settings. `short` keeps at most one WAITING job per singleton key (the step
 * id): sending a step that already has a job waiting adds nothing (pg-boss 12 only dedupes by
 * `singletonKey` under such a policy; on the default `standard` policy every send is a new job).
 * A job that is already running does not count, so a step put back by a person's retry or by the
 * sweeper's lease recovery gets a new job at once even if an old one is still finishing (that old
 * one's run then finds a newer claim and writes nothing).
 */
export const STEP_QUEUE_OPTIONS: Omit<Queue, 'name'> = { policy: 'short', ...STEP_RETRIES };

/** What an API process needs from pg-boss: sending only, so no maintenance and no cron. */
export const SENDER_OPTIONS = { supervise: false, schedule: false } as const;

export type BossOptions = Omit<ConstructorOptions, 'connectionString' | 'schema' | 'db' | 'createSchema'> & {
  /** Where pg-boss's own errors go (default `logErrorToConsole`). Gets the error and `'pg-boss'`. */
  logError?: (err: unknown, where: string) => void;
};

/**
 * A pg-boss instance on the `pgboss` schema, connecting with `systemUrl` (the app_system URL). It
 * is not started: call `start()` (which installs or upgrades pg-boss's tables when needed) and
 * then `ensureStepQueue`. `createSchema: false`: the schema already exists (0002), and pg-boss's
 * `CREATE SCHEMA IF NOT EXISTS` would need CREATE on the whole database, which app_system does
 * not get. pg-boss reports background trouble (a lost connection, a failed
 * maintenance pass) as `error` events; an EventEmitter with no `error` listener would crash the
 * process, so one is always attached, and it logs in the safe form of `describeErrorForLog`.
 * Warnings (slow queries, a long queue) are logged as one line.
 */
export function createBoss(systemUrl: string, options: BossOptions = {}): PgBoss {
  const { logError = logErrorToConsole, ...rest } = options;
  const boss = new PgBoss({ ...rest, connectionString: systemUrl, schema: PGBOSS_SCHEMA, createSchema: false });
  boss.on('error', (err) => {
    try {
      logError(err, 'pg-boss');
    } catch {
      // A failing logger must not turn a background hiccup into a crash.
    }
  });
  boss.on('warning', (warning) => {
    // Some warnings quote a database error; only its first line, without any parameters, is printed.
    const line = new Error(warning.message);
    line.name = 'pg-boss warning';
    console.warn(describeErrorForLog(line));
  });
  return boss;
}

/**
 * Makes the `agent-step` queue if it is not there yet, then checks the queue that is there.
 * Creating an existing queue changes nothing, and a policy cannot be changed afterwards, so a
 * queue made earlier with another policy (`standard`, say) would keep it: sending a step twice
 * would then make two jobs and run it twice. Startup stops with a clear error instead. The check
 * only reads; it never changes or deletes the queue.
 */
export async function ensureStepQueue(boss: PgBoss): Promise<void> {
  await boss.createQueue(STEP_QUEUE, STEP_QUEUE_OPTIONS);
  const existing = await boss.getQueue(STEP_QUEUE);
  if (existing === null) throw new Error(`The ${STEP_QUEUE} queue could not be found after it was created.`);
  if (existing.policy !== STEP_QUEUE_OPTIONS.policy) {
    throw new Error(`The ${STEP_QUEUE} queue has the wrong policy (${existing.policy}); expected ${STEP_QUEUE_OPTIONS.policy}.`);
  }
}

/**
 * The server's step queue: each step becomes an `agent-step` job,
 * `send('agent-step', {companyId, stepId}, {singletonKey: stepId, retryLimit: 5, retryBackoff: true})`.
 * The boss must be started and the queue made (`ensureStepQueue`). Sending a step that already has
 * a job waiting is a no-op, which is what makes the sweeper's re-sends safe.
 */
export class PgBossQueue implements StepQueue {
  constructor(private readonly boss: PgBoss) {}

  async enqueueStep(companyId: string, stepId: string): Promise<void> {
    const data: StepJobData = { companyId, stepId };
    await this.boss.send(STEP_QUEUE, data, { singletonKey: stepId, ...STEP_RETRIES });
  }
}
