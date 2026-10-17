import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { hoursLabel, type AgentCard, type AgentsOverview } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { agents, agentsCommon, agentsDash, agentsWindow } from '../src/copy/agents.ts';
import { WINDOW_COPY } from '../src/copy/rail.ts';
import { ACCOUNT, AGENTS_DASH_ROUTES, DASH_BODY, dashDetail, type Routes, SHELL_ROUTES, stubApi } from './helpers.tsx';

vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return { MapView: () => createElement('div', { 'data-map-mock': true }) };
});

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

/** A DOM has no layout, so every box measures nothing. This gives them all one width, as the browser would give the page. */
function withWidth(width: number): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width, height: 100, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 100, toJSON: () => ({}) });
}

async function openWindow() {
  const dialog = await screen.findByRole('main', { name: WINDOW_COPY.agents.title });
  await within(dialog).findByRole('region', { name: agentsWindow.gridLabel });
  return dialog;
}

describe('Agents window', () => {
  it('shows the tiles from real numbers and the six cards in order', async () => {
    renderApp({ 'GET /api/agents': () => ({ body: OVERVIEW }) });
    const dialog = await openWindow();
    const tiles = within(dialog).getByRole('region', { name: agentsDash.tilesLabel });
    await within(tiles).findByText('779');
    // 6600 minutes is 110 hours, which is 2.8 weeks of 40 hours; $28 an hour is $3,080.
    expect(within(tiles).getByText('110')).toBeInTheDocument();
    expect(within(tiles).getByText('2.8')).toBeInTheDocument();
    expect(within(tiles).getByText('$3,080')).toBeInTheDocument();
    // Every estimated figure carries the estimate mark (hours, staff, dollars).
    expect(within(tiles).getAllByText(agentsDash.about)).toHaveLength(3);
    expect(within(tiles).getByText(agentsDash.officeSaved)).toBeInTheDocument();
    expect(within(tiles).getByText(`6 ${agentsDash.agentsOf} 6 ${agentsDash.agentsRunning}`)).toBeInTheDocument();
    expect(within(tiles).getByRole('img', { name: new RegExp(agentsDash.perHourChart) })).toBeInTheDocument();

    const grid = within(dialog).getByRole('region', { name: agentsWindow.gridLabel });
    const order = ['Storm Scout', 'Front Desk', 'Estimator', 'Claims', 'Scheduler', 'Follow-up'];
    expect(within(grid).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(order);
    // Each name is a button that says what it does: "Show details for Storm Scout"
    for (const name of order) expect(within(grid).getByRole('button', { name: `${agentsDash.selectHint} ${name}` })).toBeInTheDocument();
    // The latest hour is the number; the twelve bars are the picture
    expect(within(tiles).getByText('25')).toBeInTheDocument();
    expect(within(tiles).getByText(agentsDash.perHourUnit)).toBeInTheDocument();
  });

  it('counts the jobs handed between agents today in a panel of their own', async () => {
    renderApp({ 'GET /api/agents': () => ({ body: OVERVIEW }) });
    const dialog = await openWindow();
    const panel = await within(dialog).findByRole('region', { name: agentsDash.handoffsTitle });
    expect(within(panel).getByText('3')).toBeInTheDocument();
  });

  it('lists the real handoffs: the job, who passed it, who took it', async () => {
    renderApp({ 'GET /api/agents': () => ({ body: OVERVIEW }) });
    const dialog = await openWindow();
    const list = await within(dialog).findByRole('list', { name: agentsDash.handoffsListLabel });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('504 Transom Ct')).toBeInTheDocument();
    expect(within(rows[0]!).getByText(`Storm Scout ${agentsDash.handedTo} Front Desk`, { exact: false })).toBeInTheDocument();
    expect(within(rows[1]!).getByText('603 Cornice Dr')).toBeInTheDocument();
    expect(within(rows[1]!).getByText(`Front Desk ${agentsDash.handedTo} Estimator`, { exact: false })).toBeInTheDocument();
  });

  it('says so when no job has been handed on yet', async () => {
    renderApp({
      'GET /api/agents': () => ({ body: OVERVIEW }),
      'GET /api/agents/dashboard': () => ({ body: { ...DASH_BODY, handoffsToday: 0, handoffs: [] } }),
    });
    const dialog = await openWindow();
    expect(await within(dialog).findByText(agentsDash.handoffsEmpty)).toBeInTheDocument();
  });

  it('marks the picked card with its own ring and a pressed name, and moves it with the pick', async () => {
    const { user } = renderApp({
      'GET /api/agents': () => ({ body: OVERVIEW }),
      'GET /api/agents/storm_scout?period=week': () => ({ body: dashDetail('storm_scout') }),
      'GET /api/agents/feed?agent=storm_scout': () => ({ body: { items: [], nextCursor: null } }),
    });
    const dialog = await openWindow();
    const front = within(dialog).getByRole('article', { name: /Front Desk/ });
    const storm = within(dialog).getByRole('article', { name: /Storm Scout/ });
    expect(front).toHaveAttribute('data-selected', 'true');
    expect(storm).not.toHaveAttribute('data-selected');
    await user.click(within(storm).getByRole('button', { name: /Storm Scout/ }));
    expect(storm).toHaveAttribute('data-selected', 'true');
    expect(front).not.toHaveAttribute('data-selected');
  });

  it('with no room for the panel beside the cards there is no panel, and a card opens its agent\'s page', async () => {
    renderApp({ 'GET /api/agents': () => ({ body: OVERVIEW }) }, 'owner', () => withWidth(700));
    const dialog = await openWindow();
    await waitFor(() => expect(within(dialog).queryByRole('complementary')).toBeNull());
    const link = within(dialog).getByRole('link', { name: `${agentsDash.openAgent} Storm Scout` });
    expect(link).toHaveAttribute('href', '/agents/storm-scout');
    expect(within(dialog).queryByRole('button', { name: new RegExp(agentsDash.selectHint) })).toBeNull();
    // Nothing is picked, so no card has the ring
    for (const card of within(dialog).getAllByRole('article')) expect(card).not.toHaveAttribute('data-selected');
  });

  it.each([
    [991, false],
    [992, true],
  ])('the panel sits beside the cards from 62rem of width: at %ipx it is %s', async (width, beside) => {
    renderApp({ 'GET /api/agents': () => ({ body: OVERVIEW }) }, 'owner', () => withWidth(width));
    const dialog = await openWindow();
    await waitFor(() => expect(within(dialog).queryByRole('complementary', { name: /Front Desk/ }) !== null).toBe(beside));
    expect(within(dialog).queryByRole('button', { name: `${agentsDash.selectHint} Storm Scout` }) !== null).toBe(beside);
  });

  it('the tabs are pages: Overview is the current one', async () => {
    renderApp({ 'GET /api/agents': () => ({ body: OVERVIEW }) });
    const dialog = await openWindow();
    const tabs = within(dialog).getByRole('navigation', { name: agents.tabsLabel });
    expect(within(tabs).getByRole('link', { name: agents.tabs.overview })).toHaveAttribute('aria-current', 'page');
    expect(within(tabs).getByRole('link', { name: agents.tabs.feed })).toHaveAttribute('href', '/agents/feed');
    expect(within(tabs).getByRole('link', { name: agents.tabs.waiting })).toHaveAttribute('href', '/agents/waiting');
  });

  it('shows a card with its numbers and latest action', async () => {
    renderApp({ 'GET /api/agents': () => ({ body: OVERVIEW }) });
    const dialog = await openWindow();
    const card = within(dialog).getByRole('article', { name: /Front Desk/ });
    expect(await within(card).findByText('Booked an inspection')).toBeInTheDocument();
    expect(within(card).getByText('64')).toBeInTheDocument();
    expect(within(card).getByText('90%')).toBeInTheDocument();
    expect(within(card).getByText(hoursLabel(31 * 60))).toBeInTheDocument();
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
    // What it may not do says so in words, not only with its lock
    expect(within(panel).getByText(agentsDash.notAllowedWord)).toBeInTheDocument();
    expect(within(panel).getByText('Spend ad money without approval').closest('li')).toHaveAttribute('data-on', 'false');
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
    const dialog = await screen.findByRole('main', { name: WINDOW_COPY.agents.title });
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
    const dialog = await screen.findByRole('main', { name: WINDOW_COPY.agents.title });
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
    const dialog = await screen.findByRole('main', { name: WINDOW_COPY.agents.title });
    expect(await within(dialog).findByText(agentsWindow.loadError)).toBeInTheDocument();
    fail = false;
    await user.click(within(dialog).getByRole('button', { name: agentsCommon.retry }));
    await waitFor(() => expect(within(dialog).getByRole('region', { name: agentsWindow.gridLabel })).toBeInTheDocument());
    expect(within(dialog).queryByText(agentsWindow.loadError)).toBeNull();
  });
});
