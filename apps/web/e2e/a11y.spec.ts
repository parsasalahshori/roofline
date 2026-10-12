import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';

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
