/* eslint-disable no-empty-pattern -- Playwright reads the `{}` pattern of a hook with no fixtures. */
import type { Page } from '@playwright/test';
import { create } from '../src/copy/create.ts';
import { frontDeskInbox } from '../src/copy/front-desk-inbox.ts';
import { job } from '../src/copy/job.ts';
import { measure } from '../src/copy/measure.ts';
import { storm } from '../src/copy/storm.ts';
import { test, expect } from './fixtures.ts';
import {
  checkScreen,
  expectCleanBrowser,
  makeItDaytime,
  setUpFrontDesk,
  signInViaUi,
  simulateInboundText,
  watchBrowser,
  type BrowserTrouble,
  type ScreenLog,
} from './rehearsal-helpers.ts';

/*
 * Launch dress rehearsal, phone variant (the `phone` project matches *phone.spec): the key owner
 * screens at 375px, reached through the bottom tabs and the More sheet. Same checks as the desktop
 * file: no "coming soon", no browser errors, no sideways scroll.
 *   cd apps/web && npx playwright test e2e/rehearsal.phone.spec.ts --project=phone
 */

const OWNER = 'owner@a.test';
const HOME = { street: '22074 Farnam St', city: 'Omaha', state: 'NE', zip: '68102' };

let trouble: BrowserTrouble;
let screens: ScreenLog;

test.beforeEach(({ context }) => {
  trouble = watchBrowser(context);
  screens = [];
});

test.afterEach(async ({}, testInfo) => {
  await testInfo.attach('screens.json', { body: JSON.stringify(screens, null, 2), contentType: 'application/json' });
  await expectCleanBrowser(trouble, testInfo);
});

async function noSideScroll(page: Page): Promise<void> {
  expect.soft(await page.evaluate(() => document.documentElement.scrollWidth), `side scroll on ${page.url()}`).toBeLessThanOrEqual(375);
}

/** Checks the screen for "coming soon" and sideways scroll. */
async function look(page: Page): Promise<void> {
  await checkScreen(page, screens);
  await noSideScroll(page);
}

/** Opens an app from the More sheet. */
async function openFromMore(page: Page, name: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'More', exact: true }).click();
  const more = page.getByRole('dialog', { name: 'More', exact: true });
  await expect(more).toBeVisible();
  await more.getByRole('link', { name, exact: true }).click();
  await expect(more).toHaveCount(0);
}

test('phone: CRM and Estimator, customer to job to sent proposal', async ({ page, db }) => {
  test.setTimeout(120_000);
  await signInViaUi(page, OWNER);
  await look(page);

  await page.goto('/customers/new');
  await page.getByLabel(create.newCustomer.firstName, { exact: true }).fill('Pia');
  await page.getByLabel(create.newCustomer.lastName, { exact: true }).fill('Phone');
  await page.getByLabel(create.newCustomer.phone, { exact: true }).first().fill('4025550191');
  await page.getByLabel(create.address.street).fill(HOME.street);
  await page.getByLabel(create.address.city).fill(HOME.city);
  await page.getByLabel(create.address.state, { exact: true }).selectOption(HOME.state);
  await page.getByLabel(create.address.zip).fill(HOME.zip);
  const consent = page.getByLabel(create.newCustomer.textConsent);
  if (await consent.count()) await consent.check();
  await look(page);
  await page.getByRole('button', { name: create.newCustomer.save, exact: true }).click();
  await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  await expect(page.getByRole('group', { name: 'Customer actions' })).toBeVisible();
  await look(page);

  await page.getByRole('group', { name: 'Customer actions' }).getByRole('link', { name: 'New job', exact: true }).click();
  await page.getByRole('button', { name: create.newJob.submit, exact: true }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const jobId = /\/jobs\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
  await expect(page.getByRole('group', { name: job.stepperLabel })).toBeVisible();
  await look(page);

  // The Jobs tab shows the board with the new job
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Jobs', exact: true }).click();
  await expect(page.locator(`a[href="/jobs/${jobId}"]`).first()).toBeAttached({ timeout: 15_000 });
  await look(page);

  await page.goto(`/jobs/${jobId}`);
  await page.getByRole('button', { name: job.newProposal, exact: true }).click();
  await expect(page).toHaveURL(/\/estimator\/measure\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  const make = page.getByRole('button', { name: measure.makeProposal, exact: true });
  await expect(make).toBeEnabled({ timeout: 30_000 });
  await look(page);
  await makeItDaytime(db);
  await make.click();
  await expect(page).toHaveURL(/\/approvals\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await look(page);
  await page.getByRole('button', { name: /^Approve 1 step/ }).click();
  await expect(page.getByRole('dialog').getByRole('list').getByText('Done', { exact: true })).toHaveCount(1, { timeout: 30_000 });

  await page.goto(`/jobs/${jobId}`);
  const row = page.locator('a[href^="/estimator/proposals/"]').first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await look(page);
});

test('phone: Storm, Front Desk and Agents from the More sheet', async ({ page, db, scenario }) => {
  test.setTimeout(120_000);
  const token = await setUpFrontDesk(db, scenario.a.companyId);
  await makeItDaytime(db);
  await signInViaUi(page, OWNER);

  // Storm: the list, the storm, draft a plan
  await openFromMore(page, 'Storm');
  await expect(page.getByRole('region', { name: 'Storms in your area' })).toBeVisible({ timeout: 15_000 });
  await look(page);
  await page.locator(`a[href="/storm/${scenario.companyStormId}"]`).first().click();
  const planCard = page.getByRole('region', { name: storm.planHeadingDetail });
  await expect(planCard).toBeVisible({ timeout: 15_000 });
  await planCard.getByRole('button', { name: storm.redraft, exact: true }).click();
  await expect(planCard.getByRole('link', { name: storm.openPlan, exact: true })).toBeVisible({ timeout: 20_000 });
  await look(page);
  await planCard.getByRole('link', { name: storm.openPlan, exact: true }).click();
  await expect(page.getByRole('button', { name: /^Approve \d+ steps/ })).toBeVisible({ timeout: 15_000 });
  await look(page);

  // Front Desk: an inbound text shows up in the inbox
  await simulateInboundText(page.request, token, '+14025550179', 'Do you do gutters too?');
  await openFromMore(page, 'Front Desk');
  const textRow = page.getByRole('link').filter({ hasText: frontDeskInbox.channel.sms }).first();
  await expect(textRow).toBeVisible({ timeout: 20_000 });
  await look(page);
  await textRow.click();
  // Turns are written by the debounced fd-text job and the open window does not refresh (BUG-3): reload.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Do you do gutters too?')).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 75_000, intervals: [5_000] });
  await look(page);

  // Agents overview, feed and waiting
  await openFromMore(page, 'Agents');
  await expect(page.getByRole('heading', { name: 'Your agents' })).toBeAttached({ timeout: 15_000 });
  await look(page);
  for (const path of ['/agents/feed', '/agents/waiting', '/settings/agents', '/settings/front-desk']) {
    await page.goto(path);
    await expect(page.getByRole('dialog').first()).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState('networkidle');
    await look(page);
  }
});
