import { test, expect } from './fixtures.ts';

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
  await expect(page.getByRole('dialog').first()).toBeVisible();

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
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
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
