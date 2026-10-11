import {
  buildDeps,
  createBoss,
  describeErrorForLog,
  loadConfigOrExit,
  PgBossQueue,
  SCHEDULES,
  startWorker,
} from '@roofline/api';

/*
 * The worker process: `npm start -w @roofline/worker` (or `npm run dev:worker` from the root). It
 * reads the same environment as the API, builds the same deps, and works pg-boss's queues: each
 * approved step (`agent-step`, run with `runStep`) and the scheduler's recurring jobs (`SCHEDULES`:
 * draft expiry every 5 minutes, the queued-step sweeper and the scheduled-text dispatcher every
 * minute). Several workers can run at once; pg-boss hands each job to one of them. Texts go through
 * `deps.sms`, which `buildDeps` sets to the disabled provider until F3 adds Twilio.
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

const deps = buildDeps(config, new PgBossQueue(boss));
try {
  await startWorker(boss, deps);
} catch (err) {
  // Includes ensureStepQueue refusing an agent-step queue that has the wrong policy.
  console.error(`Could not set up the job queue: ${describeErrorForLog(err)}`);
  process.exit(1);
}
console.log(`Roofline worker started (${config.NODE_ENV}): agent-step, ${SCHEDULES.map((s) => `${s.name} (${s.cron})`).join(', ')}`);

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
