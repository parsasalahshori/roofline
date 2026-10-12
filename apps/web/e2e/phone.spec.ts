import type { Page, Locator } from '@playwright/test';
import { test, expect } from './fixtures.ts';
import { makeAndSendProposal } from './estimator-helpers.ts';

/*
 * The phone shell (below 768px): full-screen pages, the bottom tab bar that replaces the dock, and
 * the More sheet. This file runs in the `phone` Playwright project (375x812, Pixel 7). F3 Task 36
 * appends its pages to the same tests below, so keep one `test` per page group and add helpers here.
 */

/** Fails when the page is wider than the phone screen, so something scrolls sideways. */
async function noSideScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
}

/** Fails unless `button` sits fully above the bottom tab bar (1px tolerance for sub-pixel layout). */
async function expectAboveTabs(page: Page, button: Locator): Promise<void> {
  const tabs = await page.getByRole('navigation', { name: 'Main' }).boundingBox();
  const box = await button.boundingBox();
  expect(tabs).not.toBeNull();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(tabs!.y + 1);
}

test('bottom tabs work', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/');

  const tabs = page.getByRole('navigation', { name: 'Main' });
  await expect(page.getByRole('navigation', { name: 'Apps' })).toHaveCount(0);

  await tabs.getByRole('link', { name: 'Map', exact: true }).click();
  await expect(page).toHaveURL('/');
  await expect(tabs.getByRole('link', { name: 'Map', exact: true })).toHaveAttribute('aria-current', 'page');

  await tabs.getByRole('link', { name: 'My day', exact: true }).click();
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole('dialog', { name: 'My day' })).toBeVisible();
  await expect(tabs.getByRole('link', { name: 'My day', exact: true })).toHaveAttribute('aria-current', 'page');

  await tabs.getByRole('link', { name: 'Jobs', exact: true }).click();
  await expect(page).toHaveURL(/\/jobs$/);
  await expect(tabs.getByRole('link', { name: 'Jobs', exact: true })).toHaveAttribute('aria-current', 'page');

  await tabs.getByRole('link', { name: 'Calendar', exact: true }).click();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(tabs.getByRole('link', { name: 'Calendar', exact: true })).toHaveAttribute('aria-current', 'page');

  await tabs.getByRole('button', { name: 'More', exact: true }).click();
  const more = page.getByRole('dialog', { name: 'More', exact: true });
  await expect(more).toBeVisible();
  await more.getByRole('link', { name: 'Storm', exact: true }).click();
  await expect(page).toHaveURL(/\/storm$/);
  await expect(page.getByRole('dialog', { name: 'More', exact: true })).toHaveCount(0);
});

test('no horizontal scroll', async ({ page, loginAs, markTodaySeen, scenario }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');

  for (const path of ['/', '/approvals', '/approvals/' + scenario.taskId]) {
    await page.goto(path);
    if (path === '/') {
      await expect(page.getByText('Map showing 70 customers and 25 open jobs.')).toBeAttached({ timeout: 20_000 });
    } else {
      await expect(page.getByRole('dialog').first()).toBeVisible();
    }
    await noSideScroll(page);
  }
});

test('Approve stays pinned', async ({ page, loginAs, markTodaySeen, scenario }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/approvals/' + scenario.taskId);

  const button = page.getByRole('button', { name: 'Approve 3 steps · up to $270' });
  await expect(button).toBeVisible();
  await expectAboveTabs(page, button);

  await page.mouse.move(187, 400);
  await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(300);
  await expectAboveTabs(page, button);
});

test('long text does not widen the page', async ({ page, loginAs, markTodaySeen, scenario, db }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await db.query(`update customers set display_name = repeat('Long', 15) where company_id = $1`, [
    scenario.a.companyId,
  ]);
  await db.query(
    `update agent_task_steps set payload = jsonb_set(payload, '{sample}', to_jsonb(repeat('word ', 80)))
      where task_id = $1 and type = 'demo_message'`,
    [scenario.taskId],
  );

  await page.goto('/approvals/' + scenario.taskId);
  await expect(page.getByRole('dialog').first()).toBeVisible();
  await noSideScroll(page);
});

test('sign-up does not scroll sideways', async ({ page }) => {
  await page.goto('/sign-up');
  await expect(page.getByLabel('Your name')).toBeVisible();
  await noSideScroll(page);
});

test('F3 pages do not scroll sideways', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');

  for (const path of ['/settings/setup', '/settings/billing', '/settings/setup/import']) {
    await page.goto(path);
    await expect(page.getByRole('dialog').first()).toBeVisible();
    await noSideScroll(page);
  }
});

test('the proposal view fits the phone', async ({ page, loginAs, markTodaySeen, click }) => {
  test.setTimeout(120_000);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const sent = await makeAndSendProposal(page, click);

  await page.goto('/estimator/proposals/' + sent.proposalId);
  await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();
  await noSideScroll(page);
});

test('C1 pages do not scroll sideways', async ({ page, loginAs, markTodaySeen, db, scenario }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const job = await db.query<{ id: string }>(`select id from jobs where company_id = $1 order by id limit 1`, [
    scenario.a.companyId,
  ]);
  const customer = await db.query<{ id: string }>(`select id from customers where company_id = $1 order by id limit 1`, [
    scenario.a.companyId,
  ]);

  const pages: [string, () => Locator][] = [
    ['/jobs?view=list', () => page.getByLabel('Jobs list', { exact: true })],
    [`/jobs/${job.rows[0]?.id}`, () => page.getByRole('group', { name: 'Job stage' })],
    [`/customers/${customer.rows[0]?.id}`, () => page.getByRole('group', { name: 'Customer actions' })],
    [
      '/calendar?view=list',
      () => page.locator('[data-testid^="agenda-day-"]').first().or(page.getByText('Nothing scheduled.', { exact: true })),
    ],
  ];
  for (const [path, ready] of pages) {
    await page.goto(path);
    await expect(ready()).toBeVisible({ timeout: 20_000 });
    await noSideScroll(page);
  }
});

test('agents screens fit the phone', async ({ page, loginAs, markTodaySeen, agentsSeed }) => {
  void agentsSeed;
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');

  const screens: [string, (p: Page) => Locator][] = [
    ['/agents', (p) => p.getByRole('heading', { name: 'Your agents' })],
    ['/agents/storm-scout', (p) => p.getByText('What it does').first()],
    ['/agents/feed', (p) => p.getByRole('list', { name: 'What your agents did' })],
    ['/agents/waiting', (p) => p.getByLabel('Waiting', { exact: true })],
    ['/settings/agents', (p) => p.getByText('How we count time saved').first()],
  ];
  for (const [path, landmark] of screens) {
    await page.goto(path);
    await expect(landmark(page)).toBeAttached();
    if (path === '/agents') await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await noSideScroll(page);
  }
});
