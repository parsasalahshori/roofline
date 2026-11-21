import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, readStack, chooseOption } from './fixtures.ts';
import { OMAHA_ADDRESS } from './estimator-helpers.ts';

/*
 * The windows journey, start to finish, on the e2e stack with its fake providers (no outside network, no real time):
 *   1. A visitor opens the company's instant quote page, gives an address, sees the estimate, leaves their details and
 *      books a free visit. 2. Staff find that lead in the CRM. 3. They measure the home's windows from the address,
 *      change one count, add two windows measured on site (the way the iPhone staff app adds them), 4. and turn the
 *      measurement into a factory order: styles picked, marked ready. The order is read back from the database.
 */

const SLUG = 'acme-roofing';
const PHOTO = readFileSync(fileURLToPath(new URL('./fixtures/window-photo.jpg', import.meta.url)));

/** Four LiDAR corners of a `w` x `h` inch window, one metre in front of the camera (the shape the iPhone app sends). */
function arScale(w: number, h: number) {
  const m = 0.0254;
  const at = (x: number, y: number): [number, number, number] => [x * m, 1.2 + y * m, -2];
  return {
    kind: 'ar',
    pointsM: [at(-w / 2, h / 2), at(w / 2, h / 2), at(w / 2, -h / 2), at(-w / 2, -h / 2)],
    trackingLostCount: 0,
    device: 'arkit-lidar',
    cornerSpreadM: [0.001, 0.002, 0.002, 0.001],
  };
}

test('a visitor asks for a window quote, staff measure the windows and make the factory order', async ({ page, browser, db, scenario, loginAs, markTodaySeen }) => {
  test.setTimeout(240_000);
  const companyId = scenario.a.companyId;
  await db.query(
    `insert into company_settings (company_id, quote_enabled, quote_slug, quote_products, quote_booking)
     values ($1, true, $2, $3, true)
     on conflict (company_id) do update set quote_enabled = true, quote_slug = excluded.quote_slug, quote_products = excluded.quote_products, quote_booking = true`,
    [companyId, SLUG, ['windows', 'roof']],
  );

  // 1. The visitor: no cookies, a phone-sized window, the public page only.
  const visitorContext = await browser.newContext({ baseURL: readStack().baseUrl, viewport: { width: 375, height: 812 } });
  const visitor = await visitorContext.newPage();
  try {
    await visitor.goto(`/q/${SLUG}`);
    await expect(visitor.getByRole('heading', { name: 'What are you looking for?' })).toBeVisible();
    await visitor.getByRole('checkbox', { name: /Window Replacement/ }).check();
    await visitor.getByRole('button', { name: 'Continue' }).click();
    await visitor.getByLabel('Home address').fill(OMAHA_ADDRESS);
    await visitor.getByRole('button', { name: 'See my estimate' }).click();
    await expect(visitor.getByRole('heading', { name: 'Your estimate' })).toBeVisible({ timeout: 45_000 });
    await expect(visitor.getByText(/About \d+(–\d+)? windows/)).toBeVisible();

    await visitor.getByRole('button', { name: "Book a free visit and we'll measure" }).or(visitor.getByRole('button', { name: 'Next: your details' })).first().click();
    await visitor.getByLabel('First name', { exact: true }).fill('Pat');
    await visitor.getByLabel('Last name', { exact: true }).fill('Visitor');
    await visitor.getByLabel('Email', { exact: true }).fill('pat.visitor@example.com');
    await visitor.getByLabel('Phone', { exact: true }).fill('4025550166');
    await visitor.getByLabel('ZIP code').fill('68102');
    await visitor.getByLabel('You may call or email me about my estimate').check();
    // The consent text and its version are the ones the page loaded.
    await expect(visitor.getByText(/By checking this box and clicking "Send my request"/)).toBeVisible();
    // The page refuses a form sent faster than a person can fill it: let the minimum fill time pass.
    await visitor.waitForTimeout(3_500);
    // A visit time, when the company has open times; the first listed one.
    const times = visitor.getByRole('radio');
    const booked = (await times.count()) > 1;
    if (booked) await times.nth(1).check();
    await visitor.getByRole('button', { name: 'Send my request' }).click();
    await expect(visitor.getByRole('heading', { name: 'Thanks, Pat!' })).toBeVisible({ timeout: 20_000 });
    if (booked) await expect(visitor.getByText(/is booked for/)).toBeVisible();
  } finally {
    await visitorContext.close();
  }

  // What the request filed: a customer, a lead job from the web with the consent kept on the request.
  const filed = await db.query<{ job_id: string; consent_version: string; consent_text: string; products: string[] }>(
    `select r.job_id, r.consent_version, r.consent_text, r.products from quote_requests r where r.company_id = $1`,
    [companyId],
  );
  expect(filed.rows).toHaveLength(1);
  expect(filed.rows[0]!.products).toEqual(['windows']);
  expect(filed.rows[0]!.consent_text).toContain('Acme Roofing');

  // 2. Staff: the lead is in the CRM, with what the homeowner was shown on its timeline.
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  await page.goto('/jobs');
  await page.getByText('Pat Visitor').first().click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Pat Visitor' })).toBeVisible();
  await expect(page.getByText(/Instant quote request\. Asked about windows\. Shown: about \d+ windows/)).toBeVisible();
  const address = (await db.query<{ address_line: string; city: string; state: string; zip: string }>(
    `select p.address_line, p.city, p.state, p.zip from jobs j join properties p on p.id = j.property_id where j.id = $1`,
    [filed.rows[0]!.job_id],
  )).rows[0]!;
  await expect(page.getByText(address.address_line).first()).toBeVisible();

  // 3. Measure the home's windows from its address: the scan counts them from the walls.
  await page.goto('/estimator/windows');
  await page.getByLabel('Address', { exact: true }).fill(`${address.address_line}, ${address.city}, ${address.state} ${address.zip}`);
  await page.getByRole('button', { name: 'Measure this address' }).click();
  await expect(page).toHaveURL(/\/estimator\/windows\/[0-9a-f-]{36}$/, { timeout: 45_000 });
  const measurementId = page.url().split('/').pop()!;
  await expect(page.getByRole('button', { name: 'Adjust counts' })).toBeVisible({ timeout: 45_000 });
  const better = page.getByText(/^Total, Better$/).locator('xpath=following-sibling::*[1]');
  const before = await better.innerText();

  // Change one count: one more small window. The quote moves, and the change is still there after a reload.
  await page.getByRole('button', { name: 'Adjust counts' }).click();
  await page.getByRole('button', { name: 'One more small window' }).click();
  await expect(better).not.toHaveText(before);
  const after = await better.innerText();
  await expect.poll(async () => {
    const saved = await db.query<{ adjustments: { manualCounts?: Record<string, number> } }>(`select adjustments from window_measurements where id = $1`, [measurementId]);
    return saved.rows[0]?.adjustments.manualCounts?.small;
  }).toBeGreaterThan(0);
  await page.reload();
  // The scan's reveal is remembered for the tab, so the work is shown at once.
  await expect(page.getByRole('button', { name: 'Adjust counts' })).toBeVisible({ timeout: 45_000 });
  await expect(better).toHaveText(after);

  // Two windows measured on site, added the way the iPhone staff app adds them: a photo, then the window with its LiDAR corners.
  const base = `/api/window-measurements/${measurementId}`;
  const windows = [
    { id: 'den', label: 'Den', w: 24, h: 36 },
    { id: 'bedroom', label: 'Bedroom', w: 30, h: 24 },
  ];
  for (const w of windows) {
    const up = await page.request.post(`${base}/uploads`, { data: PHOTO, headers: { 'Content-Type': 'image/jpeg' } });
    expect(up.status()).toBe(201);
    const uploadId = ((await up.json()) as { id: string }).id;
    const added = await page.request.post(`${base}/photo-windows`, {
      data: { id: w.id, uploadId, label: w.label, corners: [[100, 80], [540, 80], [540, 400], [100, 400]], scale: arScale(w.w, w.h) },
    });
    expect(added.status(), await added.text()).toBe(201);
  }
  await page.reload();
  await expect(page.locator('tr[data-row="photo:den"]')).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('tr[data-row="photo:bedroom"]')).toBeVisible();

  // 4. The factory order: Create factory order, a style for each line, mark it ready.
  await page.getByRole('link', { name: 'Create factory order' }).click();
  await expect(page).toHaveURL(new RegExp(`/estimator/windows/${measurementId}/order$`));
  await expect(page.getByRole('heading', { name: 'Windows to order' })).toBeVisible();
  const lines = page.getByRole('table', { name: /Windows to order/ }).getByRole('row');
  await expect(lines.filter({ hasText: 'Den' })).toBeVisible();
  await expect(lines.filter({ hasText: 'Bedroom' })).toBeVisible();
  for (const label of ['Den', 'Bedroom']) {
    await lines.filter({ hasText: label }).click();
    await chooseOption(page, 'Style', 'Double-hung');
  }
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('button', { name: 'Mark ready (locks sizes)' })).toBeEnabled({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Mark ready (locks sizes)' }).click();
  await expect.poll(async () => (await db.query<{ status: string }>(`select status from window_orders where window_measurement_id = $1`, [measurementId])).rows[0]?.status, { timeout: 20_000 }).toBe('ready');

  // The order exists with the right windows: the sizes are the smallest reading less its error and 1/4 in, down to 1/8 in.
  const order = await db.query<{ status: string; lines: { location: string; style: string; quantity: number; order: { widthIn: number; heightIn: number } | null; measured: { widthIn: number; heightIn: number }[] }[] }>(
    `select status, lines from window_orders where window_measurement_id = $1`,
    [measurementId],
  );
  expect(order.rows).toHaveLength(1);
  expect(order.rows[0]!.status).toBe('ready');
  const byLocation = Object.fromEntries(order.rows[0]!.lines.map((l) => [l.location, l]));
  expect(Object.keys(byLocation).sort()).toEqual(['Bedroom', 'Den']);
  for (const [location, w, h] of [['Den', 24, 36], ['Bedroom', 30, 24]] as const) {
    const line = byLocation[location]!;
    expect(line.style).toBe('double-hung');
    expect(line.quantity).toBe(1);
    const measured = line.measured[0]!;
    expect(measured.widthIn).toBeCloseTo(w, 0);
    expect(measured.heightIn).toBeCloseTo(h, 0);
  }
});
