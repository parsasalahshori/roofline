import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createPools, migrate } from '@roofline/db';
import { APP_ROLES, roleUrl, setRolePasswords } from '@roofline/db/testing';
import { DEMO_COMPANY_NAME, DEMO_LOGIN, DEMO_WINCHOICE_LOGIN, DEMO_WINCHOICE_NAME, DirObjectStore, seedDemoWorld, seedWinChoiceWorld } from '@roofline/api';
import { dockerProblem, nodeProblem, portIsFree, portProblem } from './demo-preflight.ts';

/*
 * `npm run demo`: the whole app with no real accounts, on macOS (Docker Desktop) or Linux.
 *
 *  1. Checks Node, Docker (on Linux it starts `dockerd` when Docker is not answering) and the ports.
 *  2. Starts the demo database with docker compose (docker-compose.demo.yml: multi-arch PostGIS on
 *     its own port and volume) and runs every migration.
 *  3. Seeds Summit Ridge Roofing (apps/api/src/scripts/demo-world.ts) and WinChoice (demo) (demo-winchoice.ts, a windows-first
 *     company in Arkansas with its own owner login and red brand) unless they are already there.
 *  4. Builds the web app when apps/web/dist was not built from this commit (DEMO_BUILD=1 forces it).
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
const COMPOSE_PROJECT = process.env.DEMO_COMPOSE_PROJECT?.trim() || 'roofline-demo';
const COMPOSE = ['compose', '-p', COMPOSE_PROJECT, '-f', `${REPO_ROOT}docker-compose.demo.yml`];
const OWNER_URL = `postgres://roofline:roofline@127.0.0.1:${DB_PORT}/roofline`;
/** Local-only role passwords for the demo database (it listens on 127.0.0.1 only). */
const ROLE_PASSWORDS = { tenant: 'demo-tenant-pw', system: 'demo-system-pw' } as const;
const SHUTDOWN_WAIT_MS = 10_000;
const RESET = process.argv.includes('--reset');
/** The demo's file store (signed PDFs), shared by the seed, the API and the worker; git-ignored, emptied by --reset. */
const FILES_DIR = `${REPO_ROOT}.demo-files/${COMPOSE_PROJECT}`;
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
  rmSync(FILES_DIR, { recursive: true, force: true });
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

/**
 * What the demo web build is for: the commit it was built from and the map tiles, or null when git cannot tell
 * (not a clone, git missing) or the working tree has uncommitted changes, in which case the build is always redone.
 */
function demoBuildStamp(): string | null {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^[0-9a-f]{40}$/.test(head) && dirty === '' ? `commit=${head}\n${Object.entries(WEB_BUILD_ENV).map(([k, v]) => `${k}=${v}\n`).join('')}` : null;
  } catch {
    return null;
  }
}

/**
 * This machine's demo ENCRYPTION_KEY, made once and kept in .env.demo (git-ignored, like every .env
 * file): the demo database outlives a run, and its proposal links and sessions need the same key.
 */
function demoEncryptionKey(): string {
  const file = `${REPO_ROOT}.env.demo`;
  const found = existsSync(file) ? /^DEMO_ENCRYPTION_KEY=(\S+)$/m.exec(readFileSync(file, 'utf8'))?.[1] : undefined;
  if (found) return found;
  const key = randomBytes(32).toString('base64');
  writeFileSync(file, `# Made by npm run demo for this machine's demo database only. Never commit it.\nDEMO_ENCRYPTION_KEY=${key}\n`, { mode: 0o600 });
  return key;
}
const ENCRYPTION_KEY = demoEncryptionKey();

/**
 * The real lookup keys, from .env.keys (git-ignored): GEOCODIO_API_KEY turns on real address lookups,
 * MAPTILER_KEY real map and satellite tiles, and GOOGLE_MAPS_API_KEY Google satellite photos in the roof view,
 * Google Solar roof pitch (and outlines where no footprint is found) and roofs reconstructed in 3D from Google Solar's
 * Data Layers (a paid request per new roof, kept on the measurement). Every other outside service stays a fake.
 * No file, no keys: the plain demo.
 */
function realKeys(): { geocodio?: string; maptiler?: string; google?: string } {
  const file = `${REPO_ROOT}.env.keys`;
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  const read = (name: string) => new RegExp(`^${name}=(\\S+)$`, 'm').exec(text)?.[1];
  return { geocodio: read('GEOCODIO_API_KEY'), maptiler: read('MAPTILER_KEY'), google: read('GOOGLE_MAPS_API_KEY') };
}
const KEYS = realKeys();
/** The web build's map settings: MapTiler with a key, else free OSM tiles and aerial imagery. */
const WEB_BUILD_ENV: Record<string, string> = {
  ...(KEYS.maptiler ? { VITE_MAPTILER_KEY: KEYS.maptiler } : { VITE_MAP_TILES: 'osm', VITE_MAP_IMAGERY: 'aerial' }),
  // Google satellite photos in the roof view (Map Tiles API).
  ...(KEYS.google ? { VITE_GOOGLE_MAPS_KEY: KEYS.google } : {}),
};

const tenantUrl = roleUrl(OWNER_URL, APP_ROLES.tenant, ROLE_PASSWORDS.tenant);
const systemUrl = roleUrl(OWNER_URL, APP_ROLES.system, ROLE_PASSWORDS.system);

// 3. Migrations and seed; 4. web build
try {
  log('Running the migrations.');
  // A brand-new database restarts once after its first-boot setup; retry through that.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await migrate(OWNER_URL);
      break;
    } catch (err) {
      if (attempt >= 15) throw err;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  await setRolePasswords(OWNER_URL, ROLE_PASSWORDS);
  const pools = createPools({ tenant: tenantUrl, system: systemUrl });
  try {
    const world = await seedDemoWorld(pools, OWNER_URL, new Date(), { encryptionKey: ENCRYPTION_KEY, objectStore: new DirObjectStore(FILES_DIR) });
    log(
      world.created
        ? `Seeded ${DEMO_COMPANY_NAME}: ${Object.entries(world.counts).filter(([name]) => !name.includes('.')).map(([name, n]) => `${n} ${name}`).join(', ')}.`
        : `${DEMO_COMPANY_NAME} is already seeded (npm run demo:reset starts fresh).`,
    );
    // The second company, a windows-first one in Arkansas with its own owner and brand colour (an older demo database gets it here too).
    const winchoice = await seedWinChoiceWorld(pools, OWNER_URL, new Date(), { encryptionKey: ENCRYPTION_KEY, objectStore: new DirObjectStore(FILES_DIR) });
    log(
      winchoice.created
        ? `Seeded ${DEMO_WINCHOICE_NAME}: ${Object.entries(winchoice.counts).filter(([name]) => !name.includes('.')).map(([name, n]) => `${n} ${name}`).join(', ')}.`
        : `${DEMO_WINCHOICE_NAME} is already seeded (npm run demo:reset starts fresh).`,
    );
  } finally {
    await pools.end();
  }
  if (DB_ONLY) {
    log('Database ready (--db-only).');
    process.exit(0);
  }
  // The demo's own build (OpenStreetMap streets and Esri aerial photos for satellite and the roof view, no key needed). The marker records the commit it was
  // built from, so switching branches or pulling new code rebuilds; so do uncommitted changes, an unreadable
  // git, a build made for anything else (vite empties dist/ on every build, marker included) and DEMO_BUILD=1.
  const marker = `${REPO_ROOT}apps/web/dist/.demo-build`;
  const wanted = demoBuildStamp();
  const built = existsSync(marker) ? readFileSync(marker, 'utf8') : '';
  if (process.env.DEMO_BUILD === '1' || wanted === null || built !== wanted) {
    log('Building the web app (about 1 minute).');
    execFileSync('npm', ['run', 'build:web'], { cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, ...WEB_BUILD_ENV } });
    if (wanted !== null) writeFileSync(marker, wanted);
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
  // Only the "Hail storm hits" simulation uses it: storms are written by the owner role.
  DEMO_DATABASE_URL_OWNER: OWNER_URL,
  ENCRYPTION_KEY,
  DEMO_FILES_DIR: FILES_DIR,
  WEB_DIST_DIR: 'apps/web/dist',
  API_RATE_LIMIT_PER_MIN: '100000',
  // The instant quote page (/q/summit-ridge) offers "Measure with the WinChoice app" (a button and a QR code) when this is set;
  // the demo uses a placeholder App Store link unless the shell has one. The phone app talks to /api/public/homeowner/summit-ridge.
  HOMEOWNER_APP_URL: process.env.HOMEOWNER_APP_URL?.trim() || 'https://apps.apple.com/us/app/winchoice/id0000000000',
};
// Never let a real key from the shell reach a demo process.
for (const name of Object.keys(env)) {
  if (/^(STRIPE|TWILIO|POSTMARK|ANTHROPIC|GEOCODIO|EAGLEVIEW|GOOGLE_ADS|GOOGLE_SOLAR|GOOGLE_MAPS|META|R2|MAPTILER|GOOGLE_CLIENT|MICROSOFT)_/.test(name)) {
    delete env[name];
  }
}
// The keys from .env.keys go back in on purpose: real address lookups, the server's MapTiler tiles and Google Solar.
if (KEYS.geocodio) env.GEOCODIO_API_KEY = KEYS.geocodio;
if (KEYS.maptiler) env.MAPTILER_SERVER_KEY = KEYS.maptiler;
if (KEYS.google) env.GOOGLE_SOLAR_API_KEY = KEYS.google;
// Measure windows: the same Google key for Street View photos of the house's front (Static images and metadata).
if (KEYS.google) env.GOOGLE_MAPS_API_KEY = KEYS.google;
// Measure windows' optional detector model (OWLv2, read from disk only): passed when it is there. The detector itself
// stays off unless WINDOW_DETECTOR=owlv2 is set in the shell.
{
  const modelDir = process.env.WINDOW_MODEL_DIR ?? `${REPO_ROOT}models`;
  if (existsSync(`${modelDir}/Xenova/owlv2-base-patch16-ensemble/onnx/model_quantized.onnx`)) env.WINDOW_MODEL_DIR = modelDir;
}
// Real lookups need real roof outlines: the free Microsoft footprints, loaded per map tile on first use.
if (KEYS.geocodio) env.DEMO_REAL_FOOTPRINTS = '1';
if (KEYS.geocodio || KEYS.maptiler || KEYS.google) log(`Real lookups on: ${[KEYS.geocodio && 'Geocodio addresses', KEYS.maptiler && 'MapTiler maps', KEYS.google && 'Google satellite, Solar roof pitch, 3D roofs from Solar Data Layers and Street View photos for Measure windows'].filter(Boolean).join(', ')}.`);

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
log(`  ${DEMO_COMPANY_NAME} (default blue brand)`);
log(`    Email:    ${DEMO_LOGIN.email}`);
log(`    Password: ${DEMO_LOGIN.password}`);
log(`  ${DEMO_WINCHOICE_NAME} (red brand, windows first)`);
log(`    Email:    ${DEMO_WINCHOICE_LOGIN.email}`);
log(`    Password: ${DEMO_WINCHOICE_LOGIN.password}`);
log('  Click the Demo badge (top bar) to simulate a text, a call,');
log('  a hail storm or a signature. Ctrl+C stops the demo.');
log(`  Instant quote page:  ${BASE_URL}/q/summit-ridge`);
log(`  Homeowner app API:   ${BASE_URL}/api/public/homeowner/summit-ridge`);
log('                       (the phone app\'s server; docs/windows/homeowner-api.md)');
log('==============================================================');
if (process.env.DEMO_OPEN === '1') {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(opener, [BASE_URL], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
}
