import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobView, ProposalOptionView, ProposalView, Tier } from '@roofline/shared';
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

const TIERS: Tier[] = ['good', 'better', 'best'];

/** The figures an option was priced from: 33.1 squares, a 6/12 pitch, 10% waste so 36.4 to order. */
const SCOPE = { areaSqFt: 3310, areaType: 'surface', pitch: 6, wastePercent: 10, ridgeFt: 118, edgeFt: 148, valleyFt: 0 };
const CALCULATION = { roofSquares: 33.1, orderedSquares: 36.4 };

function option(id: string, tier: Tier, totalCents: number, name = 'Option'): ProposalOptionView {
  return { id, tier, name, highlights: [], scope: SCOPE, addOns: [], calculation: CALCULATION, addOnLines: [], totalCents, monthlyEstimateCents: null, enabled: true } as unknown as ProposalOptionView;
}

function proposal(id: string, number: string, jobId: string, status: string, basis: string, totals: number[], more: Partial<ProposalView> = {}): ProposalView {
  return {
    id, number, status, jobId, basis,
    options: totals.map((totalCents, index) => option(`${id}-o${index}`, TIERS[index] ?? 'good', totalCents)),
    sentAt: null, views: { count: 0, first: null, last: null }, signed: null, declined: null,
    ...more,
  } as unknown as ProposalView;
}

const LIST = [
  proposal('pr1', 'P-1001', 'j1', 'sent', 'estimate', [1200000, 900000]),
  proposal('pr2', 'P-1002', 'j1', 'signed', 'exact', [1500000]),
];  // the server filters by job (Ruling EM), so the answer holds only this job's proposals

function renderJob(list: ProposalView[], overrides: Record<string, () => { body?: unknown; status?: number }> = {}) {
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/team': () => ({ body: { members: [], invites: [] } }),
    'GET /api/company': () => ({ body: { id: 'c1', name: 'Summit Roofing', timezone: 'America/Chicago' } }),
    'GET /api/jobs/j1/view': () => ({ body: VIEW }),
    'GET /api/proposals?jobId=j1': () => ({ body: { proposals: list, total: list.length } }),
    'GET /api/jobs/j1/claim': () => ({ body: { claim: null, intake: null, packet: null } }),
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
      // The measure window opens and reads the measurement; answered so the test does not race the cleanup
      'GET /api/measurements/m7': () => ({ status: 404, body: { error: 'Not found.' } }),
      'GET /api/proposals?status=draft': () => ({ body: { proposals: [], total: 0 } }),
    });
    await screen.findByRole('link', { name: /P-1001/ });
    await user.click(screen.getByRole('button', { name: job.newProposal }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/estimator/measure/m7'));
    expect(api.sent('POST /api/measurements')).toEqual([{ propertyId: 'p1' }]);
    expect(router.state.location.state).toEqual({ jobId: 'j1' });
  });

  it("asks the server for this job's proposals only", async () => {
    renderJob(LIST);
    expect(await screen.findByRole('link', { name: /P-1001/ })).toBeInTheDocument();
    expect(api.calls.map((c) => c.key)).toContain('GET /api/proposals?jobId=j1');
    expect(api.calls.map((c) => c.key)).not.toContain('GET /api/proposals');
  });

  it('empty state', async () => {
    renderJob([]);
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

  it('the newest proposal opens out into Good, Better and Best, with Better recommended', async () => {
    renderJob([proposal('pr1', 'P-1001', 'j1', 'sent', 'exact', [940000, 1100000, 1380000])]);
    const tiers = within(await screen.findByRole('list', { name: job.tiersLabel }));
    const tiles = tiers.getAllByRole('listitem');
    expect(tiles.map((tile) => tile.getAttribute('data-tier'))).toEqual(['good', 'better', 'best']);
    expect(tiles[0]).toHaveTextContent(proposals.money(940000));
    expect(tiles[1]).toHaveTextContent(proposals.money(1100000));
    expect(tiles[2]).toHaveTextContent(proposals.money(1380000));
    // Only the recommended option is ringed, and it says so in words
    expect(tiles.map((tile) => tile.getAttribute('data-recommended'))).toEqual([null, 'true', null]);
    expect(tiles[1]).toHaveTextContent(job.recommended);
    expect(tiles[0]).not.toHaveTextContent(job.recommended);
  });

  it('only the newest proposal opens out; an older one is a row', async () => {
    renderJob(LIST);
    await screen.findByRole('link', { name: /P-1001/ });
    expect(screen.getAllByRole('list', { name: job.tiersLabel })).toHaveLength(1);
  });

  it('options that are left out of the proposal are not drawn', async () => {
    const left = proposal('pr1', 'P-1001', 'j1', 'sent', 'exact', [940000, 1100000, 1380000]);
    left.options[2] = { ...left.options[2]!, enabled: false };
    renderJob([left]);
    const tiers = within(await screen.findByRole('list', { name: job.tiersLabel }));
    expect(tiers.getAllByRole('listitem')).toHaveLength(2);
  });

  it('says how many times the customer opened it, when it was sent and when it was last opened', async () => {
    // Dates well in the past: a recent one would read "today" or "yesterday"
    const sentAt = '2026-09-12T19:10:00.000Z';
    const last = '2026-09-15T19:42:00.000Z';
    renderJob([proposal('pr1', 'P-1001', 'j1', 'viewed', 'exact', [1100000], { sentAt, views: { count: 2, first: '2026-09-12T23:31:00.000Z', last } })]);
    await screen.findByRole('list', { name: job.tiersLabel });
    // The tag, in words and with its count
    expect(screen.getByRole('link', { name: /P-1001/ })).toHaveTextContent(job.openedTag(2));
    expect(screen.getByText(/^Sent Sep 12/)).toBeInTheDocument();
    expect(screen.getByText(/^Opened 2 times · last Sep 15/)).toBeInTheDocument();
  });

  it('a proposal that was sent and not opened says so', async () => {
    renderJob([proposal('pr1', 'P-1001', 'j1', 'sent', 'exact', [1100000], { sentAt: '2026-09-12T19:10:00.000Z' })]);
    expect(await screen.findByText(proposals.eventsNone)).toBeInTheDocument();
  });

  it('a signed proposal says who signed it and when', async () => {
    renderJob([
      proposal('pr1', 'P-1001', 'j1', 'signed', 'exact', [1100000], {
        sentAt: '2026-09-12T19:10:00.000Z',
        signed: { optionId: 'pr1-o0', name: 'Pat Homeowner', at: '2026-09-16T15:00:00.000Z' },
      }),
    ]);
    expect(await screen.findByText(/^Signed by Pat Homeowner · Sep 16/)).toBeInTheDocument();
  });

  it('a rep sees the options without their prices', async () => {
    renderJob([proposal('pr1', 'P-1001', 'j1', 'sent', 'exact', [940000, 1100000, 1380000])], {
      'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role: 'rep' } }),
      'GET /api/jobs/j1/view': () => ({ body: { ...VIEW, can: { edit: true, seeValue: false, archive: true } } }),
    });
    const tiers = within(await screen.findByRole('list', { name: job.tiersLabel }));
    expect(tiers.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByText(proposals.money(1100000))).not.toBeInTheDocument();
  });

  it('the roof card shows the figures the proposal was priced from, under an Exact report tag', async () => {
    renderJob([proposal('pr1', 'P-1001', 'j1', 'sent', 'exact', [940000, 1100000, 1380000])]);
    const roof = within(await screen.findByRole('region', { name: job.roofTitle }));
    expect(roof.getByText(job.roofExact)).toBeInTheDocument();
    expect(roof.getByText(job.roofArea).nextElementSibling).toHaveTextContent(job.squares(33.1));
    expect(roof.getByText(job.roofPitch).nextElementSibling).toHaveTextContent('6/12');
    expect(roof.getByText(job.roofOrder(10)).nextElementSibling).toHaveTextContent(job.squares(36.4));
    expect(roof.getByText(job.roofRidge).nextElementSibling).toHaveTextContent(job.feet(118));
    expect(roof.getByText(job.roofEdge).nextElementSibling).toHaveTextContent(job.feet(148));
    // A length of zero is not a measurement: no row for it
    expect(roof.queryByText(job.roofValley)).not.toBeInTheDocument();
  });

  it('an instant estimate is called an Estimate, not an exact report', async () => {
    renderJob([proposal('pr1', 'P-1001', 'j1', 'sent', 'estimate', [1100000])]);
    const roof = within(await screen.findByRole('region', { name: job.roofTitle }));
    expect(roof.getByText(job.roofEstimate)).toBeInTheDocument();
    expect(roof.queryByText(job.roofExact)).not.toBeInTheDocument();
  });

  it('a job with no proposal has no roof card', async () => {
    renderJob([]);
    await screen.findByText(job.proposalsEmpty);
    expect(screen.queryByRole('region', { name: job.roofTitle })).not.toBeInTheDocument();
  });

  it('the empty state offers the next step in the panel', async () => {
    renderJob([]);
    expect(await screen.findByText(job.proposalsEmptyBody)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: job.newProposal })).toBeInTheDocument();
  });

  it('a proposals list that fails to load says so, in place, and can be tried again', async () => {
    let calls = 0;
    const { user } = renderJob([], {
      'GET /api/proposals?jobId=j1': () => {
        calls += 1;
        return calls === 1 ? { status: 500, body: { error: 'x' } } : { body: { proposals: LIST, total: LIST.length } };
      },
    });
    const alert = (await screen.findByText(job.proposalsLoadFailed)).closest('[role="alert"]');
    expect(alert).not.toBeNull();
    await user.click(within(alert as HTMLElement).getByRole('button', { name: job.retry }));
    expect(await screen.findByRole('link', { name: /P-1001/ })).toBeInTheDocument();
  });
});
