import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import type { AgentCard, AgentDetail } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { agentPage, agentRules, agentsWindow } from '../src/copy/agents.ts';
import { ACCOUNT, COMPANY, type Routes, SHELL_ROUTES, stubApi } from './helpers.tsx';

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

const G1 = ['claims', 'scheduler', 'follow_up'] as const;
const SLUG = { claims: 'claims', scheduler: 'scheduler', follow_up: 'follow-up' } as const;
const RULES = [
  { text: 'I check claims every morning at 10.', links: [] },
  { text: 'I never contact insurers or adjusters.', links: [] },
];

function card(agent: AgentCard['agent']): AgentCard {
  return { agent, status: 'paused', finishedToday: 0, successRate: null, notApproved30d: 0, minutesThisMonth: 0, last14Days: [], waitingCount: 0 };
}

function detail(agent: AgentCard['agent']): AgentDetail {
  return {
    card: card(agent),
    period: 'month',
    minutesInPeriod: 0,
    breakdown: [],
    rules: RULES,
    paused: { at: '2026-10-12T15:00:00Z', byName: null },
    runNow: { kind: 'available', nextAllowedAt: null },
    recentTasks: [],
    hourlyRateCents: 2800,
  };
}

function setup(path: string, overrides: Routes = {}) {
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/company': () => ({ body: COMPANY }),
    'GET /api/claims': () => ({ body: { claims: [] } }),
    'GET /api/agent-values': () => ({ body: {} }),
    ...Object.fromEntries(G1.map((a) => [`GET /api/agents/${a}?period=month`, () => ({ body: detail(a) })])),
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
  return { user: userEvent.setup() };
}

describe('G1 agents start paused', () => {
  it('the Agents window shows Turn on on each paused G1 card', async () => {
    setup('/agents', {
      'GET /api/agents': () => ({ body: { cards: [card('storm_scout'), ...G1.map(card)], totals: { minutesThisMonth: 0 }, hourlyRateCents: 2800 } }),
    });
    await waitFor(() => expect(screen.getAllByText(agentsWindow.turnOnHint)).toHaveLength(3));
  });

  it('shows the rules before turning on, and sends one request only on confirm', async () => {
    const PUT = 'PUT /api/agents/claims/paused';
    const { user } = setup('/agents/claims', { [PUT]: () => ({ body: {} }) });
    await user.click(await screen.findByRole('button', { name: agentPage.turnOnButton }));
    const dialog = await screen.findByRole('dialog', { name: agentPage.turnOnTitle });
    for (const rule of RULES) expect(within(dialog).getByText(rule.text)).toBeInTheDocument();
    expect(api.count(PUT)).toBe(0);

    await user.click(within(dialog).getByRole('button', { name: agentPage.turnOnCancel }));
    expect(screen.queryByRole('dialog', { name: agentPage.turnOnTitle })).toBeNull();
    expect(api.count(PUT)).toBe(0);

    await user.click(screen.getByRole('button', { name: agentPage.turnOnButton }));
    const again = await screen.findByRole('dialog', { name: agentPage.turnOnTitle });
    await user.click(within(again).getByRole('button', { name: agentPage.turnOnConfirm }));
    await waitFor(() => expect(api.sent(PUT)).toEqual([{ paused: false }]));
  });

  it('the Settings Agents tab has no coming soon text', async () => {
    setup('/settings/agents', { 'GET /api/agent-values': () => ({ body: {
      claimsNudgeDays: [3, 5, 7], weatherRainPct: 60, weatherGustMph: 25, reminderHour: 15, followupDays: [3, 4], leadFollowupDays: 2,
      reviewLink: null, reviewDelayDays: 3, followupReviews: true, followupLeads: true, followupProposals: true,
    } }) });
    expect(await screen.findByText(agentRules.title)).toBeInTheDocument();
    expect(screen.queryByText('How we count time saved is coming soon.')).toBeNull();
    expect(screen.queryByText(/is coming soon/i)).toBeNull();
  });

  it.each(G1)('Run now is labelled for %s once it is on', async (agent) => {
    setup(`/agents/${SLUG[agent]}`, {
      [`GET /api/agents/${agent}?period=month`]: () => ({ body: { ...detail(agent), paused: null } }),
    });
    expect(await screen.findByRole('button', { name: agentPage.runNowLabels[agent] })).toBeInTheDocument();
  });

  it.each(G1)('a paused %s offers Turn on and no Run now', async (agent) => {
    setup(`/agents/${SLUG[agent]}`);
    expect(await screen.findByText(agentPage.rulesTitle)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: agentPage.runNowLabels[agent] })).toBeNull();
  });
});
