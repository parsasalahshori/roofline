import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import type { AgentCard, AgentsOverview } from '@roofline/shared';
import { moneyLabel } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { agentsWindow } from '../src/copy/agents.ts';
import { WINDOW_COPY } from '../src/copy/dock.ts';
import { AGENT_LABEL } from '../src/copy/status.ts';
import { ACCOUNT, type Routes, SHELL_ROUTES, stubApi } from './helpers.tsx';

vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return { MapView: () => createElement('div', { 'data-map-mock': true }) };
});

// Card internals are tested elsewhere; here a card is a stand-in with the agent name.
vi.mock('../src/features/agents/AgentCard.tsx', async () => {
  const { createElement } = await import('react');
  const { AGENT_LABEL: labels } = await import('../src/copy/status.ts');
  return {
    AgentCard: ({ card }: { card: { agent: keyof typeof labels } }) =>
      createElement('div', { 'data-testid': `card-${card.agent}` }, labels[card.agent]),
  };
});

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

function live(agent: AgentCard['agent']): AgentCard {
  return { agent, status: 'on', finishedToday: 2, successRate: 0.9, notApproved30d: 1, minutesThisMonth: 600, last14Days: [], waitingCount: 0 };
}
function soon(agent: AgentCard['agent']): AgentCard {
  return { agent, status: 'coming_soon', finishedToday: 0, successRate: null, notApproved30d: 0, minutesThisMonth: 0, last14Days: [], waitingCount: 0 };
}
const OVERVIEW: AgentsOverview = {
  cards: [live('storm_scout'), live('estimator'), live('front_desk'), soon('claims'), soon('scheduler'), soon('follow_up')],
  minutesThisMonth: 1860,
  hourlyRateCents: 2800,
};

function renderApp(overrides: Routes) {
  api = stubApi({ ...SHELL_ROUTES, 'GET /api/auth/me': () => ({ body: ACCOUNT }), ...overrides });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: ['/agents'] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { user: userEvent.setup() };
}

describe('Agents window', () => {
  it('shows the honest totals line and the cards in order', async () => {
    renderApp({ 'GET /api/agents': () => ({ body: OVERVIEW }) });
    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.agents.title });
    const expected = `About 31 hours saved this month (estimate) · ${moneyLabel(1860, 2800)}`;
    expect(await within(dialog).findByText(expected)).toBeInTheDocument();

    const grid = within(dialog).getByRole('region', { name: agentsWindow.gridLabel });
    const cards = within(grid).getAllByTestId(/^card-/);
    expect(cards.map((el) => el.textContent)).toEqual(OVERVIEW.cards.map((c) => AGENT_LABEL[c.agent]));
  });

  it('links How we count to the agent settings', async () => {
    renderApp({ 'GET /api/agents': () => ({ body: OVERVIEW }) });
    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.agents.title });
    const link = await within(dialog).findByRole('link', { name: agentsWindow.howWeCount });
    expect(link).toHaveAttribute('href', agentsWindow.howWeCountHref);
  });

  it('shows the load error when the server fails', async () => {
    renderApp({ 'GET /api/agents': () => ({ status: 500, body: { error: 'boom' } }) });
    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.agents.title });
    expect(await within(dialog).findByText(agentsWindow.loadError)).toBeInTheDocument();
  });
});
