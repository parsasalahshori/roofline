import { test, expect } from './fixtures.ts';

/*
 * Setup: the checklist in Settings. The count is read from the progress line on the page; the ring
 * beside the avatar shows the same words as its label.
 */

const PROGRESS = /(\d+) of 5 setup steps done/;

test.beforeEach(async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/settings/setup');
});

async function doneCount(page: import('@playwright/test').Page): Promise<number> {
  const text = await page.getByText(PROGRESS).first().textContent();
  return Number(PROGRESS.exec(text ?? '')?.[1] ?? Number.NaN);
}

test('skip the import and the ring moves', async ({ page }) => {
  await expect(page.getByText(PROGRESS).first()).toBeVisible();
  const before = await doneCount(page);
  expect(before).toBeGreaterThanOrEqual(0);

  const row = page.getByRole('listitem').filter({ hasText: 'Bring in your customers' });
  await row.getByRole('button', { name: 'Skip for now' }).click();

  await expect.poll(() => doneCount(page)).toBe(before + 1);
  await expect(page.getByRole('link', { name: `${before + 1} of 5 setup steps done` })).toBeVisible();
});

test('no step says Coming with, and the ad accounts step links to Connections', async ({ page }) => {
  // Every step is real: calendar since C1 Task 12, phone number since D1 Task 24, prices since E1 Task 8, ads since S1.
  await expect(page.getByText(/Coming with/)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Connect ad accounts' })).toHaveAttribute('href', '/settings/connections');
});

test('the phone number step opens the forwarding guide', async ({ page }) => {
  await expect(page.getByText('Coming with Front Desk', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Forward your calls' })).toHaveAttribute(
    'href',
    '/settings/front-desk#forwarding',
  );
});
