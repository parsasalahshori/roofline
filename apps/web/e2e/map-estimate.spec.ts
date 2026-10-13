import { expect, readStack, test } from './fixtures.ts';

/*
 * "Estimate this roof" end to end, from the building under a map point to a proposal waiting for the owner's OK.
 * The map click itself (card, highlight, button) is proven by map-roof.test.tsx; a canvas click here would
 * need the live map's projection. Here the same two calls the card makes run against the real stack, then the
 * measuring screen is driven by hand: the picked building is preselected, the free estimate is the default,
 * and a home with no customer asks for one before Make proposal. The browser clock is fixed.
 */

/** Inside fake-ne-1 of the NE footprint fixture (apps/api/test/fixtures/footprints-ne.json). */
const POINT = { lat: 41.2565, lng: -95.9345 };

test('estimate this roof: picked building to a proposal for a new customer', async ({ page, loginAs, markTodaySeen }) => {
  test.setTimeout(60_000);
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
  await expect(page.getByLabel(`Building ${picked}`, { exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: /Free estimate/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Paid report, needs your OK')).toBeVisible();

  const make = page.getByRole('button', { name: 'Make proposal' });
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
