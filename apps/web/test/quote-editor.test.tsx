import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { calculateQuote, defaultPricebook, defaultScope, money, type Pricebook, type QuoteView, type Scope } from '@roofline/shared';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import type { CompanyBody } from '../src/api/types.ts';
import { quotes } from '../src/copy/quotes.ts';
import { QuoteWindow } from '../src/features/quotes/QuoteWindow.tsx';
import { type Reply, stubApi } from './helpers.tsx';

const phoneMode = vi.hoisted(() => ({ phone: false }));
vi.mock('../src/shell/useIsPhone.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/shell/useIsPhone.ts')>()),
  useIsPhone: () => phoneMode.phone,
}));

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  phoneMode.phone = false;
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** The prices a quote was priced on when it was made: differ from the live example on purpose. */
const snapshotPrices: Pricebook = { ...defaultPricebook, architecturalBundle: 50 };

/** A quote as the server sends it. Pass what differs. */
function makeQuote(overrides: Partial<QuoteView> = {}): QuoteView {
  const scope = overrides.scope ?? defaultScope;
  const prices = overrides.prices ?? defaultPricebook;
  return {
    id: 'q1',
    jobId: 'j1',
    number: 'Q-0001',
    status: 'draft',
    measurement: { source: 'manual', areaSqFt: 2480, areaType: 'surface', pitch: 6, notes: null },
    scope,
    prices,
    calculation: calculateQuote(scope, prices),
    notes: null,
    validUntil: '2026-11-12T00:00:00.000Z',
    createdAt: '2026-10-10T12:00:00.000Z',
    finalizedAt: null,
    canEdit: true,
    ...overrides,
  };
}

const finalQuote = (overrides: Partial<QuoteView> = {}) =>
  makeQuote({ status: 'final', finalizedAt: '2026-10-12T03:00:00.000Z', ...overrides });

const company: Partial<CompanyBody> = { timezone: 'America/Chicago' };

/** The part of the job's view the quote page reads: the customer, whose name is on the way back to the job. */
const jobView = { customer: { id: 'cu1', displayName: 'Dana Whitfield', phone: null, email: null } };

/** Stubs the reads the window makes, plus whatever the test adds. */
function stubQuote(quote: QuoteView, routes: Record<string, () => Reply> = {}) {
  api = stubApi({
    'GET /api/company': () => ({ body: company }),
    'GET /api/jobs/j1/view': () => ({ body: jobView }),
    'GET /api/quotes/q1': () => ({ body: quote }),
    ...routes,
  });
  return api;
}

function renderQuote(path = '/jobs/j1/quotes/q1') {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createMemoryRouter(
    [
      { path: '/jobs/:jobId/quotes/:quoteId', element: <QuoteWindow /> },
      { path: '*', element: <p>elsewhere</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, user: userEvent.setup() };
}

/** The roof-area field and the other number boxes are labelled by the copy, so they are found by label. */
const field = (label: string) => screen.findByLabelText(label);

/** Types a new value into a number box: clear it, then type. */
async function setNumber(user: ReturnType<typeof userEvent.setup>, label: string, value: string) {
  const box = await field(label);
  await user.clear(box);
  await user.type(box, value);
}

describe('quote editor', () => {
  it('shows the live total equal to calculateQuote for the default scope', async () => {
    stubQuote(makeQuote());
    renderQuote();

    const total = money(calculateQuote(defaultScope, defaultPricebook).totalCents);
    await waitFor(() => expect(screen.getAllByText(total).length).toBeGreaterThanOrEqual(2));
    expect(screen.getAllByText(quotes.estimateLabel).length).toBeGreaterThanOrEqual(1);
  });

  it('recomputes from the frozen price snapshot when the scope changes', async () => {
    stubQuote(makeQuote({ prices: snapshotPrices, calculation: calculateQuote(defaultScope, snapshotPrices) }));
    const { user } = renderQuote();

    await setNumber(user, quotes.waste, '20');

    const expected = money(calculateQuote({ ...defaultScope, wastePercent: 20 }, snapshotPrices).totalCents);
    await waitFor(() => expect(screen.getAllByText(expected).length).toBeGreaterThanOrEqual(2));
    expect(api.calls.filter((call) => /pricebook|price/i.test(call.url))).toEqual([]);
  });

  it('saves the whole scope with PATCH', async () => {
    const saved: Scope = { ...defaultScope, wastePercent: 20 };
    stubQuote(makeQuote(), {
      'PATCH /api/quotes/q1': () => ({ body: makeQuote({ scope: saved, calculation: calculateQuote(saved, defaultPricebook) }) }),
    });
    const { user } = renderQuote();

    await setNumber(user, quotes.waste, '20');
    await user.click(await screen.findByRole('button', { name: quotes.save }));

    await waitFor(() => expect(api.sent('PATCH /api/quotes/q1')).toHaveLength(1));
    expect(api.sent('PATCH /api/quotes/q1')[0]).toEqual({
      measurement: { source: 'manual', areaSqFt: 2480, areaType: 'surface', pitch: 6, notes: null },
      scope: { ...defaultScope, wastePercent: 20 },
      notes: null,
    });
    await screen.findByText(quotes.saved);
  });

  it('makes the inputs read-only and shows Copy when the quote is final', async () => {
    stubQuote(finalQuote());
    renderQuote();

    expect(await field(quotes.area)).toBeDisabled();
    expect(screen.queryByRole('button', { name: quotes.save })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: quotes.markFinal })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: quotes.copy })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: quotes.downloadPdf })).toBeInTheDocument();
  });

  it('shows the final date in the company time zone', async () => {
    // 03:00 UTC on the 12th is still the 11th in Chicago
    stubQuote(finalQuote());
    renderQuote();

    expect(await screen.findByText(quotes.finalizedOn('Oct 11, 2026'))).toBeInTheDocument();
  });

  it('marks a quote final after the confirm', async () => {
    stubQuote(makeQuote(), {
      'POST /api/quotes/q1/finalize': () => ({ body: finalQuote() }),
    });
    const { user } = renderQuote();

    await user.click(await screen.findByRole('button', { name: quotes.markFinal }));
    const dialog = await screen.findByRole('dialog', { name: quotes.confirmFinalTitle });
    await user.click(within(dialog).getByRole('button', { name: quotes.confirmFinal }));

    await waitFor(() => expect(api.count('POST /api/quotes/q1/finalize')).toBe(1));
  });

  it('copies to a new quote and navigates to it', async () => {
    const copy = makeQuote({ id: 'q2', status: 'draft', finalizedAt: null });
    stubQuote(finalQuote(), {
      'POST /api/quotes/q1/copy': () => ({ status: 201, body: copy }),
      'GET /api/quotes/q2': () => ({ body: copy }),
    });
    const { router, user } = renderQuote();

    await user.click(await screen.findByRole('button', { name: quotes.copy }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/jobs/j1/quotes/q2'));
  });

  it('keeps Save and Mark final off while a number box is invalid', async () => {
    stubQuote(makeQuote());
    const { user } = renderQuote();

    // Make the draft dirty first, so the invalid box (not the clean draft) is what disables Save
    await setNumber(user, quotes.tax, '7');
    await user.clear(await field(quotes.waste));

    expect(await screen.findByRole('button', { name: quotes.save })).toBeDisabled();
    expect(screen.getByRole('button', { name: quotes.markFinal })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: quotes.save }));
    expect(api.sent('PATCH /api/quotes/q1')).toHaveLength(0);
  });

  it('links the PDF download to the quote pdf route', async () => {
    stubQuote(makeQuote());
    renderQuote();

    expect(await screen.findByRole('link', { name: quotes.downloadPdf })).toHaveAttribute('href', '/api/quotes/q1/pdf');
  });
});

describe('quote page', () => {
  it('the number is the title; Jobs and the job, named for its customer, are in the trail', async () => {
    stubQuote(makeQuote());
    renderQuote();

    expect(await screen.findByRole('heading', { level: 1, name: quotes.title('Q-0001') })).toBeInTheDocument();
    const trail = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(trail.getByRole('link', { name: 'Jobs' })).toHaveAttribute('href', '/jobs');
    expect(await trail.findByRole('link', { name: 'Dana Whitfield' })).toHaveAttribute('href', '/jobs/j1');
  });

  it('until the job is known the trail says Job, and a job that will not load does not break the page', async () => {
    stubQuote(makeQuote(), { 'GET /api/jobs/j1/view': () => ({ status: 500, body: { error: 'x' } }) });
    renderQuote();

    expect(await screen.findByRole('heading', { level: 1, name: quotes.title('Q-0001') })).toBeInTheDocument();
    const trail = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(trail.getByRole('link', { name: quotes.crumbJob })).toHaveAttribute('href', '/jobs/j1');
  });

  it('the summary strip: status, the total as an estimate, and until when the price is good and when it was made', async () => {
    stubQuote(makeQuote());
    renderQuote();

    const strip = within(await screen.findByRole('region', { name: quotes.statsLabel }));
    expect(strip.getByText(quotes.status.draft)).toBeInTheDocument();
    expect(strip.getByText(quotes.notFinal)).toBeInTheDocument();
    expect(strip.getByText(money(calculateQuote(defaultScope, defaultPricebook).totalCents))).toBeInTheDocument();
    expect(strip.getByText(quotes.estimateLabel)).toBeInTheDocument();
    // 00:00 UTC on the 12th is still the evening of the 11th in Chicago
    expect(strip.getByText('Nov 11')).toBeInTheDocument();
    expect(strip.getByText(quotes.madeOn('Oct 10, 2026'))).toBeInTheDocument();
  });

  it('a final quote says Final in the strip, and when', async () => {
    stubQuote(finalQuote());
    renderQuote();

    const strip = within(await screen.findByRole('region', { name: quotes.statsLabel }));
    expect(strip.getByText(quotes.status.final)).toBeInTheDocument();
    expect(strip.getByText(quotes.finalizedOn('Oct 11, 2026'))).toBeInTheDocument();
    expect(strip.queryByText(quotes.notFinal)).toBeNull();
  });

  it('the price lines are a table in a panel, with the totals under them', async () => {
    stubQuote(makeQuote());
    renderQuote();

    const panel = within(await screen.findByRole('region', { name: quotes.priceLinesHeading }));
    const table = panel.getByRole('table', { name: quotes.linesLabel });
    expect(within(table).getAllByRole('row').length).toBeGreaterThan(2);
    expect(within(table).getByRole('columnheader', { name: quotes.colAmount })).toHaveAttribute('data-numeric', 'true');
    expect(panel.getByLabelText(quotes.totalsLabel)).toBeInTheDocument();
  });

  it('a quote that does not load says so, in place, and can be tried again', async () => {
    let calls = 0;
    stubQuote(makeQuote(), {
      'GET /api/quotes/q1': () => {
        calls += 1;
        return calls === 1 ? { status: 500, body: { error: 'x' } } : { body: makeQuote() };
      },
    });
    const { user } = renderQuote();

    const alert = (await screen.findByText(quotes.loadFailed)).closest('[role="alert"]');
    expect(alert).not.toBeNull();
    await user.click(within(alert as HTMLElement).getByRole('button', { name: quotes.retry }));
    expect(await screen.findByRole('heading', { level: 1, name: quotes.title('Q-0001') })).toBeInTheDocument();
  });

  it('on a phone the lines keep two columns: the quantity and the rate go under the name', async () => {
    phoneMode.phone = true;
    const quote = makeQuote();
    stubQuote(quote);
    renderQuote();

    const table = within(await screen.findByRole('table', { name: quotes.linesLabel }));
    expect(table.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([quotes.colName, quotes.colAmount]);
    const first = quote.calculation.lines[0]!;
    expect(table.getByText(quotes.lineDetail(quotes.quantityWithUnit(first.quantity, first.unit), money(first.unitCents)))).toBeInTheDocument();
    expect(table.getByText(money(first.totalCents))).toBeInTheDocument();
  });

  it('a desktop keeps four columns', async () => {
    stubQuote(makeQuote());
    renderQuote();

    const table = within(await screen.findByRole('table', { name: quotes.linesLabel }));
    expect(table.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([quotes.colName, quotes.colQuantity, quotes.colRate, quotes.colAmount]);
  });

  it('a quote that is not there says so in place, with a way back to the jobs', async () => {
    stubQuote(makeQuote(), { 'GET /api/quotes/q1': () => ({ status: 404, body: { error: 'Not found' } }) });
    renderQuote();

    expect(await screen.findByText(quotes.notFound)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: quotes.pageTitle })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: quotes.backToJobs })).toHaveAttribute('href', '/jobs');
  });

  it('while it loads, a status names the wait and the page is already titled Quote', async () => {
    api = stubApi({
      'GET /api/company': () => ({ body: company }),
      'GET /api/jobs/j1/view': () => ({ body: jobView }),
      'GET /api/quotes/q1': () => new Promise(() => undefined) as never,
    });
    renderQuote();

    expect(await screen.findByRole('status', { name: quotes.loading })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: quotes.pageTitle })).toBeInTheDocument();
  });

  it('on a phone the total is pinned at the foot of the screen', async () => {
    phoneMode.phone = true;
    stubQuote(makeQuote());
    renderQuote();

    await screen.findByRole('heading', { level: 1, name: quotes.title('Q-0001') });
    const total = money(calculateQuote(defaultScope, defaultPricebook).totalCents);
    // The totals under the lines and the pinned bar; the strip keeps to the status and the date
    expect(screen.getAllByText(total)).toHaveLength(2);
    expect(within(screen.getByRole('region', { name: quotes.statsLabel })).queryByText(total)).toBeNull();
  });

  it('a desktop has no pinned total', async () => {
    stubQuote(makeQuote());
    renderQuote();

    await screen.findByRole('heading', { level: 1, name: quotes.title('Q-0001') });
    expect(screen.getAllByText(money(calculateQuote(defaultScope, defaultPricebook).totalCents))).toHaveLength(2);
  });
});
