import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { customers } from '../src/copy/customers.ts';
import type { CustomerListItem, CustomerListPage } from '../src/features/customers/api.ts';
import { ACCOUNT, SHELL_ROUTES, stubApi } from './helpers.tsx';

// This file is the phone's list of cards (customers-list.test.tsx is the desktop table).
vi.mock('../src/shell/useIsPhone.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/shell/useIsPhone.ts')>()),
  useIsPhone: () => true,
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

function renderCustomers(rows: CustomerListItem[]) {
  const body: CustomerListPage = { customers: rows, total: rows.length };
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/jobs/board': () => ({ body: { columns: [], lost: { count: 0 } } }),
    'GET /api/team': () => ({ body: { members: [] } }),
    'GET /api/customers?limit=50&offset=0': () => ({ body }),
  });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={createAppRouter({ initialEntries: ['/customers'] })} />
    </Providers>,
  );
  return userEvent.setup();
}

describe('the customers list on a phone', () => {
  it('has no slot for a phone number on a card whose customer has none, so its texting tag starts where the name does', async () => {
    renderCustomers([
      customer({ id: 'c1', displayName: 'Ashley Perez' }),
      customer({ id: 'c2', displayName: 'Ashley Thomas', phones: [{ number: '(402) 555-0144', label: null, primary: true }] }),
    ]);

    const list = await screen.findByRole('list', { name: customers.list.tableLabel });
    const [without, withNumber] = within(list).getAllByRole('listitem');
    // The card with no number says nothing about one: no dash and no words for it (the table has them, a card has no column to fill)
    expect(within(without!).queryByText(customers.list.noPhoneDash)).toBeNull();
    expect(within(without!).queryByText('(402) 555-0144')).toBeNull();
    expect(within(without!).getByText(customers.consent.none)).toBeInTheDocument();
    expect(within(withNumber!).getByText('(402) 555-0144')).toBeInTheDocument();
  });
});
