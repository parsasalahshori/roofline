import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';
import { AGENTS_SEED_MINUTES } from './agents-seed.ts';

/*
 * The Agents screen (A1 Task 13, the design-d2 dashboard): the totals tiles and agent cards, an agent page (rules, pause,
 * run now), the feed, and the waiting list. Data comes from the `agentsSeed` fixture. The job queue
 * is never drained: Storm Scout "Run now" only returns 202, so these tests assert the cooldown line.
 * Banners and messages are found by text, because several role=status/alert regions are always mounted.
 */

/** The Agents dashboard's card grid ("Totals for your agents" also contains the words, hence exact). */
function grid(page: Page) {
  return page.getByRole('region', { name: 'Your agents', exact: true });
}

/** The card for one agent: the grid's list item whose heading picks that agent. */
function card(page: Page, name: string) {
  return grid(page)
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: `Show details for ${name}`, exact: true }) });
}

/** The dashboard card switch: on means running. */
function running(page: Page, name: string) {
  return card(page, name).getByRole('switch', { name: `${name} Running` });
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

  // Storm Scout finished one task today, the Estimator none; both are on.
  await expect(storm.getByText('tasks today', { exact: true })).toBeVisible();
  await expect(storm.locator('p').first()).toHaveText('1');
  await expect(estimator.locator('p').first()).toHaveText('0');
  await expect(running(page, 'Storm Scout')).toHaveAttribute('aria-checked', 'true');
  // Both have work waiting on a person (the showcase storm draft, the needs-attention task): Waiting, with the count.
  await expect(storm.getByText('Waiting', { exact: true })).toBeVisible();
  await expect(storm.getByText(/^Waiting on you: [2-9]\d*$/)).toBeVisible();
  await expect(estimator.getByText('Waiting on you: 1', { exact: true })).toBeVisible();
  // Storm minutes this week include today's 90-minute task: at least 1 whole hour, marked as an estimate.
  expect(AGENTS_SEED_MINUTES.stormToday).toBe(90);
  await expect(storm.getByText(/^about [1-9]\d* hrs$/)).toBeVisible();

  // Picking a card opens its panel, which links to the agent's own page.
  await page.getByRole('button', { name: 'Show details for Storm Scout' }).click();
  const open = page.getByRole('link', { name: 'Open Storm Scout' });
  await expect(open).toHaveAttribute('href', '/agents/storm-scout');
});

test('agents window: totals tiles show tasks, hours and office time, marked as estimates', async ({ page, loginAs, markTodaySeen, agentsSeed }) => {
  void agentsSeed;
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/agents');
  const tiles = page.getByRole('region', { name: 'Totals for your agents' });
  await expect(tiles).toBeVisible({ timeout: 15_000 });
  await expect(tiles.getByRole('heading', { name: 'Tasks today' })).toBeVisible();
  await expect(tiles.getByRole('heading', { name: 'Hours saved this week' })).toBeVisible();
  await expect(tiles.getByRole('heading', { name: 'Office time saved this week' })).toBeVisible();
  // Estimated money and time say so.
  await expect(tiles.getByText(/^about \$[\d,]+$/)).toBeVisible();
  await expect(tiles).toContainText('(estimate)');
});

// G1 ships its three agents (G1_AGENTS_SHIPPED): they start paused with a Turn on hint, not Coming soon (probe pass 14).
test('agents window: the G1 agents start paused', async ({ page, loginAs, markTodaySeen, agentsSeed }) => {
  void agentsSeed;
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/agents');
  await expect(grid(page)).toBeVisible({ timeout: 15_000 });
  for (const name of ['Claims', 'Scheduler', 'Follow-up']) {
    await expect(card(page, name)).toContainText('Paused');
    await expect(running(page, name)).toHaveAttribute('aria-checked', 'false');
  }
  await expect(grid(page).getByText('Coming soon', { exact: true })).toHaveCount(0);
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
  await expect(running(page, 'Storm Scout')).toHaveAttribute('aria-checked', 'false');
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
  // The /approvals/:id route opens the review dialog (approvals.spec.ts); its Approve button proves the review, not the list, is showing.
  const review = page.getByRole('main');
  await expect(review.getByRole('button', { name: /^Approve \d+ steps?/ })).toBeVisible({ timeout: 15_000 });
  await expect(review.getByText(agentsSeed.draftTitle).first()).toBeVisible();
});

test('rep sees a smaller Agents window', async ({ page, loginAs, markTodaySeen, agentsSeed }) => {
  void agentsSeed;
  await loginAs(page, 'rep');
  await markTodaySeen('rep@a.test');
  await page.goto('/agents');
  await expect(card(page, 'Storm Scout')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('We could not load your agents')).toHaveCount(0);
  // Only the owner turns agents on and off: a rep's cards have no switch.
  await expect(grid(page).getByRole('switch')).toHaveCount(0);

  // Ruling AX-J: a rep sees tasks on their own jobs only; the seeded tasks have no job subject
  await page.goto('/agents/feed');
  await expect(page.getByRole('group', { name: 'Show work by' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Storm plan for Elkhorn')).toHaveCount(0);
  await expect(page.getByText('Proposal for Lopez')).toHaveCount(0);
});
