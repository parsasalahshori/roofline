import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import type { CallView, ConversationDetail } from '@roofline/shared';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordingPlayer } from '../src/features/front-desk/RecordingPlayer.tsx';
import { SummaryPanel } from '../src/features/front-desk/SummaryPanel.tsx';
import { conversationCopy } from '../src/copy/front-desk-conversation.ts';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi> | undefined;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
  api = undefined;
});

const AT = '2026-10-11T14:00:00.000Z';
const SIGNED_URL = 'https://signed.example/rec.mp3';
const RECORDING = 'GET /api/calls/call1/recording';
const HANDLING = 'POST /api/conversations/conv1/handling';
const SPAM = 'POST /api/calls/call1/spam';

function makeCall(overrides: Partial<CallView> = {}): CallView {
  return {
    id: 'call1',
    status: 'ended',
    startedAt: AT,
    endedAt: AT,
    aiSeconds: 42,
    recordingStatus: 'stored',
    transcriptStored: true,
    transferResult: 'none',
    transferTo: null,
    spamReason: null,
    canPlayRecording: true,
    ...overrides,
  };
}

function makeConversation(overrides: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    id: 'conv1',
    channel: 'voice',
    status: 'ended',
    customer: { id: 'c1', name: 'Pat Homeowner' },
    phoneE164: '+15551230000',
    outcome: 'booked',
    summary: 'Pat wants a roof inspection next week.',
    followUps: ['Send the estimate', 'Call Pat back on Monday'],
    identity: 'matched',
    handledBy: 'assistant',
    teamUntil: null,
    calls: [makeCall()],
    turns: [],
    links: { jobIds: [], appointmentIds: [], claimIntakeIds: [] },
    canReply: false,
    ...overrides,
  };
}

/** Renders `ui` under the app providers and a memory router, the way the other web tests do. */
function renderWith(ui: ReactElement) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createMemoryRouter([{ path: '*', element: ui }], { initialEntries: ['/'] });
  const result = render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { ...result, user: userEvent.setup() };
}

describe('RecordingPlayer', () => {
  it('renders nothing when the role cannot play the recording', () => {
    api = stubApi({});
    const { container } = renderWith(<RecordingPlayer call={makeCall({ canPlayRecording: false })} />);

    expect(container.querySelector('section')).toBeNull();
    expect(screen.queryByText(conversationCopy.recordingHeading)).toBeNull();
    expect(screen.queryByRole('button', { name: conversationCopy.playRecording })).toBeNull();
    expect(container.querySelector('audio')).toBeNull();
  });

  it('fetches the signed URL only when the person presses play, then plays it with native controls', async () => {
    api = stubApi({
      [RECORDING]: () => ({ body: { url: SIGNED_URL, expiresAt: '2026-10-11T14:05:00.000Z' } }),
    });
    const { container, user } = renderWith(<RecordingPlayer call={makeCall()} />);

    expect(screen.getByText(conversationCopy.recordingHeading)).toBeInTheDocument();
    expect(api.count(RECORDING)).toBe(0);

    await user.click(screen.getByRole('button', { name: conversationCopy.playRecording }));

    await waitFor(() => expect(container.querySelector('audio')).not.toBeNull());
    expect(api.count(RECORDING)).toBe(1);
    const audio = container.querySelector('audio');
    expect(audio).toHaveAttribute('src', SIGNED_URL);
    expect(audio).toHaveAttribute('controls');
    expect(audio).toHaveAttribute('aria-label', conversationCopy.recordingLabel);
    expect(screen.queryByRole('button', { name: conversationCopy.playRecording })).toBeNull();
  });

  it('shows a plain danger message when the recording cannot be loaded', async () => {
    api = stubApi({
      [RECORDING]: () => ({ status: 500, body: { error: 'x' } }),
    });
    const { container, user } = renderWith(<RecordingPlayer call={makeCall()} />);

    await user.click(screen.getByRole('button', { name: conversationCopy.playRecording }));

    expect(await screen.findByText(conversationCopy.recordingFailed)).toBeInTheDocument();
    expect(container.querySelector('audio')).toBeNull();
  });
});

describe('SummaryPanel', () => {
  it('renders the summary and the follow-ups', () => {
    api = stubApi({});
    renderWith(<SummaryPanel conversation={makeConversation()} />);

    expect(screen.getByText(conversationCopy.summaryHeading)).toBeInTheDocument();
    expect(screen.getByText('Pat wants a roof inspection next week.')).toBeInTheDocument();
    expect(screen.getByText(conversationCopy.followUpsHeading)).toBeInTheDocument();
    expect(screen.getByText('Send the estimate')).toBeInTheDocument();
    expect(screen.getByText('Call Pat back on Monday')).toBeInTheDocument();
  });

  it('shows the empty summary line and no follow-ups heading when there are none', () => {
    api = stubApi({});
    renderWith(<SummaryPanel conversation={makeConversation({ summary: null, followUps: [] })} />);

    expect(screen.getByText(conversationCopy.summaryNone)).toBeInTheDocument();
    expect(screen.queryByText(conversationCopy.followUpsHeading)).toBeNull();
  });

  it('switches the team on: a switch on an assistant conversation posts by team', async () => {
    api = stubApi({ [HANDLING]: () => ({ body: {} }) });
    const { user } = renderWith(<SummaryPanel conversation={makeConversation({ handledBy: 'assistant' })} />);

    const toggle = screen.getByRole('switch', { name: conversationCopy.handling });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);

    await waitFor(() => expect(api?.count(HANDLING)).toBe(1));
    expect(api?.sent(HANDLING)).toEqual([{ by: 'team' }]);
  });

  it('switches the team off: a checked switch posts by assistant', async () => {
    api = stubApi({ [HANDLING]: () => ({ body: {} }) });
    const { user } = renderWith(<SummaryPanel conversation={makeConversation({ handledBy: 'team' })} />);

    const toggle = screen.getByRole('switch', { name: conversationCopy.handling });
    expect(toggle).toBeChecked();
    await user.click(toggle);

    await waitFor(() => expect(api?.count(HANDLING)).toBe(1));
    expect(api?.sent(HANDLING)).toEqual([{ by: 'assistant' }]);
  });

  it('marks the last call as spam on a voice conversation', async () => {
    api = stubApi({ [SPAM]: () => ({ body: {} }) });
    const { user } = renderWith(<SummaryPanel conversation={makeConversation({ channel: 'voice' })} />);

    await user.click(screen.getByRole('button', { name: conversationCopy.markSpam }));

    await waitFor(() => expect(api?.count(SPAM)).toBe(1));
    expect(api?.sent(SPAM)).toEqual([{}]);
  });

  it('hides Mark as spam for a text conversation', () => {
    api = stubApi({});
    renderWith(<SummaryPanel conversation={makeConversation({ channel: 'sms' })} />);

    expect(screen.queryByRole('button', { name: conversationCopy.markSpam })).toBeNull();
  });

  it('shows the spam mark instead of the button once the call is marked', () => {
    api = stubApi({});
    renderWith(
      <SummaryPanel
        conversation={makeConversation({ calls: [makeCall({ spamReason: 'robocall' })] })}
      />,
    );

    expect(screen.queryByRole('button', { name: conversationCopy.markSpam })).toBeNull();
    expect(screen.getByText(conversationCopy.spamMarked)).toBeInTheDocument();
  });

  it('calls back as a tel: link, not a button', () => {
    api = stubApi({});
    renderWith(<SummaryPanel conversation={makeConversation()} />);

    const link = screen.getByRole('link', { name: conversationCopy.callBack });
    expect(link).toHaveAttribute('href', 'tel:+15551230000');
    expect(screen.queryByRole('button', { name: conversationCopy.callBack })).toBeNull();
  });
});
