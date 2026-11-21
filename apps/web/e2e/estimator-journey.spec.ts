import { test, expect, readStack } from './fixtures.ts';
import { makeItDaytime, OMAHA_ADDRESS } from './estimator-helpers.ts';

/*
 * The estimator's whole journey on the e2e stack, in one walk: search an address, measure it, leave one roof section out
 * (the totals and prices fall), add the customer, make and send the proposal (the owner approves the text), open the
 * homeowner's page as the customer, pick an option and sign, and read the signed PDF and the job as the owner afterwards.
 * Fakes supply the roof, the text and the clock-free parts; nothing leaves the machine.
 */

const DOLLARS = /\$[\d,]+/;

test('estimator journey: address to measured roof, a section left out, proposal sent, signed by the homeowner', async ({
  page,
  browser,
  db,
  loginAs,
  markTodaySeen,
}) => {
  test.setTimeout(150_000);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');

  // 1. Search an address that has no request and measure it: the roof comes back with sections
  await page.goto('/estimator');
  await page.getByRole('searchbox', { name: 'Search name or address' }).fill(OMAHA_ADDRESS);
  await page.getByRole('button', { name: 'Measure a new roof at ' + OMAHA_ADDRESS }).click();
  await expect(page.getByRole('button', { name: 'Adjust' })).toBeVisible({ timeout: 45_000 });
  const measurementId = page.url().split('/').pop()!;
  const card = page.locator('[data-measure-card]');
  await expect(card).toContainText(/All \d+ sections in the quote/);
  const total = page.getByText(/^Total, Better/).locator('..');
  const wholeTotal = (await total.innerText()).match(DOLLARS)![0];
  const wholeSquares = (await card.innerText()).match(/([\d,.]+)\s+squares/)![1]!;

  // 2. Leave one section out: the card, the sections line and the price all change, and the save survives a reload
  await page.getByText('B', { exact: true }).first().click({ force: true });
  await expect(card).toContainText(/\d+ of \d+ sections in the quote/);
  await expect(total).not.toContainText(wholeTotal);
  const partTotal = (await total.innerText()).match(DOLLARS)![0];
  expect((await card.innerText()).match(/([\d,.]+)\s+squares/)![1]).not.toBe(wholeSquares);
  await expect.poll(async () => ((await (await page.request.get(`/api/measurements/${measurementId}`)).json()) as { excludedFacets?: string[] }).excludedFacets?.length ?? 0).toBe(1);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Adjust' })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/^Total, Better/).locator('..')).toContainText(partTotal);

  // 3. A number another customer already has is named; a new one makes the proposal
  await page.getByLabel('Name', { exact: true }).fill('Dana Homeowner');
  await page.getByLabel('Phone', { exact: true }).fill('12');
  await page.getByLabel('They asked for this proposal by text').check();
  await page.getByRole('button', { name: 'Send proposal' }).click();
  await expect(page.getByText('Enter a 10-digit phone number.')).toBeVisible();
  await page.getByLabel('Phone', { exact: true }).fill('4025550142');
  const sent = page.waitForResponse(
    (r) => /\/api\/proposals\/[^/]+\/send$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST',
    { timeout: 45_000 },
  );
  await page.getByRole('button', { name: 'Send proposal' }).click();
  const response = await sent;
  const proposalId = /\/api\/proposals\/([^/]+)\/send$/.exec(new URL(response.url()).pathname)![1]!;
  const { taskId } = (await response.json()) as { taskId: string };

  // 4. The owner approves the text: the review shows the three tier totals, then the text goes out through the fake
  await expect(page).toHaveURL(new RegExp('/approvals/' + taskId + '$'), { timeout: 15_000 });
  await expect(page.getByText(/Good \$[\d,]+ · Better \$[\d,]+ · Best \$[\d,]+/)).toBeVisible();
  await makeItDaytime();
  await page.getByRole('button', { name: /^Approve 1 step/ }).click();
  await expect(page.getByRole('main').getByRole('list').getByText('Done', { exact: true })).toHaveCount(1, { timeout: 20_000 });
  const link = new URL(((await (await page.request.get(`/api/proposals/${proposalId}/link`)).json()) as { url: string }).url).pathname;
  expect(link.startsWith('/p/')).toBe(true);

  // The proposal is priced for the sections that stayed in, and reads Sent
  await page.goto('/estimator/proposals/' + proposalId);
  await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('main')).toContainText(partTotal);

  // 5. The homeowner opens the link with no sign-in, picks Best and signs
  const context = await browser.newContext({ baseURL: readStack().baseUrl, viewport: { width: 390, height: 844 } });
  try {
    const home = await context.newPage();
    await home.goto(link);
    await expect(home.getByRole('heading', { level: 1 })).toContainText('proposal');
    await home.locator('input[name="option"]').nth(2).check({ force: true });
    const bestPrice = (await home.getByRole('button', { name: /^Choose Best/ }).innerText()).match(DOLLARS)![0];
    await home.getByRole('button', { name: /^Choose Best/ }).click();
    const sheet = home.getByRole('dialog', { name: 'Sign your proposal' });
    await sheet.getByLabel('Your full name').fill('Pat Homeowner');
    await sheet.getByRole('checkbox').check();
    await sheet.getByRole('button', { name: new RegExp(`^Sign and accept \\${bestPrice}$`) }).click();
    await expect(home.getByRole('heading', { name: 'Thank you, your proposal is signed' })).toBeVisible({ timeout: 20_000 });
    await expect(home.getByText(/Signed by Pat Homeowner/)).toBeVisible();

    // 6. The signed PDF exists (the worker makes it a moment after the signature), and survives a reload
    await home.reload();
    const download = home.getByRole('link', { name: 'Download your signed copy' });
    await expect(download).toBeVisible({ timeout: 60_000 });
    // The e2e stack's worker and API each hold their own in-memory file store, so the bytes cannot be fetched here (the
    // demo shares a directory and serves them): the stored file row of the signature, and the link on the page, are the proof.
    expect(await download.getAttribute('href')).toMatch(/\/signed\.pdf$/);
    const stored = await db.query(
      `select f.content_type, f.bytes from proposal_signatures s join stored_files f on f.id = s.pdf_file_id where s.proposal_id = $1`,
      [proposalId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].content_type).toBe('application/pdf');
    expect(Number(stored.rows[0].bytes)).toBeGreaterThan(1000);

    // 7. The owner's proposal and job show it: Signed with the chosen option, the job Won at that price
    await page.goto('/estimator/proposals/' + proposalId);
    await expect(page.getByText('Signed', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await page.goto('/jobs');
    await expect(page.locator('[data-stage="won"]').filter({ hasText: bestPrice }).first()).toBeVisible({ timeout: 20_000 });
  } finally {
    await context.close();
  }
});
