import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';

/*
 * Settings, Agents tab: the time baselines table and the 90-day recount. The Storm Scout task finished
 * today sent 60 texts at 1.5 minutes (90 minutes). Raising the text baseline to 2 and recounting makes
 * that step 120 minutes (at the 120 cap, not over it), so the total grows by exactly 30 minutes.
 * Every other seeded step recounts to the same minutes because it carries its result. The
 * dashboard shows the week, which always holds today's Storm Scout step.
 */

const INPUT = 'Minutes saved for Texts sent';

/**
 * The "Office time saved this week" tile ("about $514") on the Agents dashboard: this week's minutes at the hourly rate, in dollars. The
 * recount's 30 minutes land on today's Storm Scout step, so it always moves ($14 at the default $28 an hour).
 */
function totalsLine(page: Page) {
  return page.getByRole('region', { name: 'Totals for your agents' }).getByText(/^about \$[\d,]+$/);
}

async function readTotals(page: Page): Promise<string> {
  await page.goto('/agents');
  await expect(totalsLine(page)).toBeVisible();
  return (await totalsLine(page).innerText()).trim();
}

const baselinesSection = (page: Page) => page.getByRole('region', { name: 'How we count time saved' });

async function saveTextBaseline(page: Page): Promise<void> {
  await page.goto('/settings/agents');
  const input = page.getByRole('textbox', { name: INPUT }).or(page.getByRole('spinbutton', { name: INPUT }));
  await input.fill('2');
  // Scoped to the time-baselines section: other settings on this tab have their own Save.
  await baselinesSection(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(baselinesSection(page).getByText('Saved.', { exact: true })).toBeVisible();
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
  await expect(baselinesSection(page).getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Recount the last 90 days with these numbers' })).toHaveCount(0);
});

test('settings agents: reps cannot see the Agents tab', async ({ page, loginAs, markTodaySeen, agentsSeed }) => {
  expect(agentsSeed.stormTodayTaskId).toBeTruthy();
  await loginAs(page, 'rep');
  await markTodaySeen('rep@a.test');
  await page.goto('/settings');
  const settings = page.getByRole('main', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('link', { name: 'Agents', exact: true })).toHaveCount(0);
  await expect(settings.getByRole('tab', { name: 'Agents', exact: true })).toHaveCount(0);
  await page.goto('/settings/agents');
  await expect(page.getByText('How we count time saved')).toHaveCount(0);
});
