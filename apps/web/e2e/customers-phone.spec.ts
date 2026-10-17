import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';

/*
 * The customers screens on a phone (the file name puts it in the `phone` project, 375x812): with a tag, an email and a
 * name as long as the forms allow, nothing runs out of its panel or off the screen. A tag is up to 40 characters with no
 * break in it; the kit's tag is a single line that never shrinks, which used to push it out of the Contact panel.
 */
const LONG_TAG = 'a'.repeat(40);
const LONG_EMAIL = `${'b'.repeat(50)}@${'c'.repeat(40)}.example`;

/** Fails when the page is wider than the phone screen, so something scrolls sideways. */
async function noSideScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
}

test('a long tag and a long email stay inside the customer page and the list', async ({ page, loginAs, markTodaySeen, db, scenario }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const customer = await db.query<{ id: string }>(`select id from customers where company_id = $1 order by id limit 1`, [
    scenario.a.companyId,
  ]);
  const id = customer.rows[0]!.id;
  await db.query(`update customers set tags = $2, emails = $3::jsonb, display_name = $4 where id = $1`, [
    id,
    [LONG_TAG],
    JSON.stringify([LONG_EMAIL]),
    'Maximilian-Alexander Featherstonehaugh-Montgomery',
  ]);

  // The customer page: the tag and the email end inside the Contact panel, which ends inside the screen
  await page.goto(`/customers/${id}`);
  const contact = page.getByRole('region', { name: 'Contact', exact: true });
  await expect(contact).toBeVisible({ timeout: 20_000 });
  const tag = contact.getByText(LONG_TAG);
  const email = contact.getByRole('link', { name: LONG_EMAIL });
  await expect(tag).toBeVisible();
  await expect(email).toBeVisible();
  const panelBox = (await contact.boundingBox())!;
  for (const box of [(await tag.boundingBox())!, (await email.boundingBox())!]) {
    expect(box.x + box.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 0.5);
  }
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(375);
  await noSideScroll(page);

  // The list: the card shows the tag, wrapped inside the card and the screen
  await page.goto('/customers');
  const listedTag = page.getByRole('list', { name: 'Customers' }).getByText(LONG_TAG);
  await expect(listedTag).toBeVisible({ timeout: 20_000 });
  const listed = (await listedTag.boundingBox())!;
  expect(listed.x + listed.width).toBeLessThanOrEqual(375);
  await noSideScroll(page);
});

test('the new customer form fits the phone, says what is optional and stacks the address', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/customers/new');
  await expect(page.getByLabel('Name to show')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel('Phone (optional)')).toBeVisible();
  await expect(page.getByLabel('Email (optional)')).toBeVisible();
  await noSideScroll(page);

  // On a phone city, state and ZIP stack one under another
  const city = (await page.getByLabel('City').boundingBox())!;
  const zip = (await page.getByLabel('ZIP code').boundingBox())!;
  expect(zip.y).toBeGreaterThan(city.y + city.height);
});
