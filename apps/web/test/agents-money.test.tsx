import { cleanup, render, screen, within } from '@testing-library/react';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import type { AgentCard, AgentDetail, AgentsOverview } from '@roofline/shared';
import { moneyLabel } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter } from 'react-router';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import type { CompanyBody } from '../src/api/types.ts';
import { agentsCommon } from '../src/copy/agents.ts';
import { WINDOW_COPY } from '../src/copy/dock.ts';
import { AgentCard as Card } from '../src/features/agents/AgentCard.tsx';
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

const MINUTES = 1860;
const MONEY = moneyLabel(MINUTES, 2800);
const LINE = `${MONEY} of staff time at $28/hour ${agentsCommon.estimate}`;

const WINDOW_LINE = `About 31 hours saved this month ${agentsCommon.estimate} · ${LINE}`;

const COMPANY: CompanyBody = {
  id: 'c1', name: 'Summit Roofing', slug: 'summit-roofing', status: 'active', legalName: null, phone: null, email: null,
  website: null, addressStreet: null, addressCity: null, addressState: null, addressZip: null, timezone: 'America/Chicago',
  logoUrl: null, located: false, serviceAreaMiles: null,
};

const CARD: AgentCard = {
  agent: 'storm_scout', status: 'on', finishedToday: 1, successRate: 0.9, notApproved30d: 0, minutesThisMonth: MINUTES, last14Days: [], waitingCount: 0,
};
const overview = (rate: number | null): AgentsOverview => ({ cards: [CARD], minutesThisMonth: MINUTES, hourlyRateCents: rate });
const detail = (rate: number | null): AgentDetail => ({
  card: CARD, period: 'month', minutesInPeriod: MINUTES, breakdown: [], rules: [], paused: null,
  runNow: { kind: 'works_when_asked' }, recentTasks: [], hourlyRateCents: rate,
});

function renderApp(path: string, role: 'owner' | 'office' | 'rep', overrides: Routes) {
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role } }),
    'GET /api/company': () => ({ body: COMPANY }),
    ...overrides,
  });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={createAppRouter({ initialEntries: [path] })} />
    </Providers>,
  );
}

describe('the money line', () => {
  it.each([
    ['/agents', { 'GET /api/agents': () => ({ body: overview(2800) }) }, WINDOW_LINE],
    ['/agents/storm-scout', { 'GET /api/agents/storm_scout?period=month': () => ({ body: detail(2800) }) }, LINE],
  ] as const)('owner sees the rate and a link to change it on %s', async (path, routes, text) => {
    renderApp(path, 'owner', routes);
    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.agents.title });
    expect(await within(dialog).findByText(text)).toBeInTheDocument();
    const link = within(dialog).getByRole('link', { name: agentsCommon.changeRate });
    expect(link).toHaveAttribute('href', agentsCommon.changeRateHref);
  });

  it.each([
    ['/agents', { 'GET /api/agents': () => ({ body: overview(2800) }) }],
    ['/agents/storm-scout', { 'GET /api/agents/storm_scout?period=month': () => ({ body: detail(2800) }) }],
  ] as const)('office sees the text but no link on %s', async (path, routes) => {
    renderApp(path, 'office', routes);
    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.agents.title });
    expect(await within(dialog).findByText(new RegExp(LINE.replace(/[$()]/g, '\\$&')))).toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: agentsCommon.changeRate })).toBeNull();
  });

  it.each([
    ['/agents', { 'GET /api/agents': () => ({ body: overview(null) }) }, /^About 31 hours saved this month/],
    ['/agents/storm-scout', { 'GET /api/agents/storm_scout?period=month': () => ({ body: detail(null) }) }, /Time saved in this period/],
  ] as const)('shows no money at all without a rate on %s', async (path, routes, anchor) => {
    renderApp(path, 'owner', routes);
    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.agents.title });
    await within(dialog).findByText(anchor);
    expect(dialog.textContent).not.toContain('≈');
    expect(dialog.textContent).not.toContain('staff time');
    expect(within(dialog).queryByRole('link', { name: agentsCommon.changeRate })).toBeNull();
  });

  it('the card shows the amount and the estimate marker but not the rate', () => {
    const router = createMemoryRouter([{ path: '/', element: <Card card={CARD} hourlyRateCents={2800} /> }]);
    render(<RouterProvider router={router} />);
    expect(screen.getByText(`${MONEY} ${agentsCommon.estimate}`)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('staff time');
    expect(document.body.textContent).not.toContain('/hour');
  });

  it('the card shows no money without a rate', () => {
    const router = createMemoryRouter([{ path: '/', element: <Card card={CARD} hourlyRateCents={null} /> }]);
    render(<RouterProvider router={router} />);
    expect(document.body.textContent).not.toContain('≈');
  });
});
