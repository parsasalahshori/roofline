import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPools, type Pools, withTenant } from '@roofline/db';
import { findCompanyBySlug } from '@roofline/db/system';
import { systemClock } from '../clock.ts';
import { AppError, describeErrorForLog } from '../errors.ts';
import { systemContext } from '../permissions.ts';
import { demoTask } from '../tasks/demo.ts';
import { createTask } from '../tasks/service.ts';

/*
 * The demo seed: makes the 3-step F2 demo plan (tasks/demo.ts) as a draft for one company.
 *
 *   DATABASE_URL_TENANT=... DATABASE_URL_SYSTEM=... npm run seed:demo -w @roofline/api -- --company acme-roofing
 *
 * The company is found by its slug through app_system (companies is global); the plan is then made
 * with `createTask` in that company's own app_tenant transaction, as an agent would make it (no
 * person behind it). Prints the new task's id.
 */

export const USAGE = 'Usage: npm run seed:demo -w @roofline/api -- --company <slug>';

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

/** Makes the demo plan for the company with this slug, at `now`. Throws SeedError when no company has it. */
export async function seedDemoTask(pools: Pools, slug: string, now: Date): Promise<{ taskId: string; companyName: string }> {
  const company = await findCompanyBySlug(pools.system, slug);
  if (!company) throw new SeedError(`No company has the slug "${slug}".`);
  const ctx = systemContext(company.id);
  const { taskId } = await withTenant(pools, ctx, (tx) => createTask(tx, ctx, demoTask(now), { now, ip: null }));
  return { taskId, companyName: company.name };
}

async function main(): Promise<void> {
  const tenant = process.env.DATABASE_URL_TENANT?.trim();
  const system = process.env.DATABASE_URL_SYSTEM?.trim();
  if (!tenant || !system) {
    console.error('Set DATABASE_URL_TENANT and DATABASE_URL_SYSTEM (the app_tenant and app_system connection URLs).');
    process.exitCode = 1;
    return;
  }
  let slug: string;
  try {
    slug = slugFromArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
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
