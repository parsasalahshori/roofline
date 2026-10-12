import { test, expect } from './fixtures.ts';

/*
 * Sign-up: a new roofer goes from the public page to the map with Setup open, with no card asked
 * for. Fields are found by their visible labels; banners by their text.
 */

test('a new roofer reaches the map with Setup open in under 2 minutes, no card', async ({ page }) => {
  test.setTimeout(60_000);
  const start = Date.now();
  await page.goto('/sign-up');

  await page.getByLabel('Your name', { exact: true }).fill('Pat Tester');
  await page.getByLabel('Email', { exact: true }).fill(`signup-${Date.now()}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Continue' }).click();

  // The company step is exactly three fields
  await expect(page.getByRole('textbox')).toHaveCount(3);
  await page.getByLabel('Company name').fill('Acme Test Roofing');
  await page.getByLabel('Business phone').fill('(402) 555-0177');
  await page.getByLabel('Business address').fill('1200 Farnam St, Omaha, NE 68102');
  await page.getByRole('button', { name: 'Start my free trial' }).click();

  await expect(page).toHaveURL(/\/settings\/setup$/);
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  const basics = page.getByRole('listitem').filter({ hasText: 'Your company on the map' });
  await expect(basics).toContainText('Done');
  expect(Date.now() - start).toBeLessThan(120_000);
  await expect(page.getByText(/card number/i)).toHaveCount(0);
});
