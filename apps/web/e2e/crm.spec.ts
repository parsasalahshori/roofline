import type pg from 'pg';
import { test, expect, moveJob } from './fixtures.ts';

/*
 * Core CRM, start to finish: the pipeline board, the New job form, the job window's timeline and
 * the quote. Everything runs as the owner except the last test. Windows are found by their
 * accessible name; counts are read from the column headings ("Lead (8)"), never from card totals.
 */

const NEW_JOB_COPY = 'New job';

/** The id of a job in `stage` that has no quote yet, so the first quote made on it is Q-0001. */
async function jobWithoutQuote(db: pg.Client, companyId: string, stage: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `select j.id from jobs j
      where j.company_id = $1 and j.stage = $2 and j.archived_at is null
        and not exists (select 1 from quotes q where q.job_id = j.id)
      order by j.created_at, j.id
      limit 1`,
    [companyId, stage],
  );
  const id = result.rows[0]?.id;
  expect(id).toBeTruthy();
  return id!;
}

test('the board shows the showcase pipeline', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/jobs');

  const jobsWindow = page.getByRole('main', { name: 'Jobs', exact: true });
  await expect(jobsWindow).toBeVisible();
  await expect(jobsWindow.getByRole('region', { name: 'Pipeline board' })).toBeVisible();

  for (const heading of ['Lead (8)', 'Inspection (7)', 'Proposal (6)', 'Won (4)', 'Installed (2)']) {
    await expect(jobsWindow.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  // Lost is a collapsed tab at the right of the lanes, not a lane of cards
  await expect(jobsWindow.getByRole('button', { name: 'Lost (1)', exact: true })).toBeVisible();
});

test('drag a lead to Inspection, then Lost asks why', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/jobs');
  const board = page.getByRole('region', { name: 'Pipeline board' });
  await expect(board.getByRole('heading', { name: 'Lead (8)', exact: true })).toBeVisible();

  // Drag the first Lead card onto the Inspection column
  const leadCard = board.locator('section[data-stage="lead"] div[data-stage="lead"]').first();
  await expect(leadCard).toBeVisible();
  await leadCard.getByRole('link').dragTo(board.locator('section[data-stage="inspection"]'));
  await expect(board.getByRole('heading', { name: 'Lead (7)', exact: true })).toBeVisible();
  await expect(board.getByRole('heading', { name: 'Inspection (8)', exact: true })).toBeVisible();

  // Moving a job to Lost opens the sheet that asks why; saving without a reason is refused
  const inspectionCard = board.locator('section[data-stage="inspection"] div[data-stage="inspection"]').first();
  await moveJob(inspectionCard, 'Lost');
  const sheet = page.getByRole('dialog', { name: 'Why was the job lost?' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet.getByText('Pick why the job was lost.')).toBeVisible();

  await sheet.getByLabel('Reason').selectOption('Price');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(board.getByRole('button', { name: 'Lost (2)', exact: true })).toBeVisible();
  await expect(board.getByRole('heading', { name: 'Inspection (7)', exact: true })).toBeVisible();
});

test('a new job from the map home in 2 clicks to its form', async ({ page, loginAs, markTodaySeen, click, clicks }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/');
  const before = page.getByText('Map showing 70 customers and 25 open jobs.');
  await expect(before).toBeAttached({ timeout: 20_000 });

  // The keyboard opens search (not a click); one click picks the action
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  const search = page.getByRole('dialog', { name: 'Search' });
  await expect(search).toBeVisible();
  await search.getByRole('combobox').fill('new job');
  await click(search.getByRole('option', { name: new RegExp(`^${NEW_JOB_COPY}`) }));

  await expect(page).toHaveURL(/\/jobs\/new$/);
  const form = page.getByRole('main', { name: 'Jobs', exact: true });
  await expect(form).toBeVisible();
  await expect(form.getByRole('button', { name: 'New customer', exact: true })).toBeVisible();
  expect(clicks.count).toBeLessThanOrEqual(2);

  // A new customer at a new address, saved as a Lead
  await form.getByRole('button', { name: 'New customer', exact: true }).click();
  await form.getByLabel('Name', { exact: true }).fill('Pat Newcomer');
  await form.getByLabel('Street address').fill('100 Test Lane');
  await form.getByLabel('City').fill('Omaha');
  await form.getByLabel('State', { exact: true }).selectOption('NE');
  await form.getByLabel('ZIP code').fill('68102');
  await form.getByRole('button', { name: 'Create job', exact: true }).click();

  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('main').getByText('Pat Newcomer').first()).toBeVisible();

  // Back on Home, the new customer and the new open job are pins
  await page.getByRole('navigation', { name: 'Apps' }).getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  const after = page.getByText('Map showing 71 customers and 26 open jobs.');
  await expect(after).toBeAttached({ timeout: 20_000 });
});

test('the timeline shows a note, a stage move and a quote', async ({ page, loginAs, markTodaySeen, scenario, db }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const jobId = await jobWithoutQuote(db, scenario.a.companyId, 'lead');
  await page.goto(`/jobs/${jobId}`);

  const win = page.getByRole('main').first();
  const timeline = win.getByRole('list', { name: 'Timeline' });

  // 1. A note
  const note = 'Homeowner wants the gutters done too';
  await win.getByLabel('Add a note').fill(note);
  await win.getByRole('button', { name: 'Add note', exact: true }).click();
  await expect(timeline).toContainText(note);

  // 2. A stage move
  await win.getByRole('group', { name: 'Job stage' }).getByRole('button', { name: 'Inspection', exact: true }).click();
  await expect(timeline).toContainText('Moved to Inspection');

  // 3. A quote: New quote opens it, and going back to the job shows it on the timeline
  await win.getByRole('button', { name: 'New quote', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}/quotes/[0-9a-f-]{36}$`));
  await page.goto(`/jobs/${jobId}`);

  // Newest first: the quote, then the move, then the note
  const items = page.getByRole('main').first().getByRole('list', { name: 'Timeline' }).getByRole('listitem');
  await expect(items.nth(0)).toContainText('Quote Q-0001 started');
  await expect(items.nth(1)).toContainText('Moved to Inspection');
  await expect(items.nth(2)).toContainText(note);
});

test('a quote prices, goes final and downloads a PDF', async ({ page, loginAs, markTodaySeen, scenario, db }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const jobId = await jobWithoutQuote(db, scenario.a.companyId, 'proposal');
  await page.goto(`/jobs/${jobId}`);

  await page.getByRole('button', { name: 'New quote', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}/quotes/[0-9a-f-]{36}$`));

  // The price is an estimate, not a promise
  await expect(page.getByLabel('Quote totals').getByText('Estimate')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Quote summary' })).toContainText('Q-0001');
  await expect(page.getByRole('region', { name: 'Quote summary' })).toContainText('Draft');

  // Mark final asks first, then freezes the quote
  await page.getByRole('group', { name: 'Quote actions' }).getByRole('button', { name: 'Mark final', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Mark this quote final?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Mark final', exact: true }).click();
  await expect(page.getByText('This quote is final. Copy it to make changes.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Quote summary' })).toContainText('Final');

  // The PDF is named for the quote number
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download PDF', exact: true }).click();
  const dl = await download;
  expect(dl.suggestedFilename()).toBe('Q-0001-roofing-estimate.pdf');
});

test('a rep sees only their jobs', async ({ page, loginAs, markTodaySeen, scenario, db }) => {
  const { companyId, owner, rep, otherRep } = scenario.a;

  // The showcase gives every job past Lead to the first rep by email, which is rep2 (otherRep); hand two of them to this rep.
  const mine = await db.query<{ id: string }>(
    `update jobs set assigned_user_id = $2, created_by_user_id = $3
      where id in (
        (select id from jobs where company_id = $1 and stage = 'inspection' and archived_at is null order by id limit 1),
        (select id from jobs where company_id = $1 and stage = 'proposal' and archived_at is null order by id limit 1))
      returning id`,
    [companyId, rep.userId, owner.userId],
  );
  expect(mine.rows).toHaveLength(2);

  const hidden = await db.query<{ id: string }>(
    `select id from jobs where company_id = $1 and assigned_user_id = $2 and stage <> 'lead' and archived_at is null order by id limit 1`,
    [companyId, otherRep.userId],
  );
  expect(hidden.rows).toHaveLength(1);

  // What the rep may see: jobs assigned to or made by them, and unassigned leads
  const visible = await db.query<{ id: string; stage: string }>(
    `select id, stage from jobs
      where company_id = $1 and archived_at is null
        and (assigned_user_id = $2 or created_by_user_id = $2 or (assigned_user_id is null and stage = 'lead'))`,
    [companyId, rep.userId],
  );
  const all = await db.query<{ n: string }>(
    `select count(*)::text as n from jobs where company_id = $1 and archived_at is null`,
    [companyId],
  );
  const total = Number(all.rows[0]!.n);
  // Fewer than the owner's board, which shows every job
  expect(visible.rows.length).toBeLessThan(total);
  // 8 unassigned leads plus the rep's own jobs
  expect(visible.rows.length).toBeGreaterThan(8);

  await loginAs(page, 'rep');
  await markTodaySeen(rep.email);
  await page.goto('/jobs');
  const board = page.getByRole('region', { name: 'Pipeline board' });
  await expect(board).toBeVisible();

  // The lane counts add up to exactly the rep's jobs (the Lost tab holds the lost ones)
  const expected = visible.rows.length;
  await expect
    .poll(
      async () => {
        const counts = (await board.locator('h2 [data-part="count"]').allTextContents()).map((n) => Number(n));
        const lost = /\((\d+)\)$/.exec((await board.getByRole('button', { name: /^Lost \(/ }).getAttribute('aria-label')) ?? '')?.[1];
        return counts.reduce((a, b) => a + b, 0) + Number(lost ?? 0);
      },
      { timeout: 15_000 },
    )
    .toBe(expected);

  // Their own jobs are on the board, the other rep's are not, and no column totals are shown.
  for (const row of mine.rows) {
    await expect(board.locator(`a[href="/jobs/${row.id}"]`)).toHaveCount(1);
  }
  await expect(board.locator(`a[href="/jobs/${hidden.rows[0]!.id}"]`)).toHaveCount(0);
  await expect(board.locator('[data-part="lane-total"]')).toHaveCount(0);
});
