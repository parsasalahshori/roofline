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
import { WINDOW_COPY } from '../src/copy/rail.ts';
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

/** Picks an option of a filter chip: the chip is named "Label: current", and its list opens under it. */
async function chooseChip(user: ReturnType<typeof userEvent.setup>, label: string, current: string, option: string) {
  await user.click(screen.getByRole('button', { name: `${label}: ${current}` }));
  await user.click(await screen.findByRole('option', { name: option }));
}

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
    await chooseChip(user, customers.list.tagLabel, customers.list.allTags, 'gutter');

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
    await chooseChip(user, customers.list.textingLabel, customers.list.allTexting, customers.list.textingOk);

    expect(screen.getByRole('link', { name: 'Sam Attested' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Lee Written' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pat Homeowner' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Robin Revoked' })).not.toBeInTheDocument();
  });

  it('the Not OK to text filter shows only the rows that are not attested or written', async () => {
    signedIn(ACCOUNT, { [listKey('limit=50&offset=0')]: () => ({ body: page(consentRows()) }) });
    const { user } = renderApp('/customers');

    await tableFor();
    await chooseChip(user, customers.list.textingLabel, customers.list.allTexting, customers.list.textingNot);

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

    const dialog = await screen.findByRole('main', { name: WINDOW_COPY.customers.title });
    const tabs = within(dialog).getByRole('navigation', { name: jobs.tabsLabel });
    expect(within(tabs).getByRole('link', { name: jobs.tabs.customers })).toHaveAttribute('aria-current', 'page');
    expect(within(dialog).getByRole('link', { name: customers.list.newCustomer })).toBeInTheDocument();
  });

  it('the head counts the customers, and says how many match a search', async () => {
    signedIn(ACCOUNT, {
      [listKey('limit=50&offset=0')]: () => ({ body: page([customer({ id: 'c1', displayName: 'Pat Homeowner' })], 142) }),
      [listKey('q=smith&limit=50&offset=0')]: () => ({ body: page([customer({ id: 'c2', displayName: 'Ann Smith' })], 3) }),
    });
    const { user } = renderApp('/customers');

    const main = await screen.findByRole('main', { name: WINDOW_COPY.customers.title });
    expect(await within(main).findByText(customers.list.count(142))).toBeInTheDocument();
    await user.type(within(main).getByRole('searchbox', { name: customers.list.searchLabel }), 'smith');
    expect(await within(main).findByText(customers.list.matches(3))).toBeInTheDocument();
  });

  it('the Archived chip asks for archived customers too, and is pressed while on', async () => {
    signedIn(ACCOUNT, {
      [listKey('limit=50&offset=0')]: () => ({ body: page([customer({ id: 'c1', displayName: 'Pat Homeowner' })]) }),
      [listKey('limit=50&offset=0&includeArchived=true')]: () => ({
        body: page([
          customer({ id: 'c1', displayName: 'Pat Homeowner' }),
          customer({ id: 'c2', displayName: 'Old Customer', archivedAt: '2026-09-01T12:00:00.000Z' }),
        ]),
      }),
    });
    const { user } = renderApp('/customers');

    const chip = await screen.findByRole('button', { name: customers.list.archivedFilter });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    await user.click(chip);
    expect(await screen.findByRole('link', { name: 'Old Customer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: customers.list.archivedFilter })).toHaveAttribute('aria-pressed', 'true');
    // An archived customer says so in a tag
    expect(within(await tableFor()).getByText(customers.list.archivedChip)).toBeInTheDocument();
  });

  it('a row shows the phone in mono, the texting tag and the tags; a hold is marked with its words', async () => {
    signedIn(ACCOUNT, {
      [listKey('limit=50&offset=0')]: () => ({
        body: page([
          customer({
            id: 'c1',
            displayName: 'Ashley Thomas',
            phones: [{ number: '(402) 555-0144', label: null, primary: true }],
            tags: ['hail'],
            doNotContact: true,
            smsConsent: { status: 'written', source: null, at: null },
          }),
        ]),
      }),
    });
    renderApp('/customers');

    const row = within(await tableFor()).getByRole('row', { name: /Ashley Thomas/ });
    expect(within(row).getByText('(402) 555-0144')).toBeInTheDocument();
    expect(within(row).getByText(customers.consent.written)).toBeInTheDocument();
    expect(within(row).getByText('hail')).toBeInTheDocument();
    expect(within(row).getByText(customers.doNotContact)).toBeInTheDocument();
  });

  it('shows the Tags column only while some customer in the list has a tag', async () => {
    signedIn(ACCOUNT, {
      [listKey('limit=50&offset=0')]: () => ({ body: page([customer({ id: 'c1', displayName: 'Pat Homeowner' })]) }),
      [listKey('q=roof&limit=50&offset=0')]: () => ({
        body: page([customer({ id: 'c2', displayName: 'Sam Gutter', tags: ['roof'] })]),
      }),
    });
    const { user } = renderApp('/customers');

    // No row has a tag: the column would be a header over blank cells
    const table = within(await tableFor());
    expect(table.queryByRole('columnheader', { name: customers.list.columnTags })).toBeNull();
    expect(table.getAllByRole('columnheader')).toHaveLength(3);

    // A page with a tagged customer brings it back
    await user.type(screen.getByRole('searchbox', { name: customers.list.searchLabel }), 'roof');
    expect(await within(await tableFor()).findByRole('columnheader', { name: customers.list.columnTags })).toBeInTheDocument();
    expect(within(await tableFor()).getByText('roof')).toBeInTheDocument();
  });

  it('no customers yet shows what the list is for and a New customer button', async () => {
    signedIn(ACCOUNT, { [listKey('limit=50&offset=0')]: () => ({ body: page([]) }) });
    renderApp('/customers');

    expect(await screen.findByText(customers.list.empty)).toBeInTheDocument();
    expect(screen.getByText(customers.list.emptyBody)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: customers.list.newCustomer }).length).toBeGreaterThan(1);
  });

  it('a filter that matches nothing offers to clear the filters', async () => {
    signedIn(ACCOUNT, {
      [listKey('limit=50&offset=0')]: () => ({ body: page([customer({ id: 'c1', displayName: 'Pat Homeowner', tags: ['roof'] })]) }),
    });
    const { user } = renderApp('/customers');

    await tableFor();
    await chooseChip(user, customers.list.textingLabel, customers.list.allTexting, customers.list.textingOk);
    expect(await screen.findByText(customers.list.noMatches)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: customers.list.clearFilters }));
    expect(await screen.findByRole('link', { name: 'Pat Homeowner' })).toBeInTheDocument();
  });

  it('a failed list shows the error tag in place', async () => {
    signedIn(ACCOUNT, { [listKey('limit=50&offset=0')]: () => ({ status: 500, body: { error: 'Nope' } }) });
    renderApp('/customers');

    expect(await screen.findByText(customers.list.errorTag)).toBeInTheDocument();
  });
});

describe('phone numbers', () => {
  it('a US number reads as (402) 555-0144 in the list; any other number stays as it was typed', async () => {
    signedIn(ACCOUNT, {
      [listKey('limit=50&offset=0')]: () => ({
        body: page([
          customer({ id: 'c1', displayName: 'Ashley Thomas', phones: [{ number: '+14025550144', label: null, primary: true }] }),
          customer({ id: 'c2', displayName: 'Pat Abroad', phones: [{ number: '+442071838750', label: null, primary: true }] }),
        ]),
      }),
    });
    renderApp('/customers');

    const table = within(await tableFor());
    expect(table.getByText('(402) 555-0144')).toBeInTheDocument();
    expect(table.getByText('+442071838750')).toBeInTheDocument();
  });
});
