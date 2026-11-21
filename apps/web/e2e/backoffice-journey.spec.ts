import { inflateSync } from 'node:zlib';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, readStack, test } from './fixtures.ts';

/*
 * The WinChoice back office, start to finish: the office user quotes a customer two designed windows, the price adds up,
 * a discount over the rep limit waits for the owner, the owner approves it, the customer accepts and the factory order is
 * released (its PDF lists both windows), and the order moves two stages with the status history on the order page.
 * The back office is switched on for the e2e company here (it is on for the WinChoice demo company only).
 */

const dollars = (cents: number): string => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** The text of a PDF the way pdfkit writes it (Helvetica as hex strings in TJ arrays, page streams deflated). */
function pdfText(bytes: Buffer): string {
  const raw = bytes.toString('latin1');
  const bodies = [raw];
  for (const m of raw.matchAll(/\/Length (\d+)\b[^]*?>>\s*stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    try {
      bodies.push(inflateSync(Buffer.from(raw.slice(start, start + Number(m[1])), 'latin1')).toString('latin1'));
    } catch {
      // not a deflated stream
    }
  }
  const pieces: string[] = [];
  for (const body of bodies) {
    for (const m of body.matchAll(/\[([^\]]*)\] TJ/g)) pieces.push(Buffer.from([...m[1]!.matchAll(/<([0-9a-f]*)>/g)].map((h) => h[1]).join(''), 'hex').toString('latin1'));
  }
  return pieces.join(' ').replace(/\s+/g, ' ');
}

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(path, { data, headers: { Origin: readStack().baseUrl } });
  expect(response.status(), `${path}: ${await response.text()}`).toBeLessThan(300);
  return (await response.json()) as T;
}

/** A customer with an email (no texting consent, so the text is skipped the same way every time), an address and a job. */
async function seedJob(page: Page, db: { query: (text: string, values?: unknown[]) => Promise<unknown> }): Promise<{ jobId: string }> {
  const customer = await post<{ id: string }>(page.request, '/api/customers', { displayName: 'Dana Whitfield', firstName: 'Dana' });
  const property = await post<{ id: string }>(page.request, '/api/properties', { addressLine: '4417 Larkspur Lane', city: 'Little Rock', state: 'AR', zip: '72205', customerId: customer.id });
  const job = await post<{ id: string }>(page.request, '/api/jobs', { customerId: customer.id, propertyId: property.id, stage: 'proposal', valueCents: 100 });
  await db.query(`update customers set emails = $2::jsonb, phones = $3::jsonb, sms_consent_status = 'none' where id = $1`, [
    customer.id,
    JSON.stringify(['dana@example.test']),
    JSON.stringify([{ e164: '+14025550111', label: 'mobile', primary: true }]),
  ]);
  return { jobId: job.id };
}

test('quote two windows, approve the discount, accept, release the factory order, move the order', async ({ page, browser, loginAs, db, scenario }) => {
  await db.query(
    `insert into company_settings (company_id, backoffice_enabled) values ($1, true) on conflict (company_id) do update set backoffice_enabled = true`,
    [scenario.a.companyId],
  );
  await loginAs(page, 'office');
  await seedJob(page, db);

  // 1. The office user opens the back office and starts a quote for the customer.
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Apps' }).getByRole('link', { name: 'Back office' }).click();
  await expect(page).toHaveURL(/\/backoffice$/);
  await page.getByRole('button', { name: 'New quote' }).first().click();
  await page.getByLabel('Which job is this for?').selectOption({ label: 'Dana Whitfield, 4417 Larkspur Lane' });
  await page.getByRole('button', { name: 'Start the quote' }).click();
  await expect(page).toHaveURL(/\/backoffice\/quotes\/[0-9a-f-]{36}$/);
  const quoteId = page.url().split('/').pop()!;
  await expect(page.getByRole('heading', { name: 'Dana Whitfield' })).toBeVisible();

  // 2. Two designed windows: the first with a colour and a grid, the second a plain picture window.
  await page.getByRole('button', { name: /Add unit/ }).click();
  const inspector = page.getByRole('complementary', { name: /Unit editor for/ });
  await inspector.getByLabel('Room', { exact: true }).fill('Kitchen');
  await inspector.getByLabel('Width', { exact: true }).fill('35 1/2');
  await inspector.getByLabel('Width', { exact: true }).press('Enter');
  await inspector.getByLabel('Height', { exact: true }).fill('59 1/2');
  await inspector.getByLabel('Height', { exact: true }).press('Enter');
  await inspector.getByLabel('Outside colour').selectOption({ label: 'Bronze exterior' });
  await inspector.getByLabel('Grid style').selectOption({ label: 'Colonial grids' });
  await inspector.getByLabel('Grid, top sash').selectOption({ label: '3 x 2 lites' });
  await inspector.getByLabel('Grid, bottom sash').selectOption({ label: '3 x 2 lites' });
  await inspector.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('button', { name: /Add unit/ }).click();
  await inspector.getByLabel('Room', { exact: true }).fill('Den');
  await inspector.getByLabel('Product', { exact: true }).selectOption({ label: 'WinChoice Picture Window' });
  await inspector.getByLabel('Width', { exact: true }).fill('60');
  await inspector.getByLabel('Width', { exact: true }).press('Enter');
  await inspector.getByLabel('Height', { exact: true }).fill('48');
  await inspector.getByLabel('Height', { exact: true }).press('Enter');
  await inspector.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('All changes saved')).toBeVisible();

  // 3. The price adds up: the lines are the units and the extras, and the total on the page is the server's.
  const read = async (api: APIRequestContext) => {
    const response = await api.get(`/api/backoffice/quotes/${quoteId}`);
    expect(response.status()).toBe(200);
    return (await response.json()) as {
      designs: { label: string; widthIn: number; heightIn: number; gridType: string; options: Record<string, string> }[];
      lines: { better: { amountCents: number }[] };
      totals: { better: { subtotalCents: number; markupCents: number; discountCents: number; totalCents: number } };
      discountNeedsApproval: boolean;
      discountApprovedPercent: number | null;
      status: string;
    };
  };
  const drawn = await read(page.request);
  expect(drawn.designs.map((d) => d.label)).toEqual(['Kitchen', 'Den']);
  expect(drawn.designs[0]).toMatchObject({ widthIn: 35.5, heightIn: 59.5, gridType: 'colonial', options: { 'exterior-color': expect.stringContaining('bronze') } });
  const sum = drawn.lines.better.reduce((total, line) => total + line.amountCents, 0);
  expect(drawn.totals.better.subtotalCents).toBe(sum);
  expect(drawn.totals.better.totalCents).toBe(sum + drawn.totals.better.markupCents);
  await expect(page.getByTestId('grand-total')).toHaveText(dollars(drawn.totals.better.totalCents));

  // 4. A discount over the rep limit waits for an approval, and the customer's yes is blocked until then.
  await page.getByRole('textbox', { name: 'Discount' }).fill('15');
  await expect(page.getByText('Needs office approval').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Customer accepted: make the order' })).toBeDisabled();
  await expect(page.getByText('All changes saved')).toBeVisible();
  const discounted = await read(page.request);
  expect(discounted.discountNeedsApproval).toBe(true);
  expect(discounted.totals.better.discountCents).toBeGreaterThan(0);
  expect(discounted.totals.better.totalCents).toBe(sum + discounted.totals.better.markupCents - discounted.totals.better.discountCents);

  // 5. The owner opens the same quote and approves the discount.
  const ownerContext = await browser.newContext({ baseURL: readStack().baseUrl });
  try {
    const ownerPage = await ownerContext.newPage();
    await loginAs(ownerPage, 'owner');
    await ownerPage.goto(`/backoffice/quotes/${quoteId}`);
    await expect(ownerPage.getByRole('heading', { name: 'Dana Whitfield' })).toBeVisible();
    await ownerPage.getByRole('button', { name: 'Approve this discount' }).click();
    await expect(ownerPage.getByText(/15% approved by/)).toBeVisible();
  } finally {
    await ownerContext.close();
  }
  expect((await read(page.request)).discountApprovedPercent).toBe(15);

  // 6. Back at the office: the approval shows after a reload and the customer accepts.
  await page.reload();
  await expect(page.getByText(/15% approved by/)).toBeVisible();
  const accept = page.getByRole('button', { name: 'Customer accepted: make the order' });
  await expect(accept).toBeEnabled();
  await accept.click();
  await expect(page).toHaveURL(/\/backoffice\/orders\/[0-9a-f-]{36}$/);
  const orderId = page.url().split('/').pop()!;
  const accepted = await read(page.request);
  expect(accepted.status).toBe('accepted');

  // 7. The factory order is released: the order says so, and its PDF lists both windows with sizes and options.
  await expect(page.getByText('Factory order released')).toBeVisible();
  const factory = page.getByRole('link', { name: /Open the factory order/ });
  await expect(factory).toHaveAttribute('href', `/api/backoffice/quotes/${quoteId}/documents/factory-order`);
  const pdf = await page.request.get(`/api/backoffice/quotes/${quoteId}/documents/factory-order`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  const text = pdfText(await pdf.body());
  expect(text).not.toContain('DRAFT');
  for (const word of ['Kitchen', 'Den', '35 1/2', '59 1/2', 'Bronze', 'Picture']) expect(text).toContain(word);
  // The accepted quote is locked
  await page.goto(`/backoffice/quotes/${quoteId}`);
  await expect(page.getByText('The customer accepted this quote, so it is locked.')).toBeVisible();

  // 8. Two stage moves, each telling the customer through the fakes; the order page keeps the history.
  await page.goto(`/backoffice/orders/${orderId}`);
  await expect(page.getByText('Sold').first()).toBeVisible();
  for (const stage of ['Measure booked', 'Measured']) {
    await page.getByRole('button', { name: `Move to ${stage}` }).click();
    await page.getByRole('button', { name: 'Move the order' }).click();
    await expect(page.getByRole('button', { name: 'Move the order' })).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Order timeline' }).getByText(stage, { exact: true })).toBeVisible();
  }
  const history = page.getByRole('list', { name: 'Order timeline' }).getByRole('listitem');
  await expect(history).toHaveCount(3);
  // Newest first: Measured, Measure booked, Sold ("Quote accepted", automatic)
  await expect(history.nth(0)).toContainText('Measured');
  await expect(history.nth(0)).toContainText('Email sent');
  await expect(history.nth(0)).toContainText('Text not sent: no texting consent');
  await expect(history.nth(1)).toContainText('Measure booked');
  await expect(history.nth(2)).toContainText('Quote accepted');

  // The same order from the API: the stage and one event per move, no duplicates
  const order = (await (await page.request.get(`/api/backoffice/orders/${orderId}`)).json()) as { stage: string; events: { stage: string }[] };
  expect(order.stage).toBe('measured');
  expect(order.events.map((e) => e.stage)).toEqual(['sold', 'measure-booked', 'measured']);
});
