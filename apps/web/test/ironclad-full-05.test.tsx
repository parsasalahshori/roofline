import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobCard } from '@roofline/shared';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { customers } from '../src/copy/customers.ts';
import { jobs } from '../src/copy/jobs.ts';
import type { CustomerListItem } from '../src/features/customers/api.ts';
import { ACCOUNT, SHELL_ROUTES, stubApi, type Routes } from './helpers.tsx';

const mode = vi.hoisted(() => ({ phone: false }));
vi.mock('../src/shell/useIsPhone.ts', async (original) => ({
  ...(await original<typeof import('../src/shell/useIsPhone.ts')>()),
  useIsPhone: () => mode.phone,
}));
vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return { MapView: () => createElement('div') };
});
let api: ReturnType<typeof stubApi>;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mode.phone = false;
  expect(api?.unexpected ?? []).toEqual([]);
});
const card: JobCard = {
  id: 'job-05', customerId: 'customer-05', propertyId: 'home-05', customerName: 'Alex Rooftop',
  addressLine: '12 Test Lane', stage: 'lead', valueCents: null, assigned: null,
  daysInStage: 2, stuck: false, nextStep: 'Book inspection', nextStepOn: null,
  updatedAt: '2026-10-12T12:00:00.000Z',
};
const board = { columns: [{ stage: 'lead', count: 1, totalCents: null, jobs: [card] }], lost: { count: 0 } };
function mount(path: string, routes: Routes = {}, rep = false) {
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role: rep ? 'rep' : 'owner' } }),
    'GET /api/team': () => ({ body: { members: [] } }),
    'GET /api/jobs/board': () => ({ body: board }),
    ...routes,
  });
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: [path] });
  render(<Providers client={client}><RouterProvider router={router} /></Providers>);
  return { router, user: userEvent.setup() };
}
function customer(id: string, consent: 'none' | 'written'): CustomerListItem {
  return {
    id, displayName: id, firstName: null, lastName: null, phones: [], emails: [], tags: [],
    doNotContact: false, smsConsent: { status: consent, source: null, at: null }, source: 'manual',
    archivedAt: null, createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z',
  };
}

describe('Ironclad CRM usability without changing contracts', () => {
  it('switches board and list while keeping the complete filter and hidden rep money', async () => {
    const query = 'assigned=me&source=referral&q=Alex&archived=true';
    const { router, user } = mount(`/jobs?${query}`, {
      [`GET /api/jobs/board?${query}`]: () => ({ body: board }),
    }, true);
    await screen.findByRole('region', { name: jobs.boardLabel });
    await user.click(screen.getByRole('button', { name: 'List view' }));
    const table = await screen.findByRole('table', { name: jobs.listLabel });
    expect(within(table).getByRole('link', { name: /Alex Rooftop/ })).toHaveAttribute('href', '/jobs/job-05');
    for (const [key, value] of new URLSearchParams(query)) expect(new URLSearchParams(router.state.location.search).get(key)).toBe(value);
    expect(new URLSearchParams(router.state.location.search).get('view')).toBe('list');
    expect(table.textContent).not.toContain('$');
    expect(screen.queryByRole('link', { name: jobs.downloadJobs })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Board view' }));
    await screen.findByRole('region', { name: jobs.boardLabel });
    expect(new URLSearchParams(router.state.location.search).has('view')).toBe(false);
    expect(api.calls.filter((call) => !call.key.startsWith('GET '))).toHaveLength(0);
  });

  it('keeps the phone list and reachable stage moves instead of offering an unusable board', async () => {
    mode.phone = true;
    mount('/jobs');
    const list = await screen.findByRole('list', { name: jobs.listLabel });
    expect(within(list).getByLabelText(jobs.moveTo)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Board view' })).not.toBeInTheDocument();
  });

  it('keeps paging available when a texting filter has no matches on the loaded page', async () => {
    const { user } = mount('/customers', {
      'GET /api/customers?limit=50&offset=0': () => ({ body: { customers: [customer('First customer', 'none')], total: 51 } }),
      'GET /api/customers?limit=50&offset=50': () => ({ body: { customers: [customer('Last customer', 'written')], total: 51 } }),
    });
    await screen.findByRole('table', { name: customers.list.tableLabel });
    await user.selectOptions(screen.getByLabelText(customers.list.textingLabel), 'ok');
    expect(screen.getByText(customers.list.noMatches)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: customers.list.next }));
    expect(await screen.findByRole('link', { name: 'Last customer' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: customers.list.previous }));
    await waitFor(() => expect(screen.getByText(customers.list.noMatches)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: customers.list.next })).toBeEnabled();
  });
});
