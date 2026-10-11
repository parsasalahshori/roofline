import { test, expect, seedDemoTask } from './fixtures.ts';

/*
 * The web shell: the map home, the dock's six apps (each one window with its own URL), Esc and
 * Close going home, deep links, focus staying inside a window, and the "need your OK" pill.
 * Banners and summaries are found by their text, never by a bare role=status (several are mounted
 * all the time).
 */

const APPS: readonly (readonly [label: string, path: string])[] = [
  ['Storm', '/storm'],
  ['Front Desk', '/front-desk'],
  ['Estimator', '/estimator'],
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

test('dock has six labeled apps that each open one window with its own URL', async ({
  page,
  loginAs,
  markTodaySeen,
}) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const viewportWidth = viewport!.width;

  for (const [label, path] of APPS) {
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Apps' })
      .getByRole('link', { name: label, exact: false })
      .click();
    await expect(page).toHaveURL(new RegExp(path + '$'));

    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveCount(1);
    await expect(dialog).toHaveAccessibleName(label);
    await expect(dialog).toBeVisible();

    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    const { x, width, height } = box!;
    expect(Math.abs(x - (viewportWidth - x - width))).toBeLessThanOrEqual(2);
    expect(width).toBeLessThanOrEqual(1280);
    expect(height).toBeLessThanOrEqual(860);
  }
});

test('Esc and ✕ go home, Back goes to the previous window', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/');

  const dock = page.getByRole('navigation', { name: 'Apps' });
  await dock.getByRole('link', { name: 'Storm', exact: false }).click();
  await expect(page).toHaveURL(/\/storm$/);
  await dock.getByRole('link', { name: 'Jobs', exact: false }).click();
  await expect(page).toHaveURL(/\/jobs$/);

  await page.goBack();
  await expect(page).toHaveURL(/\/storm$/);
  await expect(page.getByRole('dialog', { name: 'Storm', exact: true })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await dock.getByRole('link', { name: 'Jobs', exact: false }).click();
  await expect(page).toHaveURL(/\/jobs$/);
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page).toHaveURL('/');
});

test('deep link opens the review directly', async ({ page, loginAs, scenario }) => {
  // Today is not marked seen here, so Today would be due: a deep link must not open it over the review.
  await loginAs(page, 'owner');
  const asked: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/me/today-shown')) asked.push(r.url());
  });
  await page.goto('/approvals/' + scenario.taskId);
  const dialog = page.getByRole('dialog', { name: 'Need your OK' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Storm plan: hail on the north side');
  await expect(page.getByRole('button', { name: 'Approve 3 steps · up to $270' })).toBeVisible();
  // Give a stray Today question time to be sent before concluding there was none
  await page.waitForTimeout(1000);
  expect(asked).toHaveLength(0);
  await expect(page).toHaveURL('/approvals/' + scenario.taskId);
  await expect(page.getByRole('dialog', { name: 'My day' })).toHaveCount(0);
});

test('focus stays inside the window', async ({ page, loginAs, markTodaySeen }) => {
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Apps' })
    .getByRole('link', { name: 'Jobs', exact: false })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();

  for (let press = 0; press < 15; press += 1) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true);
  }
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
