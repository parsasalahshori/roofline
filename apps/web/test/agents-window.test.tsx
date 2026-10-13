import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import type { AgentCard, AgentsOverview } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { agentsCommon, agentsDash, agentsWindow } from '../src/copy/agents.ts';
import { WINDOW_COPY } from '../src/copy/dock.ts';
import { ACCOUNT, AGENTS_DASH_ROUTES, DASH_BODY, dashDetail, type Routes, SHELL_ROUTES, stubApi } from './helpers.tsx';

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

function live(agent: AgentCard['agent'], over: Partial<AgentCard> = {}): AgentCard {
  return { agent, status: 'on', finishedToday: 2, successRate: 0.9, notApproved30d: 1, minutesThisMonth: 600, last14Days: [], waitingCount: 0, ...over };
}
const OVERVIEW: AgentsOverview = {
  cards: [live('storm_scout', { finishedToday: 636 }), live('estimator'), live('front_desk', { finishedToday: 64 }), live('claims'), live('scheduler'), live('follow_up')],
  minutesThisMonth: 1860,
  hourlyRateCents: 2800,
};

function renderApp(overrides: Routes, role: 'owner' | 'office' | 'rep' = 'owner', beforeRender?: () => void) {
  api = stubApi({ ...SHELL_ROUTES, ...AGENTS_DASH_ROUTES, 'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role } }), ...overrides });
  beforeRender?.();
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: ['/agents'] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { user: userEvent.setup(), queryClient };
}

async function openWindow() {
  const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.agents.title });
  await within(dialog).findByRole('region', { name: agentsWindow.gridLabel });
  return dialog;
}

describe('Agents window', () => {
  it('shows the tiles from real numbers and the six cards in roof order', async () => {
    renderApp({ 'GET /api/agents': () => ({ body: OVERVIEW }) });
    const dialog = await openWindow();
    const tiles = within(dialog).getByRole('region', { name: agentsDash.tilesLabel });
    await within(tiles).findByText('779');
    // 6600 minutes is 110 hours, which is 2.8 weeks of 40 hours; $28 an hour is $3,080.
    expect(within(tiles).getByText('110')).toBeInTheDocument();
    expect(within(tiles).getByText('2.8')).toBeInTheDocument();
    expect(within(tiles).getByText('$3,080')).toBeInTheDocument();
    expect(within(tiles).getByText(`6 ${agentsDash.agentsOf} 6 ${agentsDash.agentsRunning}`)).toBeInTheDocument();
    expect(within(tiles).getByRole('img', { name: new RegExp(agentsDash.perHourChart) })).toBeInTheDocument();

    const grid = within(dialog).getByRole('region', { name: agentsWindow.gridLabel });
    const names = within(grid).getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(names).toEqual(['Storm Scout', 'Front Desk', 'Estimator', 'Claims', 'Scheduler', 'Follow-up'].map((n) => `${agentsDash.selectHint} ${n}`));
    expect(within(dialog).getByText(agentsDash.handoffsSuffix).parentElement?.textContent).toBe(`3${agentsDash.handoffsSuffix}`);
  });

  it('puts the real handoff tags on the roof', async () => {
    renderApp({ 'GET /api/agents': () => ({ body: OVERVIEW }) });
    const dialog = await openWindow();
    const roof = await within(dialog).findByRole('img', { name: agentsDash.diagramLabel });
    expect(within(roof as unknown as HTMLElement).getByText('504 Transom Ct')).toBeInTheDocument();
    expect(within(roof as unknown as HTMLElement).getByText('603 Cornice Dr')).toBeInTheDocument();
  });

  it('shows a card with its numbers and latest action', async () => {
    renderApp({ 'GET /api/agents': () => ({ body: OVERVIEW }) });
    const dialog = await openWindow();
    const card = within(dialog).getByRole('article', { name: /Front Desk/ });
    expect(await within(card).findByText('Booked an inspection')).toBeInTheDocument();
    expect(within(card).getByText('64')).toBeInTheDocument();
    expect(within(card).getByText('90%')).toBeInTheDocument();
    expect(within(card).getByText(`31 ${agentsDash.hoursUnit}`)).toBeInTheDocument();
    expect(within(card).getByText(agentsDash.running)).toBeInTheDocument();
  });

  it('hides the money tile when there is no rate', async () => {
    renderApp({
      'GET /api/agents': () => ({ body: { ...OVERVIEW, hourlyRateCents: null } }),
      'GET /api/agents/dashboard': () => ({ body: { ...DASH_BODY, hourlyRateCents: null } }),
    });
    const dialog = await openWindow();
    await within(dialog).findByText('110');
    expect(within(dialog).queryByText(agentsDash.officeSaved)).toBeNull();
    expect(dialog.textContent).not.toContain('$');
  });

  it('picking a card opens that agent in the panel', async () => {
    const { user } = renderApp({
      'GET /api/agents': () => ({ body: OVERVIEW }),
      'GET /api/agents/storm_scout?period=week': () => ({ body: { ...dashDetail('storm_scout'), runNow: { kind: 'available', nextAllowedAt: null } } }),
      'GET /api/agents/feed?agent=storm_scout': () => ({ body: { items: [], nextCursor: null } }),
    });
    const dialog = await openWindow();
    expect(await within(dialog).findByRole('complementary', { name: /Front Desk/ })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /Storm Scout/ }));
    const panel = await within(dialog).findByRole('complementary', { name: /Storm Scout/ });
    expect(await within(panel).findByRole('button', { name: agentsDash.runNow })).toBeInTheDocument();
    expect(within(panel).getByText(`4 ${agentsDash.agentsOf} 5 ${agentsDash.allowedOf}`)).toBeInTheDocument();
  });

  it('the switch on a card pauses after a confirmation', async () => {
    const PUT = 'PUT /api/agents/estimator/paused';
    const { user } = renderApp({
      'GET /api/agents': () => ({ body: OVERVIEW }),
      // Touching the switch also picks the card, so the panel loads this agent.
      'GET /api/agents/estimator?period=week': () => ({ body: dashDetail('estimator') }),
      'GET /api/agents/feed?agent=estimator': () => ({ body: { items: [], nextCursor: null } }),
      [PUT]: () => ({ body: { paused: true, pausedAt: '2026-10-13T06:00:00.000Z' } }),
    });
    const dialog = await openWindow();
    const toggle = within(dialog).getByRole('switch', { name: `Estimator ${agentsDash.running}` });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await user.click(toggle);
    expect(api.count(PUT)).toBe(0);
    const sheet = await screen.findByRole('dialog', { name: 'Pause this agent?' });
    await user.click(within(sheet).getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(api.sent(PUT)).toEqual([{ paused: true }]));
  });

  it('a rep sees no switch', async () => {
    renderApp({ 'GET /api/agents': () => ({ body: OVERVIEW }) }, 'rep');
    const dialog = await openWindow();
    expect(within(dialog).queryByRole('switch')).toBeNull();
  });

  it('links How we count to the agent settings', async () => {
    renderApp({ 'GET /api/agents': () => ({ body: OVERVIEW }) });
    const dialog = await openWindow();
    const link = within(dialog).getByRole('link', { name: agentsWindow.howWeCount });
    expect(link).toHaveAttribute('href', agentsWindow.howWeCountHref);
    expect(within(dialog).getByRole('link', { name: agentsCommon.changeRate })).toHaveAttribute('href', agentsCommon.changeRateHref);
  });

  it('shows the load error when the server fails', async () => {
    renderApp({ 'GET /api/agents': () => ({ status: 500, body: { error: 'boom' } }) });
    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.agents.title });
    expect(await within(dialog).findByText(agentsWindow.loadError)).toBeInTheDocument();
  });

  it('hides How we count from a rep only', async () => {
    renderApp({ 'GET /api/agents': () => ({ body: OVERVIEW }) }, 'rep');
    const dialog = await openWindow();
    expect(within(dialog).queryByRole('link', { name: agentsWindow.howWeCount })).toBeNull();
  });

  it('shows a labelled status region while loading', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderApp({ 'GET /api/agents': () => ({ body: OVERVIEW }) }, 'owner', () => {
      const answer = globalThis.fetch;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input) === '/api/agents') await gate;
          return answer(input, init);
        }),
      );
    });
    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.agents.title });
    expect(await within(dialog).findByRole('status', { name: agentsWindow.loading })).toBeInTheDocument();
    expect(within(dialog).queryByRole('region', { name: agentsWindow.gridLabel })).toBeNull();
    release();
    await within(dialog).findByRole('region', { name: agentsWindow.gridLabel });
  });

  it('keeps the content and warns when a refresh fails', async () => {
    let fail = false;
    const { queryClient } = renderApp({
      'GET /api/agents': () => (fail ? { status: 500, body: { error: 'boom' } } : { body: OVERVIEW }),
    });
    const dialog = await openWindow();
    fail = true;
    await queryClient.invalidateQueries({ queryKey: ['agents', 'overview'] });
    expect(await within(dialog).findByText(agentsCommon.refreshFailed)).toBeInTheDocument();
    expect(within(dialog).getByRole('region', { name: agentsWindow.gridLabel })).toBeInTheDocument();
    expect(within(dialog).queryByText(agentsWindow.loadError)).toBeNull();
  });

  it('a first-load failure offers a retry that recovers', async () => {
    let fail = true;
    const { user } = renderApp({
      'GET /api/agents': () => (fail ? { status: 500, body: { error: 'boom' } } : { body: OVERVIEW }),
    });
    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.agents.title });
    expect(await within(dialog).findByText(agentsWindow.loadError)).toBeInTheDocument();
    fail = false;
    await user.click(within(dialog).getByRole('button', { name: agentsCommon.retry }));
    await waitFor(() => expect(within(dialog).getByRole('region', { name: agentsWindow.gridLabel })).toBeInTheDocument());
    expect(within(dialog).queryByText(agentsWindow.loadError)).toBeNull();
  });
});
