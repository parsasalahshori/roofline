import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationListItem, ConversationPage, FrontDeskWeekStats } from '@roofline/shared';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { frontDeskInbox } from '../src/copy/front-desk-inbox.ts';
import { ACCOUNT, COMPANY, type Routes, SHELL_ROUTES, stubApi } from './helpers.tsx';

// Front Desk window (Task 21): the list with filters, unread, outcomes, live rows, polling and paging.

// The real map loads maplibre-gl, which these tests never need. The shell mounts it beside every window.
vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return { MapView: () => createElement('div', { 'data-map-mock': true }) };
});

const MAP_STUB = { 'GET /api/company': () => ({ body: { ...COMPANY, timezone: 'America/Los_Angeles' } }) };

const ZERO_STATS: FrontDeskWeekStats = {
  weekStart: '2026-10-05',
  answered: 0,
  booked: 0,
  transferred: 0,
  messages: 0,
  spam: 0,
  firstReplyMsP50: null,
  guardBlocks: 0,
  aiMinutesUsed: 0,
  aiMinutesIncluded: null,
};

function row(overrides: Partial<ConversationListItem> & { id: string }): ConversationListItem {
  return {
    channel: 'voice',
    status: 'ended',
    customerId: null,
    name: null,
    phoneE164: '+15551230000',
    outcome: null,
    summary: null,
    handledBy: 'assistant',
    unreadCount: 0,
    needsAttention: false,
    urgent: false,
    lastMessageAt: '2026-10-12T16:30:00.000Z',
    liveCall: null,
    ...overrides,
  };
}

const page = (items: ConversationListItem[], nextCursor: string | null = null): ConversationPage => ({ items, nextCursor });

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** A signed-in owner whose Front Desk reads answer with the given routes. */
function signedInApi(routes: Routes) {
  api = stubApi({
    ...SHELL_ROUTES,
    ...MAP_STUB,
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/front-desk/stats': () => ({ body: ZERO_STATS }),
    ...routes,
  });
  return api;
}

function renderApp(path: string) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: [path] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, queryClient, user: userEvent.setup() };
}

/** The filter chip group; the list sits beside it. */
async function filterGroup() {
  return screen.findByRole('group', { name: frontDeskInbox.filtersLabel });
}

const DANA = row({
  id: 'c-1',
  name: 'Dana Ruiz',
  phoneE164: '+15551230001',
  outcome: 'booked',
  summary: 'Wants an inspection on Thursday morning.',
  unreadCount: 2,
  needsAttention: true,
  urgent: true,
});
const UNKNOWN = row({ id: 'c-2', phoneE164: '+15551230002', outcome: 'message', summary: 'Asked for a callback.' });

describe('Front Desk window (Task 21)', () => {
  it('shows the exact empty text when the all filter has no calls', async () => {
    signedInApi({ 'GET /api/conversations?filter=all': () => ({ body: page([]) }) });
    renderApp('/front-desk');
    expect(await screen.findByText(frontDeskInbox.empty)).toBeInTheDocument();
    expect(screen.getByText('No calls yet. Once forwarding is on, every call shows up here.')).toBeInTheDocument();
  });

  it('renders name, outcome, unread badge, the link to the conversation, and the unknown caller', async () => {
    signedInApi({ 'GET /api/conversations?filter=all': () => ({ body: page([DANA, UNKNOWN]) }) });
    renderApp('/front-desk');

    const dana = await screen.findByRole('link', { name: /Dana Ruiz/ });
    expect(dana).toHaveAttribute('href', '/front-desk/c-1');
    expect(within(dana).getByText(frontDeskInbox.outcomes.booked)).toBeInTheDocument();
    expect(within(dana).getByRole('img', { name: frontDeskInbox.unread(2) })).toHaveTextContent('2');
    expect(within(dana).getByText(frontDeskInbox.urgent)).toBeInTheDocument();
    expect(within(dana).getByText(frontDeskInbox.needsAttention)).toBeInTheDocument();
    expect(dana).not.toHaveAttribute('data-live');

    const unknown = screen.getByRole('link', { name: new RegExp(frontDeskInbox.unknownCaller) });
    expect(unknown).toHaveAttribute('href', '/front-desk/c-2');
    expect(within(unknown).queryByRole('img')).toBeNull();
  });

  it('shows the filter chips, selects All by default, and asks for the chosen filter', async () => {
    signedInApi({
      'GET /api/conversations?filter=all': () => ({ body: page([DANA]) }),
      'GET /api/conversations?filter=booked': () => ({ body: page([row({ id: 'b-1', name: 'Lee Park', outcome: 'booked' })]) }),
    });
    const { user } = renderApp('/front-desk');

    const group = await filterGroup();
    expect(within(group).getAllByRole('button').map((chip) => chip.textContent)).toEqual(
      ['all', 'needs_attention', 'booked', 'messages', 'spam'].map((filter) => frontDeskInbox.filters[filter as keyof typeof frontDeskInbox.filters]),
    );
    expect(within(group).getByRole('button', { name: frontDeskInbox.filters.all })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: frontDeskInbox.filters.booked })).toHaveAttribute('aria-pressed', 'false');

    await user.click(within(group).getByRole('button', { name: frontDeskInbox.filters.booked }));

    expect(await screen.findByRole('link', { name: /Lee Park/ })).toHaveAttribute('href', '/front-desk/b-1');
    expect(api.count('GET /api/conversations?filter=booked')).toBe(1);
    expect(within(group).getByRole('button', { name: frontDeskInbox.filters.booked })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('link', { name: /Dana Ruiz/ })).toBeNull();
  });

  it('says nothing is here for an empty filter other than all', async () => {
    signedInApi({
      'GET /api/conversations?filter=all': () => ({ body: page([DANA]) }),
      'GET /api/conversations?filter=spam': () => ({ body: page([]) }),
    });
    const { user } = renderApp('/front-desk');
    const group = await filterGroup();
    await user.click(within(group).getByRole('button', { name: frontDeskInbox.filters.spam }));
    expect(await screen.findByText(frontDeskInbox.filterEmpty)).toBeInTheDocument();
  });

  it('marks a live call row with Live now, data-live, and an aria-hidden pulsing dot', async () => {
    const live = row({
      id: 'l-1',
      name: 'Sam Lee',
      liveCall: { callId: 'call-1', status: 'ai', startedAt: '2026-10-12T16:29:00.000Z' },
    });
    signedInApi({ 'GET /api/conversations?filter=all': () => ({ body: page([live, UNKNOWN]) }) });
    renderApp('/front-desk');

    const link = await screen.findByRole('link', { name: /Sam Lee/ });
    expect(link).toHaveAttribute('data-live', 'true');
    expect(within(link).getByText(frontDeskInbox.live)).toBeInTheDocument();
    const dot = link.querySelector('[aria-hidden="true"]');
    expect(dot).not.toBeNull();
    expect(dot).toBeInTheDocument();
    expect(screen.getByRole('link', { name: new RegExp(frontDeskInbox.unknownCaller) })).not.toHaveAttribute('data-live');
  });

  it('polls every 5 s while a call is live', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const live = row({
      id: 'l-1',
      name: 'Sam Lee',
      liveCall: { callId: 'call-1', status: 'ringing', startedAt: '2026-10-12T16:29:00.000Z' },
    });
    signedInApi({ 'GET /api/conversations?filter=all': () => ({ body: page([live]) }) });
    renderApp('/front-desk');
    await screen.findByRole('link', { name: /Sam Lee/ });
    expect(api.count('GET /api/conversations?filter=all')).toBe(1);

    await act(() => vi.advanceTimersByTimeAsync(5100));
    expect(api.count('GET /api/conversations?filter=all')).toBe(2);
  });

  it('polls every 30 s, not 5 s, when no call is live', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    signedInApi({ 'GET /api/conversations?filter=all': () => ({ body: page([DANA]) }) });
    renderApp('/front-desk');
    await screen.findByRole('link', { name: /Dana Ruiz/ });
    expect(api.count('GET /api/conversations?filter=all')).toBe(1);

    await act(() => vi.advanceTimersByTimeAsync(5100));
    expect(api.count('GET /api/conversations?filter=all')).toBe(1);

    await act(() => vi.advanceTimersByTimeAsync(25_000));
    expect(api.count('GET /api/conversations?filter=all')).toBe(2);
  });

  it('asks for the next page with its cursor from Show more', async () => {
    signedInApi({
      'GET /api/conversations?filter=all': () => ({ body: page([DANA], 'abc') }),
      'GET /api/conversations?filter=all&cursor=abc': () => ({ body: page([UNKNOWN]) }),
    });
    const { user } = renderApp('/front-desk');
    await screen.findByRole('link', { name: /Dana Ruiz/ });

    await user.click(screen.getByRole('button', { name: frontDeskInbox.loadMore }));

    expect(await screen.findByRole('link', { name: new RegExp(frontDeskInbox.unknownCaller) })).toHaveAttribute('href', '/front-desk/c-2');
    expect(api.count('GET /api/conversations?filter=all&cursor=abc')).toBe(1);
  });

  it('shows the load error when the list cannot be read', async () => {
    signedInApi({ 'GET /api/conversations?filter=all': () => ({ status: 500, body: { error: 'nope' } }) });
    renderApp('/front-desk');
    await waitFor(() => expect(screen.getByText(frontDeskInbox.loadError)).toBeInTheDocument());
  });
});
