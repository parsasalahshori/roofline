import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationListItem, ConversationPage, FrontDeskDayStats } from '@roofline/shared';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { conversationCopy } from '../src/copy/front-desk-conversation.ts';
import { frontDeskInbox } from '../src/copy/front-desk-inbox.ts';
import { WINDOW_COPY } from '../src/copy/rail.ts';
import { shell } from '../src/copy/shell.ts';
import { outcomeChip, relativeTime, secondsText } from '../src/features/front-desk/format.ts';
import { ACCOUNT, COMPANY, type Routes, SHELL_ROUTES, stubApi } from './helpers.tsx';

// The Front Desk page: its head, today's tiles, the four filters over the list of calls, the call that was picked beside it, and the phone's one-at-a-time layout.

vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return { MapView: () => createElement('div', { 'data-map-mock': true }) };
});

const copy = frontDeskInbox;
const PHONE_QUERY = '(max-width: 767.98px)';

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

/** Stubs matchMedia so the phone query matches when `phone` is true and no other query does. */
function stubPhone(phone: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query === PHONE_QUERY,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
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

/** The tile whose label is `label`: its description list. */
async function tile(label: string): Promise<HTMLElement> {
  const labelNode = await screen.findByText(label, { selector: 'dt' });
  return labelNode.closest('dl') as HTMLElement;
}

const detailOf = (id: string, name: string | null) => ({
  id,
  channel: 'voice',
  status: 'ended',
  customer: name === null ? null : { id: 'cu-1', name },
  phoneE164: '+15551230000',
  outcome: 'booked',
  summary: null,
  followUps: [],
  handledBy: 'assistant',
  teamUntil: null,
  turns: [],
  calls: [],
  links: { jobIds: [], appointmentIds: [], claimIntakeIds: [] },
  canReply: false,
});

describe('Front Desk head and numbers', () => {
  it('shows the title, the number it answers, and every tile from the numbers the server sent', async () => {
    signedInApi();
    renderApp('/front-desk');

    expect(await screen.findByRole('heading', { level: 1, name: WINDOW_COPY['front-desk'].title })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('fd-status')).toHaveTextContent(copy.answering('(555) 555-4477')));
    const calls = await tile(copy.callsToday);
    expect(within(calls).getByText('39')).toBeInTheDocument();
    expect(within(calls).getByText(copy.callsTodayHint)).toBeInTheDocument();
    const answered = await tile(copy.answered);
    expect(within(answered).getByText('100%')).toBeInTheDocument();
    expect(within(answered).getByText(copy.answeredHint(6, 2))).toBeInTheDocument();
    expect(within(await tile(copy.inspections)).getByText('6')).toBeInTheDocument();
    expect(within(await tile(copy.afterHours)).getByText('8')).toBeInTheDocument();
    const speed = await tile(copy.answerTime);
    expect(within(speed).getByText('0.8')).toBeInTheDocument();
    expect(within(speed).getByText(copy.seconds)).toBeInTheDocument();
    expect(within(speed).getByText(copy.answerTimeHint)).toBeInTheDocument();
    expect(api.count('GET /api/front-desk/stats?day=today')).toBe(1);
  });

  it('puts the tiles in the order of the page: calls, answered, inspections, after-hours, answer time', async () => {
    signedInApi();
    renderApp('/front-desk');
    const strip = await screen.findByRole('region', { name: copy.kpisLabel });
    await tile(copy.callsToday);
    expect(within(strip).getAllByRole('term').map((term) => term.textContent)).toEqual([
      copy.callsToday,
      copy.answered,
      copy.inspections,
      copy.afterHours,
      copy.answerTime,
    ]);
  });

  it('shows a dash and "No calls yet" instead of a made-up rate or speed on a quiet day', async () => {
    signedInApi(
      {},
      { ...DAY, callsToday: 0, answeredPct: null, avgAnswerMs: null, booked: 0, escalated: 0, inspectionsBooked: 0, afterHours: 0 },
    );
    renderApp('/front-desk');
    const answered = await tile(copy.answered);
    expect(within(answered).getByText('—')).toBeInTheDocument();
    expect(within(answered).getByText(copy.noCallsYet)).toBeInTheDocument();
    const speed = await tile(copy.answerTime);
    expect(within(speed).getByText('—')).toBeInTheDocument();
    expect(within(speed).getByText(copy.noCallsYet)).toBeInTheDocument();
    expect(within(await tile(copy.callsToday)).getByText(copy.noCallsYet)).toBeInTheDocument();
  });

  it('says "Instant" when the assistant picks up in under a tenth of a second', async () => {
    signedInApi({}, { ...DAY, avgAnswerMs: 40 });
    renderApp('/front-desk');
    const speed = await tile(copy.answerTime);
    expect(within(speed).getByText(copy.answerTimeInstant)).toBeInTheDocument();
    expect(within(speed).queryByText(copy.seconds)).toBeNull();
  });

  it('says so when the numbers cannot be read, asks again on Try again, and the list still loads', async () => {
    let fail = true;
    signedInApi({
      'GET /api/front-desk/stats?day=today': () => (fail ? { status: 500, body: { error: 'nope' } } : { body: DAY }),
      'GET /api/conversations?filter=all': () => ({ body: page([row({ id: 'c-1', name: 'Dana Ruiz' })]) }),
    });
    const { user } = renderApp('/front-desk');
    const strip = await screen.findByRole('region', { name: copy.kpisLabel });
    expect(await within(strip).findByText(copy.kpisError)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Dana Ruiz/ })).toBeInTheDocument();

    fail = false;
    await user.click(within(strip).getByRole('button', { name: copy.tryAgain }));
    expect(await within(strip).findByText('39')).toBeInTheDocument();
  });

  it('keeps the Simulate a call button demo-only, and it makes a simulated call', async () => {
    signedInApi({ 'GET /api/demo': () => ({ body: { demo: false } }) });
    renderApp('/front-desk');
    await screen.findByTestId('fd-status');
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

  it('never asks a rep for the numbers, and still shows the number it answers and the list', async () => {
    signedInApi({ 'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role: 'rep' } }) });
    renderApp('/front-desk');
    expect(await screen.findByText(copy.empty)).toBeInTheDocument();
    expect(api.count('GET /api/front-desk/stats?day=today')).toBe(0);
    expect(screen.queryByRole('region', { name: copy.kpisLabel })).toBeNull();
    expect(screen.getByTestId('fd-status')).toBeInTheDocument();
    const group = screen.getByRole('group', { name: copy.tabsLabel });
    // Without the numbers the chips show their names alone
    expect(within(group).getAllByRole('button').map((chip) => chip.textContent)).toEqual(Object.values(copy.tabs));
  });
});

describe('Front Desk filters and rows', () => {
  it('shows All, Booked, Text-backs and Blocked with the counts from the server', async () => {
    signedInApi();
    renderApp('/front-desk');
    const group = await screen.findByRole('group', { name: copy.tabsLabel });
    await waitFor(() =>
      expect(within(group).getAllByRole('button').map((chip) => chip.textContent)).toEqual([
        `${copy.tabs.all} 8`,
        `${copy.tabs.booked} 3`,
        `${copy.tabs.messages} 1`,
        `${copy.tabs.spam} 1`,
      ]),
    );
    expect(within(group).getByRole('button', { name: `${copy.tabs.all} 8` })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: `${copy.tabs.booked} 3` })).toHaveAttribute('aria-pressed', 'false');
  });

  it('asks for the filter behind the chip: Text-backs is messages and Blocked is spam', async () => {
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
    const blocked = await screen.findByRole('link', { name: new RegExp(copy.unknownCaller) });
    expect(within(blocked).getByText(copy.chips.spam)).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: new RegExp(copy.tabs.spam) })).toHaveAttribute('aria-pressed', 'true');
  });

  it('draws initials, the outcome tag with its word, how long ago and how long it ran', async () => {
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

  it('marks an urgent call with a word and a glyph, an unread one with its count, and who is handling it', async () => {
    signedInApi({
      'GET /api/conversations?filter=all': () => ({
        body: page([row({ id: 'c-1', name: 'Dana Ruiz', outcome: 'message', urgent: true, unreadCount: 3, needsAttention: true, handledBy: 'team' })]),
      }),
    });
    renderApp('/front-desk');
    const dana = await screen.findByRole('link', { name: /Dana Ruiz/ });
    const urgent = within(dana).getByText(copy.urgent);
    expect(urgent.querySelector('svg')).not.toBeNull();
    expect(within(dana).getByRole('img', { name: copy.unread(3) })).toHaveTextContent('3');
    expect(within(dana).getByText(copy.handledByTeam)).toBeInTheDocument();
    expect(within(dana).getByText(copy.needsAttention)).toBeInTheDocument();
  });

  it('keeps the exact words when there are no calls yet, with a way to the forwarding settings for the owner', async () => {
    signedInApi();
    renderApp('/front-desk');
    expect(await screen.findByText('No calls yet. Once forwarding is on, every call shows up here.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: copy.forwardingSettings })).toHaveAttribute('href', '/settings/front-desk#forwarding');
  });

  it('offers no settings link to a rep when there are no calls', async () => {
    signedInApi({ 'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role: 'rep' } }) });
    renderApp('/front-desk');
    expect(await screen.findByText(copy.empty)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: copy.forwardingSettings })).toBeNull();
  });

  it('shows the picked call on the right, marks its row, and puts its name in the trail', async () => {
    signedInApi({
      'GET /api/conversations?filter=all': () => ({ body: page([row({ id: 'abc', name: 'Pat Lee', outcome: 'booked' })]) }),
      'GET /api/conversations/abc': () => ({ body: detailOf('abc', 'Pat Lee') }),
      'POST /api/conversations/abc/read': () => ({ body: {} }),
    });
    const { router, user } = renderApp('/front-desk');
    expect(await screen.findByText(copy.pickCall)).toBeInTheDocument();

    await user.click(await screen.findByRole('link', { name: /Pat Lee/ }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Pat Lee' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/front-desk/abc');
    expect(screen.getByRole('link', { name: /Pat Lee/ })).toHaveAttribute('aria-current', 'true');
    // The list stays beside the call, and keeps the filter the person chose
    expect(screen.getByRole('button', { name: new RegExp('^' + copy.tabs.all) })).toHaveAttribute('aria-pressed', 'true');
    // The trail in the top bar ends in the person's name; "Front Desk" before it is a link back
    const trail = screen.getByRole('navigation', { name: shell.crumbsLabel });
    expect(within(trail).getByRole('link', { name: WINDOW_COPY['front-desk'].title })).toHaveAttribute('href', '/front-desk');
    expect(within(trail).getByText('Pat Lee')).toHaveAttribute('aria-current', 'page');
    // Opening a call marks it read, once, however many times the page draws
    await waitFor(() => expect(api.count('POST /api/conversations/abc/read')).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.count('POST /api/conversations/abc/read')).toBe(1);
  });

  it('shows a plain message, with a way to try again, when the picked call cannot be loaded', async () => {
    signedInApi({
      'GET /api/conversations?filter=all': () => ({ body: page([row({ id: 'abc', name: 'Pat Lee' })]) }),
      'GET /api/conversations/abc': () => ({ status: 404, body: { error: 'Not found' } }),
      'POST /api/conversations/abc/read': () => ({ body: {} }),
    });
    renderApp('/front-desk/abc');
    expect(await screen.findByText(conversationCopy.loadFailed)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: conversationCopy.tryAgain })).toBeInTheDocument();
    // The trail has no name to show yet, so it says what it is
    const trail = screen.getByRole('navigation', { name: shell.crumbsLabel });
    expect(within(trail).getByText(copy.conversation)).toBeInTheDocument();
  });
});

describe('Front Desk on a phone', () => {
  it('shows the list alone, and a picked call alone with Front Desk as the way back', async () => {
    stubPhone(true);
    signedInApi({
      'GET /api/conversations?filter=all': () => ({ body: page([row({ id: 'abc', name: 'Pat Lee', outcome: 'booked' })]) }),
      'GET /api/conversations/abc': () => ({ body: detailOf('abc', 'Pat Lee') }),
      'POST /api/conversations/abc/read': () => ({ body: {} }),
    });
    const { router, user } = renderApp('/front-desk');

    // The list: its own heading and filters, and no call beside it
    expect(await screen.findByRole('link', { name: /Pat Lee/ })).toBeInTheDocument();
    expect(screen.queryByText(copy.pickCall)).toBeNull();

    await user.click(screen.getByRole('link', { name: /Pat Lee/ }));

    // The call: the list and the numbers are gone, and the top of the page is the way back
    expect(await screen.findByRole('heading', { level: 2, name: 'Pat Lee' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/front-desk/abc');
    expect(screen.queryByRole('group', { name: copy.tabsLabel })).toBeNull();
    expect(screen.queryByRole('region', { name: copy.kpisLabel })).toBeNull();
    expect(screen.getByRole('link', { name: WINDOW_COPY['front-desk'].title })).toHaveAttribute('href', '/front-desk');
  });

  it('lets the row of tiles be reached from the keyboard, since it slides sideways', async () => {
    stubPhone(true);
    signedInApi();
    renderApp('/front-desk');
    const strip = await screen.findByRole('region', { name: copy.kpisLabel });
    await tile(copy.callsToday);
    expect(strip.querySelector('[tabindex="0"]')).not.toBeNull();
  });
});

describe('Front Desk words', () => {
  const base = row({ id: 'x' });

  it('words every outcome as a tag with a glyph', () => {
    expect(outcomeChip({ ...base, outcome: 'booked' })).toMatchObject({ label: copy.chips.booked, tone: 'ok', icon: 'cal' });
    expect(outcomeChip({ ...base, outcome: 'spam' })).toMatchObject({ label: copy.chips.spam, tone: 'warn', icon: 'lock' });
    expect(outcomeChip({ ...base, outcome: 'claim' }).label).toBe(copy.chips.claim);
    expect(outcomeChip({ ...base, outcome: 'job_question' }).label).toBe(copy.chips.question);
    expect(outcomeChip({ ...base, outcome: 'transferred', transferredToName: 'Sam' }).label).toBe(copy.chips.sentTo('Sam'));
    expect(outcomeChip({ ...base, outcome: 'transferred' }).label).toBe(copy.chips.sentToTeam);
    expect(outcomeChip({ ...base, outcome: 'abandoned', textBackSent: true }).label).toBe(copy.chips.textBack);
    expect(outcomeChip({ ...base, outcome: 'abandoned' }).label).toBe(copy.chips.hungUp);
    expect(outcomeChip({ ...base, channel: 'sms', outcome: 'message' }).label).toBe(copy.chips.textBack);
    expect(outcomeChip({ ...base, outcome: 'message' }).label).toBe(copy.chips.message);
  });

  it('counts time ago and tenths of a second', () => {
    expect(relativeTime('2026-10-13T17:59:50.000Z', NOW)).toBe(copy.time.justNow);
    expect(relativeTime('2026-10-13T17:00:00.000Z', NOW)).toBe(copy.time.hours(1));
    expect(relativeTime('2026-10-11T17:00:00.000Z', NOW)).toBe(copy.time.days(2));
    expect(secondsText(800)).toBe('0.8');
    expect(secondsText(1260)).toBe('1.3');
  });
});
