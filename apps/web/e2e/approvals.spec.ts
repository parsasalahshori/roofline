import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';
import { seedOldLead, seedTextsPlan, seedWeatherMovePlan } from './g1-seeds.ts';

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

/*
 * The queue (/approvals): the plans as cards, and the keys of a triage list. A plan with one step to decide is approved
 * right on the queue; a plan with several opens its review, where each step has its switch.
 */

const WEATHER_TITLE = 'Rain on the install day: move 1 install?';

test('queue: the keys move between cards, 1 approves a one-step plan and opens the review of a bigger one', async ({
  page,
  loginAs,
  markTodaySeen,
  scenario,
  db,
  pools,
}) => {
  const move = await seedWeatherMovePlan(pools, db, scenario.a.companyId);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/approvals');

  const list = page.getByRole('list', { name: 'Plans waiting for your OK' });
  const weather = list.getByRole('article', { name: WEATHER_TITLE });
  await expect(weather).toBeVisible({ timeout: 15_000 });
  // The storm plan has three steps to decide: its main button opens the review
  const storm = list.getByRole('article').filter({ has: page.getByRole('link', { name: 'Review 3 steps' }) });
  await expect(storm.getByRole('link', { name: 'Review 3 steps' })).toHaveAttribute('href', new RegExp('/approvals/' + scenario.taskId + '$'));
  // What it reaches and what it costs, from the plan itself
  await expect(storm).toContainText('31 texts');
  await expect(storm).toContainText('Up to $270');

  // J goes to the first card (the newest plan, the weather move), J again to the next, K back
  await page.keyboard.press('j');
  await expect(weather.getByRole('button', { name: 'Approve' })).toBeFocused();
  await page.keyboard.press('j');
  await expect(storm.getByRole('link', { name: 'Review 3 steps' })).toBeFocused();
  await page.keyboard.press('k');
  await expect(weather.getByRole('button', { name: 'Approve' })).toBeFocused();

  // 1 on the one-step plan approves it: the card leaves the queue and says so
  await page.keyboard.press('1');
  await expect(page.getByText('Approved: ' + WEATHER_TITLE)).toBeVisible({ timeout: 15_000 });
  await expect(list.getByRole('article', { name: WEATHER_TITLE })).toHaveCount(0, { timeout: 15_000 });
  await expect
    .poll(async () => (await db.query<{ status: string }>('select status from agent_tasks where id = $1', [move.taskId])).rows[0]?.status, {
      timeout: 20_000,
    })
    .not.toBe('draft');

  // The focus went to the plan that took its place; 1 there opens its review
  await expect(storm.getByRole('link', { name: 'Review 3 steps' })).toBeFocused();
  await page.keyboard.press('1');
  await expect(page).toHaveURL(new RegExp('/approvals/' + scenario.taskId + '$'));
  await expect(page.getByRole('button', { name: 'Approve 3 steps · up to $270' })).toBeVisible();
});

test('queue: H sets a plan aside with a reason, E edits a plan with one text to change', async ({
  page,
  loginAs,
  markTodaySeen,
  scenario,
  db,
  pools,
}) => {
  const lead = await seedOldLead(db, scenario.a.companyId);
  const texts = await seedTextsPlan(pools, scenario.a.companyId, lead.customerId);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/approvals');

  const card = page.getByRole('article', { name: 'Follow up with 1 lead' });
  await expect(card).toBeVisible({ timeout: 15_000 });

  // E fetches the plan and opens the step's own sheet right there
  await card.getByRole('button', { name: 'Approve' }).focus();
  await page.keyboard.press('e');
  const edit = page.getByRole('dialog', { name: 'Edit this step' });
  await expect(edit).toBeVisible({ timeout: 15_000 });
  await expect(edit.getByRole('textbox').first()).toHaveValue(/Would Tuesday at 10 AM/);
  await edit.getByRole('button', { name: 'Cancel' }).click();
  await expect(edit).toHaveCount(0);

  // H asks for a reason, then sets the plan aside
  await card.getByRole('button', { name: 'Approve' }).focus();
  await page.keyboard.press('h');
  const sheet = page.getByRole('dialog', { name: 'Set this plan aside?' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('textbox', { name: 'Why not? (optional)' }).fill('Customer called to reschedule');
  await sheet.getByRole('button', { name: 'Not now' }).click();
  await expect(page.getByText("Okay, we've set this plan aside.")).toBeVisible({ timeout: 15_000 });
  await expect(card).toHaveCount(0, { timeout: 15_000 });
  const row = await db.query<{ status: string }>('select status from agent_tasks where id = $1', [texts.taskId]);
  expect(row.rows[0]?.status).toBe('declined');
});
