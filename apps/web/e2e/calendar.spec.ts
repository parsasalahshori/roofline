import { chooseOption, test, expect } from './fixtures.ts';

/*
 * The calendar from the browser, on the FAKE_PROVIDERS stack: booking an inspection from a lead,
 * and connecting a calendar so an appointment shows it is on that calendar.
 */

test('book an inspection from a lead in 3 clicks and the job moves', async ({
  page,
  loginAs,
  markTodaySeen,
  db,
  scenario,
  click,
  clicks,
}) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const lead = await db.query<{ id: string }>(
    `select id from jobs where company_id = $1 and stage = 'lead' order by id limit 1`,
    [scenario.a.companyId],
  );
  const jobId = lead.rows[0]?.id;
  expect(jobId).toBeDefined();

  await page.goto(`/jobs/${jobId}`);
  await expect(page.getByRole('main').first()).toBeVisible();

  await click(page.getByRole('link', { name: 'Book inspection' }));
  const times = page.getByRole('list', { name: 'Suggested times' });
  await expect(times).toBeVisible({ timeout: 20_000 });
  await click(times.getByRole('button').first());
  await click(page.getByRole('button', { name: 'Save', exact: true }));

  await expect(page).toHaveURL(/\/calendar\/appointments\/[0-9a-f-]+$/, { timeout: 20_000 });
  expect(clicks.count).toBe(3);

  const after = await db.query<{ stage: string }>(`select stage from jobs where id = $1`, [jobId]);
  expect(after.rows[0]?.stage).toBe('inspection');

  await page.goto(`/jobs/${jobId}`);
  await expect(page.getByRole('group', { name: 'Job stage' }).getByRole('button', { name: 'Inspection' })).toHaveAttribute(
    'aria-current',
    'step',
  );
});

// Outbound only: the app writes the appointment to the connected calendar (the calendar-push job).
// The inbound direction is not driven from the browser (Ruling 9); it is covered by
// apps/api/test/calendar-pull.test.ts in the acceptance map.
test('connect a calendar, and appointments sync both ways', async ({ page, loginAs, markTodaySeen, db, scenario }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');

  await page.goto('/settings/connections');
  await expect(page.getByRole('main', { name: 'Settings' })).toBeVisible();
  await page.getByRole('link', { name: 'Connect Google Calendar' }).click();

  // The fake sign-in sends the browser straight back through the callback.
  await expect(page).toHaveURL(/\/settings\/connections/, { timeout: 20_000 });
  await expect(page.getByText('fake@example.test')).toBeVisible({ timeout: 20_000 });

  const lead = await db.query<{ id: string }>(
    `select id from jobs where company_id = $1 and stage = 'lead' order by id limit 1`,
    [scenario.a.companyId],
  );
  await page.goto(`/jobs/${lead.rows[0]?.id}`);
  await page.getByRole('link', { name: 'Book inspection' }).click();
  const times = page.getByRole('list', { name: 'Suggested times' });
  await expect(times).toBeVisible({ timeout: 20_000 });
  await times.getByRole('button').first().click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/calendar\/appointments\/[0-9a-f-]+$/, { timeout: 20_000 });

  // The push runs in the background; reload until the detail shows the sync line.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('On your Google calendar')).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 45_000 });
});

/*
 * The calendar as drawn in Chalk Line: the three views on one set of visits, the people chips, the grid's blocks, the
 * appointment page and the form. The visits are rows put in the book for the owner: tomorrow in the company's own zone.
 */

type Visits = { day: string; inspection: string; followUp: string; install: string; canceled: string; ownerName: string; ownerId: string };

/** Four visits for the owner tomorrow: an inspection at 10, a 30 minute follow-up at 11:30, a canceled visit at 14, and a two-day install. */
async function seedVisits(db: import('pg').Client, companyId: string): Promise<Visits> {
  const owner = await db.query<{ user_id: string; name: string }>(
    `select m.user_id, u.name from memberships m join users u on u.id = m.user_id where m.company_id = $1 and m.role = 'owner' order by m.user_id limit 1`,
    [companyId],
  );
  const customer = await db.query<{ id: string }>(`select id from customers where company_id = $1 order by id limit 1`, [companyId]);
  const times = await db.query<{ day: string; t10: Date; t11: Date; t1130: Date; t12: Date; t14: Date; t15: Date; d0: Date; d2: Date }>(
    `select to_char(d, 'YYYY-MM-DD') as day,
            (d + time '10:00') at time zone tz as t10, (d + time '11:00') at time zone tz as t11,
            (d + time '11:30') at time zone tz as t1130, (d + time '12:00') at time zone tz as t12,
            (d + time '14:00') at time zone tz as t14, (d + time '15:00') at time zone tz as t15,
            d::timestamp at time zone tz as d0, (d + 2)::timestamp at time zone tz as d2
       from (select c.timezone as tz, ((now() at time zone c.timezone)::date + 1) as d from companies c where c.id = $1) t`,
    [companyId],
  );
  const t = times.rows[0]!;
  const userId = owner.rows[0]!.user_id;
  const insert = async (kind: string, title: string, start: Date, end: Date, extra: { allDay?: boolean; status?: string } = {}) => {
    const row = await db.query<{ id: string }>(
      `insert into appointments (company_id, kind, title, assigned_user_id, customer_id, starts_at, ends_at, all_day, status, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual') returning id`,
      [companyId, kind, title, userId, customer.rows[0]?.id ?? null, start, end, extra.allDay ?? false, extra.status ?? 'scheduled'],
    );
    return row.rows[0]!.id;
  };
  return {
    day: t.day,
    ownerName: owner.rows[0]!.name,
    ownerId: userId,
    inspection: await insert('inspection', 'Roof inspection', t.t10, t.t11),
    followUp: await insert('other', 'Quick follow-up', t.t1130, t.t12),
    canceled: await insert('inspection', 'Canceled walk', t.t14, t.t15, { status: 'canceled' }),
    install: await insert('install', 'Roof install', t.d0, t.d2, { allDay: true }),
  };
}

test('calendar: the week, day and list views show the same visits, and the chips and Show canceled filter them', async ({
  page,
  loginAs,
  markTodaySeen,
  db,
  scenario,
}) => {
  const visits = await seedVisits(db, scenario.a.companyId);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto(`/calendar?view=week&date=${visits.day}`);

  // The controls: a radio group for the view, ghost steps, the one primary button
  const views = page.getByRole('radiogroup', { name: 'Calendar view' });
  await expect(views.getByRole('radio', { name: 'Week' })).toBeChecked({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'New appointment' })).toBeVisible();

  // Week: blocks on the grid, an all-day row, no canceled visit yet
  const grid = page.getByRole('region', { name: 'Calendar time grid' });
  await expect(grid).toBeVisible();
  const block = grid.getByTestId(`appt-${visits.inspection}`);
  await expect(block).toBeVisible();
  await expect(block).toHaveAttribute('title', /Roof inspection/);
  await expect(grid.getByTestId(`appt-${visits.followUp}`)).toHaveAttribute('data-size', 'short');
  await expect(grid.getByTestId(`allday-${visits.install}`).first()).toBeVisible();
  await expect(grid.getByTestId(`appt-${visits.canceled}`)).toHaveCount(0);

  // A block never runs its text out of its box
  const clipped = await block.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
  expect(clipped).toBe(true);

  // The grid opens with the first visit in view, below the sticky head and all-day row, whatever the hour is now: a tall visit that began
  // above the fold would show only its coloured edge
  const inView = await block.evaluate((element) => {
    const scroller = element.closest('[data-testid="time-grid"]');
    if (scroller === null) return false;
    const box = element.getBoundingClientRect();
    const frame = scroller.getBoundingClientRect();
    const stuck = Array.from(scroller.querySelectorAll('[data-day]'))
      .filter((cell) => getComputedStyle(cell).position === 'sticky')
      .map((cell) => cell.getBoundingClientRect().bottom);
    return box.top >= Math.max(frame.top, ...stuck) - 1 && box.bottom <= frame.bottom + 1;
  });
  expect(inView).toBe(true);

  // Show canceled adds the canceled visit, and says so in words
  await page.getByRole('switch', { name: 'Show canceled' }).click();
  await expect(grid.getByTestId(`appt-${visits.canceled}`)).toBeVisible();
  await expect(grid.getByTestId(`appt-${visits.canceled}`).getByText('Canceled', { exact: true })).toBeAttached();

  // The people chips: switching the owner off takes the owner's visits away
  const people = page.getByRole('group', { name: 'Show appointments for' });
  const chip = people.getByRole('button', { name: visits.ownerName });
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await expect(grid.getByTestId(`appt-${visits.inspection}`)).toHaveCount(0);
  await chip.click();
  await expect(grid.getByTestId(`appt-${visits.inspection}`)).toBeVisible();

  // Day
  await views.getByRole('radio', { name: 'Day' }).click();
  await expect(page).toHaveURL(/view=day/);
  await expect(page.getByTestId(`appt-${visits.inspection}`)).toBeVisible();
  await expect(page.getByTestId(`appt-${visits.install}`)).toHaveCount(0);

  // List: a panel for the day with a table, and the visit's name opens it
  await views.getByRole('radio', { name: 'List' }).click();
  await expect(page).toHaveURL(/view=list/);
  const panel = page.getByTestId(`agenda-day-${visits.day}`);
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('columnheader', { name: 'Time' })).toBeVisible();
  await expect(panel.getByTestId(`agenda-item-${visits.inspection}`)).toBeVisible();
  await panel.getByTestId(`agenda-item-${visits.inspection}`).click();
  await expect(page).toHaveURL(new RegExp(`/calendar/appointments/${visits.inspection}$`));
});

test('calendar: a click on an empty slot starts the form at that time, with the person and the length chosen from lists', async ({
  page,
  loginAs,
  markTodaySeen,
  db,
  scenario,
}) => {
  const visits = await seedVisits(db, scenario.a.companyId);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto(`/calendar?view=week&date=${visits.day}`);

  // 1 PM tomorrow is free
  await page.getByTestId(`slot-${visits.day}-13:00`).click();
  await expect(page).toHaveURL(/\/calendar\/new\?start=/);
  await expect(page.getByLabel('Date', { exact: true })).toHaveValue(visits.day, { timeout: 20_000 });
  await expect(page.getByLabel('Time', { exact: true })).toHaveValue('13:00');

  // Kind, Person and Duration are pick-one lists; the suggested times are beside them
  for (const label of ['Kind', 'Person', 'Duration']) {
    await expect(page.getByLabel(label, { exact: true })).toHaveAttribute('aria-haspopup', 'listbox');
  }
  await expect(page.getByRole('list', { name: 'Suggested times' })).toBeVisible({ timeout: 20_000 });
  await chooseOption(page, 'Duration', '2 hours');
  await expect(page.getByText('Ends at 3:00 PM')).toBeVisible();

  // An install is a set of days: no time, no length, no suggestions
  await chooseOption(page, 'Kind', 'Install');
  await expect(page.getByLabel('Start date', { exact: true })).toBeVisible();
  await expect(page.getByLabel('End date', { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Suggested times' })).toHaveCount(0);
  await expect(page.getByLabel('Duration', { exact: true })).toHaveCount(0);
});

test('calendar: a visit opens, is rescheduled to a different length, and is marked done', async ({
  page,
  loginAs,
  markTodaySeen,
  db,
  scenario,
}) => {
  const visits = await seedVisits(db, scenario.a.companyId);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto(`/calendar/appointments/${visits.inspection}`);

  // The page: the title, the status as a tag, when it is and the details; the trail goes back to the calendar
  await expect(page.getByRole('heading', { name: 'Roof inspection', level: 2 })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Scheduled', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'When' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Details' }).getByText('Inspection', { exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Calendar' })).toBeVisible();
  const actions = page.getByRole('group', { name: 'Appointment actions' });
  await expect(actions.getByRole('button')).toHaveText(['Reschedule', 'Mark done', 'No-show', 'Cancel']);

  // Reschedule: the same form, with the length of this visit; Cancel comes back to the page
  await actions.getByRole('button', { name: 'Reschedule' }).click();
  await expect(page.getByLabel('Duration', { exact: true })).toContainText('1 hour');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Roof inspection', level: 2 })).toBeVisible();

  await actions.getByRole('button', { name: 'Reschedule' }).click();
  await chooseOption(page, 'Duration', '2 hours');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  // A time the server warns about is kept; the warning never stops the save
  const keep = page.getByRole('button', { name: 'Keep it' });
  const back = page.getByRole('group', { name: 'Appointment actions' });
  await expect(keep.or(back)).toBeVisible({ timeout: 20_000 });
  if (await keep.isVisible()) await keep.click();
  await expect(back).toBeVisible({ timeout: 20_000 });
  const length = await db.query<{ minutes: number }>(`select (extract(epoch from (ends_at - starts_at)) / 60)::int as minutes from appointments where id = $1`, [visits.inspection]);
  expect(length.rows[0]?.minutes).toBe(120);

  // Mark done: the tag changes and the actions go
  await page.getByRole('button', { name: 'Mark done' }).click();
  await expect(page.getByText('Done', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('group', { name: 'Appointment actions' })).toHaveCount(0);
  const status = await db.query<{ status: string }>(`select status from appointments where id = $1`, [visits.inspection]);
  expect(status.rows[0]?.status).toBe('completed');
});

test('calendar: a visit is canceled only after the sheet asks', async ({ page, loginAs, markTodaySeen, db, scenario }) => {
  const visits = await seedVisits(db, scenario.a.companyId);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto(`/calendar/appointments/${visits.followUp}`);

  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Cancel this appointment?' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Quick follow-up')).toBeVisible();
  await sheet.getByRole('button', { name: 'Keep it' }).click();
  await expect(sheet).toHaveCount(0);
  const before = await db.query<{ status: string }>(`select status from appointments where id = $1`, [visits.followUp]);
  expect(before.rows[0]?.status).toBe('scheduled');

  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('dialog', { name: 'Cancel this appointment?' }).getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(page.getByText('Canceled', { exact: true })).toBeVisible({ timeout: 20_000 });
  const after = await db.query<{ status: string }>(`select status from appointments where id = $1`, [visits.followUp]);
  expect(after.rows[0]?.status).toBe('canceled');
});
