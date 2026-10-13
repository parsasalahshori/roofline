import { expect, readStack, test } from './fixtures.ts';

/*
 * "Estimate this roof" end to end, from the building under a map point to a proposal waiting for the owner's OK.
 * The map click itself (card, highlight, button) is proven by map-roof.test.tsx; a canvas click here would
 * need the live map's projection. Here the same two calls the card makes run against the real stack, then the
 * measuring screen is driven by hand: the picked building is preselected, the free estimate is the default,
 * and a home with no customer asks for one before Send proposal. The browser clock starts at a fixed time.
 */

/** Inside fake-ne-1 of the NE footprint fixture (apps/api/test/fixtures/footprints-ne.json). */
const POINT = { lat: 41.2565, lng: -95.9345 };

test('estimate this roof: picked building to a proposal for a new customer', async ({ page, loginAs, markTodaySeen }) => {
  // The scan plays about five seconds before the numbers and the proposal show
  test.setTimeout(120_000);
  // A fixed date with real timers: the fake timers of clock.install stall under the map's animation frames, and the
  // Measure roof scan (and the search debounce) never finish
  await page.clock.setFixedTime(new Date('2026-10-13T16:00:00.000Z'));
  await loginAs(page, 'owner');
  await markTodaySeen('owner@a.test');
  const headers = { Origin: readStack().baseUrl };

  const found = await page.request.get(`/api/map/building-at?lat=${POINT.lat}&lng=${POINT.lng}`);
  expect(found.status()).toBe(200);
  const { footprintId } = (await found.json()) as { footprintId: string };
  const made = await page.request.post('/api/estimator/from-footprint', { headers, data: { footprintId, ...POINT } });
  expect(made.status()).toBe(201);
  const { measurementId } = (await made.json()) as { measurementId: string };

  const view = await page.request.get(`/api/measurements/${measurementId}`);
  const m = (await view.json()) as { hasCustomer: boolean; structures: { footprintId: string; included: boolean }[] };
  expect(m.hasCustomer).toBe(false);
  expect(m.structures.filter((s) => s.included).map((s) => s.footprintId)).toEqual([footprintId]);
  const picked = m.structures.findIndex((s) => s.footprintId === footprintId) + 1;

  await page.goto(`/estimator/measure/${measurementId}`);
  // A new roof is revealed by the scan first: Measure roof, then the numbers and the choices
  await page.getByRole('button', { name: 'Measure roof' }).click();
  // The building choices sit under the result card's Adjust row
  await page.getByRole('button', { name: 'Adjust' }).click();
  await expect(page.getByLabel(`Building ${picked}`, { exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: /Free estimate/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Paid · ordered after your OK')).toBeVisible();

  const make = page.getByRole('button', { name: 'Send proposal' });
  await expect(make).toBeDisabled();
  await page.getByLabel('Name', { exact: true }).fill('Dana Homeowner');
  await page.getByLabel('Phone', { exact: true }).fill('4025550142');
  await page.getByLabel('They asked for this proposal by text').check();
  await expect(make).toBeEnabled();

  const sent = page.waitForResponse(
    (r) => /\/api\/proposals\/[^/]+\/send$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST',
    { timeout: 45_000 },
  );
  await make.click();
  const { taskId } = (await (await sent).json()) as { taskId: string };
  await expect(page).toHaveURL(new RegExp('/approvals/' + taskId + '$'), { timeout: 15_000 });
  await expect(page.getByText(/Good \$[\d,]+ · Better \$[\d,]+ · Best \$[\d,]+/)).toBeVisible();
});
