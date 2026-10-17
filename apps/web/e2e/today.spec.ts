import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';

/*
 * Today: the "My day" page opens once per day when the person arrives at Home, never on a
 * deep link, and stays closed after going Home and a reload the same day. The day it was shown is stored on
 * the server, so these tests do not call markTodaySeen. Pages are found by their accessible name
 * and banners by their text, never by a bare role=status.
 */

/** Home through the rail: a page has no close button, and Esc leaves it where it is. */
async function goHome(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Apps' }).getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}

test('opens once per day, again the next day', async ({ page, loginAs, db }) => {
  await loginAs(page, 'owner');
  await page.goto('/');
  await expect(page).toHaveURL(/\/today$/);
  const dlg = page.getByRole('main', { name: 'My day' });
  // The page names itself and lists today's visits; it does not greet (Home does)
  await expect(dlg.getByRole('heading', { level: 1, name: 'My day' })).toBeVisible();
  await expect(dlg.getByRole('region', { name: 'Your visits today' })).toBeVisible();
  await goHome(page);

  // Same day: the question is asked again, but the answer is no
  const answered = page.waitForResponse('**/api/me/today-shown');
  await page.goto('/');
  await answered;
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('main', { name: 'My day' })).toHaveCount(0);

  // Yesterday was the last time it was shown, so today it opens again
  await db.query(
    'update memberships set last_today_shown_on = last_today_shown_on - 1 where user_id = (select id from users where email = $1)',
    ['owner@a.test'],
  );
  await page.goto('/');
  await expect(page).toHaveURL(/\/today$/);
});

test('a deep link does not open Today', async ({ page, loginAs }) => {
  await loginAs(page, 'owner');
  const asked: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/me/today-shown')) asked.push(r.url());
  });

  await page.goto('/jobs');
  await expect(page.getByRole('main', { name: 'Jobs', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/jobs$/);
  // Give a stray question time to be sent before concluding there was none
  await page.waitForTimeout(1000);
  expect(asked).toHaveLength(0);

  // Today had not been shown yet that day, so the map home still opens it
  await page.goto('/');
  await expect(page).toHaveURL(/\/today$/);
});

test('auto-open on arrival at Home, gone after going Home and reloading', async ({ page, loginAs }) => {
  await loginAs(page, 'owner');
  await page.goto('/');
  await expect(page.getByRole('main', { name: 'My day' })).toBeVisible();
  await expect(page).toHaveURL(/\/today$/);

  await goHome(page);

  // The day is stored on the server: the reload asks again and must not reopen Today
  const answered = page.waitForResponse('**/api/me/today-shown');
  await page.reload();
  await answered;
  await expect(page.getByRole('main', { name: 'My day' })).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
});
