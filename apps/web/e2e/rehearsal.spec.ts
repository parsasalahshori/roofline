/* eslint-disable no-empty-pattern -- Playwright reads the `{}` pattern of a hook with no fixtures. */
import type { Page } from '@playwright/test';
import type pg from 'pg';
import { agentPage as agentsCopy, agentsCommon, agentsWindow } from '../src/copy/agents.ts';
import { appointments as appointmentsCopy } from '../src/copy/appointments.ts';
import { claims as claimsCopy } from '../src/copy/claims.ts';
import { create } from '../src/copy/create.ts';
import { WINDOW_COPY } from '../src/copy/dock.ts';
import { conversationCopy } from '../src/copy/front-desk-conversation.ts';
import { frontDeskInbox } from '../src/copy/front-desk-inbox.ts';
import { job } from '../src/copy/job.ts';
import { mapCopy } from '../src/copy/map.ts';
import { measure } from '../src/copy/measure.ts';
import { storm } from '../src/copy/storm.ts';
import { test, expect, readStack } from './fixtures.ts';
import { BETTER_NAME, makeAndSendProposal } from './estimator-helpers.ts';
import { draftAndApproveStormPlan, waitForStormSteps } from './fixtures.ts';
import {
  checkScreen,
  expectCleanBrowser,
  makeItDaytime,
  setUpFrontDesk,
  signInViaUi,
  simulateInboundCall,
  simulateInboundText,
  watchBrowser,
  type BrowserTrouble,
  type ScreenLog,
} from './rehearsal-helpers.ts';

/*
 * Launch dress rehearsal (desktop). The core owner journeys end to end through the real UI, on the
 * fake providers. Every test also checks that no visited screen says "coming soon" and that the
 * browser logged no errors (soft checks, so a journey goes on and every problem is reported).
 * Findings: ops/sdd/integration/dress-rehearsal.md. Run:
 *   cd apps/web && npx playwright test e2e/rehearsal.spec.ts --project=desktop
 */

const OWNER = 'owner@a.test';

/** The Omaha address the fake geocoder drops inside a fixture footprint (estimator-helpers OMAHA_ADDRESS), in parts. */
const HOME = { street: '22074 Farnam St', city: 'Omaha', state: 'NE', zip: '68102' };

let trouble: BrowserTrouble;
let screens: ScreenLog;

test.beforeEach(({ context }) => {
  trouble = watchBrowser(context);
  screens = [];
});

test.afterEach(async ({}, testInfo) => {
  await testInfo.attach('screens.json', { body: JSON.stringify(screens, null, 2), contentType: 'application/json' });
  await expectCleanBrowser(trouble, testInfo);
});

/** Opens one app from the dock and waits for its window. */
async function openFromDock(page: Page, title: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Apps' }).getByRole('link', { name: title, exact: false }).click();
  await expect(page.getByRole('dialog', { name: title, exact: true }).first()).toBeVisible({ timeout: 15_000 });
}

/** New customer (with a home and a phone) through the search box, then New job from their window. Returns the ids. */
async function addCustomerAndJob(page: Page, name: { first: string; last: string }, phone: string, home: typeof HOME = HOME) {
  // The top bar's Search button (My day may have opened itself on the first sign-in of the day)
  await page.getByRole('banner').getByRole('button', { name: 'Search', exact: true }).click();
  const search = page.getByRole('dialog', { name: 'Search' });
  await expect(search).toBeVisible();
  await search.getByRole('combobox').fill('new customer');
  await search.getByRole('option', { name: new RegExp(`^${create.newCustomer.title}`) }).first().click();
  await expect(page).toHaveURL(/\/customers\/new$/);
  await checkScreen(page, screens);

  await page.getByLabel(create.newCustomer.firstName, { exact: true }).fill(name.first);
  await page.getByLabel(create.newCustomer.lastName, { exact: true }).fill(name.last);
  await page.getByLabel(create.newCustomer.phone, { exact: true }).first().fill(phone);
  await page.getByLabel(create.address.street).fill(home.street);
  await page.getByLabel(create.address.city).fill(home.city);
  await page.getByLabel(create.address.state, { exact: true }).selectOption(home.state);
  await page.getByLabel(create.address.zip).fill(home.zip);
  const consent = page.getByLabel(create.newCustomer.textConsent);
  if (await consent.count()) await consent.check();
  await page.getByRole('button', { name: create.newCustomer.save, exact: true }).click();

  await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const customerId = /\/customers\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
  const customerWindow = page.getByRole('dialog').first();
  await expect(customerWindow.getByText(`${name.first} ${name.last}`).first()).toBeVisible();
  await checkScreen(page, screens);

  // Customer -> New job (the customer and their home are already picked)
  await page.getByRole('group', { name: 'Customer actions' }).getByRole('link', { name: 'New job', exact: true }).click();
  await expect(page).toHaveURL(/\/jobs\/new\?customerId=/);
  await checkScreen(page, screens);
  await page.getByRole('button', { name: create.newJob.submit, exact: true }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const jobId = /\/jobs\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
  return { customerId, jobId };
}

test('a. a new roofer signs up and lands on Setup', async ({ page }) => {
  await page.goto('/sign-up');
  await checkScreen(page, screens);
  await page.getByLabel('Your name', { exact: true }).fill('Riley Rehearsal');
  await page.getByLabel('Email', { exact: true }).fill(`rehearsal-${Date.now()}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Company name').fill('Rehearsal Roofing');
  await page.getByLabel('Business phone').fill('(402) 555-0166');
  await page.getByLabel('Business address').fill('1200 Farnam St, Omaha, NE 68102');
  await page.getByRole('button', { name: 'Start my free trial' }).click();

  await expect(page).toHaveURL(/\/settings\/setup$/, { timeout: 20_000 });
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Your company on the map' })).toContainText('Done');
  await checkScreen(page, screens);

  // The new company's empty apps open from the dock
  for (const app of ['storm', 'front-desk', 'estimator', 'jobs', 'calendar', 'agents'] as const) {
    await openFromDock(page, WINDOW_COPY[app].title);
    await page.waitForLoadState('networkidle');
    await checkScreen(page, screens);
  }
});

test('b. CRM: sign in, add a customer and a job, and the windows link to each other', async ({ page }) => {
  await signInViaUi(page, OWNER);
  await expect(page.getByText('Map showing 70 customers and 25 open jobs.')).toBeAttached({ timeout: 20_000 });
  await checkScreen(page, screens);
  // BUG-1 (S1): the hail layer's fill-color is rejected by MapLibre, the map fires 'error' and the home map
  // shows its error banner (the e2e build uses the blank style: no tiles are fetched, so nothing else fails).
  await page.waitForTimeout(2_000);
  if ((await page.getByText(mapCopy.error).count()) > 0) {
    test.info().annotations.push({ type: 'known-bug', description: `BUG-1 (S1): home map shows "${mapCopy.error}"` });
  }
  const { customerId, jobId } = await addCustomerAndJob(page, { first: 'Rae', last: 'Rehearsal' }, '4025550188');

  // Job window: the customer link and the timeline
  const jobWindow = page.getByRole('dialog').first();
  await expect(jobWindow.getByRole('group', { name: job.stepperLabel })).toBeVisible();
  await expect(jobWindow.getByRole('list', { name: 'Timeline' })).toBeVisible();
  await checkScreen(page, screens);
  await jobWindow.getByRole('link', { name: 'Rae Rehearsal', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/customers/${customerId}$`));

  // Customer window lists the job and links back to it
  const back = page.getByRole('dialog').first().locator(`a[href="/jobs/${jobId}"]`).first();
  await expect(back).toBeVisible({ timeout: 15_000 });
  await checkScreen(page, screens);
  await back.click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}$`));

  // The job is on the board, and the board links to it
  await openFromDock(page, WINDOW_COPY.jobs.title);
  const card = page.getByRole('region', { name: 'Pipeline board' }).locator(`a[href="/jobs/${jobId}"]`);
  await expect(card).toHaveCount(1);
  await checkScreen(page, screens);
  await card.click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}$`));
});

test('c. Estimator: measure the job’s roof, send the proposal, the homeowner signs', async ({ page, browser, db }) => {
  test.setTimeout(150_000);
  await signInViaUi(page, OWNER);
  const { jobId } = await addCustomerAndJob(page, { first: 'Dana', last: 'Estimate' }, '4025550142');

  // Job -> New proposal -> the measure window
  await page.getByRole('button', { name: job.newProposal, exact: true }).click();
  await expect(page).toHaveURL(/\/estimator\/measure\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  const make = page.getByRole('button', { name: measure.makeProposal, exact: true });
  await expect(make).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByText(measure.squares).first()).toBeVisible();
  await checkScreen(page, screens);

  // Make proposal -> the review of the send step
  await makeItDaytime(db);
  await make.click();
  await expect(page).toHaveURL(/\/approvals\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await expect(page.getByText(/Good \$[\d,]+ · Better \$[\d,]+ · Best \$[\d,]+/)).toBeVisible();
  await checkScreen(page, screens);
  await page.getByRole('button', { name: /^Approve 1 step/ }).click();
  await expect(page.getByRole('dialog').getByRole('list').getByText('Done', { exact: true })).toHaveCount(1, { timeout: 30_000 });

  // Job -> its proposal row -> the proposal window says Sent
  await page.goto(`/jobs/${jobId}`);
  const row = page.getByRole('dialog').first().locator('a[href^="/estimator/proposals/"]').first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await checkScreen(page, screens);
  await row.click();
  await expect(page).toHaveURL(/\/estimator\/proposals\/[0-9a-f-]{36}$/);
  const proposalId = /\/estimator\/proposals\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
  await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await checkScreen(page, screens);

  // The homeowner opens the link (the one Copy link copies) in a fresh browser and signs
  const linkResponse = await page.request.get(`/api/proposals/${proposalId}/link`);
  expect(linkResponse.status()).toBe(200);
  const link = new URL(((await linkResponse.json()) as { url: string }).url).pathname;
  const homeContext = await browser.newContext({ baseURL: readStack().baseUrl });
  const homeTrouble = watchBrowser(homeContext);
  try {
    const home = await homeContext.newPage();
    await home.goto(link);
    await expect(home.getByRole('heading', { level: 1 })).toContainText('proposal');
    await checkScreen(home, screens);
    const better = home.getByRole('region', { name: BETTER_NAME });
    await better.getByRole('button', { name: `Choose ${BETTER_NAME}`, exact: true }).click();
    const sheet = home.getByRole('dialog', { name: 'Sign your proposal' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('checkbox').check();
    await sheet.getByLabel('Your full name').fill('Dana Estimate');
    await sheet.getByRole('button', { name: /^Sign and accept/ }).click();
    await expect(home.getByRole('heading', { name: 'Thank you, your proposal is signed' })).toBeVisible({ timeout: 20_000 });
    await checkScreen(home, screens);
  } finally {
    trouble.console.push(...homeTrouble.console.map((l) => `[homeowner] ${l}`));
    trouble.pageErrors.push(...homeTrouble.pageErrors.map((l) => `[homeowner] ${l}`));
    trouble.serverErrors.push(...homeTrouble.serverErrors.map((l) => `[homeowner] ${l}`));
    await homeContext.close();
  }

  // Back in the office: the job is Won
  await page.goto(`/jobs/${jobId}`);
  await expect(page.getByRole('dialog').first().getByRole('group', { name: job.stepperLabel }).getByRole('button', { name: 'Won', exact: true }))
    .toHaveAttribute('aria-current', /step|true/, { timeout: 20_000 });
  await checkScreen(page, screens);
});

test('d. Storm Scout: see the storm, draft a plan, approve it, see results', async ({ page, scenario }) => {
  test.setTimeout(120_000);
  await signInViaUi(page, OWNER);
  await openFromDock(page, WINDOW_COPY.storm.title);
  await checkScreen(page, screens);

  // Storm list -> the fixture storm
  await page.locator(`a[href="/storm/${scenario.companyStormId}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/storm/${scenario.companyStormId}$`));
  const planCard = page.getByRole('region', { name: storm.planHeadingDetail });
  await expect(planCard).toBeVisible({ timeout: 15_000 });
  await checkScreen(page, screens);

  // Draft a plan from the storm, then the storm links to the plan
  await planCard.getByRole('button', { name: storm.redraft, exact: true }).click();
  const open = planCard.getByRole('link', { name: storm.openPlan, exact: true });
  await expect(open).toBeVisible({ timeout: 20_000 });
  await open.click();
  await expect(page).toHaveURL(/\/storm\/plans\/[0-9a-f-]{36}$/);
  const taskId = /\/storm\/plans\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
  await checkScreen(page, screens);
  await page.getByRole('button', { name: /^Approve \d+ steps/ }).click();
  await expect(page.getByRole('dialog').getByRole('list').getByText('Done', { exact: true })).toHaveCount(5, { timeout: 60_000 });

  // Results on the storm; the storm still links to the (now running or finished) plan
  await page.goto(`/storm/${scenario.companyStormId}`);
  await expect(page.getByRole('heading', { name: storm.resultsHeading })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`a[href="/storm/plans/${taskId}"]`).first()).toBeVisible();
  await checkScreen(page, screens);

  // The Agents feed records the plan (feed rows link only to open drafts, by design: agents-feed.ts feedHref)
  await page.goto('/agents/feed');
  const feed = page.getByRole('list', { name: 'What your agents did' });
  await expect(feed.getByRole('listitem').filter({ hasText: /^Storm Scout.*Finished: Storm plan/ }).first()).toBeVisible({ timeout: 15_000 });
  await checkScreen(page, screens);
});

test('e1. Front Desk: an inbound text shows up and is answered', async ({ page, db, scenario }) => {
  test.setTimeout(120_000);
  const token = await setUpFrontDesk(db, scenario.a.companyId);
  await makeItDaytime(db);
  await signInViaUi(page, OWNER);

  // A text from someone new
  const texter = '+14025550177';
  await simulateInboundText(page.request, token, texter, 'Hi, I think hail hit my roof last night.');
  await openFromDock(page, WINDOW_COPY['front-desk'].title);
  const textRow = page.getByRole('dialog').first().getByRole('link').filter({ hasText: frontDeskInbox.channel.sms }).first();
  await expect(textRow).toBeVisible({ timeout: 20_000 });
  await checkScreen(page, screens);
  await textRow.click();
  await expect(page).toHaveURL(/\/front-desk\/[0-9a-f-]{36}$/);
  // The conversation shows turns, which the debounced fd-text job writes (FD_TEXT_DEBOUNCE_SECONDS = 20),
  // and the open window does not refresh itself (BUG-3): reload until the job has run.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Hi, I think hail hit my roof last night.')).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 75_000, intervals: [5_000] });
  // The assistant answers (the fake model's default line)
  await expect(page.getByText('Sorry, could you say that again?')).toBeVisible();
  await checkScreen(page, screens);
});

// BUG-4 / BUG-5 (D1): a call's conversation never gets its call row (calls.conversation_id is never
// written), so the after-call summary never runs and the transcript reads "removed after the retention
// period"; calls.transcript_stored is never set true either. The call row itself does show up.
test('e2. Front Desk: an inbound call shows up with what was said and a summary', async ({ page, db, scenario }) => {
  test.fail(true, 'BUG-4/BUG-5 (D1): call not linked to its conversation; transcript hidden, no summary');
  test.setTimeout(120_000);
  const token = await setUpFrontDesk(db, scenario.a.companyId);
  await makeItDaytime(db);
  await signInViaUi(page, OWNER);

  const call = await simulateInboundCall(page.request, token, '+14025550178', 'I need someone to look at my roof.');
  expect(call.assistant.length).toBeGreaterThan(0);
  await openFromDock(page, WINDOW_COPY['front-desk'].title);
  const callRow = page.getByRole('dialog').first().getByRole('link').filter({ hasText: frontDeskInbox.channel.voice }).first();
  await expect(callRow).toBeVisible({ timeout: 30_000 });
  await checkScreen(page, screens);

  // Evidence for the findings: the call row as the API left it once the after-call job had time to run (5 s delay)
  await page.waitForTimeout(12_000);
  const { rows } = await db.query<{ conversation_id: string | null; transcript_stored: boolean; status: string }>(
    `select conversation_id, transcript_stored, status from calls where call_sid = $1`,
    [call.callSid],
  );
  test.info().annotations.push({ type: 'evidence', description: `calls row after the call: ${JSON.stringify(rows[0])}` });

  await callRow.click();
  await expect(page).toHaveURL(/\/front-desk\/[0-9a-f-]{36}$/);
  await checkScreen(page, screens);
  await expect(page.getByText('I need someone to look at my roof.')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(conversationCopy.summaryNone)).toHaveCount(0);
});

test('f. Agents: the work done shows as tasks and minutes saved', async ({ page, db, scenario, click }) => {
  test.setTimeout(150_000);
  await signInViaUi(page, OWNER);
  // One Estimator task and one Storm Scout task, finished today
  await makeAndSendProposal(page, click);
  const { taskId } = await draftAndApproveStormPlan(page, scenario.companyStormId);
  await waitForStormSteps(page, taskId);
  void db;

  await openFromDock(page, WINDOW_COPY.agents.title);
  const grid = page.getByRole('region', { name: 'Your agents' });
  await expect(grid).toBeVisible({ timeout: 15_000 });
  const cardOf = (name: string) => grid.locator('a', { has: page.getByRole('heading', { name }) });
  for (const name of ['Storm Scout', 'Estimator']) {
    const card = cardOf(name);
    await expect(card.locator('p', { hasText: agentsWindow.finishedToday }).locator('span').nth(1)).toHaveText(/^[1-9]\d*$/);
    await expect(card.locator('p', { hasText: agentsWindow.timeSaved })).toContainText(/about/);
  }
  const totals = page.getByText(agentsWindow.totalsSaved).first();
  await expect(totals).toContainText(/about/i);
  await expect(totals).not.toContainText(/about 0 hours/);
  await checkScreen(page, screens);

  // Card -> agent page, and the feed shows both tasks
  await cardOf('Estimator').click();
  await expect(page).toHaveURL(/\/agents\/estimator$/);
  await checkScreen(page, screens);
  await page.goto('/agents/feed');
  const feed = page.getByRole('list', { name: 'What your agents did' });
  await expect(feed.getByRole('listitem').filter({ hasText: 'Storm Scout' }).first()).toBeVisible({ timeout: 15_000 });
  await expect(feed.getByRole('listitem').filter({ hasText: 'Estimator' }).first()).toBeVisible();
  await checkScreen(page, screens);
  await page.goto('/agents/waiting');
  await expect(page.getByLabel('Waiting', { exact: true })).toBeVisible({ timeout: 15_000 });
  await checkScreen(page, screens);
});

/** The newest task of `agent` and `kind` for the company, polled until the worker has made it (empty string while none). */
async function newestTask(db: pg.Client, companyId: string, agent: string, kind: string): Promise<string> {
  let taskId = '';
  await expect
    .poll(
      async () => {
        const found = await db.query<{ id: string }>(
          `select id from agent_tasks where company_id = $1 and agent = $2 and kind = $3 order by created_at desc limit 1`,
          [companyId, agent, kind],
        );
        taskId = found.rows[0]?.id ?? '';
        return taskId;
      },
      { timeout: 60_000, intervals: [1_000, 2_000] },
    )
    .not.toBe('');
  return taskId;
}

/** On the agent's page: Turn on (through the rules sheet), then its Run now button. */
async function turnOnAndRun(page: Page, slug: string, title: string, runLabel: string): Promise<void> {
  await page.goto(`/agents/${slug}`);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible({ timeout: 20_000 });
  await checkScreen(page, screens);
  await page.getByRole('button', { name: agentsCopy.turnOnButton, exact: true }).click();
  const sheet = page.getByRole('dialog', { name: agentsCopy.turnOnTitle });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(agentsCopy.turnOnIntro)).toBeVisible();
  await sheet.getByRole('button', { name: agentsCopy.turnOnConfirm, exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Paused' })).not.toBeChecked();
  await page.getByRole('button', { name: runLabel, exact: true }).click();
  await expect(page.getByText(agentsCopy.runNowAgain)).toBeVisible({ timeout: 15_000 });
}

/** From the Waiting list, open the task's review and approve every step; waits for every step to be Done. */
async function approveFromWaiting(page: Page, taskId: string): Promise<void> {
  await page.goto('/agents/waiting');
  const open = page.getByLabel('Waiting', { exact: true }).locator(`a[href="/approvals/${taskId}"]`);
  await expect(open).toBeVisible({ timeout: 15_000 });
  await checkScreen(page, screens);
  await open.click();
  await expect(page).toHaveURL(new RegExp(`/approvals/${taskId}$`));
  const approve = page.getByRole('button', { name: /^Approve \d+ steps?/ });
  await expect(approve).toBeVisible({ timeout: 20_000 });
  await checkScreen(page, screens);
  const steps = Number(/^Approve (\d+)/.exec((await approve.textContent()) ?? '')?.[1] ?? '1');
  await approve.click();
  await expect(page.getByRole('dialog').getByRole('list').getByText('Done', { exact: true })).toHaveCount(steps, {
    timeout: 30_000,
  });
}

test('g. Claims, Scheduler and Follow-up each fire once and show their tasks', async ({ page, db, scenario }) => {
  test.setTimeout(240_000);
  const companyId = scenario.a.companyId;
  await makeItDaytime(db);
  await signInViaUi(page, OWNER);

  // The three cards are real agents now: paused, with Turn on, and not "Coming soon"
  await openFromDock(page, WINDOW_COPY.agents.title);
  const grid = page.getByRole('region', { name: 'Your agents' });
  await expect(grid).toBeVisible({ timeout: 15_000 });
  const cardOf = (name: string) => grid.locator('a', { has: page.getByRole('heading', { name, exact: true }) });
  for (const name of ['Claims', 'Scheduler', 'Follow-up']) {
    await expect(cardOf(name)).toContainText(agentsWindow.status.paused, { timeout: 15_000 });
    await expect(cardOf(name)).not.toContainText(agentsWindow.status.coming_soon);
  }
  await checkScreen(page, screens);

  // --- Claims: a job with a claim the owner marked Filed (UI); the claim was filed 6 days ago (DB: no UI for time) ---
  const claimJob = await addCustomerAndJob(page, { first: 'Cora', last: 'Claimant' }, '4025550161', { ...HOME, street: '400 Claim Ct' });
  await page.getByRole('button', { name: claimsCopy.addDetails, exact: true }).click();
  const claimForm = page.getByRole('dialog', { name: claimsCopy.formTitle });
  await claimForm.getByLabel(claimsCopy.insurerLabel).fill('Prairie Mutual');
  await claimForm.getByLabel(claimsCopy.claimNumberLabel).fill('CL-50101');
  await claimForm.getByLabel(claimsCopy.statusLabel, { exact: true }).selectOption({ label: claimsCopy.status.filed });
  await claimForm.getByRole('button', { name: claimsCopy.save, exact: true }).click();
  await expect(claimForm).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText('CL-50101').first()).toBeVisible();
  await checkScreen(page, screens);
  const filed = await db.query(
    `update claims set status_changed_at = now() - interval '6 days', created_at = now() - interval '6 days' where job_id = $1 and status = 'filed'`,
    [claimJob.jobId],
  );
  expect(filed.rowCount, 'the claim saved from the job window, as Filed').toBe(1);

  // --- Scheduler: an inspection booked for tomorrow from the job window (UI) ---
  const visitJob = await addCustomerAndJob(page, { first: 'Sal', last: 'Schedule' }, '4025550162', { ...HOME, street: '500 Visit Way' });
  const tomorrow = (
    await db.query<{ day: string }>(`select to_char((now() at time zone timezone)::date + 1, 'YYYY-MM-DD') as day from companies where id = $1`, [companyId])
  ).rows[0]!.day;
  await page.getByRole('link', { name: job.bookInspection, exact: true }).click();
  await expect(page).toHaveURL(/\/calendar\/new\?/);
  await checkScreen(page, screens);
  await page.getByLabel(appointmentsCopy.dateLabel, { exact: true }).fill(tomorrow);
  await page.getByLabel(appointmentsCopy.timeLabel, { exact: true }).fill('10:00');
  await page.getByRole('button', { name: appointmentsCopy.save, exact: true }).click();
  await expect(page).toHaveURL(/\/calendar\/appointments\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  await checkScreen(page, screens);
  void visitJob;

  // --- Follow-up: a new lead (UI) that has waited 10 days with no visit (DB: no UI for time) ---
  const leadJob = await addCustomerAndJob(page, { first: 'Fay', last: 'Followup' }, '4025550163', { ...HOME, street: '600 Lead Ln' });
  await db.query(
    `update jobs set created_at = now() - interval '10 days', stage_changed_at = now() - interval '10 days', updated_at = now() - interval '10 days' where id = $1`,
    [leadJob.jobId],
  );

  // Each agent: Turn on, Run now, its plan appears in Waiting, the owner approves it, the texts go out
  const runs = [
    { slug: 'claims', title: 'Claims', agent: 'claims', kind: 'claims_nudges', run: agentsCopy.runNowLabels.claims },
    { slug: 'scheduler', title: 'Scheduler', agent: 'scheduler', kind: 'reminders', run: agentsCopy.runNowLabels.scheduler },
    { slug: 'follow-up', title: 'Follow-up', agent: 'follow_up', kind: 'follow_ups', run: agentsCopy.runNowLabels.follow_up },
  ] as const;
  const tasks: Record<string, string> = {};
  for (const r of runs) {
    await turnOnAndRun(page, r.slug, r.title, r.run);
    tasks[r.agent] = await newestTask(db, companyId, r.agent, r.kind);
    await approveFromWaiting(page, tasks[r.agent]!);
  }

  // The texts reached the fake SMS for the three customers made above
  const sent = await db.query<{ n: string }>(
    `select count(distinct m.customer_id)::text as n from messages m join customers c on c.id = m.customer_id
      where m.company_id = $1 and m.direction = 'out' and m.status in ('sent', 'scheduled', 'delivered')
        and c.display_name in ('Cora Claimant', 'Sal Schedule', 'Fay Followup')`,
    [companyId],
  );
  expect(Number(sent.rows[0]!.n), 'customers texted by the three plans').toBe(3);

  // Agents window: each card is On, finished a task today and counts time saved
  const savedLines: Record<string, string> = {};
  await page.goto('/agents');
  await expect(grid).toBeVisible({ timeout: 15_000 });
  for (const name of ['Claims', 'Scheduler', 'Follow-up']) {
    const card = cardOf(name);
    await expect(card).not.toContainText(agentsWindow.status.coming_soon);
    await expect(card.locator('p', { hasText: agentsWindow.finishedToday }).locator('span').nth(1)).toHaveText(/^[1-9]\d*$/, { timeout: 15_000 });
    // A few texts are minutes of work: the line reads "less than half an hour", never zero
    const saved = card.locator('p', { hasText: agentsWindow.timeSaved });
    await expect(saved).toContainText(/less than half an hour|about [1-9][\d.]* hours?|about 0\.5 hours/);
    await expect(saved).toContainText(agentsCommon.estimate);
    savedLines[name] = (await saved.innerText()).replace(/\s+/g, ' ');
  }
  test.info().annotations.push({ type: 'evidence', description: `time saved lines: ${JSON.stringify(savedLines)}` });
  await checkScreen(page, screens);

  // Each agent page lists its task under Recent work, Done, with its time saved
  for (const r of runs) {
    await page.goto(`/agents/${r.slug}`);
    await expect(page.getByRole('heading', { name: r.title, exact: true })).toBeVisible({ timeout: 15_000 });
    const recent = page.locator('section', { has: page.getByRole('heading', { name: agentsCopy.recentTitle }) }).getByRole('listitem');
    const row = recent.filter({ hasText: 'Done' }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText(agentsCommon.estimate);
    const kindText = ((await row.locator('span').first().textContent()) ?? '').trim();
    // BUG-6 (A1/G1): TASK_KIND_LABEL has no G1 kinds, so the row shows the raw kind ("claims nudges", "reminders", "follow ups")
    test.info().annotations.push({ type: 'evidence', description: `/agents/${r.slug} Recent work kind text: "${kindText}"` });
    if (kindText.toLowerCase() === r.kind.replace(/_/g, ' ')) {
      test.info().annotations.push({ type: 'known-bug', description: `BUG-6 (G1): /agents/${r.slug} Recent work shows the raw kind "${kindText}"` });
    }
    await checkScreen(page, screens);
  }
  await page.goto('/agents/feed');
  const feed = page.getByRole('list', { name: 'What your agents did' });
  for (const name of ['Claims', 'Scheduler', 'Follow-up']) {
    await expect(feed.getByRole('listitem').filter({ hasText: name }).first()).toBeVisible({ timeout: 15_000 });
  }
  await checkScreen(page, screens);
});

test('h. Front Desk follow-ups: listed once on Waiting, and the card count matches', async ({ page, db, scenario }) => {
  test.setTimeout(120_000);
  const token = await setUpFrontDesk(db, scenario.a.companyId);
  await makeItDaytime(db);
  await signInViaUi(page, OWNER);

  // A customer and job with a next step (UI)
  const { customerId, jobId } = await addCustomerAndJob(page, { first: 'Mo', last: 'Message' }, '4025550164', { ...HOME, street: '700 Note St' });
  await page.getByRole('button', { name: job.edit, exact: true }).click();
  const sheet = page.getByRole('dialog', { name: job.editTitle });
  await sheet.getByLabel(job.nextStepFieldLabel, { exact: true }).fill('Call back about the leak');
  await sheet.getByRole('button', { name: job.save, exact: true }).click();
  await expect(sheet).toHaveCount(0, { timeout: 15_000 });

  // The customer texts in (real webhook); Front Desk's outcome for it is "took a message" (DB: the outcome is set
  // by the after-call/after-text summary, which the fake model does not produce for texts)
  await simulateInboundText(page.request, token, '+14025550164', 'Please have someone call me back about the leak.');
  await expect
    .poll(async () => (await db.query(`select 1 from conversations where customer_id = $1`, [customerId])).rowCount, { timeout: 15_000 })
    .toBe(1);
  await db.query(`update conversations set outcome = 'message' where customer_id = $1`, [customerId]);

  await page.goto('/agents/waiting');
  const waiting = page.getByLabel('Waiting', { exact: true });
  await expect(waiting).toBeVisible({ timeout: 15_000 });
  const fdRows = waiting.getByRole('listitem').filter({ hasText: /^Front Desk/ });
  await expect(fdRows.filter({ hasText: 'Call back about the leak' })).toHaveCount(1, { timeout: 15_000 });
  await expect(fdRows.filter({ hasText: 'Call back about the leak' }).locator(`a[href="/jobs/${jobId}"]`)).toHaveCount(1);
  const listed = await fdRows.count();
  await checkScreen(page, screens);

  await page.goto('/agents');
  const fdCard = page.getByRole('region', { name: 'Your agents' }).locator('a', { has: page.getByRole('heading', { name: 'Front Desk', exact: true }) });
  await expect(fdCard).toContainText(`${agentsWindow.waiting} ${listed}`, { timeout: 15_000 });
  await checkScreen(page, screens);
});
