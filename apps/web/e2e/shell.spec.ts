import { test, expect, seedDemoTask } from './fixtures.ts';

/*
 * The web shell: Home with its map panel, the rail's apps (each one full-height page with its own URL and a
 * trail in the top bar), Back, deep links, focus moving freely between the rail and the page, and the "need your OK"
 * pill. Banners and summaries are found by their text, never by a bare role=status (several are mounted
 * all the time).
 */

const APPS: readonly (readonly [label: string, path: string])[] = [
  ['Storm', '/storm'],
  ['Front Desk', '/front-desk'],
  ['Measure', '/estimator'],
  ['Jobs', '/jobs'],
  ['Calendar', '/calendar'],
  ['Agents', '/agents'],
];

test('map home shows the seeded pins', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/');
  // 70 addresses; 25 open jobs = lead 8 + inspection 7 + proposal 6 + won 4.
  await expect(page.getByText('Map showing 70 customers and 25 open jobs.')).toBeAttached({ timeout: 20_000 });
});

test('the rail has labeled apps that each open one full-height page with its own URL', async ({
  page,
  loginAs,
  markTodaySeen,
}) => {
  // Six pages open one after another (about 5 s each on a slow CI runner): more than the 30 s default.
  test.setTimeout(60_000);
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const viewportWidth = viewport!.width;
  const rail = page.getByRole('navigation', { name: 'Apps' });

  for (const [label, path] of APPS) {
    await page.goto('/');
    await rail.getByRole('link', { name: label, exact: false }).click();
    // Measure opens its first request, so its URL carries an id after the path
    await expect(page).toHaveURL(new RegExp(path + (path === '/estimator' ? '(/measure/[^/]+)?' : '') + '$'));

    const main = page.getByRole('main');
    await expect(main).toHaveCount(1);
    await expect(main).toHaveAccessibleName(label);
    await expect(main).toBeVisible();
    // The page is not a window: no dialog, and the rail stays on screen with this app marked
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(rail.getByRole('link', { name: label, exact: false })).toHaveAttribute('aria-current', 'page');
    // The trail in the top bar names the page
    await expect(page.getByRole('banner').getByRole('navigation', { name: 'Breadcrumb' })).toContainText(label);

    // It fills the column to the right of the rail, edge to edge up to its gutters
    const railBox = await rail.boundingBox();
    const box = await main.boundingBox();
    expect(railBox).not.toBeNull();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(railBox!.x + railBox!.width - 2);
    expect(box!.x + box!.width).toBeGreaterThanOrEqual(viewportWidth - 20);
  }
});

test('Home is the dashboard with a map panel in it, and the rail marks it', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/');
  const rail = page.getByRole('navigation', { name: 'Apps' });
  await expect(rail.getByRole('link', { name: 'Home', exact: true })).toHaveAttribute('aria-current', 'page');
  const main = page.getByRole('main', { name: 'Home' });
  await expect(main).toBeVisible();
  // The map is a panel inside the page, not the page's background
  const map = page.getByRole('region', { name: /map/i }).first();
  const mapBox = await map.boundingBox();
  const mainBox = await main.boundingBox();
  expect(mapBox).not.toBeNull();
  expect(mainBox).not.toBeNull();
  expect(mapBox!.width).toBeLessThan(mainBox!.width);
  expect(mapBox!.height).toBeLessThan(mainBox!.height);
});

test('Back goes to the previous page, and Esc and a missing close button leave a page alone', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/');

  const rail = page.getByRole('navigation', { name: 'Apps' });
  await rail.getByRole('link', { name: 'Storm', exact: false }).click();
  await expect(page).toHaveURL(/\/storm$/);
  await rail.getByRole('link', { name: 'Jobs', exact: false }).click();
  await expect(page).toHaveURL(/\/jobs$/);

  await page.goBack();
  await expect(page).toHaveURL(/\/storm$/);
  await expect(page.getByRole('main', { name: 'Storm', exact: true })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/storm$/);
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toHaveCount(0);

  await rail.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL('/');
});

test('the rail keeps its labels in the accessibility tree when it collapses to icons', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto('/jobs');
  const rail = page.getByRole('navigation', { name: 'Apps' });
  await expect(rail.getByRole('link', { name: 'Jobs', exact: false })).toBeVisible();
  const box = await rail.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(80);
  // The words are not on screen (clipped to a point), but every app is still named for a screen reader
  const word = await rail.getByText('Calendar', { exact: true }).boundingBox();
  expect(word).not.toBeNull();
  expect(word!.width).toBeLessThanOrEqual(2);
  await expect(rail.getByRole('link', { name: 'Calendar' })).toBeVisible();
});

test('deep link opens the review directly', async ({ page, loginAs, scenario }) => {
  // Today is not marked seen here, so Today would be due: a deep link must not open it over the review.
  await loginAs(page, 'owner');
  const asked: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/me/today-shown')) asked.push(r.url());
  });
  await page.goto('/approvals/' + scenario.taskId);
  // The review is its own page: its landmark takes the plan's name, and the trail above it leads back to Need your OK
  const main = page.getByRole('main', { name: 'Storm plan: hail on the north side' });
  await expect(main).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Need your OK' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve 3 steps · up to $270' })).toBeVisible();
  // Give a stray Today question time to be sent before concluding there was none
  await page.waitForTimeout(1000);
  expect(asked).toHaveLength(0);
  await expect(page).toHaveURL('/approvals/' + scenario.taskId);
  await expect(page.getByRole('main', { name: 'My day' })).toHaveCount(0);
});

test('focus is not trapped: Tab moves between the rail and the page', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/jobs');
  await expect(page.getByRole('main', { name: 'Jobs' })).toBeVisible();

  const seen = new Set<string>();
  for (let press = 0; press < 60; press += 1) {
    await page.keyboard.press('Tab');
    seen.add(
      await page.evaluate(() => {
        const active = document.activeElement;
        if (active?.closest('nav[aria-label="Apps"]')) return 'rail';
        if (active?.closest('main')) return 'page';
        if (active?.closest('header')) return 'bar';
        return 'other';
      }),
    );
  }
  expect(seen.has('rail')).toBe(true);
  expect(seen.has('bar')).toBe(true);
  expect(seen.has('page')).toBe(true);
});

test('pill shows the live draft count', async ({ page, loginAs, markTodaySeen, pools }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/');
  await expect(page.getByRole('link', { name: '1 need your OK' })).toBeVisible();

  await seedDemoTask(pools, 'acme-roofing', new Date());
  await page.reload();
  await expect(page.getByRole('link', { name: '2 need your OK' })).toBeVisible();
});
