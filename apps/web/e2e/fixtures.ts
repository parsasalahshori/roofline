/* eslint-disable no-empty-pattern -- Playwright reads the `{}` pattern of a fixture with no dependencies. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Locator, type Page } from '@playwright/test';
import pg from 'pg';
import { createPools, type Pools } from '@roofline/db';
import { resetDb, seedTwoCompanies, SEED_PASSWORD, type SeededCompany } from '@roofline/db/testing';
import type { CompanyStatus } from '@roofline/shared';
import { seedDemoTask, seedFootprintFixture, seedShowcase, seedStormFixture } from '@roofline/api';

/*
 * Shared end-to-end helpers. `stack.ts` writes `.stack.json` beside this file once the database is
 * up; every test then resets the database to the same scenario before it runs.
 */

export type Stack = {
  ownerUrl: string;
  tenantUrl: string;
  systemUrl: string;
  baseUrl: string;
  /** The stack's ENCRYPTION_KEY (a throwaway key for the throwaway database). */
  encryptionKey: string;
  /** TWILIO_TEST_CALLER_NUMBER: the number the Front Desk forwarding test calls from. */
  testCallerNumber: string;
};

/** The three database URLs in the shape `resetScenario` and the pools take. */
function dbUrls(stack: Stack): { owner: string; tenant: string; system: string } {
  return { owner: stack.ownerUrl, tenant: stack.tenantUrl, system: stack.systemUrl };
}

/** The seeded world a test starts from: Acme Roofing (company a) and its showcase task. */
export type Scenario = { a: SeededCompany; taskId: string; stormId: string; companyStormId: string };

/** The policy pages domain the e2e stack runs with (stack.ts sets POLICY_PAGES_DOMAIN to it). */
export const E2E_POLICY_DOMAIN = 'roofline.test';

/** A URL on Acme Roofing's company host; the browser maps `*.roofline.test` to the stack (playwright.config.ts). */
export function companyHostUrl(path: string): string {
  return `http://acme-roofing.${E2E_POLICY_DOMAIN}:4410${path}`;
}

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
  const now = new Date();
  const { taskId } = await seedShowcase(pools, a.companyId, now, { companyName: 'Acme Roofing' });
  // The storm tables are global or owner-written, so the fixture runs its SQL through the owner pool.
  const owner = new pg.Pool({ connectionString: urls.owner, max: 1 });
  try {
    const { stormId, companyStormId } = await seedStormFixture(pools, a.companyId, {
      now,
      query: async (text, values) => (await owner.query(text, values)).rows,
    });
    await seedFootprintFixture(pools);
    return { a, taskId, stormId, companyStormId };
  } finally {
    await owner.end();
  }
}

/** Sets Acme Roofing's billing status directly in the database. */
export async function setCompanyStatus(status: CompanyStatus): Promise<void> {
  const client = new pg.Client({ connectionString: readStack().ownerUrl });
  await client.connect();
  try {
    await client.query(`update companies set status = $1 where slug = 'acme-roofing'`, [status]);
  } finally {
    await client.end();
  }
}

/** The 8-character code of the fixture storm's page (or of `companyStormId`'s), waiting up to 15 seconds for the page to exist. */
export async function stormPageCode(db: pg.Client, companyStormId?: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const { rows } =
      companyStormId === undefined
        ? await db.query<{ code: string }>(`select code from storm_pages order by created_at desc limit 1`)
        : await db.query<{ code: string }>(`select code from storm_pages where company_storm_id = $1 order by created_at desc limit 1`, [
            companyStormId,
          ]);
    if (rows[0] !== undefined) return rows[0].code;
    if (Date.now() > deadline) throw new Error('The storm page was not created within 15 seconds.');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

type ApprovalStepView = {
  id: string;
  version: number;
  enabled: boolean;
  status: string;
  type?: string;
  errorPlain?: string | null;
  result?: unknown;
};

/** Drafts the storm plan for the company storm id and approves every step, as the signed-in owner on `page`. */
export async function draftAndApproveStormPlan(page: Page, companyStormId: string): Promise<{ taskId: string }> {
  const headers = { Origin: readStack().baseUrl };
  const drafted = await page.request.post(`/api/storms/${companyStormId}/plan`, { headers, data: {} });
  expect(drafted.status()).toBe(200);
  const { taskId } = (await drafted.json()) as { taskId: string };
  const task = await page.request.get(`/api/approvals/${taskId}`);
  expect(task.status()).toBe(200);
  const { steps } = (await task.json()) as { steps: ApprovalStepView[] };
  const approved = await page.request.post(`/api/approvals/${taskId}/approve`, {
    headers,
    data: { steps: steps.filter((step) => step.enabled).map((step) => ({ id: step.id, version: step.version })) },
  });
  expect(approved.status()).toBe(200);
  return { taskId };
}

/** Polls the plan until every enabled step is 'done' (60 seconds at most). */
export async function waitForStormSteps(page: Page, taskId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/approvals/${taskId}`);
        if (response.status() !== 200) return 'unreadable';
        const { steps } = (await response.json()) as { steps: ApprovalStepView[] };
        const open = steps.filter((step) => step.enabled && step.status !== 'done');
        // The unfinished steps are named in the failure so a CI log shows which one stopped.
        return open.length === 0
          ? 'done'
          : open.map((step) => `${step.type ?? '?'}:${step.status}:${step.errorPlain ?? ''}:${JSON.stringify(step.result ?? null)}`).join(' | ');
      },
      { timeout: 60_000, intervals: [500, 1000] },
    )
    .toBe('done');
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

  // Marks Today as already shown for today in the user's company timezone (`companies.timezone`),
  // so the auto-open does not fire. The API decides "today" in that same zone.
  markTodaySeen: async ({ db }, use) => {
    await use(async (email) => {
      await db.query(
        `update memberships m set last_today_shown_on = (now() at time zone c.timezone)::date
           from companies c
          where c.id = m.company_id
            and m.user_id = (select id from users where email = $1)`,
        [email],
      );
    });
  },
});

export { expect, seedDemoTask };
