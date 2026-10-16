import type { Page } from '@playwright/test';
import { test, expect, companyHostUrl, draftAndApproveStormPlan, stormPageCode, waitForStormSteps } from './fixtures.ts';

/*
 * Storm Scout on a phone (375x812, the `phone` project): a rep marks a door "Wants a check" and the
 * lead lands on Today, and a homeowner sends an inspection request from the landing page on the
 * company host. The plan is drafted and approved through the API as the owner; its routes step
 * builds the routes (assigned to the active reps, so the rep user has one) and its ad step creates
 * the landing page. A Lead from a door is assigned to the rep and a Lead from the landing page is
 * unassigned, so both show on the REP's Today (an owner's Today lists only jobs assigned to or
 * created by the owner).
 */

/** Fails when the page is wider than the phone screen, so something scrolls sideways. */
async function noSideScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
}

test('rep marks a door Wants a check and the lead reaches the rep Today', async ({
  page,
  loginAs,
  markTodaySeen,
  scenario,
  db,
}) => {
  test.setTimeout(90_000);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const { taskId } = await draftAndApproveStormPlan(page, scenario.companyStormId);
  await waitForStormSteps(page, taskId);

  // The routes belong to the company's reps (the owner takes the doors only when there is no rep).
  await loginAs(page, 'rep');
  await markTodaySeen('rep@a.test');
  await page.goto('/storm/routes');
  const routeLink = page.getByRole('link', { name: /, 0 of \d+ doors$/ }).first();
  await expect(routeLink).toBeVisible({ timeout: 20_000 });
  await routeLink.click();

  await expect(page.getByRole('heading', { name: 'Doors in order' })).toBeVisible();
  await noSideScroll(page);

  await page.getByRole('button', { name: 'Wants a check', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Wants a check' });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel('Name', { exact: true }).fill('Pat Door');
  await sheet.getByLabel('Phone', { exact: true }).fill('4025550142');
  await sheet.getByLabel('OK to text about this').check();
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(sheet).toHaveCount(0);
  await expect(page.getByText('Done', { exact: true }).first()).toBeVisible();

  // The Lead job carries the storm id and the customer name.
  const lead = await db.query<{ stage: string }>(
    `select j.stage from jobs j join customers c on c.id = j.customer_id
      where j.company_id = $1 and j.storm_id = $2 and c.display_name = 'Pat Door'`,
    [scenario.a.companyId, scenario.stormId],
  );
  expect(lead.rows.map((r) => r.stage)).toEqual(['lead']);

  // The follow-up is on the Today of the rep who knocked.
  await page.goto('/today');
  const today = page.getByRole('main', { name: 'My day' });
  await expect(today).toBeVisible();
  await expect(today.getByText('Pat Door')).toBeVisible();
});

test('landing page on a phone submits a request', async ({ page, loginAs, markTodaySeen, scenario, db }) => {
  test.setTimeout(90_000);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const { taskId } = await draftAndApproveStormPlan(page, scenario.companyStormId);
  await waitForStormSteps(page, taskId);
  const code = await stormPageCode(db, scenario.companyStormId);

  await page.goto(companyHostUrl('/storm/' + code));
  await expect(page.getByRole('button', { name: 'Request a free inspection' })).toBeVisible();
  await noSideScroll(page);

  await page.getByLabel('Name', { exact: true }).fill('Lee Landing');
  await page.getByLabel('Mobile phone').fill('4025550143');
  await page.getByLabel('Address of the home to inspect').fill('7421 Cedar Ridge Dr, Omaha, NE 68114');
  await page.getByRole('button', { name: 'Request a free inspection' }).click();

  await expect(page).toHaveURL(new RegExp('/storm/' + code + '/thanks$'));
  await expect(page.getByRole('heading', { name: 'Thanks, we got your request' })).toBeVisible();
  await noSideScroll(page);

  const lead = await db.query<{ stage: string }>(
    `select j.stage from jobs j join customers c on c.id = j.customer_id
      where j.company_id = $1 and j.storm_id = $2 and c.display_name = 'Lee Landing'`,
    [scenario.a.companyId, scenario.stormId],
  );
  expect(lead.rows.map((r) => r.stage)).toEqual(['lead']);

  // An unassigned Lead is on the rep's Today.
  await loginAs(page, 'rep');
  await markTodaySeen('rep@a.test');
  await page.goto('/today');
  const today = page.getByRole('main', { name: 'My day' });
  await expect(today).toBeVisible();
  await expect(today.getByText('Lee Landing')).toBeVisible();
});
