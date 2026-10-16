import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';

/*
 * The review window (R2): approving a draft in two clicks from the map pill or the Storm window,
 * turning a step off, and the office user whose spend step waits for the owner. Steps are found
 * by their title inside the review dialog; statuses are counted inside the step list only.
 */

/** The step row for one step title inside the review dialog. */
function row(page: Page, title: string) {
  return page.getByRole('main').getByRole('listitem').filter({ hasText: title });
}

test('one draft: pill to approved in 2 clicks', async ({ page, loginAs, markTodaySeen, click, clicks }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/');
  await click(page.getByRole('link', { name: '1 need your OK' }));
  await click(page.getByRole('button', { name: 'Approve 3 steps · up to $270' }));
  // Scoped to the step list: once every step is done the task's own status in the stat strip also reads "Done".
  await expect(page.getByRole('main').getByRole('list').getByText('Done', { exact: true })).toHaveCount(3, {
    timeout: 15_000,
  });
  expect(clicks.count).toBe(2);
});

test('from the Storm window: 2 clicks', async ({ page, loginAs, markTodaySeen, scenario, click, clicks }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/storm');
  await click(page.getByRole('link', { name: 'Approve storm plan' }));
  await expect(page).toHaveURL(new RegExp('/storm/plans/' + scenario.taskId + '$'));
  await click(page.getByRole('button', { name: 'Approve 3 steps · up to $270' }));
  await expect(page.getByRole('main').getByRole('list').getByText('Done', { exact: true })).toHaveCount(3, {
    timeout: 15_000,
  });
  expect(clicks.count).toBe(2);
});

test('turning a step off excludes it', async ({ page, loginAs, markTodaySeen, scenario }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/approvals/' + scenario.taskId);

  // Toggling a switch is not one of the two counted approval clicks, so it uses page directly.
  const doorKnock = page.getByRole('switch', { name: 'Door-knock routes for 4 reps' });
  await doorKnock.click();
  await expect(doorKnock).toHaveAttribute('aria-checked', 'false');

  await page.getByRole('button', { name: 'Approve 2 steps · up to $270' }).click();
  await expect(row(page, 'Door-knock routes for 4 reps')).toContainText('Turned off', { timeout: 15_000 });
  await expect(row(page, 'Text 31 customers')).toContainText('Done', { timeout: 15_000 });
  await expect(row(page, 'Google + Facebook ads on the swath')).toContainText('Done', { timeout: 15_000 });
});

test('office approves two, the ad waits for the owner', async ({ page, loginAs, markTodaySeen, scenario }) => {
  await loginAs(page, 'office');
  await markTodaySeen('office@a.test');
  await page.goto('/approvals/' + scenario.taskId);

  await expect(row(page, 'Google + Facebook ads on the swath')).toContainText('Your owner approves spending');
  await page.getByRole('button', { name: 'Approve 2 steps · send ad to owner' }).click();

  // No reload: the review picks up the live result of the approval.
  await expect(row(page, 'Text 31 customers')).toContainText('Done', { timeout: 15_000 });
  await expect(row(page, 'Door-knock routes for 4 reps')).toContainText('Done', { timeout: 15_000 });
  await expect(row(page, 'Google + Facebook ads on the swath')).toContainText('Waiting for owner', { timeout: 15_000 });

  // The owner signs in and sees the one step left to approve.
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/');
  await page.getByRole('link', { name: '1 need your OK' }).click();
  await expect(page.getByRole('button', { name: 'Approve 1 step · up to $270' })).toBeVisible();
});
