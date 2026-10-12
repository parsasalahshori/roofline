import { test, expect } from './fixtures.ts';
import { seedOldLead, seedWeatherMovePlan } from './g1-seeds.ts';

/*
 * The three G1 agents end to end (Task 18b): they start paused and the owner turns Follow-up on and runs
 * it; the claim section saves and builds a packet; a weather move plan shows its new day and reason and is
 * approved. The e2e server runs with FAKE_PROVIDERS, so drafts fall back to templates and texts go to the
 * fake SMS. No test depends on a dock, so the file runs in the desktop and the phone project.
 */

test('the three G1 agents start paused, Turn on Follow-up shows its rules, and Run now makes a plan to approve', async ({
  page,
  loginAs,
  markTodaySeen,
  scenario,
  db,
}) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/agents');

  const grid = page.getByLabel('Your agents').first();
  for (const name of ['Claims', 'Scheduler', 'Follow-up']) {
    // A1's card link is labelled by its name, status chip and time line, so it is found by its heading (probe pass 14).
    const card = grid.locator('a', { has: page.getByRole('heading', { name, exact: true }) });
    await expect(card).toContainText('Paused', { timeout: 20_000 });
    await expect(card).toContainText('Turn on');
  }

  await page.goto('/agents/follow-up');
  await expect(page.getByRole('heading', { name: 'Follow-up', exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Turn on', exact: true }).click();

  const sheet = page.getByRole('dialog', { name: 'Turn this agent on?' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('This is what I will do. I only draft texts for you to approve.')).toBeVisible();
  await sheet.getByRole('button', { name: 'Turn on', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Paused' })).not.toBeChecked();

  // An unbooked lead that is old enough, then ask the agent to look now.
  const lead = await seedOldLead(db, scenario.a.companyId);
  await page.getByRole('button', { name: 'Find follow-ups now', exact: true }).click();

  // The worker runs followup-daily and makes one draft plan.
  let taskId = '';
  await expect
    .poll(
      async () => {
        const found = await db.query<{ id: string }>(
          `select id from agent_tasks where company_id = $1 and agent = 'follow_up' and kind = 'follow_ups' order by created_at desc limit 1`,
          [scenario.a.companyId],
        );
        taskId = found.rows[0]?.id ?? '';
        return taskId;
      },
      { timeout: 45_000, intervals: [500, 1_000, 2_000] },
    )
    .not.toBe('');

  await page.goto('/approvals/' + taskId);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Send 1 personal text')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: /^Approve 1 step/ }).click();
  await expect(dialog.getByRole('list').getByText('Done', { exact: true })).toHaveCount(1, { timeout: 20_000 });

  // The text went through the fake SMS: an outbound message row for the seeded customer.
  await expect
    .poll(
      async () => {
        const rows = await db.query(`select 1 from messages where company_id = $1 and customer_id = $2 and direction = 'out' and status in ('sent', 'scheduled')`, [
          scenario.a.companyId,
          lead.customerId,
        ]);
        return rows.rowCount;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
});

test('the claim section saves insurer and claim number, then builds a claim packet with a Download link', async ({
  page,
  loginAs,
  markTodaySeen,
  db,
  scenario,
}) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const job = await db.query<{ id: string }>(`select id from jobs where company_id = $1 order by id limit 1`, [scenario.a.companyId]);
  await page.goto(`/jobs/${job.rows[0]?.id}`);

  await page.getByRole('button', { name: 'Add claim details', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Insurance claim' });
  await form.getByLabel('Insurer').fill('Prairie Mutual');
  await form.getByLabel('Claim number').fill('CL-48213');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText('CL-48213').first()).toBeVisible();

  await page.getByRole('button', { name: 'Build claim packet', exact: true }).click();
  await expect(page.getByRole('link', { name: /^Download packet \(built / })).toBeVisible({ timeout: 30_000 });
});

test('a weather move review shows the new day and the reason, then Approve', async ({ page, loginAs, markTodaySeen, scenario, db, pools }) => {
  const plan = await seedWeatherMovePlan(pools, db, scenario.a.companyId);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/approvals/' + plan.taskId);

  // The day label the preview uses (formatDayLabel): short weekday, short month, day.
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(
    new Date(`${plan.newDay}T12:00:00Z`),
  );
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Move the install to ' + day, { exact: false })).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByRole('paragraph').filter({ hasText: plan.reason })).toBeVisible();

  await page.getByRole('button', { name: /^Approve 1 step/ }).click();
  await expect(dialog.getByRole('list').getByText('Done', { exact: true })).toHaveCount(1, { timeout: 20_000 });

  // The install now starts on the new day in the company's zone.
  const moved = await db.query<{ day: string }>(
    `select to_char(a.starts_at at time zone c.timezone, 'YYYY-MM-DD') as day
       from appointments a join companies c on c.id = a.company_id
      where a.company_id = $1 and a.kind = 'install' and a.moved_by_task_id = $2`,
    [scenario.a.companyId, plan.taskId],
  );
  expect(moved.rows[0]?.day).toBe(plan.newDay);
});
