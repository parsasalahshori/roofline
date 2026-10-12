import { cleanup, configure, render, screen, within } from '@testing-library/react';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProposalView } from '@roofline/shared';
import type { CompanyBody } from '../src/api/types.ts';
import { createAppRouter } from '../src/app/router.tsx';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { proposals } from '../src/copy/proposals.ts';
import { today } from '../src/copy/today.ts';
import { zonedDateKey } from '../src/features/calendar/time.ts';
import { ACCOUNT, SHELL_ROUTES, stubApi } from './helpers.tsx';

vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return { MapView: () => createElement('div', { 'data-map-mock': true }) };
});

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

const ZONE = 'America/Los_Angeles';
const COMPANY_BODY: CompanyBody = {
  id: 'c1', name: 'Summit Roofing', slug: 'summit-roofing', status: 'active', legalName: null, phone: null, email: null,
  website: null, addressStreet: null, addressCity: null, addressState: null, addressZip: null, timezone: ZONE,
  logoUrl: null, located: false, serviceAreaMiles: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function signed(id: string, name: string, address: string, totalCents: number, basis: 'estimate' | 'exact' = 'estimate'): ProposalView {
  return {
    id,
    basis,
    number: 'P-' + id,
    status: 'signed',
    jobId: 'j-' + id,
    customer: { id: 'cu-' + id, name, phone: null },
    address,
    options: [
      { id: 'o-other-' + id, totalCents: 1 },
      { id: 'o-' + id, totalCents },
    ],
    signed: { optionId: 'o-' + id, name, at: '2026-10-12T15:00:00.000Z' },
  } as unknown as ProposalView;
}

function mount(list: ProposalView[]) {
  const urls: string[] = [];
  const key = () => `GET /api/proposals?status=signed&signedOn=${zonedDateKey(new Date(), ZONE)}`;
  const api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/jobs/board': () => ({ body: { columns: [], lost: { count: 0 } } }),
    'GET /api/team': () => ({ body: { members: [] } }),
    'GET /api/today': () => ({ body: { appointments: [], followUps: [] } }),
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/company': () => ({ body: COMPANY_BODY }),
    [key()]: ({ url }) => {
      urls.push(url);
      return { body: { proposals: list, total: list.length } };
    },
  });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: ['/today'] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { api, urls };
}

describe('Today: signed today', () => {
  it('asks for signed proposals signed on the company-zone today', async () => {
    const { urls } = mount([]);
    await screen.findByText(today.signedNone);
    expect(urls[0]).toContain('status=signed');
    expect(urls[0]).toContain('signedOn=' + zonedDateKey(new Date(), ZONE));
  });

  it('lists signed proposals', async () => {
    mount([signed('p1', 'Maria Lopez', '12 Oak St', 1425000), signed('p2', 'Dan Reyes', '9 Pine Rd', 990000, 'exact')]);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('heading', { name: today.signedToday })).toBeInTheDocument();
    const list = await within(dialog).findByRole('list', { name: today.signedLabel });
    expect(within(list).getByText('Maria Lopez')).toBeInTheDocument();
    expect(within(list).getByText('Dan Reyes')).toBeInTheDocument();
    expect(within(list).getByText(today.signedEstimate(proposals.money(1425000)))).toBeInTheDocument();
    const exact = within(list).getByText(proposals.money(990000));
    expect(exact).toBeInTheDocument();
    expect(exact.textContent).not.toContain('Estimate');
    expect(within(list).getAllByRole('link')[0]).toHaveAttribute('href', '/estimator/proposals/p1');
  });

  it('shows the no-signed note when nothing was signed', async () => {
    mount([]);
    expect(await screen.findByText(today.signedNone)).toBeInTheDocument();
  });

  it('keeps the existing Today content', async () => {
    mount([]);
    expect(await screen.findByRole('heading', { name: today.needYourOk })).toBeInTheDocument();
  });
});
