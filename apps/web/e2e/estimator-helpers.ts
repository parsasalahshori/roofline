import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The fake geocoder places an address by a hash of its text; this one lands inside a footprint of the NE
 * fixture (footprints-ne.json), so the measurement finds an outline and goes straight to a proposal.
 */
export const OMAHA_ADDRESS = '22074 Farnam St, Omaha, NE 68102';

export type SentProposal = { proposalId: string; taskId: string; link: string };

/**
 * The page is already signed in as the owner. Types the address, fills the new customer, presses Make proposal
 * (counted), approves the text on the review screen (counted), and returns the proposal id, the task id and the
 * homeowner path (`/p/<token>`). Typing and reading never go through `click`.
 */
export async function makeAndSendProposal(
  page: Page,
  click: (locator: Locator) => Promise<void>,
): Promise<SentProposal> {
  await page.goto('/estimator');
  await page.getByLabel('Address', { exact: true }).fill(OMAHA_ADDRESS);
  await page.getByLabel('Address', { exact: true }).press('Enter');

  await page.getByLabel('Name', { exact: true }).fill('Dana Homeowner');
  await page.getByLabel('Phone', { exact: true }).fill('4025550142');
  await page.getByLabel('They asked for this proposal by text').check();

  const sent = page.waitForResponse(
    (r) => /\/api\/proposals\/[^/]+\/send$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST',
    { timeout: 45_000 },
  );
  await click(page.getByRole('button', { name: 'Make proposal' }));
  const response = await sent;
  const proposalId = /\/api\/proposals\/([^/]+)\/send$/.exec(new URL(response.url()).pathname)?.[1] ?? '';
  const { taskId } = (await response.json()) as { taskId: string };
  expect(proposalId).not.toBe('');

  await expect(page).toHaveURL(new RegExp('/approvals/' + taskId + '$'), { timeout: 15_000 });
  // The review shows each enabled option's total, labelled by its tier, before the owner approves.
  await expect(page.getByText(/Good \$[\d,]+ · Better \$[\d,]+ · Best \$[\d,]+/)).toBeVisible();
  await click(page.getByRole('button', { name: /^Approve 1 step/ }));
  await expect(page.getByRole('dialog').getByRole('list').getByText('Done', { exact: true })).toHaveCount(1, {
    timeout: 20_000,
  });

  // The same address the Copy link button writes to the clipboard.
  const linkResponse = await page.request.get(`/api/proposals/${proposalId}/link`);
  expect(linkResponse.status()).toBe(200);
  const { url } = (await linkResponse.json()) as { url: string };
  const link = new URL(url).pathname;
  expect(link.startsWith('/p/')).toBe(true);
  return { proposalId, taskId, link };
}

// Default Better template name, from packages/shared/src/tiers.ts.
export const BETTER_NAME = 'Architectural + protection';
