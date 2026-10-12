import { cleanup, render, screen } from '@testing-library/react';
import type { CallView, ConversationDetail, TurnView } from '@roofline/shared';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationView } from '../src/features/front-desk/ConversationView.tsx';
import { conversationCopy } from '../src/copy/front-desk-conversation.ts';

const AT = '2026-10-11T14:00:00.000Z';

afterEach(() => {
  cleanup();
});

function call(overrides: Partial<CallView> = {}): CallView {
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
    canPlayRecording: false,
    ...overrides,
  };
}

function turn(overrides: Partial<TurnView> = {}): TurnView {
  return { id: 't1', callId: 'call1', position: 1, speaker: 'caller', text: null, truncated: false, at: AT, actions: [], ...overrides };
}

function renderView(calls: CallView[], phoneE164 = '+15551230001', turns: TurnView[] = [turn()]) {
  const conversation: ConversationDetail = {
    id: 'conv1',
    channel: 'voice',
    status: 'ended',
    customer: { id: 'c1', name: 'Pat Homeowner' },
    phoneE164,
    outcome: 'booked',
    summary: null,
    followUps: [],
    identity: 'matched',
    handledBy: 'assistant',
    teamUntil: null,
    calls,
    turns,
    links: { jobIds: [], appointmentIds: [], claimIntakeIds: [] },
    canReply: false,
  };
  const router = createMemoryRouter([{ path: '*', element: <ConversationView conversation={conversation} /> }], {
    initialEntries: ['/'],
  });
  render(<RouterProvider router={router} />);
}

describe('ConversationView carries', () => {
  it('formats the phone number in the header', () => {
    renderView([call()]);
    expect(screen.getByText('(555) 123-0001')).toBeInTheDocument();
    expect(screen.queryByText('+15551230001')).toBeNull();
  });

  it('says the transcript was removed when the only call stored one', () => {
    renderView([call({ transcriptStored: true })]);
    expect(screen.getByText(conversationCopy.transcriptRemoved)).toBeInTheDocument();
  });

  it('says the transcript was not kept when the only call did not store one', () => {
    renderView([call({ transcriptStored: false })]);
    expect(screen.getByText(conversationCopy.transcriptNotKept)).toBeInTheDocument();
    expect(screen.queryByText(conversationCopy.transcriptRemoved)).toBeNull();
  });

  it('ties each turn to its own call when several calls exist', () => {
    renderView(
      [call({ id: 'kept', transcriptStored: true }), call({ id: 'dropped', transcriptStored: false })],
      '+15551230001',
      [turn({ id: 't1', callId: 'kept', position: 1 }), turn({ id: 't2', callId: 'dropped', position: 2 })],
    );
    expect(screen.getAllByText(conversationCopy.transcriptRemoved)).toHaveLength(1);
    expect(screen.getAllByText(conversationCopy.transcriptNotKept)).toHaveLength(1);
  });
});
