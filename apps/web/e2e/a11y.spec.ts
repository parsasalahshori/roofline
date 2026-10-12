import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, readStack, companyHostUrl, stormPageCode, draftAndApproveStormPlan, waitForStormSteps } from './fixtures.ts';
import { makeAndSendProposal, BETTER_NAME } from './estimator-helpers.ts';
import { seedOldLead, seedTextsPlan } from './g1-seeds.ts';
import { seedFrontDesk, seedRooflineNumber } from './front-desk-seed.ts';

/*
 * Accessibility: each page is scanned with axe for WCAG 2.0 and 2.1 A and AA rules, and any
 * violation of impact "serious" or "critical" fails the test. Each test signs in as the owner and
 * waits for the page's own text before scanning. F3 appends its pages as more tests in this file.
 *
 * No exclusions. If a CI run shows that MapLibre's own attribution control fails a contrast rule,
 * add `.exclude('.maplibregl-ctrl-attrib')` to the builder in scan() and name the axe rule id here.
 */

async function scan(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad, bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`).join('\n')).toEqual([]);
}

test('map home has no serious accessibility violations', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/');
  await expect(page.getByText('Map showing 70 customers and 25 open jobs.')).toBeAttached({ timeout: 20_000 });
  await scan(page);
});

test('approvals list has no serious accessibility violations', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/approvals');
  await expect(page.getByRole('dialog')).toBeVisible();
  await scan(page);
});

test('approval review has no serious accessibility violations', async ({ page, loginAs, markTodaySeen, scenario }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/approvals/' + scenario.taskId);
  await expect(page.getByRole('button', { name: 'Approve 3 steps · up to $270' })).toBeVisible();
  await scan(page);
});

test('sign-up has no serious accessibility violations', async ({ page }) => {
  await page.goto('/sign-up');
  await expect(page.getByLabel('Your name')).toBeVisible();
  await scan(page);
});

test('setup has no serious accessibility violations', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/settings/setup');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await scan(page);
});

test('estimator has no serious accessibility violations', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/estimator');
  await expect(page.getByRole('dialog', { name: 'Estimator' })).toBeVisible();
  await expect(page.getByLabel('Address')).toBeVisible();
  await scan(page);
});

test('measure view has no serious accessibility violations', async ({ page, loginAs, markTodaySeen, click }) => {
  test.setTimeout(120_000);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const sent = await makeAndSendProposal(page, click);
  const response = await page.request.get('/api/proposals/' + sent.proposalId);
  const { measurementId } = (await response.json()) as { measurementId: string };
  await page.goto('/estimator/measure/' + measurementId);
  await expect(page.getByText('The numbers')).toBeVisible({ timeout: 20_000 });
  await scan(page);
});

test('proposal view has no serious accessibility violations', async ({ page, loginAs, markTodaySeen, click }) => {
  test.setTimeout(120_000);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const sent = await makeAndSendProposal(page, click);
  await page.goto('/estimator/proposals/' + sent.proposalId);
  await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();
  await scan(page);
});

test('homeowner page has no serious accessibility violations', async ({ page, browser, loginAs, markTodaySeen, click }) => {
  test.setTimeout(120_000);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const sent = await makeAndSendProposal(page, click);
  const context = await browser.newContext({ baseURL: readStack().baseUrl });
  try {
    const home = await context.newPage();
    await home.goto(sent.link);
    await expect(home.getByRole('button', { name: `Choose ${BETTER_NAME}`, exact: true })).toBeVisible();
    await scan(home);
  } finally {
    await context.close();
  }
});

test('jobs board has no serious accessibility violations', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/jobs');
  await expect(page.getByRole('heading', { name: 'Lead (8)', exact: true })).toBeVisible({ timeout: 20_000 });
  await scan(page);
});

test('job window has no serious accessibility violations', async ({ page, loginAs, markTodaySeen, db, scenario }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const job = await db.query<{ id: string }>(`select id from jobs where company_id = $1 order by id limit 1`, [
    scenario.a.companyId,
  ]);
  await page.goto(`/jobs/${job.rows[0]?.id}`);
  await expect(page.getByRole('group', { name: 'Job stage' })).toBeVisible();
  await scan(page);
});

test('customer window has no serious accessibility violations', async ({ page, loginAs, markTodaySeen, db, scenario }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const customer = await db.query<{ id: string }>(`select id from customers where company_id = $1 order by id limit 1`, [
    scenario.a.companyId,
  ]);
  await page.goto(`/customers/${customer.rows[0]?.id}`);
  await expect(page.getByRole('group', { name: 'Customer actions' })).toBeVisible();
  await scan(page);
});

test('calendar week has no serious accessibility violations', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/calendar?view=week');
  await expect(page.locator('[data-testid^="slot-"]').first()).toBeAttached({ timeout: 20_000 });
  await scan(page);
});

test('agents window with the G1 cards has no serious accessibility violations', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/agents');
  await expect(page.getByLabel('Your agents').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Follow-up', { exact: true }).first()).toBeVisible();
  await scan(page);
});

test('job window claim section has no serious accessibility violations', async ({ page, loginAs, markTodaySeen, db, scenario }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const job = await db.query<{ id: string }>(`select id from jobs where company_id = $1 order by id limit 1`, [
    scenario.a.companyId,
  ]);
  await page.goto(`/jobs/${job.rows[0]?.id}`);
  await expect(page.getByRole('heading', { name: 'Insurance claim' })).toBeVisible({ timeout: 20_000 });
  await scan(page);
});

test('follow-up review with personal texts has no serious accessibility violations', async ({
  page,
  loginAs,
  markTodaySeen,
  db,
  pools,
  scenario,
}) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const lead = await seedOldLead(db, scenario.a.companyId);
  const { taskId } = await seedTextsPlan(pools, scenario.a.companyId, lead.customerId);
  await page.goto('/approvals/' + taskId);
  await expect(page.getByText('Send 1 personal text')).toBeVisible({ timeout: 20_000 });
  await scan(page);
});

test('storm window has no serious accessibility violations', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/storm');
  await expect(page.getByRole('region', { name: 'Storms in your area' })).toBeVisible({ timeout: 20_000 });
  await scan(page);
});

test('storm detail has no serious accessibility violations', async ({ page, loginAs, markTodaySeen, scenario }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto(`/storm/${scenario.companyStormId}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 });
  await scan(page);
});

test('route view has no serious accessibility violations', async ({ page, loginAs, markTodaySeen, scenario }) => {
  test.setTimeout(90_000);
  // The owner approves the plan so the routes are built; the routes belong to the reps.
  await loginAs(page, 'owner');
  const { taskId } = await draftAndApproveStormPlan(page, scenario.companyStormId);
  await waitForStormSteps(page, taskId);

  await loginAs(page, 'rep');
  await markTodaySeen('rep@a.test');
  const mine = await page.request.get('/api/routes/mine', { headers: { Origin: readStack().baseUrl } });
  expect(mine.status()).toBe(200);
  const { routes } = (await mine.json()) as { routes: { id: string }[] };
  expect(routes.length).toBeGreaterThan(0);
  await page.goto(`/storm/routes/${routes[0]?.id}`);
  await expect(page.getByRole('heading', { name: 'Doors in order' })).toBeVisible({ timeout: 20_000 });
  await scan(page);
});

test('storm landing page has no serious accessibility violations', async ({ page, loginAs, db, scenario }) => {
  test.setTimeout(90_000);
  await loginAs(page, 'owner');
  const { taskId } = await draftAndApproveStormPlan(page, scenario.companyStormId);
  await waitForStormSteps(page, taskId);
  const code = await stormPageCode(db, scenario.companyStormId);
  await page.goto(companyHostUrl('/storm/' + code));
  await expect(page.getByLabel('Name', { exact: true })).toBeVisible();
});

test('Front Desk inbox has no serious accessibility violations', async ({ page, loginAs, markTodaySeen, pools, scenario }) => {
  await seedFrontDesk(pools, scenario);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/front-desk');
  await expect(page.getByRole('heading', { name: 'This week' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('link', { name: /Maria Alvarez/ })).toBeVisible();
  await scan(page);
});

test('Front Desk conversation has no serious accessibility violations', async ({ page, loginAs, markTodaySeen, pools, scenario }) => {
  const { ids } = await seedFrontDesk(pools, scenario);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto(`/front-desk/${ids.maria}`);
  await expect(page.getByRole('heading', { name: 'What was said' })).toBeVisible({ timeout: 20_000 });
  await scan(page);
});

test('Front Desk text conversation has no serious accessibility violations', async ({ page, loginAs, markTodaySeen, pools, scenario }) => {
  const { ids } = await seedFrontDesk(pools, scenario);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto(`/front-desk/${ids.tom}`);
  await expect(page.getByLabel('Your reply')).toBeVisible({ timeout: 20_000 });
  await scan(page);
});

test('Settings Front Desk has no serious accessibility violations', async ({ page, loginAs, markTodaySeen, pools, scenario, db }) => {
  await seedRooflineNumber(pools, db, scenario);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/settings/front-desk');
  await expect(page.getByRole('button', { name: 'Test it' })).toBeVisible({ timeout: 20_000 });
  await scan(page);
});

test('Settings Your profile has no serious accessibility violations', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/settings/profile');
  await expect(page.getByLabel('Your phone number')).toBeVisible({ timeout: 20_000 });
  await scan(page);
});
