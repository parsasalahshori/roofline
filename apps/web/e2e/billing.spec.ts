import { test, expect, setCompanyStatus } from './fixtures.ts';

/** F3 Task 36: the banners under the top bar and the read-only message on a save. */
test('trial ended: banner, read-only message on a save', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await setCompanyStatus('trial_ended');
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Pick a plan to keep going' })).toBeVisible({ timeout: 20_000 });

  await page.goto('/settings/company');
  const phone = page.getByLabel('Phone', { exact: true });
  await expect(phone).toBeVisible();
  await phone.fill('(402) 555-0199');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByText('Your free trial has ended, so Roofline is read-only for now. Pick a plan to keep going.'),
  ).toBeVisible({ timeout: 15_000 });
});

test('past due: the payment banner', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await setCompanyStatus('past_due');
  await page.goto('/');
  await expect(
    page.getByText("Your payment didn't go through. Texts and calls are paused until it's fixed."),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Fix payment', { exact: true })).toBeVisible();
});
