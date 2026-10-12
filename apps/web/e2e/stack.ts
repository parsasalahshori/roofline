import { randomBytes } from 'node:crypto';
import { type ChildProcess, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startTestDatabase } from '@roofline/db/testing';
import { resetScenario } from './fixtures.ts';

/*
 * The end-to-end stack, run by Playwright's webServer (`npx tsx e2e/stack.ts`, cwd apps/web). It
 * starts a throwaway PostGIS, seeds the scenario, then runs the API and the worker against it on
 * port 4410 and stays in the foreground until either child exits or the process is signalled.
 */

const BASE_URL = 'http://127.0.0.1:4410';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const STACK_FILE = fileURLToPath(new URL('.stack.json', import.meta.url));
const SHUTDOWN_WAIT_MS = 10_000;

const db = await startTestDatabase();

const ENCRYPTION_KEY = randomBytes(32).toString('base64');
/** Roofline's own test caller number for the Front Desk forwarding test (a 555 number; no call leaves the box). */
const TEST_CALLER_NUMBER = '+14025550100';

/** Both children read this one environment (on top of process.env). */
const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'test',
  PORT: '4410',
  HOST: '127.0.0.1',
  APP_ORIGIN: BASE_URL,
  PUBLIC_BASE_URL: BASE_URL,
  DATABASE_URL_TENANT: db.urls.tenant,
  DATABASE_URL_SYSTEM: db.urls.system,
  ENCRYPTION_KEY,
  TWILIO_TEST_CALLER_NUMBER: TEST_CALLER_NUMBER,
  WEATHER_DISABLED: '1',
  FAKE_PROVIDERS: '1',
  WEB_DIST_DIR: 'apps/web/dist',
  API_RATE_LIMIT_PER_MIN: '100000',
};

let shuttingDown = false;

/** Stops both children and the database, then exits with `code`. Runs once. */
async function shutdown(code: number, children: ChildProcess[]): Promise<never> {
  shuttingDown = true;
  const exits = children.map(
    (child) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  );
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS));
  await Promise.race([Promise.all(exits), timeout]);
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await db.stop();
  process.exit(code);
}

/** Starts one child process whose output is prefixed line by line with `[name] `. */
function start(name: string, script: string): ChildProcess {
  const child = spawn('npx', ['tsx', script], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const forward = (stream: NodeJS.ReadableStream | null) => {
    if (!stream) return;
    createInterface({ input: stream }).on('line', (line) => {
      process.stdout.write(`[${name}] ${line}\n`);
    });
  };
  forward(child.stdout);
  forward(child.stderr);
  return child;
}

try {
  await writeFile(
    STACK_FILE,
    `${JSON.stringify(
      {
        ownerUrl: db.urls.owner,
        tenantUrl: db.urls.tenant,
        systemUrl: db.urls.system,
        baseUrl: BASE_URL,
        // Throwaway key of this run's database: the Front Desk specs encrypt a webhook signing token with it.
        encryptionKey: ENCRYPTION_KEY,
        testCallerNumber: TEST_CALLER_NUMBER,
      },
      null,
      2,
    )}\n`,
  );
  await resetScenario(db.urls);
} catch (err) {
  console.error(err);
  await db.stop();
  process.exit(1);
}

const api = start('api', 'apps/api/src/server.ts');
const worker = start('worker', 'apps/worker/src/index.ts');
const children = [api, worker];

for (const [name, child] of [
  ['api', api],
  ['worker', worker],
] as const) {
  child.once('exit', (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(`[${name}] exited on its own (code ${code ?? 'none'}, signal ${signal ?? 'none'})\n`);
    void shutdown(1, children);
  });
}

process.on('SIGINT', () => {
  if (!shuttingDown) void shutdown(0, children);
});
process.on('SIGTERM', () => {
  if (!shuttingDown) void shutdown(0, children);
});
