import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConsentStatus } from '@roofline/shared';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { customers } from '../src/copy/customers.ts';
import { jobs } from '../src/copy/jobs.ts';
import { WINDOW_COPY } from '../src/copy/dock.ts';
import type { CustomerListItem, CustomerListPage } from '../src/features/customers/api.ts';
import { ACCOUNT, type Routes, SHELL_ROUTES, stubApi } from './helpers.tsx';

// The phone layout is a separate list; these tests use the desktop table.
vi.mock('../src/shell/useIsPhone.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/shell/useIsPhone.ts')>()),
  useIsPhone: () => false,
}));

// The real map loads maplibre-gl, which these tests never need.
vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return {
    MapView: () => createElement('div', { 'data-map-mock': true }),
  };
});

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** A customer as the list endpoint sends it. Pass what differs; `id` and `displayName` are required. */
function customer(overrides: Partial<CustomerListItem> & { id: string; displayName: string }): CustomerListItem {
  return {
    firstName: null,
    lastName: null,
    phones: [],
    emails: [],
    tags: [],
    doNotContact: false,
    smsConsent: { status: 'none', source: null, at: null },
    source: 'manual',
    archivedAt: null,
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-10T12:00:00.000Z',
    ...overrides,
  };
}

/** A page of the list. `total` defaults to the rows given. */
function page(rows: CustomerListItem[], total = rows.length): CustomerListPage {
  return { customers: rows, total };
}

/** The list answer for one `METHOD /path?query` key, as fetch is called. */
const listKey = (query: string) => `GET /api/customers?${query}`;

/** The customers in the table. Consent and tags are read from the same rows. */
const tableFor = () => screen.findByRole('table', { name: customers.list.tableLabel });

/** A signed-in person whose list answers from the routes given. */
function signedIn(account = ACCOUNT, overrides: Routes = {}) {
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: account }),
    'GET /api/jobs/board': () => ({ body: { columns: [], lost: { count: 0 } } }),
    'GET /api/team': () => ({ body: { members: [] } }),
    ...overrides,
  });
  return api;
}

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

/** The four consent rows used by the chip and filter tests. */
const FOUR_STATUSES: [string, ConsentStatus][] = [
  ['Pat Homeowner', 'none'],
  ['Sam Express', 'express'],
  ['Lee Written', 'written'],
  ['Robin Revoked', 'revoked'],
];

function consentRows(): CustomerListItem[] {
  return FOUR_STATUSES.map(([displayName, status], index) =>
    customer({ id: `c${index + 1}`, displayName, smsConsent: { status, source: null, at: null } }),
  );
}

describe('customers list', () => {
  it('search sends q', async () => {
    signedIn(ACCOUNT, {
      [listKey('limit=50&offset=0')]: () => ({ body: page([customer({ id: 'c1', displayName: 'Pat Homeowner' })]) }),
      [listKey('q=smith&limit=50&offset=0')]: () => ({ body: page([customer({ id: 'c2', displayName: 'Ann Smith' })]) }),
    });
    const { user } = renderApp('/customers');

    const search = await screen.findByRole('searchbox', { name: customers.list.searchLabel });
    await user.type(search, 'smith');

    await waitFor(() => expect(api.calls.map((call) => call.url)).toContain('/api/customers?q=smith&limit=50&offset=0'));
    expect(await screen.findByRole('link', { name: 'Ann Smith' })).toBeInTheDocument();
  });

  it('shows the four consent chips with their words', async () => {
    signedIn(ACCOUNT, { [listKey('limit=50&offset=0')]: () => ({ body: page(consentRows()) }) });
    renderApp('/customers');

    const table = within(await tableFor());
    expect(table.getByText(customers.consent.none)).toBeInTheDocument();
    expect(table.getByText(customers.consent.express)).toBeInTheDocument();
    expect(table.getByText(customers.consent.written)).toBeInTheDocument();
    expect(table.getByText(customers.consent.revoked)).toBeInTheDocument();
    expect(table.getByText('No texting consent')).toBeInTheDocument();
    expect(table.getByText('Texts about their own jobs only')).toBeInTheDocument();
    expect(table.getByText('OK to text')).toBeInTheDocument();
    expect(table.getByText('Asked not to be texted')).toBeInTheDocument();
  });

  it('the tag filter narrows the loaded rows with no new request', async () => {
    signedIn(ACCOUNT, {
      [listKey('limit=50&offset=0')]: () => ({
        body: page([
          customer({ id: 'c1', displayName: 'Pat Homeowner', tags: ['roof'] }),
          customer({ id: 'c2', displayName: 'Sam Gutter', tags: ['gutter'] }),
        ]),
      }),
    });
    const { user } = renderApp('/customers');

    await tableFor();
    const before = api.count(listKey('limit=50&offset=0'));
    await user.selectOptions(screen.getByLabelText(customers.list.tagLabel), 'gutter');

    expect(screen.queryByRole('link', { name: 'Pat Homeowner' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sam Gutter' })).toBeInTheDocument();
    expect(api.count(listKey('limit=50&offset=0'))).toBe(before);
  });

  it('the texting filter OK shows only attested and written rows', async () => {
    signedIn(ACCOUNT, {
      [listKey('limit=50&offset=0')]: () =>
        ({
          body: page([
            customer({ id: 'c1', displayName: 'Pat Homeowner', smsConsent: { status: 'none', source: null, at: null } }),
            customer({ id: 'c2', displayName: 'Sam Attested', smsConsent: { status: 'attested', source: null, at: null } }),
            customer({ id: 'c3', displayName: 'Lee Written', smsConsent: { status: 'written', source: null, at: null } }),
            customer({ id: 'c4', displayName: 'Robin Revoked', smsConsent: { status: 'revoked', source: null, at: null } }),
          ]),
        }),
    });
    const { user } = renderApp('/customers');

    await tableFor();
    await user.selectOptions(screen.getByLabelText(customers.list.textingLabel), 'ok');

    expect(screen.getByRole('link', { name: 'Sam Attested' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Lee Written' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pat Homeowner' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Robin Revoked' })).not.toBeInTheDocument();
  });

  it('the Not OK to text filter shows only the rows that are not attested or written', async () => {
    signedIn(ACCOUNT, { [listKey('limit=50&offset=0')]: () => ({ body: page(consentRows()) }) });
    const { user } = renderApp('/customers');

    await tableFor();
    await user.selectOptions(screen.getByLabelText(customers.list.textingLabel), 'not');

    expect(screen.getByRole('link', { name: 'Pat Homeowner' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sam Express' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Robin Revoked' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Lee Written' })).not.toBeInTheDocument();
  });

  it('an owner sees the Download customers link; a rep does not', async () => {
    signedIn(ACCOUNT, { [listKey('limit=50&offset=0')]: () => ({ body: page([]) }) });
    renderApp('/customers');

    expect(await screen.findByRole('link', { name: customers.list.download })).toHaveAttribute('href', '/api/export/customers.csv');
  });

  it('a rep sees no Download customers link', async () => {
    signedIn({ ...ACCOUNT, role: 'rep' }, { [listKey('limit=50&offset=0')]: () => ({ body: page([]) }) });
    renderApp('/customers');

    await screen.findByText(customers.list.empty);
    expect(screen.queryByRole('link', { name: customers.list.download })).not.toBeInTheDocument();
  });

  it('New customer links to /customers/new', async () => {
    signedIn(ACCOUNT, { [listKey('limit=50&offset=0')]: () => ({ body: page([]) }) });
    renderApp('/customers');

    expect(await screen.findByRole('link', { name: customers.list.newCustomer })).toHaveAttribute('href', '/customers/new');
  });

  it('rows link to the customer window', async () => {
    signedIn(ACCOUNT, {
      [listKey('limit=50&offset=0')]: () => ({ body: page([customer({ id: 'c42', displayName: 'Pat Homeowner' })]) }),
    });
    renderApp('/customers');

    expect(await screen.findByRole('link', { name: 'Pat Homeowner' })).toHaveAttribute('href', '/customers/c42');
  });

  it('?q= in the URL pre-fills the search and is sent', async () => {
    signedIn(ACCOUNT, {
      [listKey('q=smith&limit=50&offset=0')]: () => ({ body: page([customer({ id: 'c2', displayName: 'Ann Smith' })]) }),
    });
    renderApp('/customers?q=smith');

    const search = await screen.findByRole('searchbox', { name: customers.list.searchLabel });
    expect(search).toHaveValue('smith');
    await waitFor(() => expect(api.calls.map((call) => call.url)).toContain('/api/customers?q=smith&limit=50&offset=0'));
  });

  it('paging steps by 50 when the total is more than one page', async () => {
    const first = Array.from({ length: 50 }, (_, index) => customer({ id: `a${index}`, displayName: `Customer ${index}` }));
    signedIn(ACCOUNT, {
      [listKey('limit=50&offset=0')]: () => ({ body: page(first, 60) }),
      [listKey('limit=50&offset=50')]: () => ({ body: page([customer({ id: 'b1', displayName: 'Last One' })], 60) }),
    });
    const { user } = renderApp('/customers');

    await user.click(await screen.findByRole('button', { name: customers.list.next }));

    expect(await screen.findByRole('link', { name: 'Last One' })).toBeInTheDocument();
    expect(api.calls.map((call) => call.url)).toContain('/api/customers?limit=50&offset=50');
  });

  it('a list that cannot load shows the failure with a retry', async () => {
    signedIn(ACCOUNT, { [listKey('limit=50&offset=0')]: () => ({ status: 500, body: { error: 'Nope' } }) });
    renderApp('/customers');

    expect(await screen.findByText(customers.list.loadFailed)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: customers.list.retry })).toBeInTheDocument();
  });

  it('the Customers tab is the current page and the list sits in the Customers window', async () => {
    signedIn(ACCOUNT, { [listKey('limit=50&offset=0')]: () => ({ body: page([]) }) });
    renderApp('/customers');

    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.customers.title });
    const tabs = within(dialog).getByRole('navigation', { name: jobs.tabsLabel });
    expect(within(tabs).getByRole('link', { name: jobs.tabs.customers })).toHaveAttribute('aria-current', 'page');
    expect(within(dialog).getByRole('link', { name: customers.list.newCustomer })).toBeInTheDocument();
  });
});
