import { test, expect } from './fixtures.ts';
import { makeAndSendProposal } from './estimator-helpers.ts';

/*
 * Measure (the Estimator app) end to end: a typed address to a sent proposal in three clicks, and the owner approving the
 * spend for an exact roof report. EagleView completion and re-pricing are proven by integration tests (Ruling 8).
 */

test('typed address to sent in 3 clicks', async ({ page, loginAs, markTodaySeen, click, clicks }) => {
  test.setTimeout(60_000);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');

  // Measure a new roof (the scan plays by itself), Send proposal, then Approve on the review screen (which shows the three
  // tier totals and ends in Done).
  const sent = await makeAndSendProposal(page, click);
  expect(clicks.count).toBeLessThanOrEqual(3);
  expect(sent.link.startsWith('/p/')).toBe(true);

  // The fake text adapter took the text: the proposal now reads Sent.
  await page.goto('/estimator/proposals/' + sent.proposalId);
  await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();
});

test('exact report: owner approves the spend', async ({ page, loginAs, markTodaySeen, click }) => {
  test.setTimeout(60_000);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const sent = await makeAndSendProposal(page, click);

  // The measure view of the proposal's measurement asks for the exact report.
  const proposal = await page.request.get('/api/proposals/' + sent.proposalId);
  expect(proposal.status()).toBe(200);
  const { measurementId } = (await proposal.json()) as { measurementId: string };
  await page.goto('/estimator/measure/' + measurementId);
  await page.getByRole('button', { name: /Order EagleView report/ }).click();
  await page.getByRole('button', { name: 'Request EagleView report' }).click();
  await page.getByRole('link', { name: 'Waiting for your OK' }).click();

  // The owner sees the most it can cost and approves it.
  await expect(page).toHaveURL(/\/approvals\//);
  await expect(page.getByText(/^Up to \$[\d,]+$/)).toBeVisible();
  await page.getByRole('button', { name: /^Approve 1 step · up to \$[\d,]+$/ }).click();

  // The order is placed and parks while the report is made. The step reads "Working on it".
  await expect(page.getByRole('dialog').getByRole('list').getByText('Working on it', { exact: true })).toHaveCount(1, {
    timeout: 20_000,
  });
});
