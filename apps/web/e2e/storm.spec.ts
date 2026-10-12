import type { Page } from '@playwright/test';
import { test, expect, readStack } from './fixtures.ts';

/*
 * Storm Scout end to end: the owner approves a five-step storm plan in two clicks and every step
 * finishes with the fakes, and the office user approves the messages while the owner approves the
 * two ad steps. The plan is drafted through the API (the fixture storm is seeded without one).
 * The hail worker, match timing and ad sync are proven by pytest and integration tests, not here.
 */

function row(page: Page, title: string) {
  return page.getByRole('dialog').getByRole('listitem').filter({ hasText: title });
}

/** Drafts the fixture storm's plan as the signed-in user and returns the new task id. */
async function draftPlan(page: Page, stormId: string): Promise<string> {
  const response = await page.request.post(`/api/storms/${stormId}/plan`, {
    headers: { Origin: readStack().baseUrl },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { taskId: string };
  return body.taskId;
}

test('storm plan in 2 clicks', async ({ page, loginAs, markTodaySeen, scenario, click, clicks }) => {
  test.setTimeout(90_000);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const taskId = await draftPlan(page, scenario.companyStormId);
  expect(taskId).not.toBe(scenario.taskId);

  await page.goto('/storm');
  // The newest plan is the one the card offers; the showcase demo plan is older.
  await click(page.getByRole('link', { name: 'Approve storm plan' }));
  await expect(page).toHaveURL(new RegExp('/storm/plans/' + taskId + '$'));
  await click(page.getByRole('button', { name: /^Approve \d+ steps/ }));

  await expect(page.getByRole('dialog').getByRole('list').getByText('Done', { exact: true })).toHaveCount(5, {
    timeout: 60_000,
  });
  expect(clicks.count).toBe(2);

  // Results: texts went out, and the ads have a budget line (two campaigns share it).
  await page.goto(`/storm/${scenario.companyStormId}`);
  await expect(page.getByRole('heading', { name: 'Results so far' })).toBeVisible({ timeout: 20_000 });
  const grid = page.getByTestId('storm-results-grid');
  const textsSent = grid.locator('dl').filter({ has: page.getByText('Texts sent', { exact: true }) });
  await expect(textsSent).toBeVisible();
  await expect(textsSent.locator('dd').first()).not.toHaveText('0');
  await expect(grid.getByText(/^Ad spend \$/)).toBeVisible();
});

test('office approves messages, owner approves spend', async ({
  page,
  loginAs,
  markTodaySeen,
  scenario,
}) => {
  test.setTimeout(90_000);
  await loginAs(page, 'owner');
  const taskId = await draftPlan(page, scenario.companyStormId);

  await loginAs(page, 'office');
  await markTodaySeen('office@a.test');
  await page.goto('/approvals/' + taskId);

  const google = 'Google ads on the hail area';
  const meta = 'Facebook and Instagram ads on the hail area';
  await expect(row(page, google)).toContainText('Your owner approves spending', { timeout: 20_000 });
  await expect(row(page, meta)).toContainText('Your owner approves spending');
  await page.getByRole('button', { name: /^Approve \d+ steps · send (ad|\d+ steps) to owner/ }).click();

  // No reload: the review picks up the live result of the approval.
  await expect(row(page, 'Text ')).toContainText('Done', { timeout: 60_000 });
  await expect(row(page, 'Email ')).toContainText('Done', { timeout: 60_000 });
  await expect(row(page, 'door-knock route')).toContainText('Done', { timeout: 60_000 });
  await expect(row(page, google)).toContainText('Waiting for owner', { timeout: 60_000 });
  await expect(row(page, meta)).toContainText('Waiting for owner', { timeout: 60_000 });

  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/approvals/' + taskId);
  await page.getByRole('button', { name: /^Approve 2 steps · up to \$/ }).click();
  await expect(row(page, google)).toContainText('Done', { timeout: 60_000 });
  await expect(row(page, meta)).toContainText('Done', { timeout: 60_000 });
});
