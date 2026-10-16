import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import type { AgentDetail } from '@roofline/shared';
import type { CompanyBody } from '../src/api/types.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { RunNowButton } from '../src/features/agents/RunNowButton.tsx';
import { agentPage, agents, agentsCommon } from '../src/copy/agents.ts';
import { WINDOW_COPY } from '../src/copy/rail.ts';
import { AGENT_LABEL } from '../src/copy/status.ts';
import { ACCOUNT, type Routes, SHELL_ROUTES, stubApi } from './helpers.tsx';

vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return { MapView: () => createElement('div', { 'data-map-mock': true }) };
});

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

const COMPANY: CompanyBody = {
  id: 'c1', name: 'Summit Roofing', slug: 'summit-roofing', status: 'active', legalName: null, phone: null, email: null,
  website: null, addressStreet: null, addressCity: null, addressState: null, addressZip: null, timezone: 'America/Chicago',
  logoUrl: null, located: false, serviceAreaMiles: null,
};

const DETAIL: AgentDetail = {
  card: { agent: 'storm_scout', status: 'on', finishedToday: 0, successRate: null, notApproved30d: 0, minutesThisMonth: 0, last14Days: [], waitingCount: 0 },
  period: 'month',
  minutesInPeriod: 1860,
  breakdown: [
    { baseline: 'route_built', units: 2, minutes: 90 },
    { baseline: 'text_sent', units: 40, minutes: 60 },
  ],
  rules: [{ text: 'Looks for hail of 1 inch or more', links: [{ label: '1 inch', href: '/settings/storm-scout' }] }],
  paused: null,
  runNow: { kind: 'available', nextAllowedAt: null },
  recentTasks: [
    { id: 't1', kind: 'storm_check', status: 'done', mode: 'live', createdAt: '2026-10-12T15:00:00Z', finishedAt: '2026-10-12T15:05:00Z', minutesSaved: 45, href: '/approvals/t1' },
  ],
  hourlyRateCents: 2800,
};

function setup(path: string, role: 'owner' | 'office' | 'rep' = 'owner', overrides: Routes = {}) {
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role } }),
    'GET /api/agents/storm_scout?period=month': () => ({ body: DETAIL }),
    'GET /api/company': () => ({ body: COMPANY }),
    ...overrides,
  });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: [path] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, user: userEvent.setup(), queryClient };
}

describe('agent page', () => {
  it('shows time saved as an estimate', async () => {
    setup('/agents/storm-scout');
    const dialog = await screen.findByRole('main', { name: WINDOW_COPY.agents.title });
    expect(await within(dialog).findByText(/about 31 hours/)).toBeInTheDocument();
    expect(within(dialog).getAllByText(/\(estimate\)/).length).toBeGreaterThan(0);
  });

  it('renders the rule with its link', async () => {
    setup('/agents/storm-scout');
    const link = await screen.findByRole('link', { name: '1 inch' });
    expect(link).toHaveAttribute('href', '/settings/storm-scout');
  });

  it('period picker refetches', async () => {
    const { user } = setup('/agents/storm-scout', 'owner', {
      'GET /api/agents/storm_scout?period=week': () => ({ body: { ...DETAIL, period: 'week', minutesInPeriod: 270 } }),
    });
    await screen.findByRole('link', { name: '1 inch' });
    expect(screen.queryByText(/about 4\.5 hours/)).toBeNull();
    expect(api.count('GET /api/agents/storm_scout?period=week')).toBe(0);
    await user.click(screen.getByRole('button', { name: agentPage.periods.week }));
    expect((await screen.findAllByText(/about 4\.5 hours/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/about 31 hours/)).toBeNull();
    expect(api.count('GET /api/agents/storm_scout?period=week')).toBe(1);
  });

  it('shows not-found for an unknown agent', async () => {
    setup('/agents/nope');
    expect(await screen.findByRole('main', { name: WINDOW_COPY.notFound.title })).toBeInTheDocument();
  });

  it('shows the pause switch to the owner only', async () => {
    setup('/agents/storm-scout', 'owner');
    expect(await screen.findByRole('switch')).toBeInTheDocument();
  });

  it('hides the pause switch from a rep', async () => {
    setup('/agents/storm-scout', 'rep');
    await screen.findByRole('link', { name: '1 inch' });
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  const PUT = 'PUT /api/agents/storm_scout/paused';
  const POST = 'POST /api/agents/storm_scout/run';
  const GET = 'GET /api/agents/storm_scout?period=month';
  const PAUSED = { at: '2026-10-12T15:00:00Z', byName: 'Sam Roofer' };
  const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

  it('pausing asks first', async () => {
    const { user } = setup('/agents/storm-scout', 'owner', { [PUT]: () => ({ body: {} }) });
    await user.click(await screen.findByRole('switch'));
    expect(await screen.findByRole('dialog', { name: agentPage.pauseTitle })).toBeInTheDocument();
    expect(api.count(PUT)).toBe(0);
    await user.click(screen.getByRole('button', { name: agentPage.pauseCancel }));
    expect(screen.queryByRole('dialog', { name: agentPage.pauseTitle })).toBeNull();
    expect(api.count(PUT)).toBe(0);
    await user.click(screen.getByRole('switch'));
    await user.click(await screen.findByRole('button', { name: agentPage.pauseConfirm }));
    await waitFor(() => expect(api.sent(PUT)).toEqual([{ paused: true }]));
  });

  it('resuming needs no confirm', async () => {
    const { user } = setup('/agents/storm-scout', 'owner', {
      [GET]: () => ({ body: { ...DETAIL, paused: PAUSED } }),
      [PUT]: () => ({ body: {} }),
    });
    await user.click(await screen.findByRole('switch'));
    await waitFor(() => expect(api.sent(PUT)).toEqual([{ paused: false }]));
    expect(screen.queryByRole('dialog', { name: agentPage.pauseTitle })).toBeNull();
  });

  it('a rep sees who paused it', async () => {
    setup('/agents/storm-scout', 'rep', { [GET]: () => ({ body: { ...DETAIL, paused: PAUSED } }) });
    expect(await screen.findByText(agentPage.pausedBy + ' Sam Roofer')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it.each([
    ['works_when_asked', agentPage.worksWhenAsked],
    ['answers_calls', agentPage.answersCalls],
  ])('run now state %s', async (kind, text) => {
    setup('/agents/storm-scout', 'owner', {
      [GET]: () => ({ body: { ...DETAIL, runNow: { kind } as AgentDetail['runNow'] } }),
    });
    const dialog = await screen.findByRole('main', { name: WINDOW_COPY.agents.title });
    expect(await within(dialog).findByText(text)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: agentPage.runNowButton })).not.toBeInTheDocument();
  });

  it('run now starts and shows the cooldown', async () => {
    const { user } = setup('/agents/storm-scout', 'owner', {
      [POST]: () => ({ status: 202, body: { started: true, nextAllowedAt: inAnHour() } }),
    });
    await user.click(await screen.findByRole('button', { name: agentPage.runNowButton }));
    expect(await screen.findByText(/You can run it again at/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: agentPage.runNowButton })).not.toBeInTheDocument();
  });

  it('a future nextAllowedAt shows the cooldown', async () => {
    setup('/agents/storm-scout', 'owner', {
      [GET]: () => ({ body: { ...DETAIL, runNow: { kind: 'available', nextAllowedAt: inAnHour() } } }),
    });
    expect(await screen.findByText(/You can run it again at/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: agentPage.runNowButton })).not.toBeInTheDocument();
  });

  it('a refused run shows why', async () => {
    const { user } = setup('/agents/storm-scout', 'owner', {
      [POST]: () => ({ status: 409, body: { error: 'It is already checking. Try again soon.' } }),
    });
    await user.click(await screen.findByRole('button', { name: agentPage.runNowButton }));
    expect(await screen.findByText('It is already checking. Try again soon.')).toBeInTheDocument();
  });

  it('recent work opens the review', async () => {
    setup('/agents/storm-scout');
    const link = await screen.findByRole('link', { name: /storm check/i });
    expect(link).toHaveAttribute('href', '/approvals/t1');
  });

  it('recent task with href is a link to it', async () => {
    setup('/agents/storm-scout', 'owner', {
      [GET]: () => ({ body: { ...DETAIL, recentTasks: [{ ...DETAIL.recentTasks[0]!, href: '/jobs/j9' }] } }),
    });
    const link = await screen.findByRole('link', { name: /storm check/i });
    expect(link).toHaveAttribute('href', '/jobs/j9');
  });

  it('recent task without href is not a link', async () => {
    setup('/agents/storm-scout', 'rep', {
      [GET]: () => ({ body: { ...DETAIL, hourlyRateCents: null, recentTasks: [{ ...DETAIL.recentTasks[0]!, href: null }] } }),
    });
    expect(await screen.findByText('storm check')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /storm check/i })).toBeNull();
    expect(document.body.textContent).not.toContain('$');
  });

  it('breakdown table', async () => {
    setup('/agents/storm-scout');
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Routes planned')).toBeInTheDocument();
    expect(within(table).getByText('2')).toBeInTheDocument();
    expect(within(table).getByText('about 1.5 hours (estimate)')).toBeInTheDocument();
    expect(within(table).getByText('Texts sent')).toBeInTheDocument();
    expect(within(table).getByText('about 1 hour (estimate)')).toBeInTheDocument();
  });

  it('load error', async () => {
    setup('/agents/storm-scout', 'owner', { [GET]: () => ({ status: 500, body: { error: 'x' } }) });
    expect(await screen.findByText(agentPage.loadError)).toBeInTheDocument();
  });

  it('empty states', async () => {
    setup('/agents/storm-scout', 'owner', { [GET]: () => ({ body: { ...DETAIL, breakdown: [], recentTasks: [] } }) });
    expect(await screen.findByText(agentPage.breakdownEmpty)).toBeInTheDocument();
    expect(screen.getByText(agentPage.recentEmpty)).toBeInTheDocument();
  });

  it('PauseSwitch cancel clears the error', async () => {
    const { user } = setup('/agents/storm-scout', 'owner', { [PUT]: () => ({ status: 500, body: { error: 'x' } }) });
    await user.click(await screen.findByRole('switch'));
    await user.click(await screen.findByRole('button', { name: agentPage.pauseConfirm }));
    expect(await screen.findByText(agentPage.pauseError)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: agentPage.pauseCancel }));
    expect(screen.queryByRole('dialog', { name: agentPage.pauseTitle })).toBeNull();
    expect(screen.queryByText(agentPage.pauseError)).toBeNull();
  });

  it.each([
    ['rep', false],
    ['office', true],
    ['owner', true],
  ] as const)('Run now for a %s: shown is %s', async (role, shown) => {
    setup('/agents/storm-scout', role);
    await screen.findByRole('link', { name: '1 inch' });
    if (shown) {
      expect(await screen.findByRole('button', { name: agentPage.runNowButton })).toBeInTheDocument();
    } else {
      expect(screen.queryByRole('button', { name: agentPage.runNowButton })).toBeNull();
    }
  });

  it('a stale run error clears when a later nextAllowedAt arrives', async () => {
    api = stubApi({
      ...SHELL_ROUTES,
      'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role: 'owner' } }),
      'GET /api/company': () => ({ body: COMPANY }),
      [POST]: () => ({ status: 409, body: { error: 'It is already checking. Try again soon.' } }),
    });
    const queryClient = createQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false } });
    const view = (runNow: AgentDetail['runNow']) => (
      <Providers client={queryClient}>
        <RunNowButton agent="storm_scout" runNow={runNow} />
      </Providers>
    );
    const user = userEvent.setup();
    const { rerender } = render(view({ kind: 'available', nextAllowedAt: null }));
    await user.click(await screen.findByRole('button', { name: agentPage.runNowButton }));
    expect(await screen.findByText('It is already checking. Try again soon.')).toBeInTheDocument();
    rerender(view({ kind: 'available', nextAllowedAt: inAnHour() }));
    await waitFor(() => expect(screen.queryByText('It is already checking. Try again soon.')).toBeNull());
  });

  it('section headings are h3 under the h2 title', async () => {
    setup('/agents/storm-scout');
    const dialog = await screen.findByRole('main', { name: WINDOW_COPY.agents.title });
    await within(dialog).findByRole('link', { name: '1 inch' });
    expect(within(dialog).getByRole('heading', { level: 2, name: AGENT_LABEL.storm_scout })).toBeInTheDocument();
    expect(within(dialog).getAllByRole('heading', { level: 2 })).toHaveLength(1);
    expect(within(dialog).getAllByRole('heading', { level: 3 }).length).toBeGreaterThanOrEqual(3);
  });

  it('keeps the previous period while the next loads', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user } = setup('/agents/storm-scout', 'owner', {
      'GET /api/agents/storm_scout?period=week': () => ({ body: { ...DETAIL, period: 'week', minutesInPeriod: 270 } }),
    });
    const inner = fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('period=week') ? gate.then(() => inner(input, init)) : inner(input, init),
    );
    await screen.findByText(/about 31 hours/);
    await user.click(screen.getByRole('button', { name: agentPage.periods.week }));
    expect(screen.getAllByText(/about 31 hours/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/about 4\.5 hours/)).toBeNull();
    // the old figures stay up, marked busy, until the new period arrives
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    release();
    expect((await screen.findAllByText(/about 4\.5 hours/)).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByText(/about 31 hours/)).toBeNull());
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('a coming-soon run state shows the coming-soon page and no controls', async () => {
    setup('/agents/storm-scout', 'owner', {
      [GET]: () => ({ body: { ...DETAIL, runNow: { kind: 'coming_soon' } } }),
    });
    expect(await screen.findByText(agents.agentComingSoon)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: agentPage.runNowButton })).toBeNull();
  });

  it('keeps the content and warns when a refresh fails', async () => {
    let fail = false;
    const { queryClient } = setup('/agents/storm-scout', 'owner', {
      [GET]: () => (fail ? { status: 500, body: { error: 'x' } } : { body: DETAIL }),
    });
    await screen.findByRole('link', { name: '1 inch' });
    fail = true;
    await queryClient.invalidateQueries({ queryKey: ['agents', 'detail'] });
    expect(await screen.findByText(agentsCommon.refreshFailed)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '1 inch' })).toBeInTheDocument();
    expect(screen.queryByText(agentPage.loadError)).toBeNull();
  });

  it('a first-load failure offers a retry that recovers', async () => {
    let fail = true;
    const { user } = setup('/agents/storm-scout', 'owner', {
      [GET]: () => (fail ? { status: 500, body: { error: 'x' } } : { body: DETAIL }),
    });
    expect(await screen.findByText(agentPage.loadError)).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: agentsCommon.retry }));
    expect(await screen.findByRole('link', { name: '1 inch' })).toBeInTheDocument();
    expect(screen.queryByText(agentPage.loadError)).toBeNull();
  });

  it('shows the cooldown clock in the company time zone', async () => {
    const at = new Date(Date.now() + 3_600_000);
    const iso = at.toISOString();
    setup('/agents/storm-scout', 'owner', {
      [GET]: () => ({ body: { ...DETAIL, runNow: { kind: 'available', nextAllowedAt: iso } } }),
      'GET /api/company': () => ({ body: { ...COMPANY, timezone: 'America/Los_Angeles' } }),
    });
    const expected = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' })
      .format(at).replace(/[\u202f\u00a0]/g, ' ');
    expect(await screen.findByText(`${agentPage.runNowAgain} ${expected}`)).toBeInTheDocument();
  });

  it('formats a fixed instant in the company zone', async () => {
    api = stubApi({
      ...SHELL_ROUTES,
      'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role: 'owner' } }),
      'GET /api/company': () => ({ body: { ...COMPANY, timezone: 'America/Los_Angeles' } }),
    });
    const queryClient = createQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false } });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T19:00:00Z'));
    try {
      render(
        <Providers client={queryClient}>
          <RunNowButton agent="storm_scout" runNow={{ kind: 'available', nextAllowedAt: '2026-10-12T20:30:00Z' }} />
        </Providers>,
      );
      expect(await screen.findByText(/1:30 PM/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a paused agent hides Run now and says why', async () => {
    setup('/agents/storm-scout', 'owner', { [GET]: () => ({ body: { ...DETAIL, paused: PAUSED } }) });
    expect(await screen.findByText(agentPage.pausedNote)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: agentPage.runNowButton })).toBeNull();
  });

  it('an unpaused agent shows Run now and no paused note', async () => {
    setup('/agents/storm-scout', 'owner');
    expect(await screen.findByRole('button', { name: agentPage.runNowButton })).toBeInTheDocument();
    expect(screen.queryByText(agentPage.pausedNote)).toBeNull();
  });
});
