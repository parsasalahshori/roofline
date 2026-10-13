import { expect, type Locator, type Page } from '@playwright/test';
import pg from 'pg';
import { readStack } from './fixtures.ts';

/**
 * The fake geocoder places an address by a hash of its text; this one lands inside a footprint of the NE
 * fixture (footprints-ne.json), so the measurement finds an outline and goes straight to a proposal.
 */
export const OMAHA_ADDRESS = '22074 Farnam St, Omaha, NE 68102';

/** Real place names (a fixed offset is not accepted as a customer's zone), spread around the clock. */
const PLACES = [
  'Pacific/Honolulu', 'America/Anchorage', 'America/Los_Angeles', 'America/Denver', 'America/Chicago',
  'America/New_York', 'America/Halifax', 'America/Sao_Paulo', 'Atlantic/Azores', 'Europe/London',
  'Europe/Berlin', 'Europe/Athens', 'Europe/Moscow', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Dhaka',
  'Asia/Bangkok', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
];

/** A place where it is between 10:00 and 17:00 right now. */
function daytimePlace(): string {
  const hourIn = (zone: string) =>
    Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  return PLACES.find((zone) => hourIn(zone) >= 10 && hourIn(zone) <= 17) ?? 'America/Chicago';
}

/**
 * The text gate holds a text outside 8:00 to 21:00 in the customer's zone, and CI runs at any hour. This puts the
 * company and its properties in a place where it is daytime now, so the proposal text goes out at once.
 */
async function makeItDaytime(): Promise<void> {
  const zone = daytimePlace();
  const client = new pg.Client({ connectionString: readStack().ownerUrl });
  await client.connect();
  try {
    await client.query('update companies set timezone = $1', [zone]);
    await client.query('update properties set timezone = $1', [zone]);
  } finally {
    await client.end();
  }
}

export type SentProposal = { proposalId: string; taskId: string; link: string };

/**
 * The page is already signed in as the owner. Types the address in the Measure window's search, presses "Measure a new
 * roof at" and "Measure roof" (counted), fills the new customer, presses Send proposal (counted), approves the text on
 * the review screen (counted), and returns the proposal id, the task id and the homeowner path (`/p/<token>`).
 * Typing and reading never go through `click`.
 */
export async function makeAndSendProposal(
  page: Page,
  click: (locator: Locator) => Promise<void>,
): Promise<SentProposal> {
  await page.goto('/estimator');
  // /estimator opens the Measure window; the search takes any address, and one no request matches offers to measure it.
  // On a phone /estimator opens the first request's roof: the search is on the Requests step.
  const search = page.getByRole('searchbox', { name: 'Search name or address' });
  const requestsStep = page.getByRole('tab', { name: /Requests/ });
  await expect(search.or(requestsStep).first()).toBeVisible({ timeout: 20_000 });
  if (!(await search.isVisible())) await requestsStep.click();
  await search.fill(OMAHA_ADDRESS);
  // /estimator may already show a first request; wait for the new roof's own page before pressing its Measure roof
  const created = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/measurements' && r.request().method() === 'POST');
  await click(page.getByRole('button', { name: 'Measure a new roof at ' + OMAHA_ADDRESS }));
  const { id } = (await (await created).json()) as { id: string };
  await expect(page).toHaveURL(new RegExp(`/estimator/measure/${id}$`), { timeout: 30_000 });
  await click(page.getByRole('button', { name: 'Measure roof' }));
  // On a phone the proposal is its own step: open it once the roof is measured (not counted: a desktop shows it beside the roof)
  const proposalStep = page.getByRole('tab', { name: /Proposal/ });
  if (await proposalStep.isVisible().catch(() => false)) {
    await expect(proposalStep).toBeEnabled({ timeout: 20_000 });
    await proposalStep.click();
  }

  await page.getByLabel('Name', { exact: true }).fill('Dana Homeowner');
  await page.getByLabel('Phone', { exact: true }).fill('4025550142');
  await page.getByLabel('They asked for this proposal by text').check();

  const sent = page.waitForResponse(
    (r) => /\/api\/proposals\/[^/]+\/send$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST',
    { timeout: 45_000 },
  );
  await click(page.getByRole('button', { name: 'Send proposal' }));
  const response = await sent;
  const proposalId = /\/api\/proposals\/([^/]+)\/send$/.exec(new URL(response.url()).pathname)?.[1] ?? '';
  const { taskId } = (await response.json()) as { taskId: string };
  expect(proposalId).not.toBe('');

  await expect(page).toHaveURL(new RegExp('/approvals/' + taskId + '$'), { timeout: 15_000 });
  // The review shows each enabled option's total, labelled by its tier, before the owner approves.
  await expect(page.getByText(/Good \$[\d,]+ · Better \$[\d,]+ · Best \$[\d,]+/)).toBeVisible();
  await makeItDaytime();
  await click(page.getByRole('button', { name: /^Approve 1 step/ }));
  try {
    await expect(page.getByRole('dialog').getByRole('list').getByText('Done', { exact: true })).toHaveCount(1, {
      timeout: 20_000,
    });
  } catch (err) {
    // Say what the review window showed, so a held or failed text is named in the CI log.
    const shown = await page.getByRole('dialog').innerText().catch(() => '(no dialog)');
    throw new Error(`The send step did not finish. The window said: ${shown.replace(/\s+/g, ' ')}`, { cause: err });
  }

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
