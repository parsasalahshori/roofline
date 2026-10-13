import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CallView, ConversationDetail, TurnView } from '@roofline/shared';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallDetail } from '../src/features/front-desk/lift/CallDetail.tsx';
import { liftCall } from '../src/copy/liftCall.ts';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { ACCOUNT, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi> | undefined;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
  api = undefined;
});

const START = '2026-10-11T14:00:00.000Z';
const LATER = '2026-10-11T14:00:20.000Z';

function makeCall(overrides: Partial<CallView> = {}): CallView {
  return {
    id: 'call1',
    status: 'ended',
    startedAt: START,
    endedAt: LATER,
    aiSeconds: 98,
    recordingStatus: 'stored',
    transcriptStored: true,
    transferResult: 'none',
    transferTo: null,
    spamReason: null,
    canPlayRecording: true,
    ...overrides,
  };
}

function turn(id: string, speaker: TurnView['speaker'], text: string | null, position: number, overrides: Partial<TurnView> = {}): TurnView {
  return { id, callId: 'call1', position, speaker, text, truncated: false, at: START, actions: [], ...overrides };
}

function makeConversation(overrides: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    id: 'conv1',
    channel: 'voice',
    status: 'ended',
    customer: { id: 'c1', name: 'Mei Blakely' },
    phoneE164: '+15550110758',
    outcome: 'job_question',
    summary: 'Asked if the crew will be back to pick up the dumpster.',
    followUps: [],
    identity: 'matched',
    handledBy: 'assistant',
    teamUntil: null,
    calls: [makeCall()],
    turns: [
      turn('t2', 'assistant', 'It is scheduled for 7 AM on Thursday.', 2),
      turn('t1', 'caller', 'When is the dumpster getting picked up?', 1),
    ],
    links: { jobIds: ['job9'], appointmentIds: [], claimIntakeIds: [] },
    canReply: false,
    ...overrides,
  };
}

function renderDetail(conversation: ConversationDetail) {
  // CallActions reads the signed-in role (Mark as spam is for the owner and office).
  api = stubApi({ [`GET /api/conversations/${conversation.id}`]: () => ({ body: conversation }), 'GET /api/auth/me': () => ({ body: ACCOUNT }) });
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

const heights = () => screen.getAllByTestId('waveform')[0]!.querySelectorAll('span');

describe('CallDetail', () => {
  it('offers the staff actions: Team is handling, Mark as spam for a call (owner), and Call back', async () => {
    const conversation = makeConversation();
    renderDetail(conversation);
    expect(await screen.findByRole('switch', { name: 'Team is handling' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Mark as spam' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Call back' })).toHaveAttribute('href', `tel:${conversation.phoneE164}`);
  });

  it('shows the caller, outcome, summary, audio row and the transcript in time order', async () => {
    renderDetail(makeConversation());

    expect(await screen.findByRole('heading', { name: 'Mei Blakely' })).toBeInTheDocument();
    expect(screen.getByText('Answered question')).toBeInTheDocument();
    expect(screen.getByText('(555) 011-0758')).toBeInTheDocument();
    expect(screen.getByText(liftCall.duration('1:38', liftCall.callWord))).toBeInTheDocument();
    expect(screen.getByText(liftCall.summaryHeading)).toBeInTheDocument();
    expect(screen.getByText('Asked if the crew will be back to pick up the dumpster.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: liftCall.listen })).toBeEnabled();
    expect(screen.getByText(liftCall.position('0:00', '1:38'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: liftCall.speedLabel })).toHaveTextContent(liftCall.speed(1));

    expect(screen.getByText(liftCall.messageCount(2))).toBeInTheDocument();
    const bubbles = screen.getAllByRole('listitem');
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]).toHaveAttribute('data-side', 'left');
    expect(within(bubbles[0]!).getByText('When is the dumpster getting picked up?')).toBeInTheDocument();
    expect(bubbles[1]).toHaveAttribute('data-side', 'right');
  });

  it('links Open job to the job route, and hides it when no job is linked', async () => {
    const { unmount } = renderDetail(makeConversation());
    const link = await screen.findByRole('link', { name: liftCall.openJob });
    expect(link).toHaveAttribute('href', '/jobs/job9');
    unmount();

    renderDetail(makeConversation({ links: { jobIds: [], appointmentIds: [], claimIntakeIds: [] } }));
    await screen.findByRole('heading', { name: 'Mei Blakely' });
    expect(screen.queryByRole('link', { name: liftCall.openJob })).toBeNull();
  });

  it('streams the recording only after Listen and cycles the speed', async () => {
    const { container, user } = renderDetail(makeConversation());
    await user.click(await screen.findByRole('button', { name: liftCall.listen }));
    expect(container.querySelector('audio')?.getAttribute('src')).toBe('/api/calls/call1/recording');

    await user.click(screen.getByRole('button', { name: liftCall.speedLabel }));
    expect(screen.getByRole('button', { name: liftCall.speedLabel })).toHaveTextContent(liftCall.speed(1.5));
    expect(container.querySelector('audio')?.playbackRate).toBe(1.5);
  });

  it('returns to Listen with a message when the audio fails', async () => {
    const { container, user } = renderDetail(makeConversation());
    await user.click(await screen.findByRole('button', { name: liftCall.listen }));
    fireEvent.error(container.querySelector('audio') as HTMLAudioElement);

    expect(await screen.findByText(liftCall.recordingFailed)).toBeInTheDocument();
    expect(container.querySelector('audio')).toBeNull();
    expect(screen.getByRole('button', { name: liftCall.listen })).toBeEnabled();
  });

  it('leaves the audio row out when there is no recording to play', async () => {
    renderDetail(makeConversation({ calls: [makeCall({ recordingStatus: 'none' })] }));
    expect(await screen.findByRole('heading', { name: 'Mei Blakely' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: liftCall.listen })).toBeNull();
    expect(screen.queryByTestId('waveform')).toBeNull();
    expect(screen.queryByText(liftCall.noRecording)).toBeNull();
  });

  it('draws the same placeholder bars for the same call until the recording is decoded', async () => {
    const first = renderDetail(makeConversation());
    await screen.findByRole('button', { name: liftCall.listen });
    const one = [...heights()].map((bar) => bar.style.height);
    expect(one.length).toBeGreaterThan(10);
    first.unmount();

    renderDetail(makeConversation());
    await screen.findByRole('button', { name: liftCall.listen });
    expect([...heights()].map((bar) => bar.style.height)).toEqual(one);
    cleanup();

    renderDetail(makeConversation({ calls: [makeCall({ id: 'call2' })] }));
    await screen.findByRole('button', { name: liftCall.listen });
    expect([...heights()].map((bar) => bar.style.height)).not.toEqual(one);
  });

  it('shows a text conversation as bubbles without the audio row', async () => {
    renderDetail(
      makeConversation({
        channel: 'sms',
        calls: [],
        outcome: 'message',
        turns: [turn('m1', 'caller', 'Can you text me the quote?', 0, { callId: null }), turn('m2', 'team', null, 0, { callId: null, noWords: true, at: LATER })],
        links: { jobIds: [], appointmentIds: [], claimIntakeIds: [] },
      }),
    );

    expect(await screen.findByText('Can you text me the quote?')).toBeInTheDocument();
    expect(screen.getByText(liftCall.noWords)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: liftCall.listen })).toBeNull();
    expect(screen.queryByTestId('waveform')).toBeNull();
  });

  it('says why a transcript line has no words', async () => {
    renderDetail(makeConversation({ calls: [makeCall({ transcriptStored: false })], turns: [turn('t1', 'caller', null, 1)] }));
    expect(await screen.findByText(liftCall.transcriptNotKept)).toBeInTheDocument();
  });

  it('shows a plain message when the conversation cannot be loaded', async () => {
    api = stubApi({ 'GET /api/conversations/missing': () => ({ status: 404, body: { error: 'Not found' } }) });
    const queryClient = createQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false } });
    const router = createMemoryRouter([{ path: '*', element: <CallDetail conversationId="missing" /> }], { initialEntries: ['/'] });
    render(
      <Providers client={queryClient}>
        <RouterProvider router={router} />
      </Providers>,
    );
    expect(await screen.findByText(liftCall.loadFailed)).toBeInTheDocument();
  });
});
