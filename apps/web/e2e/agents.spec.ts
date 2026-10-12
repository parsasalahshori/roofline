import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';
import { AGENTS_SEED_MINUTES } from './agents-seed.ts';

/*
 * The Agents screen (A1 Task 13): the overview cards and totals, an agent page (rules, pause,
 * run now), the feed, and the waiting list. Data comes from the `agentsSeed` fixture. The job queue
 * is never drained: Storm Scout "Run now" only returns 202, so these tests assert the cooldown line.
 * Banners and messages are found by text, because several role=status/alert regions are always mounted.
 */

/** The card for one agent: the grid's list item or block that holds the agent's name link. */
function card(page: Page, name: string) {
  return page
    .getByRole('region', { name: 'Your agents' })
    .locator('a', { has: page.getByRole('heading', { name }) });
}

test('agents window: cards show the numbers from the seeded tasks', async ({ page, loginAs, markTodaySeen, agentsSeed }) => {
  void agentsSeed;
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/agents');

  const storm = card(page, 'Storm Scout');
  const estimator = card(page, 'Estimator');
  await expect(storm).toBeVisible({ timeout: 15_000 });
  await expect(estimator).toBeVisible();
  await expect(storm).toHaveAttribute('href', '/agents/storm-scout');
  await expect(estimator).toHaveAttribute('href', '/agents/estimator');

  // Storm Scout finished one task today; the time line is always an estimate in hours
  await expect(storm.getByText('Finished today')).toBeVisible();
  await expect(storm.locator('p', { hasText: 'Finished today' }).locator('span').nth(1)).toHaveText('1');
  await expect(estimator.locator('p', { hasText: 'Finished today' }).locator('span').nth(1)).toHaveText('0');
  await expect(storm.locator('p', { hasText: 'Time saved this month' })).toContainText(/about/);
  await expect(storm.locator('p', { hasText: 'Time saved this month' })).toContainText('(estimate)');
  // Storm minutes this month: stormToday (90) alone if the older task falls in last month, or
  // stormToday + stormOlder (90 + 190 = 280, about 4.5 hours) if it falls in this month.
  expect(AGENTS_SEED_MINUTES.stormToday).toBe(90);
  await expect(storm.locator('p', { hasText: 'Time saved this month' }).locator('span').nth(1)).toHaveText(/^about (1\.5|4\.5) hours$/);
  // Estimator: the in-month set is 0, 20, 50 or 70 minutes depending on the month boundary
  await expect(estimator.locator('p', { hasText: 'Time saved this month' }).locator('span').nth(1)).toHaveText(/^about (0|0\.5|1) hours?$/);

  // The waiting count: the showcase storm draft and the needs-attention task wait on someone
  await expect(storm.getByText(/^Waiting on you: [2-9]\d*$/)).toBeVisible();
  await expect(estimator.getByText('Waiting on you: 1', { exact: true })).toBeVisible();
});

test('agents window: totals line says about and (estimate)', async ({ page, loginAs, markTodaySeen, agentsSeed }) => {
  void agentsSeed;
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/agents');
  const totals = page.getByText('saved this month').first();
  await expect(totals).toBeVisible({ timeout: 15_000 });
  await expect(totals).toContainText(/about/i);
  await expect(totals).toContainText('(estimate)');
  await expect(totals).toContainText('≈ $');
});

test('agents window: the G1 agents say Coming soon', async ({ page, loginAs, markTodaySeen, agentsSeed }) => {
  void agentsSeed;
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/agents');
  const grid = page.getByRole('region', { name: 'Your agents' });
  await expect(grid).toBeVisible({ timeout: 15_000 });
  for (const name of ['Claims', 'Scheduler', 'Follow-up']) {
    await expect(card(page, name)).toContainText('Coming soon');
  }
  await expect(grid.getByText('Coming soon', { exact: true }).first()).toBeVisible();
});

test('agent page: Storm Scout shows its rule sentence and links to storm settings', async ({
  page,
  loginAs,
  markTodaySeen,
  agentsSeed,
}) => {
  void agentsSeed;
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/agents/storm-scout');
  const rules = page.locator('section', { has: page.getByRole('heading', { name: 'What it does' }) });
  await expect(rules).toContainText('hail', { timeout: 15_000 });
  const link = rules.getByRole('link').first();
  await expect(link).toHaveAttribute('href', '/settings/storm');
  await link.click();
  await expect(page).toHaveURL(/\/settings\/storm$/);
});

test('agent page: the owner pauses Storm Scout through the confirm sheet and the card shows paused', async ({
  page,
  loginAs,
  markTodaySeen,
  agentsSeed,
}) => {
  void agentsSeed;
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/agents/storm-scout');
  const pause = page.getByRole('switch', { name: 'Paused' });
  await expect(pause).toBeVisible({ timeout: 15_000 });
  await expect(pause).toHaveAttribute('aria-checked', 'false');
  await pause.click();
  const sheet = page.getByRole('dialog', { name: 'Pause this agent?' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Pause this agent?' })).toHaveCount(0, { timeout: 15_000 });
  await expect(pause).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 });

  await page.goto('/agents');
  await expect(card(page, 'Storm Scout')).toContainText('Paused', { timeout: 15_000 });
});

test('agent page: Run now shows the cooldown text', async ({ page, loginAs, markTodaySeen, agentsSeed }) => {
  void agentsSeed;
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/agents/storm-scout');
  await page.getByRole('button', { name: 'Check for hail now' }).click({ timeout: 15_000 });
  // The API answers 202 and the page shows when it can run again. The queued job is not drained.
  await expect(page.getByText('You can run it again at')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Check for hail now' })).toHaveCount(0);
});

test('feed: rows and filter chips', async ({ page, loginAs, markTodaySeen, agentsSeed }) => {
  void agentsSeed;
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/agents/feed');
  const list = page.getByRole('list', { name: 'What your agents did' });
  await expect(list).toBeVisible({ timeout: 15_000 });
  await expect(list.getByRole('listitem').filter({ hasText: 'Storm Scout' }).first()).toBeVisible();
  await expect(list.getByRole('listitem').filter({ hasText: 'Estimator' }).first()).toBeVisible();

  const chips = page.getByRole('group', { name: 'Show work by' });
  await chips.getByRole('button', { name: 'Estimator' }).click();
  await expect(chips.getByRole('button', { name: 'Estimator' })).toHaveAttribute('aria-pressed', 'true');
  await expect(list.getByRole('listitem').filter({ hasText: 'Proposal for Lopez' }).first()).toBeVisible({ timeout: 15_000 });
  await expect(list.getByRole('listitem').filter({ hasText: 'Storm Scout' })).toHaveCount(0);
  await expect(list.getByText('Storm plan for Elkhorn')).toHaveCount(0);

  await chips.getByRole('button', { name: 'All' }).click();
  await expect(list.getByRole('listitem').filter({ hasText: 'Storm Scout' }).first()).toBeVisible({ timeout: 15_000 });
});

test('waiting list: rows link to the approvals review', async ({ page, loginAs, markTodaySeen, agentsSeed, scenario }) => {
  void scenario;
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/agents/waiting');
  const waiting = page.getByLabel('Waiting', { exact: true });
  await expect(waiting).toBeVisible({ timeout: 15_000 });
  const draftRow = waiting.getByRole('listitem').filter({ hasText: agentsSeed.draftTitle });
  await expect(draftRow).toBeVisible();
  await expect(waiting.getByText(agentsSeed.attentionReason)).toBeVisible();
  // The showcase storm draft waits too: at least two rows link to a review
  expect(await waiting.getByRole('link', { name: 'Open' }).count()).toBeGreaterThanOrEqual(2);

  const open = draftRow.getByRole('link', { name: 'Open' });
  await expect(open).toHaveAttribute('href', new RegExp('/approvals/' + agentsSeed.draftTaskId + '$'));
  await open.click();
  await expect(page).toHaveURL(new RegExp('/approvals/' + agentsSeed.draftTaskId + '$'));
  // The /approvals/:id route renders in the approvals AppWindow, whose dialog name is the approvals title, not the Agents one.
  const review = page.getByRole('dialog', { name: 'Need your OK' });
  await expect(review).toBeVisible({ timeout: 15_000 });
  await expect(review.getByText(agentsSeed.draftTitle).first()).toBeVisible();
});

test('rep sees a smaller Agents window', async ({ page, loginAs, markTodaySeen, agentsSeed }) => {
  void agentsSeed;
  await loginAs(page, 'rep');
  await markTodaySeen('rep@a.test');
  await page.goto('/agents');
  await expect(card(page, 'Storm Scout')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('We could not load your agents')).toHaveCount(0);

  // Ruling AX-J: a rep sees tasks on their own jobs only; the seeded tasks have no job subject
  await page.goto('/agents/feed');
  await expect(page.getByRole('group', { name: 'Show work by' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Storm plan for Elkhorn')).toHaveCount(0);
  await expect(page.getByText('Proposal for Lopez')).toHaveCount(0);
});
