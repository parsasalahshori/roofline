import {
  buildDeps,
  createBoss,
  describeErrorForLog,
  JOB_NAMES,
  loadConfigOrExit,
  PgBossJobs,
  PgBossQueue,
  SCHEDULES,
  startWorker,
} from '@roofline/api';

/*
 * The worker process: `npm start -w @roofline/worker` (or `npm run dev:worker` from the root). It
 * reads the same environment as the API, builds the same deps, and works pg-boss's queues: each
 * approved step (`agent-step`, run with `runStep`), the background jobs (`JOB_NAMES`: imports and
 * texting registration), and the scheduler's recurring jobs (`SCHEDULES`, listed in
 * apps/api/src/jobs/worker.ts). Several workers can run at once; pg-boss hands each job to one of
 * them. Texts go through `deps.sms`, the adapter `createSmsAdapter` picks from the config: the
 * fake, Twilio, or the disabled adapter.
 *
 * On SIGTERM or SIGINT it stops taking jobs, lets the running ones finish (pg-boss's graceful
 * stop), then closes the database pools.
 */

/** How long a graceful stop waits for running steps before giving up on them. */
const STOP_TIMEOUT_MS = 30_000;

const config = loadConfigOrExit(process.env);
const boss = createBoss(config.DATABASE_URL_SYSTEM);
try {
  await boss.start();
} catch (err) {
  console.error(`Could not connect to the job queue: ${describeErrorForLog(err)}`);
  process.exit(1);
}

const deps = buildDeps(config, new PgBossQueue(boss), new PgBossJobs(boss));
try {
  await startWorker(boss, deps);
} catch (err) {
  // Includes ensureStepQueue refusing an agent-step queue that has the wrong policy.
  console.error(`Could not set up the job queue: ${describeErrorForLog(err)}`);
  process.exit(1);
}
// The segmenter's model loads now, not with the first scan's first frame (SCAN_REFINE=on runs SAM 2 here, in the worker)
if (config.SCAN_REFINE === 'on') void deps.windowSegmenter.warm?.().catch((err: unknown) => console.warn(`The window segmenter did not warm up: ${describeErrorForLog(err)}`));
console.log(
  `Roofline worker started (${config.NODE_ENV}): agent-step, job queues ${JOB_NAMES.join(', ')}, ${SCHEDULES.map((s) => `${s.name} (${s.cron})`).join(', ')}`,
);

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, finishing the running steps and stopping.`);
  const force = setTimeout(() => process.exit(1), STOP_TIMEOUT_MS + 5_000);
  force.unref();
  boss
    .stop({ graceful: true, timeout: STOP_TIMEOUT_MS })
    .then(() => deps.pools.end())
    .then(
      () => process.exit(0),
      (err: unknown) => {
        console.error(`Stopping the worker failed: ${describeErrorForLog(err)}`);
        process.exit(1);
      },
    );
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
