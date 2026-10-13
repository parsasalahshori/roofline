import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationListItem, ConversationPage, FrontDeskDayStats } from '@roofline/shared';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { frontDeskInbox } from '../src/copy/front-desk-inbox.ts';
import { outcomeChip, relativeTime, secondsText } from '../src/features/front-desk/lift/format.ts';
import { ACCOUNT, COMPANY, type Routes, SHELL_ROUTES, stubApi } from './helpers.tsx';

// Front Desk lift (piece 8): the KPI tiles from today's numbers, the four tabs with counts, the call rows and the call detail beside them.

vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return { MapView: () => createElement('div', { 'data-map-mock': true }) };
});

const copy = frontDeskInbox.lift;

const DAY: FrontDeskDayStats = {
  day: '2026-10-13',
  callsToday: 39,
  answeredPct: 100,
  booked: 6,
  escalated: 2,
  avgAnswerMs: 800,
  inspectionsBooked: 6,
  afterHours: 8,
  tabCounts: { all: 8, booked: 3, messages: 1, spam: 1 },
};

const NOW = Date.parse('2026-10-13T18:00:00.000Z');

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
    lastMessageAt: '2026-10-13T17:46:00.000Z',
    liveCall: null,
    durationSeconds: 126,
    transferredToName: null,
    textBackSent: false,
    ...overrides,
  };
}

const page = (items: ConversationListItem[]): ConversationPage => ({ items, nextCursor: null });

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

function signedInApi(routes: Routes = {}, day: FrontDeskDayStats = DAY) {
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/company': () => ({ body: { ...COMPANY, timezone: 'America/Los_Angeles', phone: '+15555554477' } }),
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/front-desk/stats?day=today': () => ({ body: day }),
    'GET /api/conversations?filter=all': () => ({ body: page([]) }),
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
  return { router, user: userEvent.setup() };
}

/** The tile whose label is `label`, as its text. */
async function tile(label: string): Promise<HTMLElement> {
  const labelNode = await screen.findByText(label, { selector: 'dt' });
  return labelNode.closest('[data-testid="kpi-tile"]') as HTMLElement;
}

describe('Front Desk tiles (piece 8)', () => {
  it('shows the header and every tile from the numbers the server sent', async () => {
    signedInApi();
    renderApp('/front-desk');

    expect(await screen.findByRole('heading', { name: `${copy.title} ${copy.subtitle}` })).toBeInTheDocument();
    expect(within(await tile(copy.callsToday)).getByText('39')).toBeInTheDocument();
    expect(within(await tile(copy.callsToday)).getByText(copy.callsTodayHint)).toBeInTheDocument();
    expect(within(await tile(copy.answered)).getByText('100%')).toBeInTheDocument();
    expect(within(await tile(copy.answered)).getByText(copy.answeredHint(6, 2))).toBeInTheDocument();
    const speed = await tile(copy.answerTime);
    expect(within(speed).getByText(copy.seconds('0.8'))).toBeInTheDocument();
    expect(speed).toHaveAttribute('data-highlight', 'true');
    expect(within(await tile(copy.inspections)).getByText('6')).toBeInTheDocument();
    expect(within(await tile(copy.afterHours)).getByText('8')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-answering')).toHaveTextContent(copy.answering('(555) 555-4477'));
    expect(api.count('GET /api/front-desk/stats?day=today')).toBe(1);
  });

  it('shows a plain "no calls" instead of a made-up rate or speed on a quiet day', async () => {
    signedInApi(
      {},
      { ...DAY, callsToday: 0, answeredPct: null, avgAnswerMs: null, booked: 0, escalated: 0, inspectionsBooked: 0, afterHours: 0 },
    );
    renderApp('/front-desk');
    expect(within(await tile(copy.answered)).getByText(copy.answeredNone)).toBeInTheDocument();
    expect(within(await tile(copy.answerTime)).getByText(copy.answerTimeNone)).toBeInTheDocument();
  });

  it('says so when the numbers cannot be read, and the list still loads', async () => {
    signedInApi({
      'GET /api/front-desk/stats?day=today': () => ({ status: 500, body: { error: 'nope' } }),
      'GET /api/conversations?filter=all': () => ({ body: page([row({ id: 'c-1', name: 'Dana Ruiz' })]) }),
    });
    renderApp('/front-desk');
    expect(await screen.findByText(copy.kpisError)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Dana Ruiz/ })).toBeInTheDocument();
  });

  it('keeps the Simulate a call button demo-only, and it makes a simulated call', async () => {
    signedInApi({ 'GET /api/demo': () => ({ body: { demo: false } }) });
    renderApp('/front-desk');
    await screen.findByTestId('kpi-answering');
    expect(screen.queryByRole('button', { name: copy.simulateCall })).toBeNull();
    cleanup();

    signedInApi({
      'GET /api/demo': () => ({ body: { demo: true } }),
      'POST /api/demo/simulate/call': () => ({ body: { ok: true, message: 'A call came in.' } }),
    });
    const { user } = renderApp('/front-desk');
    await user.click(await screen.findByRole('button', { name: copy.simulateCall }));
    await waitFor(() => expect(api.count('POST /api/demo/simulate/call')).toBe(1));
  });

  it('never asks a rep for the numbers', async () => {
    signedInApi({ 'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role: 'rep' } }) });
    renderApp('/front-desk');
    expect(await screen.findByText(frontDeskInbox.empty)).toBeInTheDocument();
    expect(api.count('GET /api/front-desk/stats?day=today')).toBe(0);
    expect(screen.queryByTestId('kpi-answering')).toBeNull();
    const group = screen.getByRole('group', { name: copy.tabsLabel });
    // Without the numbers the tabs show their names alone
    expect(within(group).getAllByRole('button').map((tab) => tab.textContent)).toEqual(Object.values(copy.tabs));
  });
});

describe('Front Desk tabs and rows (piece 8)', () => {
  it('shows All, Booked, Text-backs and Blocked with the counts from the server', async () => {
    signedInApi();
    renderApp('/front-desk');
    const group = await screen.findByRole('group', { name: copy.tabsLabel });
    await waitFor(() =>
      expect(within(group).getAllByRole('button').map((tab) => tab.textContent)).toEqual([
        `${copy.tabs.all}8`,
        `${copy.tabs.booked}3`,
        `${copy.tabs.messages}1`,
        `${copy.tabs.spam}1`,
      ]),
    );
  });

  it('asks for the filter behind the tab: Text-backs is messages and Blocked is spam', async () => {
    signedInApi({
      'GET /api/conversations?filter=messages': () => ({ body: page([row({ id: 't-1', name: 'Carmen Blakely', channel: 'sms', textBackSent: true })]) }),
      'GET /api/conversations?filter=spam': () => ({ body: page([row({ id: 's-1', outcome: 'spam' })]) }),
    });
    const { user } = renderApp('/front-desk');
    const group = await screen.findByRole('group', { name: copy.tabsLabel });

    await user.click(within(group).getByRole('button', { name: new RegExp(copy.tabs.messages) }));
    const textBack = await screen.findByRole('link', { name: /Carmen Blakely/ });
    expect(within(textBack).getByText(copy.chips.textBack)).toBeInTheDocument();
    expect(within(textBack).getByText(copy.textThread)).toBeInTheDocument();

    await user.click(within(group).getByRole('button', { name: new RegExp(copy.tabs.spam) }));
    const blocked = await screen.findByRole('link', { name: new RegExp(frontDeskInbox.unknownCaller) });
    expect(within(blocked).getByText(copy.chips.spam)).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: new RegExp(copy.tabs.spam) })).toHaveAttribute('aria-pressed', 'true');
  });

  it('draws initials, the outcome chip, how long ago and how long it ran', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
    signedInApi({
      'GET /api/conversations?filter=all': () => ({
        body: page([
          row({ id: 'c-1', name: 'Molly Lindgren', outcome: 'booked', durationSeconds: 126 }),
          row({ id: 'c-2', name: 'Brent Hollis', outcome: 'transferred', transferredToName: 'Dale', lastMessageAt: '2026-10-13T15:00:00.000Z', durationSeconds: 72 }),
        ]),
      }),
    });
    renderApp('/front-desk');
    const molly = await screen.findByRole('link', { name: /Molly Lindgren/ });
    expect(within(molly).getByText('ML')).toBeInTheDocument();
    expect(within(molly).getByText(copy.chips.booked)).toBeInTheDocument();
    expect(within(molly).getByText(copy.time.minutes(14))).toBeInTheDocument();
    expect(within(molly).getByText('2:06')).toBeInTheDocument();
    const brent = screen.getByRole('link', { name: /Brent Hollis/ });
    expect(within(brent).getByText(copy.chips.sentTo('Dale'))).toBeInTheDocument();
    expect(within(brent).getByText(copy.time.hours(3))).toBeInTheDocument();
    expect(within(brent).getByText('1:12')).toBeInTheDocument();
  });

  it('shows the call on the right when a row is picked, and a way back on a phone', async () => {
    signedInApi({
      'GET /api/conversations?filter=all': () => ({ body: page([row({ id: 'abc', name: 'Pat Lee', outcome: 'booked' })]) }),
      'GET /api/conversations/abc': () => ({
        body: {
          id: 'abc',
          channel: 'voice',
          status: 'ended',
          customer: { id: 'cu-1', name: 'Pat Lee' },
          phoneE164: '+15551230000',
          outcome: 'booked',
          summary: null,
          handledBy: 'assistant',
          teamUntil: null,
          turns: [],
          calls: [],
          canReply: false,
        },
      }),
      'POST /api/conversations/abc/read': () => ({ body: {} }),
    });
    const { router, user } = renderApp('/front-desk');
    expect(screen.queryByTestId('kpi-answering')).toBeNull();
    expect(await screen.findByText(copy.pickCall)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: copy.backToCalls })).toBeNull();

    await user.click(await screen.findByRole('link', { name: /Pat Lee/ }));

    expect(await screen.findByRole('heading', { name: 'Pat Lee' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/front-desk/abc');
    expect(screen.getByRole('link', { name: /Pat Lee/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('link', { name: copy.backToCalls })).toHaveAttribute('href', '/front-desk');
    // The list stays beside the call, and keeps the tab the person chose
    expect(screen.getByRole('button', { name: new RegExp(copy.tabs.all) })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Front Desk formatting (piece 8)', () => {
  const base = row({ id: 'x' });

  it('words every outcome as a chip', () => {
    expect(outcomeChip({ ...base, outcome: 'booked' }).label).toBe(copy.chips.booked);
    expect(outcomeChip({ ...base, outcome: 'spam' }).label).toBe(copy.chips.spam);
    expect(outcomeChip({ ...base, outcome: 'claim' }).label).toBe(copy.chips.claim);
    expect(outcomeChip({ ...base, outcome: 'job_question' }).label).toBe(copy.chips.question);
    expect(outcomeChip({ ...base, outcome: 'transferred', transferredToName: 'Sam' }).label).toBe(copy.chips.sentTo('Sam'));
    expect(outcomeChip({ ...base, outcome: 'transferred' }).label).toBe(copy.chips.sentToTeam);
    expect(outcomeChip({ ...base, outcome: 'abandoned', textBackSent: true }).label).toBe(copy.chips.textBack);
    expect(outcomeChip({ ...base, channel: 'sms', outcome: 'message' }).label).toBe(copy.chips.textBack);
  });

  it('counts time ago and tenths of a second', () => {
    expect(relativeTime('2026-10-13T17:59:50.000Z', NOW)).toBe(copy.time.justNow);
    expect(relativeTime('2026-10-13T17:00:00.000Z', NOW)).toBe(copy.time.hours(1));
    expect(relativeTime('2026-10-11T17:00:00.000Z', NOW)).toBe(copy.time.days(2));
    expect(secondsText(800)).toBe('0.8');
    expect(secondsText(1260)).toBe('1.3');
  });
});
