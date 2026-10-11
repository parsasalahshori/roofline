/* eslint-disable no-empty-pattern -- Playwright reads the `{}` pattern of a fixture with no dependencies. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Locator, type Page } from '@playwright/test';
import pg from 'pg';
import { createPools, type Pools } from '@roofline/db';
import { resetDb, seedTwoCompanies, SEED_PASSWORD, type SeededCompany } from '@roofline/db/testing';
import { seedDemoTask, seedShowcase } from '@roofline/api';

/*
 * Shared end-to-end helpers. `stack.ts` writes `.stack.json` beside this file once the database is
 * up; every test then resets the database to the same scenario before it runs.
 */

export type Stack = { ownerUrl: string; tenantUrl: string; systemUrl: string; baseUrl: string };

/** The three database URLs in the shape `resetScenario` and the pools take. */
function dbUrls(stack: Stack): { owner: string; tenant: string; system: string } {
  return { owner: stack.ownerUrl, tenant: stack.tenantUrl, system: stack.systemUrl };
}

/** The seeded world a test starts from: Acme Roofing (company a) and its showcase task. */
export type Scenario = { a: SeededCompany; taskId: string };

export type Who = 'owner' | 'office' | 'rep';

const STACK_FILE = fileURLToPath(new URL('.stack.json', import.meta.url));

/** The connection strings and base URL the running stack wrote to `.stack.json`. */
export function readStack(): Stack {
  return JSON.parse(readFileSync(STACK_FILE, 'utf8')) as Stack;
}

let sharedPools: { key: string; pools: Pools } | undefined;

/** The tenant and system pools, created once per process and reused for every test. */
export function getPools(urls: { tenant: string; system: string }): Pools {
  const key = `${urls.tenant}\n${urls.system}`;
  if (sharedPools?.key !== key) sharedPools = { key, pools: createPools(urls) };
  return sharedPools.pools;
}

/** Empties the database, seeds two companies and the showcase book for Acme Roofing, and returns what a test needs. */
export async function resetScenario(urls: { owner: string; tenant: string; system: string }): Promise<Scenario> {
  await resetDb(urls.owner);
  const { a } = await seedTwoCompanies(urls.owner);
  const pools = getPools(urls);
  const { taskId } = await seedShowcase(pools, a.companyId, new Date(), { companyName: 'Acme Roofing' });
  return { a, taskId };
}

type Fixtures = {
  scenario: Scenario;
  loginAs: (page: Page, who: Who) => Promise<void>;
  db: pg.Client;
  pools: Pools;
  clicks: { count: number };
  click: (locator: Locator) => Promise<void>;
  markTodaySeen: (email: string) => Promise<void>;
};

export const test = base.extend<Fixtures>({
  scenario: [
    async ({}, use) => {
      await use(await resetScenario(dbUrls(readStack())));
    },
    { auto: true },
  ],

  loginAs: async ({ scenario }, use) => {
    await use(async (page, who) => {
      const { baseUrl } = readStack();
      const response = await page.request.post('/api/auth/login', {
        data: { email: scenario.a[who].email, password: SEED_PASSWORD },
        headers: { Origin: baseUrl },
      });
      expect(response.status()).toBe(200);
    });
  },

  // Auto fixtures (`scenario`) are set up before any test body, so the database is reset first.
  db: async ({}, use) => {
    const client = new pg.Client({ connectionString: readStack().ownerUrl });
    await client.connect();
    await use(client);
    await client.end();
  },

  pools: async ({}, use) => {
    await use(getPools(dbUrls(readStack())));
  },

  clicks: async ({}, use) => {
    await use({ count: 0 });
  },

  click: async ({ clicks }, use) => {
    await use(async (locator) => {
      clicks.count += 1;
      await locator.click();
    });
  },

  markTodaySeen: async ({ db }, use) => {
    await use(async (email) => {
      await db.query(
        `update memberships set last_today_shown_on = (now() at time zone 'America/Chicago')::date
          where user_id = (select id from users where email = $1)`,
        [email],
      );
    });
  },
});

export { expect, seedDemoTask };
