import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobView, ProposalView } from '@roofline/shared';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { job } from '../src/copy/job.ts';
import { proposals } from '../src/copy/proposals.ts';
import { ACCOUNT, SHELL_ROUTES, stubApi } from './helpers.tsx';

vi.mock('../src/shell/useIsPhone.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/shell/useIsPhone.ts')>()),
  useIsPhone: () => false,
}));
vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return { MapView: () => createElement('div', { 'data-map-mock': true }) };
});
vi.mock('../src/features/timeline/Timeline.tsx', async () => {
  const { createElement } = await import('react');
  return { Timeline: () => createElement('div', { 'data-testid': 'timeline-mock' }) };
});

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

const VIEW = {
  job: {
    id: 'j1', customerId: 'c1', customerName: 'Pat Homeowner', propertyId: 'p1', addressLine: '12 Oak St', stage: 'inspection',
    valueCents: 1425000, assigned: null, daysInStage: 3, stuck: false, nextStep: null, nextStepOn: null,
    updatedAt: '2026-10-10T12:00:00.000Z', source: 'call', lostReason: null, stageChangedAt: '2026-10-09T12:00:00.000Z',
    archived: false, createdAt: '2026-10-01T12:00:00.000Z',
  },
  customer: { id: 'c1', displayName: 'Pat Homeowner', phone: null, email: null },
  home: { id: 'p1', addressLine: '12 Oak St', city: 'Austin', state: 'TX', zip: '78701', located: true, jobs: [{ id: 'j1', stage: 'inspection' }] },
  appointments: [],
  quotes: [],
  tasks: [],
  can: { edit: true, seeValue: true, archive: true },
} as unknown as JobView;

function proposal(id: string, number: string, jobId: string, status: string, basis: string, totals: number[]): ProposalView {
  return {
    id, number, status, jobId, basis,
    options: totals.map((totalCents, index) => ({ id: `${id}-o${index}`, tier: 'good', name: 'Option', enabled: true, totalCents })),
  } as unknown as ProposalView;
}

const LIST = [
  proposal('pr1', 'P-1001', 'j1', 'sent', 'estimate', [1200000, 900000]),
  proposal('pr2', 'P-1002', 'j1', 'signed', 'exact', [1500000]),
  proposal('pr3', 'P-9999', 'other', 'draft', 'estimate', [100000]),
];

function renderJob(list: ProposalView[], overrides: Record<string, () => { body?: unknown; status?: number }> = {}) {
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/team': () => ({ body: { members: [], invites: [] } }),
    'GET /api/company': () => ({ body: { id: 'c1', name: 'Summit Roofing', timezone: 'America/Chicago' } }),
    'GET /api/jobs/j1/view': () => ({ body: VIEW }),
    'GET /api/proposals': () => ({ body: { proposals: list, total: list.length } }),
    ...overrides,
  });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: ['/jobs/j1'] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, user: userEvent.setup() };
}

describe('job proposals', () => {
  it("lists this job's proposals with status chips", async () => {
    renderJob(LIST);
    const first = await screen.findByRole('link', { name: /P-1001/ });
    expect(first).toHaveAttribute('href', '/estimator/proposals/pr1');
    expect(first).toHaveTextContent(proposals.statusLabelFor('sent'));
    const second = screen.getByRole('link', { name: /P-1002/ });
    expect(second).toHaveTextContent(proposals.statusLabelFor('signed'));
    expect(screen.queryByText('P-9999')).not.toBeInTheDocument();
  });

  it('shows Estimate on instant totals and not on exact ones', async () => {
    renderJob(LIST);
    const first = await screen.findByRole('link', { name: /P-1001/ });
    expect(first).toHaveTextContent(job.proposalFrom(proposals.money(900000)));
    expect(first).toHaveTextContent(/Estimate/);
    const second = screen.getByRole('link', { name: /P-1002/ });
    expect(second).toHaveTextContent(job.proposalExactFrom(proposals.money(1500000)));
    expect(second).not.toHaveTextContent(/Estimate/);
  });

  it("New proposal measures the job's home", async () => {
    const { router, user } = renderJob(LIST, {
      'POST /api/measurements': () => ({ body: { id: 'm7' } }),
    });
    await screen.findByRole('link', { name: /P-1001/ });
    await user.click(screen.getByRole('button', { name: job.newProposal }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/estimator/measure/m7'));
    expect(api.sent('POST /api/measurements')).toEqual([{ propertyId: 'p1' }]);
  });

  it('reads every page of the proposal list', async () => {
    renderJob(LIST, {
      'GET /api/proposals': () => ({
        body: { proposals: [proposal('px', 'P-0001', 'other', 'draft', 'estimate', [100000])], total: 2 },
      }),
      'GET /api/proposals?offset=1': () => ({
        body: { proposals: [proposal('pr1', 'P-1001', 'j1', 'sent', 'estimate', [1200000])], total: 2 },
      }),
    });
    expect(await screen.findByRole('link', { name: /P-1001/ })).toBeInTheDocument();
    expect(screen.queryByText('P-0001')).not.toBeInTheDocument();
  });

  it('empty state', async () => {
    renderJob([LIST[2]!]);
    expect(await screen.findByText(job.proposalsEmpty)).toBeInTheDocument();
  });

  it('Copy link copies the proposal link for owners and office', async () => {
    const { user } = renderJob(LIST, {
      'GET /api/proposals/pr1/link': () => ({ body: { url: 'https://x/p/abc' } }),
    });
    // after renderJob: userEvent.setup() installs its own clipboard stub, which this one replaces
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await screen.findByRole('link', { name: /P-1001/ });
    await user.click(screen.getAllByRole('button', { name: proposals.copyLink })[0]!);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('https://x/p/abc'));
    expect(await screen.findByText(proposals.linkCopied)).toBeInTheDocument();
  });

  it('hides Copy link from reps', async () => {
    renderJob(LIST, { 'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role: 'rep' } }) });
    await screen.findByRole('link', { name: /P-1001/ });
    expect(screen.queryAllByRole('button', { name: proposals.copyLink })).toHaveLength(0);
  });
});
