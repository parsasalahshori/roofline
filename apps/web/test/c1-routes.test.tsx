import { calculateQuote, DEFAULT_WORK_HOURS, defaultPricebook, defaultScope, type QuoteView, DEFAULT_WINDOW_ORDER_SETTINGS, resolveCatalog } from '@roofline/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TIER_TEMPLATES } from '@roofline/shared';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { create } from '../src/copy/create.ts';
import { quotes } from '../src/copy/quotes.ts';
import { WINDOW_COPY } from '../src/copy/rail.ts';
import { job } from '../src/copy/job.ts';
import { jobs } from '../src/copy/jobs.ts';
import { prices } from '../src/copy/prices.ts';
import { schedule } from '../src/copy/schedule.ts';
import { settings } from '../src/copy/settings.ts';
import { ACCOUNT, COMPANY, type Routes, SHELL_ROUTES, stubApi, where } from './helpers.tsx';

// The real map loads maplibre-gl, which these tests never need. The stand-in has two pins that open a job and a customer.
vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return {
    MapView: (props: { onOpen: (target: { kind: 'customer' | 'job'; id: string }) => void }) =>
      createElement(
        'div',
        { 'data-map-mock': true },
        createElement('button', { type: 'button', onClick: () => props.onOpen({ kind: 'job', id: 'j9' }) }, 'job pin'),
        createElement('button', { type: 'button', onClick: () => props.onOpen({ kind: 'customer', id: 'c9' }) }, 'customer pin'),
      ),
  };
});

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** A signed-in person whose shell reads answer "nothing", unless a test gives its own answers. */
function signedInApi(account = ACCOUNT, overrides: Routes = {}) {
  // The pipeline board (the /jobs window) reads the board and the team; both are empty here
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: account }),
    'GET /api/jobs/board': () => ({ body: { columns: [], lost: { count: 0 } } }),
    'GET /api/jobs/j1/view': () => ({ status: 404, body: { error: 'Not found' } }),
    'GET /api/team': () => ({ body: { members: [] } }),
    ...overrides,
  });
  return api;
}

/** The shell reads plus the two Prices reads, so the Prices tab can render its E1 sections. */
const PRICES_ROUTES: Routes = {
  'GET /api/tier-templates': () => ({ body: { templates: DEFAULT_TIER_TEMPLATES.map((t) => ({ ...t, addOns: [...t.addOns], highlights: [...t.highlights] })) } }),
  'GET /api/estimator/settings': () => ({ body: { defaultPitchX12: 6, overhangFt: 1, proposalValidDays: 30, aerialMeasure: false, aerialConfigured: false, estimateChangeClause: true, financingAprBps: null, financingTermMonths: null } }),
  'GET /api/instant-quote/settings': () => ({ body: { enabled: false, slug: null, products: ['windows', 'roof'], rangePct: 12, dailyCap: 50, embedOrigins: [], booking: false, accentColor: null, pageUrl: null } }),
  'GET /api/window-order-settings': () => ({ body: DEFAULT_WINDOW_ORDER_SETTINGS }),
  'GET /api/window-catalog': () => ({ body: { catalog: resolveCatalog(null) } }),
};

function renderApp(path: string) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: [path] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, queryClient, user: userEvent.setup() };
}

/** The row of tab links in the Settings window. */
const settingsTabs = () => screen.findByRole('navigation', { name: settings.tabsLabel });

const PRICEBOOK_VIEW = {
  prices: defaultPricebook,
  defaults: { wastePercent: 12, markupPercent: 25, taxPercent: 0, material: 'architectural' as const },
  isExample: false,
};

const SCHEDULE_ROUTES: Routes = {
  'GET /api/calendar/settings': () => ({
    body: { workHours: DEFAULT_WORK_HOURS, travelBufferMinutes: 30, minNoticeMinutes: 120, stuckAfterDays: 14 },
  }),
  'GET /api/calendar/my-hours': () => ({ body: { workHours: DEFAULT_WORK_HOURS, custom: false } }),
};

describe('C1 windows', () => {
  it.each([
    ['/jobs', WINDOW_COPY.jobs.title, jobs.newJob],
    ['/jobs/j1', WINDOW_COPY.jobs.title, job.notFoundTitle],
  ])('%s shows its placeholder in the %s window', async (path, title, copy) => {
    signedInApi();
    renderApp(path);

    const dialog = await screen.findByRole('main', { name: title });
    expect(await within(dialog).findByText(copy)).toBeInTheDocument();
  });

  it('/jobs/j1/quotes/q1 is the quote page, titled for the quote', async () => {
    const quote: QuoteView = {
      id: 'q1',
      jobId: 'j1',
      number: 'Q-0001',
      status: 'draft',
      measurement: { source: 'manual', areaSqFt: 2480, areaType: 'surface', pitch: 6, notes: null },
      scope: defaultScope,
      prices: defaultPricebook,
      calculation: calculateQuote(defaultScope, defaultPricebook),
      notes: null,
      validUntil: '2026-11-12T00:00:00.000Z',
      createdAt: '2026-10-10T12:00:00.000Z',
      finalizedAt: null,
      canEdit: true,
    };
    signedInApi(ACCOUNT, {
      'GET /api/quotes/q1': () => ({ body: quote }),
      'GET /api/company': () => ({ body: { timezone: 'America/Chicago' } }),
    });
    renderApp('/jobs/j1/quotes/q1');

    const page = await screen.findByRole('main', { name: quotes.title('Q-0001') });
    expect(await within(page).findByRole('region', { name: quotes.statsLabel })).toBeInTheDocument();
  });

  it('shows the Jobs tabs on the pipeline, with Pipeline marked as the current page', async () => {
    signedInApi();
    renderApp('/jobs');

    const dialog = await screen.findByRole('main', { name: WINDOW_COPY.jobs.title });
    const tabs = within(dialog).getByRole('navigation', { name: jobs.tabsLabel });
    expect(within(tabs).getByRole('link', { name: jobs.tabs.pipeline })).toHaveAttribute('aria-current', 'page');
    expect(within(tabs).getByRole('link', { name: jobs.tabs.customers })).toHaveAttribute('href', '/customers');
  });

  it('shows the Customers tab as the current page on the customers list', async () => {
    // The real list window reads its first page; this test only checks the tabs, so the page is empty
    signedInApi(ACCOUNT, { 'GET /api/customers?limit=50&offset=0': () => ({ body: { customers: [], total: 0 } }) });
    renderApp('/customers');

    const dialog = await screen.findByRole('main', { name: WINDOW_COPY.customers.title });
    const tabs = within(dialog).getByRole('navigation', { name: jobs.tabsLabel });
    expect(within(tabs).getByRole('link', { name: jobs.tabs.customers })).toHaveAttribute('aria-current', 'page');
  });

  it('shows the Not found window for a path nobody has', async () => {
    signedInApi();
    renderApp('/jobs/x/y/z');

    expect(await screen.findByRole('main', { name: WINDOW_COPY.notFound.title })).toBeInTheDocument();
  });
});

describe('the New job and New customer screens', () => {
  it('/jobs/new shows the New job steps on a page titled New job, under Jobs', async () => {
    signedInApi();
    renderApp('/jobs/new');

    const page = await screen.findByRole('main', { name: create.newJob.title });
    expect((await within(page).findAllByText(create.newJob.stepCustomer)).length).toBeGreaterThan(0);
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', { name: WINDOW_COPY.jobs.title })).toHaveAttribute('href', '/jobs');
  });

  it('/customers/new shows the New customer form in the Customers window', async () => {
    signedInApi();
    renderApp('/customers/new');

    expect(await screen.findByLabelText(create.newCustomer.firstName)).toBeInTheDocument();
  });
});

describe('settings tabs for the C1 screens', () => {
  it('shows Prices to the owner', async () => {
    signedInApi(ACCOUNT, { ...PRICES_ROUTES, 'GET /api/pricebook': () => ({ body: PRICEBOOK_VIEW }) });
    renderApp('/settings/prices');

    expect(await screen.findByText(prices.fields.permit)).toBeInTheDocument();
    expect(within(await settingsTabs()).getByRole('link', { name: settings.tabs.prices })).toBeInTheDocument();
  });

  it('shows Prices to the office', async () => {
    signedInApi({ ...ACCOUNT, role: 'office' }, { ...PRICES_ROUTES, 'GET /api/pricebook': () => ({ body: PRICEBOOK_VIEW }) });
    renderApp('/settings/prices');

    expect(await screen.findByText(prices.fields.permit)).toBeInTheDocument();
    expect(within(await settingsTabs()).getByRole('link', { name: settings.tabs.prices })).toBeInTheDocument();
  });

  it('sends a rep from Prices to Company', async () => {
    signedInApi({ ...ACCOUNT, role: 'rep' }, { 'GET /api/company': () => ({ body: COMPANY }) });
    const { router } = renderApp('/settings/prices');

    await waitFor(() => expect(where(router)).toBe('/settings/company'));
    const tabs = await settingsTabs();
    expect(within(tabs).getByRole('link', { name: settings.tabs.company })).toHaveAttribute('aria-current', 'page');
    expect(within(tabs).queryByRole('link', { name: settings.tabs.prices })).not.toBeInTheDocument();
    expect(screen.queryByText(prices.fields.permit)).not.toBeInTheDocument();
  });

  it('shows Schedule to a rep', async () => {
    signedInApi({ ...ACCOUNT, role: 'rep' }, SCHEDULE_ROUTES);
    renderApp('/settings/schedule');

    expect(await screen.findByRole('region', { name: schedule.yourTitle })).toBeInTheDocument();
  });
});

