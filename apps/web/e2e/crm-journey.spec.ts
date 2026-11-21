import { createHash } from 'node:crypto';
import { chooseOption, expect, test } from './fixtures.ts';

/*
 * The CRM journey, start to finish, as a new roofer: sign up, confirm the email, finish the setup items that fakes can
 * finish (customer import, card, texting registration), add a customer, a home and a job, move the job through its
 * stages with a note, book an install for today, see it on the calendar and on Today, invite a teammate, and sign in as
 * that teammate to see the same job.
 *
 * The links in emails are not readable from here (the database keeps only a hash of each token), so the test swaps the
 * stored hash for the hash of a token it chose and opens that link: the pages and the server's checks are the real ones.
 */

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
/** A token is 43 characters of base64url. */
const VERIFY_TOKEN = 'verify-crm-journey-'.padEnd(43, 'v');
const INVITE_TOKEN = 'invite-crm-journey-'.padEnd(43, 'i');

const OWNER_EMAIL = 'journey-owner@example.test';
const MATE_EMAIL = 'journey-office@example.test';
const MATE_PASSWORD = 'office-password-12345';

const CUSTOMERS_CSV = [
  'First Name,Last Name,Phone,Email,Address,City,State,Zip',
  'Ada,Lovelace,402-555-0101,ada@example.test,10 Elm St,Omaha,NE,68102',
  'Grace,Hopper,402-555-0102,grace@example.test,11 Oak St,Omaha,NE,68103',
  'Bad,Row,notaphone,notanemail,,,,',
].join('\n');

/** Today's date in Chicago, the zone a new company starts with, as YYYY-MM-DD. */
function todayInChicago(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
}

test('a new roofer runs the CRM from sign-up to a teammate seeing the job', async ({ page, browser, db }) => {
  test.setTimeout(180_000);

  // ---- Sign up: three fields, then the free trial opens on the setup page
  await page.goto('/sign-up');
  await page.getByLabel('Your name', { exact: true }).fill('Jo Journey');
  await page.getByLabel('Email', { exact: true }).fill(OWNER_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Company name').fill('Journey Roofing');
  await page.getByLabel('Business phone').fill('(402) 555-0177');
  await page.getByLabel('Business address').fill('1200 Farnam St, Omaha, NE 68102');
  await page.getByRole('button', { name: 'Start my free trial' }).click();
  await expect(page).toHaveURL(/\/settings\/setup$/);
  const checklist = page.getByRole('main', { name: 'Settings' });
  await expect(checklist.getByText('1 of 5 setup steps done')).toBeVisible();

  // ---- Confirm the email (the checkout below needs it)
  await db.query(
    `update user_tokens set token_hash = $1 where kind = 'verify_email' and user_id = (select id from users where email = $2)`,
    [sha256(VERIFY_TOKEN), OWNER_EMAIL],
  );
  await page.goto(`/verify?token=${VERIFY_TOKEN}`);
  await expect(page.getByText('Your email is confirmed.')).toBeVisible();

  // ---- Setup: bring in customers from a spreadsheet
  await page.goto('/settings/setup/import');
  await page.getByLabel('Customer spreadsheet').setInputFiles({ name: 'customers.csv', mimeType: 'text/csv', buffer: Buffer.from(CUSTOMERS_CSV) });
  await expect(page.getByText('Match your columns')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('2 new customers')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('1 will be skipped')).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText('Import finished')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('2 new customers added')).toBeVisible();

  // ---- Setup: add a card. The payment provider is a fake that finishes the checkout at once and comes back here.
  await page.goto('/settings/billing');
  await page.getByRole('button', { name: 'Pick this plan' }).first().click();
  await expect(page).toHaveURL(/\/settings\/billing/);
  await expect(page.getByText('Active', { exact: true })).toBeVisible({ timeout: 20_000 });

  // ---- Setup: register for texting (the carrier is a fake; the request is sent and waits for approval)
  await page.goto('/settings/setup/texting');
  await page.getByLabel('Legal business name', { exact: true }).fill('Journey Roofing LLC');
  await page.getByLabel('EIN', { exact: true }).fill('12-3456789');
  await chooseOption(page, 'Business type', 'LLC');
  await page.getByLabel('Street', { exact: true }).fill('1200 Farnam St');
  await page.getByLabel('City', { exact: true }).fill('Omaha');
  await page.getByLabel('ZIP', { exact: true }).fill('68102');
  await page.getByLabel('Website', { exact: true }).fill('https://journey.example.test');
  await page.getByLabel('Contact first name', { exact: true }).fill('Jo');
  await page.getByLabel('Contact last name', { exact: true }).fill('Journey');
  await page.getByLabel('Contact email', { exact: true }).fill(OWNER_EMAIL);
  await page.getByLabel('Contact phone', { exact: true }).fill('4025550177');
  await page.getByLabel('Contact job title', { exact: true }).fill('Owner');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Send to the phone carriers' }).click();
  await expect(page.getByText('Waiting on phone carriers')).toBeVisible({ timeout: 20_000 });

  // ---- A customer with a home, then a job on it
  await page.goto('/customers/new');
  await page.getByLabel('First name (optional)').fill('Pat');
  await page.getByLabel('Last name (optional)').fill('Homeowner');
  await page.getByLabel('Phone (optional)').fill('(402) 555-0142');
  await page.getByLabel('Email (optional)').fill('pat@example.test');
  await page.getByRole('button', { name: 'Save customer' }).click();
  await expect(page).toHaveURL(/\/customers\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { name: 'Pat Homeowner' })).toBeVisible();

  await page.getByRole('link', { name: 'Add a home' }).click();
  const homeSheet = page.getByRole('dialog', { name: 'Add a home' });
  await homeSheet.getByLabel('Street address').fill('1200 Farnam St');
  await homeSheet.getByLabel('City').fill('Omaha');
  await chooseOption(homeSheet, 'State', 'Nebraska');
  await homeSheet.getByLabel('ZIP code').fill('68102');
  await homeSheet.getByRole('button', { name: 'Save home' }).click();
  await expect(page.getByText('1200 Farnam St, Omaha, NE 68102')).toBeVisible();

  await page.getByRole('link', { name: 'New job' }).first().click();
  await page.getByLabel('Value in dollars').fill('12500');
  await page.getByRole('button', { name: 'Create job' }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]+$/);
  const jobUrl = page.url();

  // ---- A note, then the stages in order; a reload keeps them
  await page.getByLabel('Add a note', { exact: true }).fill('Called Pat, roof inspection set for Monday.');
  await page.getByRole('button', { name: 'Add note', exact: true }).click();
  await expect(page.getByText('Called Pat, roof inspection set for Monday.')).toBeVisible();
  const stages = page.getByRole('group', { name: 'Job stage' });
  for (const stage of ['Inspection', 'Proposal', 'Won']) {
    await stages.getByRole('button', { name: stage, exact: true }).click();
    await expect(page.getByText(`Moved to ${stage}`, { exact: false }).first()).toBeVisible();
  }
  await page.reload();
  await expect(stages.getByRole('button', { name: 'Won', exact: true })).toHaveAttribute('aria-current', 'step');
  await expect(page.getByText('Moved to Won').first()).toBeVisible();
  await expect(page.getByText('Called Pat, roof inspection set for Monday.')).toBeVisible();

  // ---- Book the install for today; it shows on the job, the calendar and Today
  await page.getByRole('link', { name: 'Book install' }).click();
  const today = todayInChicago();
  await page.getByLabel('Start date').fill(today);
  await page.getByLabel('End date').fill(today);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/calendar\/appointments\/[0-9a-f-]+$/);
  await expect(page.getByText('Scheduled', { exact: true })).toBeVisible();

  await page.goto('/calendar');
  await expect(page.getByRole('main').getByText('Pat Homeowner').first()).toBeVisible({ timeout: 20_000 });
  await page.goto('/today');
  await expect(page.getByText('1 visit', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Pat Homeowner').first()).toBeVisible();

  // ---- Invite a teammate as office staff; the pending invite shows
  await page.goto('/settings/team');
  await page.getByLabel('Their email').fill(MATE_EMAIL);
  await chooseOption(page, 'Their role', 'Office');
  await page.getByRole('button', { name: 'Send invite' }).click();
  await expect(page.getByText('Waiting to join')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(MATE_EMAIL).first()).toBeVisible();

  // ---- The teammate opens the link, joins, and sees the same job
  await db.query(`update invites set token_hash = $1 where email = $2 and accepted_at is null`, [sha256(INVITE_TOKEN), MATE_EMAIL]);
  const mateContext = await browser.newContext({ baseURL: page.url().split('/settings')[0] });
  const mate = await mateContext.newPage();
  await mate.goto(`/invite?token=${INVITE_TOKEN}`);
  await mate.getByLabel('Your name', { exact: true }).fill('Olive Office');
  await mate.getByLabel('Password', { exact: true }).fill(MATE_PASSWORD);
  await mate.getByRole('button', { name: 'Join the team' }).click();
  await expect(mate).toHaveURL(/\/(today)?$/, { timeout: 20_000 });
  await mate.goto(jobUrl);
  await expect(mate.getByRole('heading', { name: 'Pat Homeowner' })).toBeVisible({ timeout: 20_000 });
  await expect(mate.getByText('Called Pat, roof inspection set for Monday.')).toBeVisible();

  // ---- Signing in again as the teammate lands on the same job
  await mate.getByRole('button', { name: /Olive Office/ }).click();
  await mate.getByRole('menuitem', { name: /sign out/i }).or(mate.getByRole('button', { name: /sign out/i })).first().click();
  await expect(mate).toHaveURL(/\/sign-in/);
  await mate.goto(`/sign-in?next=${encodeURIComponent(new URL(jobUrl).pathname)}`);
  await mate.getByLabel('Email', { exact: true }).fill(MATE_EMAIL);
  await mate.getByLabel('Password', { exact: true }).fill(MATE_PASSWORD);
  await mate.getByRole('button', { name: /sign in/i }).first().click();
  await expect(mate).toHaveURL(new RegExp(`${new URL(jobUrl).pathname}$`), { timeout: 20_000 });
  await expect(mate.getByRole('heading', { name: 'Pat Homeowner' })).toBeVisible();
  await mateContext.close();

  // ---- Back as the owner: four of the five setup items are done; texting waits on the carriers, which only a person can speed up
  await page.goto('/settings/setup');
  await expect(checklist.getByText('4 of 5 setup steps done')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('listitem').filter({ hasText: 'Register for texting' })).toContainText('Waiting');
});
