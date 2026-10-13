import { expect, type Page, test } from '@playwright/test';

/*
 * The Estimator in the demo (DEMO_MODE, Summit Ridge Roofing seed): any typed address, a real-looking one too,
 * lands on a seeded demo lot (DemoGeocoder, design-c2), so Measure shows its outline and squares, and Make proposal goes through to the
 * owner's OK. And on the map, a click beside a customer's home picks its roof and "Estimate this roof" opens Measure. Run with the demo config, which starts the demo itself:
 *
 *   npx playwright test -c apps/web/playwright.demo.config.ts demo-estimator
 */

const LOGIN = { email: 'owner@summitridge.test', password: 'summit-ridge-demo' };

async function signIn(page: Page): Promise<void> {
  await page.clock.install({ time: new Date('2026-10-13T16:00:00.000Z') });
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(LOGIN.email);
  await page.getByLabel('Password').fill(LOGIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('demo-badge')).toBeVisible({ timeout: 30_000 });
}

/** Measure is showing a found outline (not draw mode) and a non-zero number of squares. */
async function expectOutline(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/estimator\/measure\//, { timeout: 30_000 });
  // A new roof is revealed by the scan first (Measure roof), then the numbers
  // (Wait for either: over the aerial photos the scan bar can take a moment to show, and an instant check would miss it.)
  const scan = page.getByRole('button', { name: 'Measure roof' });
  const adjust = page.getByRole('button', { name: 'Adjust' });
  await expect(scan.or(adjust)).toBeVisible({ timeout: 60_000 });
  if (await scan.isVisible().catch(() => false)) await scan.click();
  // The numbers sit under the result card's Adjust row
  await adjust.click({ timeout: 30_000, force: true });
  await expect(page.getByText('The numbers', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Squares', { exact: true }).locator('xpath=following-sibling::dd')).not.toHaveText('0');
  await expect(page.getByText('Tap the corners of the roof.', { exact: false })).toHaveCount(0);
}

test('demo: a typed address measures a demo house and makes a proposal', async ({ page }) => {
  test.setTimeout(3 * 60_000);
  await signIn(page);

  await page.goto('/estimator');
  const search = page.getByRole('searchbox', { name: 'Search name or address' });
  await expect(search).toBeVisible();
  await search.fill('1600 Pennsylvania Ave NW, Washington, DC 20500');
  await page.getByRole('button', { name: 'Measure a new roof at 1600 Pennsylvania Ave NW, Washington, DC 20500' }).click();

  await expectOutline(page);
  await expect(page.getByRole('button', { name: /Free estimate/ })).toHaveAttribute('aria-pressed', 'true');

  await page.getByLabel('Name', { exact: true }).fill('Dana Homeowner');
  await page.getByLabel('Phone', { exact: true }).fill('4025550142');
  await page.getByLabel('They asked for this proposal by text').check();
  await page.getByRole('button', { name: 'Make proposal' }).click();
  await expect(page).toHaveURL(/\/approvals\//, { timeout: 30_000 });
  await expect(page.getByText(/Good \$[\d,]+ · Better \$[\d,]+ · Best \$[\d,]+/)).toBeVisible();
});

test('demo: Estimate this roof from the map opens Measure on that building', async ({ page }) => {
  test.setTimeout(3 * 60_000);
  await signIn(page);
  const res = await page.request.get('/api/properties?limit=50');
  const { properties } = (await res.json()) as { properties: { id: string; addressLine: string; customerId: string | null; lat: number | null; lng: number | null }[] };
  // A seeded home (the address the first test just typed has a customer but no job, so it has no pin to fly to).
  const home = properties.find((p) => p.customerId !== null && p.lat !== null && p.lng !== null && !p.addressLine.includes('Pennsylvania'));
  expect(home).toBeDefined();
  const homeLng = home!.lng!;
  const homeLat = home!.lat!;
  // The home's own roof, from the same lookup the map click makes: a spot on it well clear of the pin (the pin sits on the
  // roof's middle, and the real houses are a lot apart, so a spot beside the pin may be nearer the next house).
  const found = await page.request.get(`/api/map/building-at?lat=${homeLat}&lng=${homeLng}`);
  expect(found.status()).toBe(200);
  const ring = ((await found.json()) as { polygon: { coordinates: [number, number][][] } }).polygon.coordinates[0]!;
  const metres = ([lng, lat]: [number, number]): [number, number] => [(lng - homeLng) * 111_320 * Math.cos((homeLat * Math.PI) / 180), (lat - homeLat) * 111_320];
  const corner = ring.map(metres).sort((a, b) => Math.hypot(...b) - Math.hypot(...a))[0]!;
  const pull = Math.max(0, 1 - 1.5 / Math.hypot(...corner));
  // MapLibre's world is 512 px wide at zoom 0; the map is at zoom 18 after the two zoom-ins from the pin's zoom 16.
  const metresPerPx = (78_271.517 * Math.cos((homeLat * Math.PI) / 180)) / 2 ** 18;
  const spot = { dx: (corner[0] * pull) / metresPerPx, dy: -(corner[1] * pull) / metresPerPx };

  // Fly to the home's pin, close its card, zoom in twice, then click the roof away from the pin: an empty-map click.
  await page.goto(`/?focus=${home!.id}`);
  await page.getByRole('button', { name: 'Close', exact: true }).click({ timeout: 30_000, force: true });
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /zoom in/i }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: /zoom in/i }).click();
  await page.waitForTimeout(1500);
  const box = await page.getByRole('region', { name: /map/i }).first().boundingBox();
  const estimate = page.getByRole('button', { name: 'Estimate this roof' });
  await page.mouse.click(box!.x + box!.width / 2 + spot.dx, box!.y + box!.height / 2 + spot.dy);
  await estimate.click({ timeout: 30_000, force: true });
  await expectOutline(page);
  // That home already has its customer, so no customer step; Make proposal is ready.
  await expect(page.getByText('Who is this for?')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Make proposal' })).toBeEnabled();
});
