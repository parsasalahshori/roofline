import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';

/*
 * Settings, Agents tab: the time baselines table and the 90-day recount. The Storm Scout task finished
 * today sent 60 texts at 1.5 minutes (90 minutes). Raising the text baseline to 2 and recounting makes
 * that step 120 minutes (at the 120 cap, not over it), so the month total grows by exactly 30 minutes.
 * Every other seeded step recounts to the same minutes because it carries its result.
 */

const INPUT = 'Minutes saved for Texts sent';

/**
 * The totals line on the Agents window ("About 9 hours saved this month (estimate) · ..."). It always starts
 * with "About", unlike the per-card "Time saved this month" spans, so this matches exactly one element.
 */
function totalsLine(page: Page) {
  return page.getByText(/^About .+ saved this month/);
}

async function readTotals(page: Page): Promise<string> {
  await page.goto('/agents');
  await expect(totalsLine(page)).toBeVisible();
  return (await totalsLine(page).innerText()).trim();
}

async function saveTextBaseline(page: Page): Promise<void> {
  await page.goto('/settings/agents');
  const input = page.getByRole('textbox', { name: INPUT }).or(page.getByRole('spinbutton', { name: INPUT }));
  await input.fill('2');
  // G1's agent rules form sits below on the same tab with its own Save; the time-saved table's comes first (probe pass 14).
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
}

test('settings agents: owner changes a baseline, saves, recounts, and the month total changes', async ({
  page,
  loginAs,
  markTodaySeen,
  agentsSeed,
}) => {
  expect(agentsSeed.stormTodayTaskId).toBeTruthy();
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const before = await readTotals(page);

  await saveTextBaseline(page);
  await page.getByRole('button', { name: 'Recount the last 90 days with these numbers' }).click();
  const sheet = page.getByRole('dialog', { name: 'Recount the last 90 days?' });
  await expect(sheet).toBeVisible();
  const now = await sheet.getByText('Now:').innerText();
  const after = await sheet.getByText('After the recount:').innerText();
  expect(now.replace('Now:', '').trim()).not.toBe(after.replace('After the recount:', '').trim());
  await sheet.getByRole('button', { name: 'Recount', exact: true }).click();
  await expect(page.getByText('Done. The last 90 days now use these numbers.')).toBeVisible();

  await page.goto('/agents');
  await expect(totalsLine(page)).toBeVisible();
  await expect.poll(async () => (await totalsLine(page).innerText()).trim()).not.toBe(before);
  const total = (await totalsLine(page).innerText()).trim();
  expect(total).toContain('(estimate)');
  expect(total.toLowerCase()).toContain('about');
});

test('settings agents: saving a baseline alone does not change past totals', async ({
  page,
  loginAs,
  markTodaySeen,
  agentsSeed,
}) => {
  expect(agentsSeed.stormTodayTaskId).toBeTruthy();
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const before = await readTotals(page);

  await saveTextBaseline(page);

  expect(await readTotals(page)).toBe(before);
});

test('settings agents: office sees the table read-only', async ({ page, loginAs, markTodaySeen, agentsSeed }) => {
  expect(agentsSeed.stormTodayTaskId).toBeTruthy();
  await loginAs(page, 'office');
  await markTodaySeen('office@a.test');
  await page.goto('/settings/agents');
  await expect(page.getByText('How we count time saved')).toBeVisible();
  await expect(page.getByText('Only the owner can change these.')).toBeVisible();
  // Read-only: the table shows plain minutes, with no inputs and no Save or Recount buttons.
  await expect(page.getByRole('cell', { name: '1.5 minutes' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: INPUT })).toHaveCount(0);
  await expect(page.getByRole('spinbutton', { name: INPUT })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Recount the last 90 days with these numbers' })).toHaveCount(0);
});

test('settings agents: reps cannot see the Agents tab', async ({ page, loginAs, markTodaySeen, agentsSeed }) => {
  expect(agentsSeed.stormTodayTaskId).toBeTruthy();
  await loginAs(page, 'rep');
  await markTodaySeen('rep@a.test');
  await page.goto('/settings');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('link', { name: 'Agents', exact: true })).toHaveCount(0);
  await expect(settings.getByRole('tab', { name: 'Agents', exact: true })).toHaveCount(0);
  await page.goto('/settings/agents');
  await expect(page.getByText('How we count time saved')).toHaveCount(0);
});
