import type { Page } from '@playwright/test';
import { test, expect, readStack } from './fixtures.ts';
import { makeAndSendProposal, BETTER_NAME } from './estimator-helpers.ts';

/*
 * The homeowner's side of a proposal: the public page /p/<token>, opened in a fresh browser context
 * (no cookies, no shell) at phone size. The Playwright config runs only phone.spec in the `phone`
 * project, so this file sets the phone viewport itself and runs in the `desktop` project.
 */
test.use({ viewport: { width: 375, height: 812 } });

/** Fails when the page is wider than the phone screen, so something scrolls sideways. */
async function noSideScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
}

const DOLLARS = /\$[\d,]+/;

test('the homeowner signs with the keyboard only', async ({ page, browser, loginAs, markTodaySeen, click }) => {
  test.setTimeout(120_000);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const sent = await makeAndSendProposal(page, click);
  expect(sent.link).toMatch(/^\/p\//);

  const context = await browser.newContext({
    baseURL: readStack().baseUrl,
    viewport: { width: 375, height: 812 },
  });
  try {
    const home = await context.newPage();
    await home.goto(sent.link);
    await expect(home.getByRole('heading', { level: 1 })).toContainText('proposal');
    await noSideScroll(home);

    const better = home.getByRole('region', { name: BETTER_NAME });
    await expect(better).toBeVisible();
    const total = (await better.getByText(DOLLARS).first().innerText()).match(DOLLARS)?.[0];
    expect(total).toBeTruthy();

    // Choose the option and sign without a pointer: focus, Tab, Space and Enter only. Better is the tile that is picked when the
    // page opens; its button says the tier and the one all-in price.
    const choose = better.getByRole('button', { name: `Choose Better \u00b7 ${total}`, exact: true });
    await choose.focus();
    await home.keyboard.press('Enter');

    const sheet = home.getByRole('dialog', { name: 'Sign your proposal' });
    await expect(sheet).toBeVisible();
    const submit = sheet.getByRole('button', { name: new RegExp(`^Sign and accept \\${total}$`) });
    await expect(submit).toBeVisible();

    // The sheet reads: the name, then the drawing's Clear, then the one consent, then the main button.
    const name = sheet.getByLabel('Your full name');
    await name.focus();
    await home.keyboard.type('Pat Homeowner');
    await home.keyboard.press('Tab');
    await expect(sheet.getByRole('button', { name: 'Clear' })).toBeFocused();
    await home.keyboard.press('Tab');
    const consent = sheet.getByRole('checkbox');
    await expect(consent).toBeFocused();
    await home.keyboard.press('Space');
    await expect(consent).toBeChecked();
    await home.keyboard.press('Tab');
    await expect(submit).toBeFocused();
    await home.keyboard.press('Enter');

    await expect(home.getByRole('heading', { name: 'Thank you, your proposal is signed' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(home.getByText(/Signed by Pat Homeowner/)).toBeVisible();
    // The signed copy may still be preparing: either the download link or the waiting line shows.
    await expect(
      home.getByRole('link', { name: 'Download your signed copy' }).or(home.getByText('Your signed copy is being prepared.')),
    ).toBeVisible();
    await noSideScroll(home);

    // The owner's job is now Won, with the chosen option's value.
    await page.goto('/jobs');
    await expect(page.locator('[data-stage="won"]').filter({ hasText: total! }).first()).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    await context.close();
  }
});
