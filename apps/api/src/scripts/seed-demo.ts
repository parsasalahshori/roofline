import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPools, type Pools, withTenant } from '@roofline/db';
import { findCompanyBySlug } from '@roofline/db/system';
import { systemClock } from '../clock.ts';
import { AppError, describeErrorForLog } from '../errors.ts';
import { systemContext } from '../permissions.ts';
import { demoTask } from '../tasks/demo.ts';
import { createTask } from '../tasks/service.ts';
import { DEMO_COMPANY_NAME, DEMO_LOGIN, seedDemoWorld, type DemoWorld } from './demo-world.ts';

/*
 * The demo seed: makes the 3-step F2 demo plan (tasks/demo.ts) as a draft for one company.
 *
 *   DATABASE_URL_TENANT=... DATABASE_URL_SYSTEM=... npm run seed:demo -w @roofline/api -- --company acme-roofing
 *
 * The company is found by its slug through app_system (companies is global; apps/api/src/scripts/**
 * is allowed to import @roofline/db/system, ruled in Task 14); the plan is then made
 * with `createTask` in that company's own app_tenant transaction, as an agent would make it (no
 * person behind it). Prints the new task's id.
 *
 * The text step's sample message names the company by its name from the company row (for example
 * "Hi Maria, it's Acme Roofing."), so a demo for one company reads as that company's own plan.
 *
 * The demo plan is fake work (a "Text 31 customers" step, a spend step), so the script refuses to
 * run when NODE_ENV=production unless `--allow-production` is passed.
 *
 * `--world` makes the whole fictional demo company instead (demo-world.ts, "Summit Ridge Roofing"):
 *
 *   DATABASE_URL_OWNER=... DATABASE_URL_TENANT=... DATABASE_URL_SYSTEM=... [ENCRYPTION_KEY=...] \
 *     npm run seed:demo -w @roofline/api -- --world
 *
 * It needs the owner URL too (the company, its users and the storm rows are written as the owner), and
 * ENCRYPTION_KEY (the API's) so the sent proposals get homeowner links. It is refused in production the
 * same way, and a second run changes nothing.
 */

export const USAGE = 'Usage: npm run seed:demo -w @roofline/api -- --company <slug>';

/** What the script says, and exits non-zero with, when it is run in production without the flag. */
export const PRODUCTION_REFUSAL = 'Refusing to seed demo data in production. Pass --allow-production if you really mean it.';

const ALLOW_PRODUCTION = '--allow-production';

/** Something the person running the seed can fix; its message is the whole story. */
export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}

/** The company slug from `--company <slug>` or `--company=<slug>` (trimmed, lowercased). Anything else is the usage line. */
export function slugFromArgs(argv: readonly string[]): string {
  let raw: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--company' && raw === undefined) {
      raw = argv[i + 1] ?? '';
      i += 1;
    } else if (arg.startsWith('--company=') && raw === undefined) {
      raw = arg.slice('--company='.length);
    } else {
      throw new SeedError(USAGE);
    }
  }
  const slug = raw?.trim().toLowerCase() ?? '';
  if (slug === '' || slug.startsWith('-')) throw new SeedError(USAGE);
  return slug;
}

/** The slug and whether `--allow-production` was passed (it may come anywhere; only that exact spelling counts). */
export function parseSeedArgs(argv: readonly string[]): { slug: string; allowProduction: boolean } {
  return { slug: slugFromArgs(argv.filter((arg) => arg !== ALLOW_PRODUCTION)), allowProduction: argv.includes(ALLOW_PRODUCTION) };
}

/** Throws the refusal when `env` says production and the flag was not passed. */
export function refuseInProduction(env: NodeJS.ProcessEnv, allowProduction: boolean): void {
  if (env.NODE_ENV === 'production' && !allowProduction) throw new SeedError(PRODUCTION_REFUSAL);
}

/** Makes the demo plan for the company with this slug, at `now`. Throws SeedError when no company has it. */
export async function seedDemoTask(pools: Pools, slug: string, now: Date): Promise<{ taskId: string; companyName: string }> {
  const company = await findCompanyBySlug(pools.system, slug);
  if (!company) throw new SeedError(`No company has the slug "${slug}".`);
  const ctx = systemContext(company.id);
  const { taskId } = await withTenant(pools, ctx, (tx) => createTask(tx, ctx, demoTask(now, company.name), { now, ip: null }));
  return { taskId, companyName: company.name };
}

const WORLD = '--world';

/** The usage line of the world mode. */
export const WORLD_USAGE = 'Usage: npm run seed:demo -w @roofline/api -- --world [--allow-production]';

/** True when the command line asks for the demo world (`--world`). */
export function wantsWorld(argv: readonly string[]): boolean {
  return argv.includes(WORLD);
}

/** The world mode's arguments: `--world` and optionally `--allow-production`, nothing else. */
export function parseWorldArgs(argv: readonly string[]): { allowProduction: boolean } {
  if (argv.some((arg) => arg !== WORLD && arg !== ALLOW_PRODUCTION)) throw new SeedError(WORLD_USAGE);
  return { allowProduction: argv.includes(ALLOW_PRODUCTION) };
}

/** What the world mode prints. The password is the demo-only one documented in demo-world.ts. */
export function worldReportLines(world: DemoWorld): string[] {
  const head = world.created ? `Made ${DEMO_COMPANY_NAME} (${world.companyId}).` : `${DEMO_COMPANY_NAME} already exists, so nothing was changed.`;
  const counts = Object.entries(world.counts)
    .map(([key, n]) => `  ${key}: ${n}`);
  return [head, `Sign in as ${DEMO_LOGIN.email} / ${DEMO_LOGIN.password}`, ...counts];
}

async function mainWorld(argv: readonly string[]): Promise<void> {
  try {
    refuseInProduction(process.env, parseWorldArgs(argv).allowProduction);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }
  const owner = process.env.DATABASE_URL_OWNER?.trim();
  const tenant = process.env.DATABASE_URL_TENANT?.trim();
  const system = process.env.DATABASE_URL_SYSTEM?.trim();
  if (!owner || !tenant || !system) {
    console.error('Set DATABASE_URL_OWNER, DATABASE_URL_TENANT and DATABASE_URL_SYSTEM (the owner, app_tenant and app_system connection URLs).');
    process.exitCode = 1;
    return;
  }
  const encryptionKey = process.env.ENCRYPTION_KEY?.trim() || undefined;
  if (encryptionKey === undefined) console.warn('ENCRYPTION_KEY is not set, so the sent proposals get no homeowner links.');
  const pools = createPools({ tenant, system });
  try {
    const world = await seedDemoWorld(pools, owner, systemClock.now(), { encryptionKey });
    for (const line of worldReportLines(world)) console.log(line);
  } catch (err) {
    console.error(err instanceof SeedError || err instanceof AppError ? err.message : `The demo world could not be made: ${describeErrorForLog(err)}`);
    process.exitCode = 1;
  } finally {
    await pools.end();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (wantsWorld(argv)) {
    await mainWorld(argv);
    return;
  }
  // The guard runs right after the arguments are read, before the database URLs are even looked at.
  let slug: string;
  try {
    const args = parseSeedArgs(argv);
    refuseInProduction(process.env, args.allowProduction);
    slug = args.slug;
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }
  const tenant = process.env.DATABASE_URL_TENANT?.trim();
  const system = process.env.DATABASE_URL_SYSTEM?.trim();
  if (!tenant || !system) {
    console.error('Set DATABASE_URL_TENANT and DATABASE_URL_SYSTEM (the app_tenant and app_system connection URLs).');
    process.exitCode = 1;
    return;
  }

  const pools = createPools({ tenant, system });
  try {
    const { taskId, companyName } = await seedDemoTask(pools, slug, systemClock.now());
    console.log(`Made the demo plan for ${companyName}. Task id: ${taskId}`);
  } catch (err) {
    // A SeedError or a refused payload is a plain sentence; anything else is logged in its safe form.
    console.error(err instanceof SeedError || err instanceof AppError ? err.message : `The demo plan could not be made: ${describeErrorForLog(err)}`);
    process.exitCode = 1;
  } finally {
    await pools.end();
  }
}

/** True when this file is the script being run (`tsx src/scripts/seed-demo.ts`), not a module a test imported. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) await main();
