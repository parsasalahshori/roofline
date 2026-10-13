import { cleanup, render, screen, within } from '@testing-library/react';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import type { AgentCard, AgentDetail, AgentsOverview } from '@roofline/shared';
import { moneyLabel } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import type { CompanyBody } from '../src/api/types.ts';
import { agentsCommon, agentsDash } from '../src/copy/agents.ts';
import { WINDOW_COPY } from '../src/copy/dock.ts';
import { ACCOUNT, AGENTS_DASH_ROUTES, DASH_BODY, type Routes, SHELL_ROUTES, stubApi } from './helpers.tsx';

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
    ...AGENTS_DASH_ROUTES,
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
  it('owner sees the rate and a link to change it on the agent page', async () => {
    renderApp('/agents/storm-scout', 'owner', { 'GET /api/agents/storm_scout?period=month': () => ({ body: detail(2800) }) });
    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.agents.title });
    expect(await within(dialog).findByText(LINE)).toBeInTheDocument();
    const link = within(dialog).getByRole('link', { name: agentsCommon.changeRate });
    expect(link).toHaveAttribute('href', agentsCommon.changeRateHref);
  });

  it('office sees the text but no link on the agent page', async () => {
    renderApp('/agents/storm-scout', 'office', { 'GET /api/agents/storm_scout?period=month': () => ({ body: detail(2800) }) });
    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.agents.title });
    expect(await within(dialog).findByText(new RegExp(LINE.replace(/[$()]/g, '\\$&')))).toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: agentsCommon.changeRate })).toBeNull();
  });

  it('shows no money at all without a rate on the agent page', async () => {
    renderApp('/agents/storm-scout', 'owner', { 'GET /api/agents/storm_scout?period=month': () => ({ body: detail(null) }) });
    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.agents.title });
    await within(dialog).findByText(/Time saved in this period/);
    expect(dialog.textContent).not.toContain('≈');
    expect(dialog.textContent).not.toContain('staff time');
    expect(within(dialog).queryByRole('link', { name: agentsCommon.changeRate })).toBeNull();
  });
});

describe('the office time tile on the dashboard', () => {
  it('owner sees the dollars, the rate marked as an estimate, and a link to change it', async () => {
    renderApp('/agents', 'owner', { 'GET /api/agents': () => ({ body: overview(2800) }) });
    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.agents.title });
    expect(await within(dialog).findByText('$3,080')).toBeInTheDocument();
    expect(within(dialog).getByText(`${agentsDash.officeSub} $28 ${agentsDash.officeSubSuffix}`)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: agentsCommon.changeRate })).toHaveAttribute('href', agentsCommon.changeRateHref);
  });

  it('office sees the dollars but no link', async () => {
    renderApp('/agents', 'office', { 'GET /api/agents': () => ({ body: overview(2800) }) });
    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.agents.title });
    expect(await within(dialog).findByText('$3,080')).toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: agentsCommon.changeRate })).toBeNull();
  });

  it('shows no money at all without a rate', async () => {
    renderApp('/agents', 'owner', {
      'GET /api/agents': () => ({ body: overview(null) }),
      'GET /api/agents/dashboard': () => ({ body: { ...DASH_BODY, hourlyRateCents: null } }),
    });
    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.agents.title });
    await within(dialog).findByText('110');
    expect(dialog.textContent).not.toContain('$');
    expect(within(dialog).queryByRole('link', { name: agentsCommon.changeRate })).toBeNull();
  });
});
