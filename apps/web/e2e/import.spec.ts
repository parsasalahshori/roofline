import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.ts';

/** F3 Task 36: the customer import, start to finish: upload, mapping, preview, consent, summary, skipped rows. */
test('import a spreadsheet, with consent, and download the skipped rows', async ({ page, loginAs, markTodaySeen }) => {
  test.setTimeout(90_000);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/settings/setup/import');

  await page
    .getByLabel('Customer spreadsheet')
    .setInputFiles(fileURLToPath(new URL('./fixtures/customers-25.csv', import.meta.url)));

  await expect(page.getByText('Match your columns')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  await expect(page.getByText('20 new customers')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('5 will be skipped')).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Import', exact: true }).click();

  await expect(page.getByText('Import finished')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('20 new customers added')).toBeVisible();
  await expect(page.getByText('5 rows skipped')).toBeVisible();

  // The download control is an anchor with reloadDocument, so the browser downloads the file.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByText('Download skipped rows').click(),
  ]);
  expect(download.suggestedFilename()).toBe('skipped-rows.csv');
  const lines = readFileSync(await download.path(), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  expect(lines).toHaveLength(6);
});
