import { createApp } from './app.ts';
import { buildDeps, loadConfigOrExit } from './deps.ts';
import { describeErrorForLog } from './errors.ts';
import { attachRelayUpgrade } from './front-desk/relay-server.ts';
import { ensureJobQueues, PgBossJobs } from './jobs/queue.ts';
import { createBoss, ensureStepQueue, PgBossQueue, SENDER_OPTIONS } from './tasks/pgboss-queue.ts';

/**
 * Entry point: `npm start -w @roofline/api`. Reads the environment, connects to the job queue,
 * opens the pools, listens. Approved steps are sent to pg-boss here and run by the worker process
 * (`npm run dev:worker`, or `npm start -w @roofline/worker`); without a worker they wait, queued.
 */

const SHUTDOWN_GRACE_MS = 10_000;

const config = loadConfigOrExit(process.env);

// Sending only: the worker does pg-boss's maintenance and cron.
const boss = createBoss(config.DATABASE_URL_SYSTEM, SENDER_OPTIONS);
try {
  await boss.start();
  await ensureStepQueue(boss);
  await ensureJobQueues(boss);
} catch (err) {
  console.error(`Could not set up the job queue: ${describeErrorForLog(err)}`);
  process.exit(1);
}

const deps = buildDeps(config, new PgBossQueue(boss), new PgBossJobs(boss));
if (!config.GOOGLE_CLIENT_ID && config.NODE_ENV === 'production') {
  console.warn('GOOGLE_CLIENT_ID is not set: Sign in with Google is off.');
}
const app = createApp(deps);

// Express 5 calls this once, with the error as its argument if listening failed (port in use).
const server = app.listen(config.PORT, config.HOST, (err?: Error) => {
  if (err) {
    console.error(`Could not listen on ${config.HOST}:${config.PORT}: ${err.message}`);
    process.exit(1);
  }
  console.log(`Roofline API listening on http://${config.HOST}:${config.PORT} (${config.NODE_ENV})`);
});

// D1 Front Desk: the /relay WebSocket upgrade
const relay = attachRelayUpgrade(server, deps);

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down.`);
  const force = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS);
  force.unref();
  relay.close();
  server.close(() => {
    boss
      .stop({ graceful: true, timeout: SHUTDOWN_GRACE_MS / 2 })
      .then(() => deps.pools.end())
      .then(
        () => process.exit(0),
        (err: unknown) => {
          console.error(`Shutting down failed: ${describeErrorForLog(err)}`);
          process.exit(1);
        },
      );
  });
  server.closeIdleConnections();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
