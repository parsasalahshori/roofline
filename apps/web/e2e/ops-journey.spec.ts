import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import pg from 'pg';
import { SEED_PASSWORD } from '@roofline/db/testing';
import { seedOldLead } from './g1-seeds.ts';

/*
 * The AI and operations journey, as the owner and a rep see it, driven from the Demo badge:
 *   1. A hail storm arrives -> Storm Scout drafts its plan -> the owner approves it once -> the texts show as sent
 *      and a door-knock route exists (for the rep).
 *   2. A call comes in -> Front Desk takes it and books an inspection -> the conversation shows the booking and it
 *      is on the calendar.
 *   3. A plan waiting for the owner's OK is approved from the "needs your OK" pill -> it shows in the agents feed.
 *
 * The Demo badge only exists when the API runs with DEMO_MODE, which changes other providers, so this spec starts
 * a stack of its own (stack.ts with E2E_DEMO_MODE=1) beside the main one, on another port and in its own stack file.
 * Nothing leaves the machine: every outside service is a fake, and the call and the storm are made by the badge.
 */

const WEB_DIR = fileURLToPath(new URL('..', import.meta.url));
const PORT = (Number(process.env.E2E_PORT?.trim()) || 4410) + 100;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STACK_FILE = join(tmpdir(), `roofline-ops-journey-${String(PORT)}.json`);
const OWNER = 'owner@a.test';

test.use({ baseURL: BASE_URL });
test.describe.configure({ mode: 'serial' });

let stack: ChildProcess | undefined;
let ownerUrl = '';
const stackLog: string[] = [];

/** Starts the demo-mode stack and waits for it to answer on /health. */
test.beforeAll(async () => {
  test.setTimeout(360_000);
  rmSync(STACK_FILE, { force: true });
  stack = spawn('npx', ['tsx', 'e2e/stack.ts'], {
    cwd: WEB_DIR,
    env: { ...process.env, E2E_PORT: String(PORT), E2E_DEMO_MODE: '1', E2E_STACK_FILE: STACK_FILE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const keep = (chunk: Buffer) => {
    stackLog.push(...chunk.toString().split('\n'));
    stackLog.splice(0, Math.max(0, stackLog.length - 80));
  };
  stack.stdout?.on('data', keep);
  stack.stderr?.on('data', keep);
  let exited = false;
  stack.once('exit', () => {
    exited = true;
  });
  const deadline = Date.now() + 330_000;
  for (;;) {
    if (exited) throw new Error(`The demo stack stopped on its own:\n${stackLog.join('\n')}`);
    if (existsSync(STACK_FILE)) {
      const ok = await fetch(`${BASE_URL}/health`).then((r) => r.ok, () => false);
      if (ok) break;
    }
    if (Date.now() > deadline) throw new Error(`The demo stack did not start in time:\n${stackLog.join('\n')}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  ownerUrl = (JSON.parse(readFileSync(STACK_FILE, 'utf8')) as { ownerUrl: string }).ownerUrl;
});

test.afterAll(async () => {
  const child = stack;
  if (child === undefined || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const killer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('exit', () => {
      clearTimeout(killer);
      resolve();
    });
    child.kill('SIGTERM');
  });
  rmSync(STACK_FILE, { force: true });
});

/** Runs SQL as the database owner (the stack's own database). */
async function sql<T extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

/** Signs in through the API, so the browser holds the session cookie, and marks Today as already shown. */
async function signIn(page: Page, email: string): Promise<void> {
  const response = await page.request.post('/api/auth/login', { data: { email, password: SEED_PASSWORD }, headers: { Origin: BASE_URL } });
  expect(response.status()).toBe(200);
  await sql(
    `update memberships m set last_today_shown_on = (now() at time zone c.timezone)::date
       from companies c where c.id = m.company_id and m.user_id = (select id from users where email = $1)`,
    [email],
  );
}

/** Opens the Demo badge, presses one simulation and returns the API's answer; the panel is closed again afterwards. */
async function simulate(page: Page, kind: 'storm' | 'call'): Promise<{ status: number; body: Record<string, string | number | boolean | null>; message: string }> {
  await page.getByTestId('demo-badge').click();
  const panel = page.getByTestId('simulate-panel');
  await expect(panel).toBeVisible();
  const answered = page.waitForResponse((r) => r.url().includes(`/api/demo/simulate/${kind}`), { timeout: 90_000 });
  await panel.getByTestId(`simulate-${kind}`).click();
  const response = await answered;
  const body = (await response.json()) as Record<string, string | number | boolean | null>;
  const message = panel.getByTestId('simulate-message');
  await expect(message).toBeVisible({ timeout: 30_000 });
  const text = (await message.textContent()) ?? '';
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  return { status: response.status(), body, message: text };
}

const planSteps = (page: Page) => page.getByRole('main').getByRole('list').getByText('Done', { exact: true });

test('a hail storm arrives, its plan is approved once, the texts are sent and a door route exists', async ({ page, browser }) => {
  test.setTimeout(180_000);
  // The Front Desk call later needs a customer with a phone and a home, so one is on file.
  const [company] = await sql<{ id: string }>(`select id from companies where slug = 'acme-roofing'`);
  const pg2 = new pg.Client({ connectionString: ownerUrl });
  await pg2.connect();
  try {
    await seedOldLead(pg2, company!.id);
  } finally {
    await pg2.end();
  }

  await signIn(page, OWNER);
  await page.goto('/storm');
  await expect(page.getByRole('heading', { level: 1, name: 'Storm' })).toBeVisible();

  const storm = await simulate(page, 'storm');
  expect(storm.status).toBe(200);
  expect(storm.message).toContain('Storm Scout drafted a plan');

  // No reload: the plan is the newest card, the storm is in the table with its name, and the pill counts it.
  const card = page.getByRole('main').getByRole('article').first();
  await expect(card).toContainText('Omaha, NE (up to 2 in)', { timeout: 20_000 });
  const stormRow = page.getByRole('region', { name: 'Storms in your area' }).getByRole('row').filter({ hasText: 'Needs your OK' }).first();
  await expect(stormRow).toContainText('Omaha, NE');

  await card.getByRole('link', { name: /^Review \d+ steps$/ }).click();
  await expect(page).toHaveURL(new RegExp(`/storm/plans/${String(storm.body['taskId'])}$`));
  const approve = page.getByRole('button', { name: /^Approve (\d+) steps/ });
  const steps = Number(/Approve (\d+) steps/.exec((await approve.textContent()) ?? '')?.[1]);
  expect(steps).toBeGreaterThanOrEqual(3);
  await approve.click();

  // Once: every step finishes, the texts say how many went out, and the routes step says it built them.
  await expect(planSteps(page)).toHaveCount(steps, { timeout: 90_000 });
  const texts = page.getByRole('main').getByRole('listitem').filter({ hasText: /^Text \d+ customers/ });
  await expect(texts).toContainText(/[1-9]\d* sent/);
  await expect(texts).toContainText("0 couldn't send");
  const routes = page.getByRole('main').getByRole('listitem').filter({ hasText: 'door-knock route' });
  await expect(routes).toContainText('Done');

  // The results page counts the texts that went out.
  await page.goto(`/storm/${String(storm.body['companyStormId'])}`);
  const grid = page.getByTestId('storm-results-grid');
  await expect(grid.locator('dl').filter({ has: page.getByText('Texts sent', { exact: true }) }).locator('dd').first()).not.toHaveText('0', { timeout: 30_000 });

  // The routes belong to the company's reps (which rep gets a small route is chosen by the storm's own seed), so the
  // rep who owns the new route is the one who signs in and finds it on My routes, with its doors in order.
  const [owned] = await sql<{ email: string }>(
    `select u.email from door_routes r join users u on u.id = r.user_id where r.company_storm_id = $1 limit 1`,
    [String(storm.body['companyStormId'])],
  );
  expect(owned).toBeDefined();
  const repContext = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 375, height: 812 } });
  try {
    const repPage = await repContext.newPage();
    await signIn(repPage, owned!.email);
    await repPage.goto('/storm/routes');
    const route = repPage.getByRole('link', { name: /, 0 of \d+ doors?$/ }).first();
    await expect(route).toBeVisible({ timeout: 20_000 });
    await route.click();
    await expect(repPage.getByRole('heading', { name: 'Doors in order' })).toBeVisible();
  } finally {
    await repContext.close();
  }
});

test('a call comes in, Front Desk books an inspection, and it is on the calendar', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, OWNER);
  await page.goto('/front-desk');
  await expect(page.getByRole('main', { name: 'Front Desk', exact: true })).toBeVisible();

  const call = await simulate(page, 'call');
  expect(call.status).toBe(200);
  expect(call.message).toContain('Front Desk took the call');
  const conversationId = String(call.body['conversationId']);
  const [customer] = await sql<{ display_name: string }>(`select display_name from customers where id = $1`, [String(call.body['customerId'])]);

  // No reload: the call is in the inbox, and opening it shows the transcript and the booking card.
  const main = page.getByRole('main', { name: 'Front Desk', exact: true });
  const row = main.locator(`a[href$="/front-desk/${conversationId}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(main.getByRole('heading', { name: customer!.display_name })).toBeVisible({ timeout: 20_000 });
  await expect(main.getByRole('heading', { name: 'Transcript' })).toBeVisible();
  await expect(main.getByText(/You.re booked for Thursday at 10 AM/)).toBeVisible();
  await expect(main.getByText('Booked an inspection', { exact: true })).toBeVisible();
  await expect(main.getByText(/Front Desk booked a free inspection for Thursday at 10 AM/)).toBeVisible();

  // The visit is on the calendar, for a person and at 10:00 on a Thursday.
  const [visit] = await sql<{ id: string; starts_at: Date; assigned_user_id: string | null }>(
    `select a.id, a.starts_at, a.assigned_user_id from appointments a where a.source = 'front_desk' and a.customer_id = $1`,
    [String(call.body['customerId'])],
  );
  expect(visit).toBeDefined();
  expect(visit!.assigned_user_id).not.toBeNull();
  await main.getByRole('link', { name: 'Open appointment' }).click();
  await expect(page).toHaveURL(new RegExp(`/calendar/appointments/${visit!.id}$`));
  await expect(page.getByRole('main')).toContainText(customer!.display_name);
  await expect(page.getByRole('main')).toContainText('10:00 AM');

  await page.goto('/calendar');
  const name = page.getByRole('main').getByText(customer!.display_name).first();
  if (!(await name.isVisible().catch(() => false))) await page.getByRole('button', { name: /next/i }).first().click();
  await expect(page.getByRole('main').getByText(customer!.display_name).first()).toBeVisible({ timeout: 20_000 });
});

test('a plan waiting for the owner is approved from the pill and shows in the agents feed', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, OWNER);
  await page.goto('/');
  await page.getByRole('link', { name: /needs? your OK$/ }).first().click();
  await expect(page).toHaveURL(/\/approvals$/);
  await page.getByRole('main').getByRole('link', { name: /^Review \d+ steps$/ }).first().click();
  await expect(page).toHaveURL(/\/approvals\/[0-9a-f-]+$/);
  const approve = page.getByRole('button', { name: /^Approve \d+ steps/ });
  const steps = Number(/Approve (\d+) steps/.exec((await approve.textContent()) ?? '')?.[1]);
  await approve.click();
  await expect(planSteps(page)).toHaveCount(steps, { timeout: 60_000 });

  await page.goto('/agents/feed');
  await expect(page.getByRole('main').getByText(/approved \d+ steps?/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('main').getByText(/^Finished: /).first()).toBeVisible();
});
