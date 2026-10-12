import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createPools, migrate } from '@roofline/db';
import { APP_ROLES, roleUrl, setRolePasswords } from '@roofline/db/testing';
import { DEMO_COMPANY_NAME, DEMO_LOGIN, seedDemoWorld } from '@roofline/api';
import { dockerProblem, nodeProblem, portIsFree, portProblem } from './demo-preflight.ts';

/*
 * `npm run demo`: the whole app with no real accounts, on macOS (Docker Desktop) or Linux.
 *
 *  1. Checks Node, Docker (on Linux it starts `dockerd` when Docker is not answering) and the ports.
 *  2. Starts the demo database with docker compose (docker-compose.demo.yml: multi-arch PostGIS on
 *     its own port and volume) and runs every migration.
 *  3. Seeds Summit Ridge Roofing (apps/api/src/scripts/demo-world.ts) unless it is already there.
 *  4. Builds the web app when apps/web/dist is missing (DEMO_BUILD=1 forces it).
 *  5. Runs the API (which serves the web app) and the worker with DEMO_MODE=1, so every outside
 *     service is a fake: no text, email, call or charge leaves the machine.
 *
 * `--db-only` stops after the seed, leaving the database running.
 * Ctrl+C stops the app and the database container; the data stays for the next run.
 * `npm run demo:reset` (`--reset`) throws the database away first, for fresh data dated "now".
 *
 *   DEMO_PORT     the app's port (default 4500)
 *   DEMO_DB_PORT  the database's port (default 54339)
 *   DEMO_COMPOSE_PROJECT  the compose project (default roofline-demo; the CI smoke uses its own)
 *   DEMO_OPEN=1   opens the browser once the app answers (scripts/demo-mac.sh sets it)
 */

const PORT = Number(process.env.DEMO_PORT?.trim() || 4500);
const DB_PORT = Number(process.env.DEMO_DB_PORT?.trim() || 54339);
const BASE_URL = `http://localhost:${PORT}`;
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMPOSE = ['compose', '-p', process.env.DEMO_COMPOSE_PROJECT?.trim() || 'roofline-demo', '-f', `${REPO_ROOT}docker-compose.demo.yml`];
const OWNER_URL = `postgres://roofline:roofline@127.0.0.1:${DB_PORT}/roofline`;
/** Local-only role passwords for the demo database (it listens on 127.0.0.1 only). */
const ROLE_PASSWORDS = { tenant: 'demo-tenant-pw', system: 'demo-system-pw' } as const;
const SHUTDOWN_WAIT_MS = 10_000;
const RESET = process.argv.includes('--reset');
/** `--db-only`: start the database, migrate and seed, then stop (the arm64 CI check uses it). */
const DB_ONLY = process.argv.includes('--db-only');

function log(line: string): void {
  process.stdout.write(`[demo] ${line}\n`);
}

function fail(message: string): never {
  process.stderr.write(`\n[demo] ${message}\n\n`);
  process.exit(1);
}

function docker(args: string[], inherit = false): { ok: boolean; out: string } {
  const result = spawnSync('docker', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe', env: { ...process.env, DEMO_DB_PORT: String(DB_PORT) } });
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

async function ensureDocker(): Promise<void> {
  if (docker(['info']).ok) return;
  if (process.platform === 'linux') {
    log('Docker is not running; starting dockerd in the background.');
    const daemon = spawn('dockerd', [], { detached: true, stdio: 'ignore' });
    daemon.on('error', () => undefined);
    daemon.unref();
  } else if (process.platform === 'darwin') {
    log('Docker is not running; opening Docker Desktop (the first launch asks you to accept its terms).');
    spawnSync('open', ['-a', 'Docker'], { stdio: 'ignore' });
  }
  for (let i = 0; i < 120; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (docker(['info']).ok) return;
  }
  fail(dockerProblem(process.platform));
}

// 1. Prerequisites
const nodeIssue = nodeProblem(process.version);
if (nodeIssue) fail(nodeIssue);
await ensureDocker();
if (!docker(['compose', 'version']).ok) fail('docker compose is missing. Update Docker Desktop (it includes compose), or install the docker-compose-plugin.');
if (!(await portIsFree(PORT))) fail(portProblem(PORT, 'DEMO_PORT'));
const dbRunning = docker([...COMPOSE, 'ps', '--status', 'running', '-q', 'db']).out.trim() !== '';
if (!dbRunning && !(await portIsFree(DB_PORT))) fail(portProblem(DB_PORT, 'DEMO_DB_PORT'));

// 2. Database
if (RESET) {
  log('Resetting: removing the demo database.');
  docker([...COMPOSE, 'down', '-v'], true);
}
log('Starting the demo database (the first run downloads PostGIS, about 1 minute).');
if (!docker([...COMPOSE, 'up', '-d', '--wait', 'db'], true).ok) fail('The demo database did not start. Is Docker Desktop running and up to date?');

let children: ChildProcess[] = [];
let shuttingDown = false;

async function shutdown(code: number): Promise<never> {
  shuttingDown = true;
  const exits = children.map(
    (child) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  );
  await Promise.race([Promise.all(exits), new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS))]);
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  log('Stopping the demo database (its data is kept; npm run demo:reset starts fresh).');
  docker([...COMPOSE, 'stop']);
  process.exit(code);
}
process.on('SIGINT', () => {
  if (!shuttingDown) void shutdown(0);
});
process.on('SIGTERM', () => {
  if (!shuttingDown) void shutdown(0);
});

const tenantUrl = roleUrl(OWNER_URL, APP_ROLES.tenant, ROLE_PASSWORDS.tenant);
const systemUrl = roleUrl(OWNER_URL, APP_ROLES.system, ROLE_PASSWORDS.system);

// 3. Migrations and seed; 4. web build
try {
  log('Running the migrations.');
  await migrate(OWNER_URL);
  await setRolePasswords(OWNER_URL, ROLE_PASSWORDS);
  const pools = createPools({ tenant: tenantUrl, system: systemUrl });
  try {
    const world = await seedDemoWorld(pools, OWNER_URL, new Date());
    log(
      world.created
        ? `Seeded ${DEMO_COMPANY_NAME}: ${Object.entries(world.counts).map(([name, n]) => `${n} ${name}`).join(', ')}.`
        : `${DEMO_COMPANY_NAME} is already seeded (npm run demo:reset starts fresh).`,
    );
  } finally {
    await pools.end();
  }
  if (DB_ONLY) {
    log('Database ready (--db-only).');
    process.exit(0);
  }
  if (process.env.DEMO_BUILD === '1' || !existsSync(`${REPO_ROOT}apps/web/dist/index.html`)) {
    log('Building the web app (about 1 minute).');
    execFileSync('npm', ['run', 'build:web'], { cwd: REPO_ROOT, stdio: 'inherit' });
  }
} catch (err) {
  console.error(err);
  await shutdown(1);
}

// 5. The app
const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'development',
  DEMO_MODE: '1',
  PORT: String(PORT),
  HOST: '127.0.0.1',
  APP_ORIGIN: BASE_URL,
  PUBLIC_BASE_URL: BASE_URL,
  POLICY_PAGES_DOMAIN: 'roofline.test',
  DATABASE_URL_TENANT: tenantUrl,
  DATABASE_URL_SYSTEM: systemUrl,
  // Random per run: nothing the demo stores needs to outlive it except sessions.
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  WEB_DIST_DIR: 'apps/web/dist',
  API_RATE_LIMIT_PER_MIN: '100000',
};
// Never let a real key from the shell reach a demo process.
for (const name of Object.keys(env)) {
  if (/^(STRIPE|TWILIO|POSTMARK|ANTHROPIC|GEOCODIO|EAGLEVIEW|GOOGLE_ADS|META|R2|MAPTILER|GOOGLE_CLIENT|MICROSOFT)_/.test(name)) {
    delete env[name];
  }
}

function start(name: string, script: string): ChildProcess {
  const child = spawn('npx', ['tsx', script], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const forward = (stream: NodeJS.ReadableStream | null) => {
    if (stream) createInterface({ input: stream }).on('line', (line) => process.stdout.write(`[${name}] ${line}\n`));
  };
  forward(child.stdout);
  forward(child.stderr);
  child.once('exit', (code, signal) => {
    if (shuttingDown) return;
    log(`${name} exited on its own (code ${code ?? 'none'}, signal ${signal ?? 'none'}).`);
    void shutdown(1);
  });
  return child;
}

children = [start('api', 'apps/api/src/server.ts'), start('worker', 'apps/worker/src/index.ts')];

let up = false;
for (let i = 0; i < 240 && !up; i += 1) {
  try {
    up = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok;
  } catch {
    // not listening yet
  }
  if (!up) await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!up) {
  log('The app did not answer within 2 minutes; see the [api] lines above.');
  await shutdown(1);
}

log('');
log('==============================================================');
log(`  Roofline demo is running: ${BASE_URL}`);
log(`  Email:    ${DEMO_LOGIN.email}`);
log(`  Password: ${DEMO_LOGIN.password}`);
log('  Click the Demo badge (top bar) to simulate a text, a call,');
log('  a hail storm or a signature. Ctrl+C stops the demo.');
log('==============================================================');
if (process.env.DEMO_OPEN === '1') {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(opener, [BASE_URL], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
}
