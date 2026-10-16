import type { Page, Locator } from '@playwright/test';
import { test, expect, companyHostUrl, draftAndApproveStormPlan, stormPageCode, waitForStormSteps } from './fixtures.ts';
import { makeAndSendProposal } from './estimator-helpers.ts';
import { seedFrontDesk, seedRooflineNumber } from './front-desk-seed.ts';
import { seedOldLead, seedTextsPlan } from './g1-seeds.ts';

/*
 * The phone shell (below 768px): full-screen pages, the bottom tab bar that replaces the rail, and
 * the More sheet. This file runs in the `phone` Playwright project (375x812, Pixel 7). F3 Task 36
 * appends its pages to the same tests below, so keep one `test` per page group and add helpers here.
 */

/** Fails when the page is wider than the phone screen, so something scrolls sideways. */
async function noSideScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
}

/** Fails unless `button` sits fully above the bottom tab bar (1px tolerance for sub-pixel layout). */
async function expectAboveTabs(page: Page, button: Locator): Promise<void> {
  const tabs = await page.getByRole('navigation', { name: 'Main' }).boundingBox();
  const box = await button.boundingBox();
  expect(tabs).not.toBeNull();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(tabs!.y + 1);
}

test('bottom tabs work, with Measure raised in the middle', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/');

  const tabs = page.getByRole('navigation', { name: 'Main' });
  await expect(page.getByRole('navigation', { name: 'Apps' })).toHaveCount(0);
  // Five tabs in this order: four links, then the More button
  await expect(tabs.getByRole('link', { name: 'Map', exact: true })).toBeVisible();
  expect(await tabs.getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('data-tab')))).toEqual(['today', 'map', 'measure', 'jobs']);
  await expect(tabs.getByRole('button', { name: 'More', exact: true })).toBeVisible();

  await tabs.getByRole('link', { name: 'Map', exact: true }).click();
  await expect(page).toHaveURL('/');
  await expect(tabs.getByRole('link', { name: 'Map', exact: true })).toHaveAttribute('aria-current', 'page');

  // The first tab says Today; the page it opens is My day
  await tabs.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole('main', { name: 'My day' })).toBeVisible();
  await expect(tabs.getByRole('link', { name: 'Today', exact: true })).toHaveAttribute('aria-current', 'page');

  // The Measure tab stands above the bar: its tile starts higher than the bar's top edge
  const measure = tabs.getByRole('link', { name: 'Measure', exact: true });
  await measure.click();
  await expect(page).toHaveURL(/\/estimator/);
  await expect(measure).toHaveAttribute('aria-current', 'page');
  const [tabsBox, tileBox] = await Promise.all([tabs.boundingBox(), measure.locator('span').first().boundingBox()]);
  expect(tabsBox).not.toBeNull();
  expect(tileBox).not.toBeNull();
  expect(tileBox!.y).toBeLessThan(tabsBox!.y);

  await tabs.getByRole('link', { name: 'Jobs', exact: true }).click();
  await expect(page).toHaveURL(/\/jobs$/);
  await expect(tabs.getByRole('link', { name: 'Jobs', exact: true })).toHaveAttribute('aria-current', 'page');

  await tabs.getByRole('button', { name: 'More', exact: true }).click();
  const more = page.getByRole('dialog', { name: 'More', exact: true });
  await expect(more).toBeVisible();
  await more.getByRole('link', { name: 'Calendar', exact: true }).click();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.getByRole('dialog', { name: 'More', exact: true })).toHaveCount(0);

  await tabs.getByRole('button', { name: 'More', exact: true }).click();
  // Storm carries a count in its name ("Storm 2 plans need your OK"), so the name is matched from its start
  await page.getByRole('dialog', { name: 'More', exact: true }).getByRole('link', { name: /^Storm/ }).click();
  await expect(page).toHaveURL(/\/storm$/);
  await expect(page.getByRole('dialog', { name: 'More', exact: true })).toHaveCount(0);
});

/** Fails when two boxes overlap (1px tolerance for sub-pixel layout). */
function expectApart(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): void {
  const apart = a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1 || a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1;
  expect(apart).toBe(true);
}

for (const width of [360, 390]) {
  test(`phone head at ${width}px: no top bar, a long name shows initials and nothing overlaps`, async ({ page, loginAs, markTodaySeen, db }) => {
    const longName = 'Dana Whitfield-Montgomery';
    await db.query('update users set name = $1 where email = $2', [longName, 'owner@a.test']);
    await page.setViewportSize({ width, height: 800 });
    await loginAs(page, 'owner');
    await markTodaySeen('owner@a.test');

    for (const [path, title] of [
      ['/', 'Map'],
      ['/today', 'My day'],
      ['/jobs', 'Jobs'],
    ] as const) {
      await page.goto(path);
      const main = page.getByRole('main', { name: title });
      // A phone has no bar over the page: search, the bell and the person sit beside the title
      await expect(page.getByRole('banner')).toHaveCount(0);
      const heading = main.getByRole('heading', { level: 1, name: title });
      const menu = main.getByRole('button', { name: longName });
      const search = main.getByRole('button', { name: 'Search', exact: true });
      const bell = main.getByRole('link', { name: 'Notifications' });
      await expect(menu).toBeVisible();
      // Only the initials show on a phone; the full name is the button's label.
      await expect(main.getByText(longName, { exact: true })).toHaveCount(0);

      const [titleBox, menuBox, searchBox, bellBox] = await Promise.all([heading.boundingBox(), menu.boundingBox(), search.boundingBox(), bell.boundingBox()]);
      for (const box of [titleBox, menuBox, searchBox, bellBox]) expect(box).not.toBeNull();
      expectApart(titleBox!, searchBox!);
      expectApart(searchBox!, bellBox!);
      expectApart(bellBox!, menuBox!);
      // Everything stays on the screen and beside the title, not under it.
      for (const box of [menuBox!, searchBox!, bellBox!]) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
        expect(Math.abs(box.y - titleBox!.y)).toBeLessThan(40);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  });
}

test('no horizontal scroll', async ({ page, loginAs, markTodaySeen, scenario }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');

  for (const path of ['/', '/today', '/approvals', '/approvals/' + scenario.taskId]) {
    await page.goto(path);
    if (path === '/') {
      await expect(page.getByText('Map showing 70 customers and 25 open jobs.')).toBeAttached({ timeout: 20_000 });
    } else {
      await expect(page.getByRole('main').first()).toBeVisible();
    }
    await noSideScroll(page);
  }
});

test('Home: the layer switch, the storm note, the key and the map controls do not overlap', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/');
  await expect(page.getByText('Map showing 70 customers and 25 open jobs.')).toBeAttached({ timeout: 20_000 });

  const layers = page.getByRole('group', { name: 'Map layers' });
  const note = page.getByRole('region', { name: 'The latest storm' });
  const key = page.getByTestId('map-legend');
  const zoom = page.locator('.maplibregl-ctrl-zoom-in');
  const attribution = page.locator('.maplibregl-ctrl-attrib-button');
  await expect(layers).toBeVisible();
  await expect(note).toBeVisible();
  await expect(key).toBeVisible();
  await expect(zoom).toBeVisible();

  const boxes = await Promise.all([layers, note, key, zoom, attribution].map((locator) => locator.boundingBox()));
  const [layersBox, noteBox, keyBox, zoomBox, attributionBox] = boxes;
  for (const box of [layersBox, noteBox, keyBox, zoomBox]) expect(box).not.toBeNull();
  expectApart(layersBox!, noteBox!);
  expectApart(keyBox!, zoomBox!);
  expectApart(noteBox!, keyBox!);
  // The attribution button is the legal line: nothing sits over it
  if (attributionBox) expectApart(keyBox!, attributionBox);
  await noSideScroll(page);
});

test('Approve stays pinned', async ({ page, loginAs, markTodaySeen, scenario }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/approvals/' + scenario.taskId);

  const button = page.getByRole('button', { name: 'Approve 3 steps · up to $270' });
  await expect(button).toBeVisible();
  await expectAboveTabs(page, button);

  await page.mouse.move(187, 400);
  await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(300);
  await expectAboveTabs(page, button);
});

test('long text does not widen the page', async ({ page, loginAs, markTodaySeen, scenario, db }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await db.query(`update customers set display_name = repeat('Long', 15) where company_id = $1`, [
    scenario.a.companyId,
  ]);
  await db.query(
    `update agent_task_steps set payload = jsonb_set(payload, '{sample}', to_jsonb(repeat('word ', 80)))
      where task_id = $1 and type = 'demo_message'`,
    [scenario.taskId],
  );

  await page.goto('/approvals/' + scenario.taskId);
  await expect(page.getByRole('main').first()).toBeVisible();
  await noSideScroll(page);
});

test('sign-up does not scroll sideways', async ({ page }) => {
  await page.goto('/sign-up');
  await expect(page.getByLabel('Your name')).toBeVisible();
  await noSideScroll(page);
});

test('F3 pages do not scroll sideways', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');

  for (const path of ['/settings/setup', '/settings/billing', '/settings/setup/import']) {
    await page.goto(path);
    await expect(page.getByRole('main').first()).toBeVisible();
    await noSideScroll(page);
  }
});

test('the proposal view fits the phone', async ({ page, loginAs, markTodaySeen, click }) => {
  test.setTimeout(120_000);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const sent = await makeAndSendProposal(page, click);

  await page.goto('/estimator/proposals/' + sent.proposalId);
  await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();
  await noSideScroll(page);
});

test('C1 pages do not scroll sideways', async ({ page, loginAs, markTodaySeen, db, scenario }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const job = await db.query<{ id: string }>(`select id from jobs where company_id = $1 order by id limit 1`, [
    scenario.a.companyId,
  ]);
  const customer = await db.query<{ id: string }>(`select id from customers where company_id = $1 order by id limit 1`, [
    scenario.a.companyId,
  ]);

  const pages: [string, () => Locator][] = [
    ['/jobs?view=list', () => page.getByLabel('Jobs list', { exact: true })],
    [`/jobs/${job.rows[0]?.id}`, () => page.getByRole('group', { name: 'Job stage' })],
    [`/customers/${customer.rows[0]?.id}`, () => page.getByRole('group', { name: 'Customer actions' })],
    [
      '/calendar?view=list',
      () => page.locator('[data-testid^="agenda-day-"]').first().or(page.getByText('Nothing scheduled.', { exact: true })),
    ],
    ['/calendar', () => page.getByRole('group', { name: 'Pick a day' })],
    ['/calendar/new?kind=inspection', () => page.getByRole('list', { name: 'Suggested times' })],
  ];
  for (const [path, ready] of pages) {
    await page.goto(path);
    await expect(ready()).toBeVisible({ timeout: 20_000 });
    await noSideScroll(page);
  }
});

test('the calendar opens on the day, with a strip of the week, and the visit page keeps its actions in reach', async ({
  page,
  loginAs,
  markTodaySeen,
  db,
  scenario,
}) => {
  const owner = await db.query<{ user_id: string }>(`select user_id from memberships where company_id = $1 and role = 'owner' order by user_id limit 1`, [
    scenario.a.companyId,
  ]);
  const visit = await db.query<{ id: string }>(
    `insert into appointments (company_id, kind, title, assigned_user_id, starts_at, ends_at, status, source)
     select $1, 'inspection', 'Roof inspection', $2,
            (((now() at time zone c.timezone)::date) + time '10:00') at time zone c.timezone,
            (((now() at time zone c.timezone)::date) + time '11:00') at time zone c.timezone, 'scheduled', 'manual'
       from companies c where c.id = $1 returning id`,
    [scenario.a.companyId, owner.rows[0]!.user_id],
  );
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');

  await page.goto('/calendar');
  const views = page.getByRole('radiogroup', { name: 'Calendar view' });
  await expect(views.getByRole('radio', { name: 'Day' })).toBeChecked({ timeout: 20_000 });
  const strip = page.getByRole('group', { name: 'Pick a day' });
  await expect(strip.getByRole('button')).toHaveCount(7);
  await expect(strip.locator('[data-picked="true"]')).toHaveCount(1);
  await expect(page.getByTestId(`appt-${visit.rows[0]?.id}`)).toBeVisible();
  await noSideScroll(page);

  // A day of the strip, a thumb wide
  const other = strip.getByRole('button').nth(0);
  const box = await other.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(40);
  expect(box!.height).toBeGreaterThanOrEqual(44);

  // The visit page: the way back is the calendar, and Mark done is above the tab bar
  await page.goto(`/calendar/appointments/${visit.rows[0]?.id}`);
  await expect(page.getByRole('heading', { name: 'Roof inspection', level: 2 })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('link', { name: 'Calendar' }).first()).toBeVisible();
  await expectAboveTabs(page, page.getByRole('button', { name: 'Mark done' }));
  await noSideScroll(page);

  // The form: Save is above the tab bar too
  await page.goto('/calendar/new?kind=inspection');
  await expect(page.getByRole('list', { name: 'Suggested times' })).toBeVisible({ timeout: 20_000 });
  await expectAboveTabs(page, page.getByRole('button', { name: 'Save', exact: true }));
  await noSideScroll(page);
});

test('agents screens fit the phone', async ({ page, loginAs, markTodaySeen, agentsSeed }) => {
  void agentsSeed;
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');

  const screens: [string, (p: Page) => Locator][] = [
    ['/agents', (p) => p.getByRole('heading', { name: 'Your agents' })],
    ['/agents/storm-scout', (p) => p.getByText('What it does').first()],
    ['/agents/feed', (p) => p.getByRole('list', { name: 'What your agents did' })],
    ['/agents/waiting', (p) => p.getByLabel('Waiting', { exact: true })],
    ['/settings/agents', (p) => p.getByText('How we count time saved').first()],
  ];
  for (const [path, landmark] of screens) {
    await page.goto(path);
    await expect(landmark(page)).toBeAttached();
    if (path === '/agents') await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await noSideScroll(page);
  }
});

test('on a phone an agent card is the way to its page, and the page has the way back', async ({ page, loginAs, markTodaySeen, agentsSeed }) => {
  void agentsSeed;
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');

  await page.goto('/agents');
  await expect(page.getByRole('heading', { name: 'Your agents' })).toBeVisible({ timeout: 20_000 });
  // The panel for the picked agent has no room beside the cards: each card links to its own page instead
  await expect(page.getByRole('complementary')).toHaveCount(0);
  await noSideScroll(page);

  await page.getByRole('link', { name: 'Open Storm Scout' }).click();
  await expect(page).toHaveURL(/\/agents\/storm-scout$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Storm Scout' })).toBeVisible({ timeout: 20_000 });
  // The way back to Agents is above the title
  await expect(page.getByRole('link', { name: 'Agents', exact: true }).first()).toHaveAttribute('href', '/agents');
  await noSideScroll(page);
});

test('S1 pages do not scroll sideways', async ({ page, loginAs, markTodaySeen, scenario, db }) => {
  test.setTimeout(90_000);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const { taskId } = await draftAndApproveStormPlan(page, scenario.companyStormId);
  await waitForStormSteps(page, taskId);

  await page.goto('/storm');
  await expect(page.getByRole('region', { name: 'Storms in your area' })).toBeVisible();
  await noSideScroll(page);

  await page.goto(`/storm/${scenario.companyStormId}`);
  await expect(page.getByRole('heading', { name: 'Results so far' })).toBeVisible({ timeout: 20_000 });
  await noSideScroll(page);

  // The routes belong to the reps, so the route pages are read as the rep.
  await loginAs(page, 'rep');
  await markTodaySeen('rep@a.test');
  await page.goto('/storm/routes');
  const routeLink = page.getByRole('link', { name: /, 0 of \d+ doors$/ }).first();
  await expect(routeLink).toBeVisible({ timeout: 20_000 });
  await noSideScroll(page);
  await routeLink.click();
  await expect(page.getByRole('heading', { name: 'Doors in order' })).toBeVisible();
  await noSideScroll(page);

  const code = await stormPageCode(db, scenario.companyStormId);
  await page.goto(companyHostUrl('/storm/' + code));
  await expect(page.getByRole('button', { name: 'Request a free inspection' })).toBeVisible();
  await noSideScroll(page);
});

test('D1 Front Desk pages do not scroll sideways', async ({ page, loginAs, markTodaySeen, pools, scenario, db }) => {
  const { ids } = await seedFrontDesk(pools, scenario);
  await seedRooflineNumber(pools, db, scenario);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');

  const pages: [string, () => Locator][] = [
    ['/front-desk', () => page.getByRole('region', { name: "Today's numbers" })],
    [`/front-desk/${ids.maria}`, () => page.getByRole('heading', { name: 'Transcript' })],
    [`/front-desk/${ids.tom}`, () => page.getByLabel('Your reply')],
    ['/settings/front-desk', () => page.getByRole('button', { name: 'Test it' })],
    ['/settings/profile', () => page.getByLabel('Your phone number')],
  ];
  for (const [path, ready] of pages) {
    await page.goto(path);
    await expect(ready()).toBeVisible({ timeout: 20_000 });
    await noSideScroll(page);
  }
});

test('follow-up texts review fits the phone', async ({ page, loginAs, markTodaySeen, db, pools, scenario }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const lead = await seedOldLead(db, scenario.a.companyId);
  const { taskId } = await seedTextsPlan(pools, scenario.a.companyId, lead.customerId);
  await page.goto('/approvals/' + taskId);
  await expect(page.getByText('Send 1 personal text')).toBeVisible({ timeout: 20_000 });
  await noSideScroll(page);
  const button = page.getByRole('button', { name: /^Approve 1 step/ });
  await expect(button).toBeVisible();
  await expectAboveTabs(page, button);
});

test('Agents window with the G1 cards does not scroll sideways', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/agents');
  await expect(page.getByText('Follow-up', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await noSideScroll(page);
});
