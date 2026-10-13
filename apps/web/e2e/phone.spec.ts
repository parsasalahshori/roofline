import type { Page, Locator } from '@playwright/test';
import { test, expect } from './fixtures.ts';

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

/** Fails when two boxes overlap (1px tolerance for sub-pixel layout). */
function expectApart(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): void {
  const apart = a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1 || a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1;
  expect(apart).toBe(true);
}

for (const width of [360, 390]) {
  test(`top bar at ${width}px: a long name shows initials and nothing overlaps the OK pill`, async ({ page, loginAs, markTodaySeen, db }) => {
    const longName = 'Dana Whitfield-Montgomery';
    await db.query('update users set name = $1 where email = $2', [longName, 'owner@a.test']);
    await page.setViewportSize({ width, height: 800 });
    await loginAs(page, 'owner');
    await markTodaySeen('owner@a.test');
    await page.goto('/');

    const bar = page.getByRole('banner').first();
    const pill = bar.getByRole('link', { name: /need your OK/ });
    const menu = bar.getByRole('button', { name: longName });
    const search = bar.getByRole('button', { name: 'Search', exact: true });
    await expect(pill).toBeVisible();
    await expect(menu).toBeVisible();
    // Only the initials show on a phone; the full name is the button's label.
    await expect(bar.getByText(longName, { exact: true })).toHaveCount(0);

    const [pillBox, menuBox, searchBox, barBox] = await Promise.all([pill.boundingBox(), menu.boundingBox(), search.boundingBox(), bar.boundingBox()]);
    for (const box of [pillBox, menuBox, searchBox, barBox]) expect(box).not.toBeNull();
    expectApart(pillBox!, menuBox!);
    expectApart(pillBox!, searchBox!);
    expectApart(searchBox!, menuBox!);
    // Everything stays on the screen.
    for (const box of [pillBox!, menuBox!, searchBox!]) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

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
