import { test, expect } from './fixtures.ts';

/** The customers screens on a desktop: the new customer form's layout and what its labels say. */
test('the new customer form puts city, state and ZIP on one row and its add buttons on the field edge', async ({
  page,
  loginAs,
  markTodaySeen,
}) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/customers/new');
  await expect(page.getByLabel('Name to show')).toBeVisible({ timeout: 20_000 });

  // Wide enough: city, state and ZIP share one row (the same top edge, left to right)
  const city = (await page.getByLabel('City').boundingBox())!;
  const state = (await page.getByRole('button', { name: /^State/ }).boundingBox())!;
  const zip = (await page.getByLabel('ZIP code').boundingBox())!;
  expect(Math.abs(city.y - zip.y)).toBeLessThan(2);
  expect(Math.abs(city.y - state.y)).toBeLessThan(2);
  expect(city.x).toBeLessThan(state.x);
  expect(state.x).toBeLessThan(zip.x);

  // The plus of each add button starts where its field starts, not one button padding inside
  for (const [field, add] of [
    ['Phone (optional)', 'Add another phone'],
    ['Email (optional)', 'Add another email'],
  ] as const) {
    const fieldBox = (await page.getByLabel(field).boundingBox())!;
    const plus = (await page.getByRole('button', { name: add }).locator('svg').boundingBox())!;
    expect(Math.abs(plus.x - fieldBox.x)).toBeLessThan(1.5);
  }

  // The one field that is needed is not marked optional, and the optional ones say so
  await expect(page.getByLabel('Name to show')).toBeVisible();
  await expect(page.getByLabel('First name (optional)')).toBeVisible();
  await expect(page.getByLabel('Last name (optional)')).toBeVisible();
});

test('a customer who has no tags gets no Tags column, and one with a tag brings it back', async ({
  page,
  loginAs,
  markTodaySeen,
  db,
  scenario,
}) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await db.query(`update customers set tags = '{}' where company_id = $1`, [scenario.a.companyId]);
  await page.goto('/customers');
  const table = page.getByRole('table', { name: 'Customers' });
  await expect(table).toBeVisible({ timeout: 20_000 });
  await expect(table.getByRole('columnheader', { name: 'Texting' })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'Tags' })).toHaveCount(0);

  const first = await db.query<{ id: string }>(`select id from customers where company_id = $1 order by display_name limit 1`, [
    scenario.a.companyId,
  ]);
  await db.query(`update customers set tags = array['hail'] where id = $1`, [first.rows[0]!.id]);
  await page.goto('/customers');
  await expect(page.getByRole('table', { name: 'Customers' }).getByRole('columnheader', { name: 'Tags' })).toBeVisible({
    timeout: 20_000,
  });
});
