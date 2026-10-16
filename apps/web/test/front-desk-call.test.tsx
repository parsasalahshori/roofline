import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConversationDetail } from '@roofline/shared';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { conversationCopy } from '../src/copy/front-desk-conversation.ts';
import { frontDeskInbox } from '../src/copy/front-desk-inbox.ts';
import { CallDetail } from '../src/features/front-desk/detail/CallDetail.tsx';
import { LATER, makeCall, makeConversation, turn } from './front-desk-fixtures.ts';
import { ACCOUNT, COMPANY, type Routes, stubApi } from './helpers.tsx';

// One open call: who it is, what came of it, who is handling it, the summary, the recording and the buttons.
// What was said is in front-desk-transcript.test.tsx; the reply box is in d1-t22-reply.test.tsx.

const copy = conversationCopy;

let api: ReturnType<typeof stubApi> | undefined;

beforeEach(() => {
  // The header says "Oct 11 at ..." for a call from the 11th, so the clock is fixed a few days later
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T15:00:00.000Z'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
  api = undefined;
});

type Role = 'owner' | 'office' | 'rep';

function renderDetail(conversation: ConversationDetail, options: { role?: Role; routes?: Routes } = {}) {
  api = stubApi({
    'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role: options.role ?? 'owner' } }),
    'GET /api/company': () => ({ body: { ...COMPANY, timezone: 'America/Chicago' } }),
    [`GET /api/conversations/${conversation.id}`]: () => ({ body: conversation }),
    ...options.routes,
  });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createMemoryRouter([{ path: '*', element: <CallDetail conversationId={conversation.id} /> }], { initialEntries: ['/'] });
  const result = render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { ...result, user: userEvent.setup() };
}

const HANDLING = 'POST /api/conversations/conv1/handling';
const SPAM = 'POST /api/calls/call1/spam';
const heights = () => screen.getAllByTestId('waveform')[0]!.querySelectorAll('span');

describe('CallDetail head', () => {
  it('shows the name, the outcome as a tag, the number, when it happened and how long it ran', async () => {
    renderDetail(makeConversation());

    expect(await screen.findByRole('heading', { level: 2, name: 'Mei Blakely' })).toBeInTheDocument();
    expect(screen.getByText(frontDeskInbox.chips.question)).toBeInTheDocument();
    expect(screen.getByText('(555) 011-0758')).toBeInTheDocument();
    expect(screen.queryByText('+15550110758')).toBeNull();
    // On the company's own clock, which arrives a moment after the call: 14:00 UTC is 9:00 AM in Chicago in October
    expect(await screen.findByText(copy.onDate('Oct 11', '9:00 AM'))).toBeInTheDocument();
    // The length is in the head and again on the recording panel
    expect(screen.getAllByText('1:38').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(copy.callWord)).toBeInTheDocument();
  });

  it('says Today and Yesterday for the last two days', async () => {
    renderDetail(makeConversation({ calls: [makeCall({ startedAt: '2026-10-20T14:30:00.000Z' })] }));
    expect(await screen.findByText(copy.today('9:30 AM'))).toBeInTheDocument();
    cleanup();

    renderDetail(makeConversation({ calls: [makeCall({ startedAt: '2026-10-19T14:30:00.000Z' })] }));
    expect(await screen.findByText(copy.yesterday('9:30 AM'))).toBeInTheDocument();
  });

  it('falls back to the unknown caller line when there is no customer', async () => {
    renderDetail(makeConversation({ customer: null, phoneE164: '+15551230000' }));
    expect(await screen.findByRole('heading', { level: 2, name: copy.unknownCaller })).toBeInTheDocument();
    expect(screen.getByText('(555) 123-0000')).toBeInTheDocument();
  });

  it('calls back as a tel: link, not a button', async () => {
    renderDetail(makeConversation());
    const link = await screen.findByRole('link', { name: copy.callBack });
    expect(link).toHaveAttribute('href', 'tel:+15550110758');
    expect(screen.queryByRole('button', { name: copy.callBack })).toBeNull();
  });

  it('links Open job to the job route, and hides it when no job is linked', async () => {
    const { unmount } = renderDetail(makeConversation());
    const link = await screen.findByRole('link', { name: copy.openJob });
    expect(link).toHaveAttribute('href', '/jobs/job9');
    unmount();

    renderDetail(makeConversation({ links: { jobIds: [], appointmentIds: [], claimIntakeIds: [] } }));
    await screen.findByRole('heading', { level: 2, name: 'Mei Blakely' });
    expect(screen.queryByRole('link', { name: copy.openJob })).toBeNull();
  });
});

describe('CallDetail text thread', () => {
  it('shows a text conversation as bubbles, with its handoff, and without the recording', async () => {
    renderDetail(
      makeConversation({
        channel: 'sms',
        calls: [],
        outcome: 'message',
        summary: null,
        turns: [
          turn('m1', 'caller', 'Can you text me the quote?', 0, { callId: null }),
          turn('m2', 'team', null, 0, { callId: null, noWords: true, at: LATER }),
        ],
        links: { jobIds: [], appointmentIds: [], claimIntakeIds: [] },
      }),
    );

    expect(await screen.findByText('Can you text me the quote?')).toBeInTheDocument();
    expect(screen.getByText(copy.noWords)).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: copy.handlingLabel })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.listen })).toBeNull();
    expect(screen.queryByTestId('waveform')).toBeNull();
    // A text has no length to speak of: the header holds the number and the time only
    expect(screen.queryByText(copy.callWord)).toBeNull();
    expect(screen.getByText(frontDeskInbox.chips.textBack)).toBeInTheDocument();
  });
});

describe('CallDetail spam', () => {
  it('marks the last call as spam on a voice conversation, for the owner', async () => {
    const { user } = renderDetail(makeConversation(), { routes: { [SPAM]: () => ({ body: {} }) } });
    await user.click(await screen.findByRole('button', { name: copy.markSpam }));
    await waitFor(() => expect(api?.count(SPAM)).toBe(1));
    expect(api?.sent(SPAM)).toEqual([{}]);
  });

  it('shows Mark as spam to the office', async () => {
    renderDetail(makeConversation(), { role: 'office' });
    expect(await screen.findByRole('button', { name: copy.markSpam })).toBeInTheDocument();
  });

  it('hides Mark as spam from a rep, who cannot mark spam', async () => {
    renderDetail(makeConversation(), { role: 'rep' });
    await screen.findByRole('heading', { level: 2, name: 'Mei Blakely' });
    await waitFor(() => expect(api?.count('GET /api/auth/me')).toBe(1));
    // Let the answer render before checking the button is absent.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('button', { name: copy.markSpam })).toBeNull();
    expect(screen.getByRole('link', { name: copy.callBack })).toBeInTheDocument();
  });

  it('hides Mark as spam for a text conversation', async () => {
    renderDetail(makeConversation({ channel: 'sms', calls: [], canReply: false }));
    await screen.findByRole('heading', { level: 2, name: 'Mei Blakely' });
    expect(screen.queryByRole('button', { name: copy.markSpam })).toBeNull();
  });

  it('shows the spam mark, with its glyph, instead of the button once the call is marked', async () => {
    renderDetail(makeConversation({ calls: [makeCall({ spamReason: 'robocall' })] }));
    const mark = await screen.findByText(copy.spamMarked);
    expect(mark.querySelector('svg')).not.toBeNull();
    expect(screen.queryByRole('button', { name: copy.markSpam })).toBeNull();
  });

  it('says so when marking it did not work', async () => {
    const { user } = renderDetail(makeConversation(), { routes: { [SPAM]: () => ({ status: 500, body: { error: 'nope' } }) } });
    await user.click(await screen.findByRole('button', { name: copy.markSpam }));
    expect(await screen.findByText(copy.spamFailed)).toBeInTheDocument();
  });
});

describe('CallDetail hand-off', () => {
  const group = () => screen.findByRole('radiogroup', { name: copy.handlingLabel });

  it('shows who has the conversation as a two-choice switch', async () => {
    renderDetail(makeConversation({ handledBy: 'assistant' }));
    const choices = await group();
    expect(within(choices).getByRole('radio', { name: copy.handling.assistant })).toBeChecked();
    expect(within(choices).getByRole('radio', { name: copy.handling.team })).not.toBeChecked();
  });

  it('hands it to the team: choosing the team posts by team', async () => {
    const { user } = renderDetail(makeConversation({ handledBy: 'assistant' }), { routes: { [HANDLING]: () => ({ body: {} }) } });
    await user.click(within(await group()).getByRole('radio', { name: copy.handling.team }));
    await waitFor(() => expect(api?.count(HANDLING)).toBe(1));
    expect(api?.sent(HANDLING)).toEqual([{ by: 'team' }]);
  });

  it('shows the new choice at once, before the server has answered, and ignores a second tap meanwhile', async () => {
    const { user } = renderDetail(makeConversation({ handledBy: 'assistant' }), { routes: { [HANDLING]: () => ({ body: {} }) } });
    const choices = await group();
    // Hold the answer to the change until the test lets it go
    const answer = globalThis.fetch;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => (String(input).endsWith('/handling') ? held.then(() => answer(input, init)) : answer(input, init)));

    await user.click(within(choices).getByRole('radio', { name: copy.handling.team }));
    await waitFor(() => expect(within(choices).getByRole('radio', { name: copy.handling.team })).toBeChecked());
    expect(within(choices).getByRole('radio', { name: copy.handling.assistant })).not.toBeChecked();
    await user.click(within(choices).getByRole('radio', { name: copy.handling.assistant }));
    release();
    await waitFor(() => expect(api?.count(HANDLING)).toBe(1));
  });

  it('hands it back: choosing the assistant posts by assistant, and the time the team has it until shows', async () => {
    const { user } = renderDetail(makeConversation({ handledBy: 'team', teamUntil: '2026-10-20T20:40:00.000Z' }), {
      routes: { [HANDLING]: () => ({ body: {} }) },
    });
    const choices = await group();
    expect(within(choices).getByRole('radio', { name: copy.handling.team })).toBeChecked();
    // On the company's own clock, which arrives a moment after the call: 20:40 UTC is 3:40 PM in Chicago
    expect(await screen.findByText(copy.handlingUntil('3:40 PM'))).toBeInTheDocument();

    await user.click(within(choices).getByRole('radio', { name: copy.handling.assistant }));
    await waitFor(() => expect(api?.count(HANDLING)).toBe(1));
    expect(api?.sent(HANDLING)).toEqual([{ by: 'assistant' }]);
  });

  it('says so when the change did not work', async () => {
    const { user } = renderDetail(makeConversation(), { routes: { [HANDLING]: () => ({ status: 500, body: { error: 'nope' } }) } });
    await user.click(within(await group()).getByRole('radio', { name: copy.handling.team }));
    expect(await screen.findByText(copy.handlingFailed)).toBeInTheDocument();
  });
});

describe('CallDetail summary', () => {
  it('shows the summary and the things left to do', async () => {
    renderDetail(makeConversation({ summary: 'Pat wants a roof inspection next week.', followUps: ['Send the estimate', 'Call Pat back on Monday'] }));
    expect(await screen.findByRole('heading', { level: 3, name: copy.summaryHeading })).toBeInTheDocument();
    expect(screen.getByText('Pat wants a roof inspection next week.')).toBeInTheDocument();
    const todo = screen.getByRole('list', { name: copy.followUpsHeading });
    expect(within(todo).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Send the estimate', 'Call Pat back on Monday']);
  });

  it('says there is no summary yet on a call, with no to-do list', async () => {
    renderDetail(makeConversation({ summary: null, followUps: [] }));
    expect(await screen.findByText(copy.summaryNone)).toBeInTheDocument();
    expect(screen.queryByText(copy.followUpsHeading)).toBeNull();
  });

  it('leaves the summary out of a text thread that has nothing to say', async () => {
    renderDetail(makeConversation({ channel: 'sms', calls: [], summary: null, followUps: [], outcome: 'message' }));
    await screen.findByRole('heading', { level: 2, name: 'Mei Blakely' });
    expect(screen.queryByRole('heading', { name: copy.summaryHeading })).toBeNull();
  });
});

describe('CallDetail recording', () => {
  it('shows the audio panel with the length, Listen, the position and the speed', async () => {
    renderDetail(makeConversation());
    expect(await screen.findByRole('heading', { level: 3, name: copy.recordingHeading })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.listen })).toBeEnabled();
    expect(screen.getByText(copy.position('0:00', '1:38'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.speedLabel })).toHaveTextContent(copy.speed(1));
  });

  it('loads no sound until Listen is pressed, then streams from the recording route, and cycles the speed', async () => {
    const { container, user } = renderDetail(makeConversation());
    await user.click(await screen.findByRole('button', { name: copy.listen }));
    expect(container.querySelector('audio')?.getAttribute('src')).toBe('/api/calls/call1/recording');
    expect(container.querySelector('audio')).toHaveAttribute('aria-label', copy.audioLabel);
    expect(container.querySelector('audio')).toHaveAttribute('preload', 'none');

    await user.click(screen.getByRole('button', { name: copy.speedLabel }));
    expect(screen.getByRole('button', { name: copy.speedLabel })).toHaveTextContent(copy.speed(1.5));
    expect(container.querySelector('audio')?.playbackRate).toBe(1.5);
    await user.click(screen.getByRole('button', { name: copy.speedLabel }));
    expect(screen.getByRole('button', { name: copy.speedLabel })).toHaveTextContent(copy.speed(2));
    await user.click(screen.getByRole('button', { name: copy.speedLabel }));
    expect(screen.getByRole('button', { name: copy.speedLabel })).toHaveTextContent(copy.speed(1));
  });

  it('has no audio element, and asks for no sound, before Listen', async () => {
    const { container } = renderDetail(makeConversation());
    await screen.findByRole('button', { name: copy.listen });
    expect(container.querySelector('audio')).toBeNull();
    expect(api?.count('GET /api/calls/call1/recording')).toBe(0);
    // The seek bar waits for the sound: nothing to move through yet
    expect(screen.getByRole('slider', { name: copy.seekLabel })).toBeDisabled();
  });

  it('returns to Listen with a message when the audio fails', async () => {
    const { container, user } = renderDetail(makeConversation());
    await user.click(await screen.findByRole('button', { name: copy.listen }));
    fireEvent.error(container.querySelector('audio') as HTMLAudioElement);

    expect(await screen.findByText(copy.recordingFailed)).toBeInTheDocument();
    expect(container.querySelector('audio')).toBeNull();
    expect(screen.getByRole('button', { name: copy.listen })).toBeEnabled();
  });

  it('leaves the audio panel out when there is no recording to play', async () => {
    renderDetail(makeConversation({ calls: [makeCall({ recordingStatus: 'none' })] }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Mei Blakely' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: copy.recordingHeading })).toBeNull();
    expect(screen.queryByRole('button', { name: copy.listen })).toBeNull();
    expect(screen.queryByTestId('waveform')).toBeNull();
  });

  it('leaves it out for a role that may not hear it, and for a text thread', async () => {
    renderDetail(makeConversation({ calls: [makeCall({ canPlayRecording: false })] }));
    await screen.findByRole('heading', { level: 2, name: 'Mei Blakely' });
    expect(screen.queryByRole('heading', { name: copy.recordingHeading })).toBeNull();
    cleanup();

    renderDetail(makeConversation({ channel: 'sms', calls: [], canReply: false }));
    await screen.findByRole('heading', { level: 2, name: 'Mei Blakely' });
    expect(screen.queryByRole('heading', { name: copy.recordingHeading })).toBeNull();
  });

  it('draws the same placeholder bars for the same call until the recording is decoded', async () => {
    const first = renderDetail(makeConversation());
    await screen.findByRole('button', { name: copy.listen });
    const one = [...heights()].map((bar) => bar.style.height);
    expect(one.length).toBeGreaterThan(10);
    first.unmount();

    renderDetail(makeConversation());
    await screen.findByRole('button', { name: copy.listen });
    expect([...heights()].map((bar) => bar.style.height)).toEqual(one);
    cleanup();

    renderDetail(makeConversation({ calls: [makeCall({ id: 'call2' })] }));
    await screen.findByRole('button', { name: copy.listen });
    expect([...heights()].map((bar) => bar.style.height)).not.toEqual(one);
  });
});

describe('CallDetail states', () => {
  it('shows a status while the call loads, then the call', async () => {
    renderDetail(makeConversation());
    expect(screen.getByRole('status', { name: copy.loading })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 2, name: 'Mei Blakely' })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: copy.loading })).toBeNull();
  });

  it('shows a plain message with Try again when the conversation cannot be loaded, and loads it on a second try', async () => {
    const conversation = makeConversation();
    let fail = true;
    const { user } = renderDetail(conversation, {
      routes: { 'GET /api/conversations/conv1': () => (fail ? { status: 404, body: { error: 'Not found' } } : { body: conversation }) },
    });
    expect(await screen.findByText(copy.loadFailed)).toBeInTheDocument();

    fail = false;
    await user.click(screen.getByRole('button', { name: copy.tryAgain }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Mei Blakely' })).toBeInTheDocument();
  });
});
