import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPools, type Pools } from '@roofline/db';
import { findCompanyBySlug } from '@roofline/db/system';
import { type SeedCompanyUser, seedCompany } from '@roofline/db/testing';
import { systemClock } from '../clock.ts';
import { AppError, describeErrorForLog } from '../errors.ts';
import { SeedError } from './seed-demo.ts';
import { seedShowcase } from './showcase.ts';

/*
 * The dev seed: makes a believable roofing company to sign in to on a laptop, "Summit Roofing",
 * with three people and the showcase data (customers, addresses, jobs and a plan waiting for approval).
 *
 *   NODE_ENV=development DATABASE_URL_OWNER=... DATABASE_URL_TENANT=... DATABASE_URL_SYSTEM=... \
 *     npm run seed:dev -w @roofline/api
 *
 * Dev only: it refuses to run unless NODE_ENV is exactly `development`, and it checks that before it
 * looks at any database URL. The owner URL is needed because creating the company and its users
 * (seedCompany) runs as the table owner, the same way the test database does. The tenant and system
 * URLs are the app_tenant and app_system pools the showcase and the company lookup use.
 *
 * Running it again changes nothing: when a company with the slug `summit-roofing` exists it says so.
 * The three sign-in emails are printed; the shared dev password is documented in the README and is
 * never printed by this script.
 */

/** The slug of the dev company, which is how a second run recognises it. */
export const SUMMIT_SLUG = 'summit-roofing';

const SUMMIT_NAME = 'Summit Roofing';

export const DEV_ONLY_REFUSAL = 'Refusing to seed dev data unless NODE_ENV=development.';

export const NEEDS_URLS =
  'Set DATABASE_URL_OWNER, DATABASE_URL_TENANT and DATABASE_URL_SYSTEM (the owner, app_tenant and app_system connection URLs).';

/** The three people in the dev company, in the order they are printed. Office has no spend delegation. */
export const DEV_USERS: readonly SeedCompanyUser[] = [
  { email: 'owner@summit.test', name: 'Dana Park', role: 'owner' },
  { email: 'office@summit.test', name: 'Chris Lane', role: 'office', canApproveSpend: false },
  { email: 'rep@summit.test', name: 'Robin Hale', role: 'rep' },
];

/**
 * The shared password of the dev users. A dev-only test credential (the README names it for local
 * sign-in). It is never printed: `reportLines` lists the emails only.
 */
const DEV_PASSWORD = 'roofline-demo-2026';

/** Throws the dev-only refusal unless `env.NODE_ENV` is exactly `development`. */
export function refuseUnlessDevelopment(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'development') throw new SeedError(DEV_ONLY_REFUSAL);
}

export type SeedDevResult = {
  created: boolean;
  companyId: string;
  name: string;
  emails: string[];
  counts?: { customers: number; properties: number; jobs: number };
};

/**
 * Makes the dev company and its showcase when no company has the `summit-roofing` slug. When one
 * exists it returns that company and changes nothing, so re-running never duplicates the people
 * (their addresses are unique) or the plan.
 */
export async function seedDev(pools: Pools, ownerUrl: string, now: Date): Promise<SeedDevResult> {
  const emails = DEV_USERS.map((user) => user.email);
  const existing = await findCompanyBySlug(pools.system, SUMMIT_SLUG);
  if (existing) return { created: false, companyId: existing.id, name: existing.name, emails };

  const company = await seedCompany(ownerUrl, {
    name: SUMMIT_NAME,
    slug: SUMMIT_SLUG,
    timezone: 'America/Chicago',
    state: 'NE',
    users: [...DEV_USERS],
    password: DEV_PASSWORD,
  });
  const { customers, properties, jobs } = await seedShowcase(pools, company.companyId, now, { companyName: SUMMIT_NAME });
  return {
    created: true,
    companyId: company.companyId,
    name: company.name,
    emails,
    counts: { customers, properties, jobs },
  };
}

/** What the script prints for a result. The password is never among these lines. */
export function reportLines(result: SeedDevResult): string[] {
  const summary =
    result.created && result.counts
      ? `Made ${result.name}: ${result.counts.customers} customers, ${result.counts.properties} addresses and ${result.counts.jobs} jobs, plus a plan waiting for approval.`
      : `${result.name} already exists, so nothing was changed.`;
  return [summary, 'Sign in with one of these (the password is in the README):', ...result.emails.map((email) => `  ${email}`)];
}

async function main(): Promise<void> {
  // The guard runs first, before anything else, including the database URLs.
  try {
    refuseUnlessDevelopment(process.env);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }
  const owner = process.env.DATABASE_URL_OWNER?.trim();
  const tenant = process.env.DATABASE_URL_TENANT?.trim();
  const system = process.env.DATABASE_URL_SYSTEM?.trim();
  if (!owner || !tenant || !system) {
    console.error(NEEDS_URLS);
    process.exitCode = 1;
    return;
  }

  const pools = createPools({ tenant, system });
  try {
    const result = await seedDev(pools, owner, systemClock.now());
    for (const line of reportLines(result)) console.log(line);
  } catch (err) {
    // A SeedError or a refused payload is a plain sentence; anything else is logged in its safe form.
    console.error(
      err instanceof SeedError || err instanceof AppError
        ? err.message
        : `The dev data could not be made: ${describeErrorForLog(err)}`,
    );
    process.exitCode = 1;
  } finally {
    await pools.end();
  }
}

/** True when this file is the script being run (`tsx src/scripts/seed-dev.ts`), not a module a test imported. */
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
