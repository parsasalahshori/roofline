import { cleanup, render, screen, within } from '@testing-library/react';
import type { ConversationDetail, TurnView } from '@roofline/shared';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationView } from '../src/features/front-desk/ConversationView.tsx';
import { conversationCopy } from '../src/copy/front-desk-conversation.ts';

const AT = '2026-10-11T14:00:00.000Z';

function turn(overrides: Partial<TurnView> & Pick<TurnView, 'id' | 'position' | 'speaker'>): TurnView {
  return { callId: null, text: 'Hello', truncated: false, at: AT, actions: [], ...overrides };
}

function makeConversation(overrides: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    id: 'conv1',
    channel: 'voice',
    status: 'ended',
    customer: { id: 'c1', name: 'Pat Homeowner' },
    phoneE164: '+15551230000',
    outcome: 'booked',
    summary: null,
    followUps: [],
    identity: 'matched',
    handledBy: 'assistant',
    teamUntil: null,
    calls: [
      {
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
      },
    ],
    turns: [],
    links: { jobIds: [], appointmentIds: [], claimIntakeIds: [] },
    canReply: false,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

function renderView(conversation: ConversationDetail) {
  const router = createMemoryRouter(
    [{ path: '*', element: <ConversationView conversation={conversation} /> }],
    { initialEntries: ['/'] },
  );
  render(<RouterProvider router={router} />);
}

describe('ConversationView', () => {
  it('shows the speaker label and a matching data-speaker attribute for each of the four speakers', () => {
    renderView(
      makeConversation({
        turns: [
          turn({ id: 't1', position: 1, speaker: 'caller', text: 'My roof leaks' }),
          turn({ id: 't2', position: 2, speaker: 'assistant', text: 'I can book that' }),
          turn({ id: 't3', position: 3, speaker: 'team', text: 'I will take it from here' }),
          turn({ id: 't4', position: 4, speaker: 'system', text: 'Call connected' }),
        ],
      }),
    );

    const speakers = ['caller', 'assistant', 'team', 'system'] as const;
    for (const speaker of speakers) {
      const label = conversationCopy.speaker[speaker];
      const labelElement = screen.getByText(label);
      const item = labelElement.closest('li');
      expect(item).not.toBeNull();
      expect(item).toHaveAttribute('data-speaker', speaker);
    }
  });

  it('lists a text line (position 0) among the turns in time order', () => {
    renderView(
      makeConversation({
        channel: 'sms',
        calls: [],
        turns: [
          turn({ id: 't2', position: 2, speaker: 'assistant', text: 'We can come Thursday', at: '2026-10-11T14:05:00.000Z' }),
          turn({ id: 'm9', position: 0, speaker: 'team', text: 'This is Sam, see you then', at: '2026-10-11T14:10:00.000Z' }),
          turn({ id: 'm8', position: 0, speaker: 'caller', text: 'Are you coming Thursday', at: '2026-10-11T14:00:00.000Z' }),
        ],
      }),
    );
    const lines = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    const order = ['Are you coming Thursday', 'We can come Thursday', 'This is Sam, see you then'].map((w) =>
      lines.findIndex((l) => l.includes(w)),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('lists turns in position order', () => {
    renderView(
      makeConversation({
        turns: [
          turn({ id: 't2', position: 2, speaker: 'assistant', text: 'Second line' }),
          turn({ id: 't1', position: 1, speaker: 'caller', text: 'First line' }),
        ],
      }),
    );
    const items = screen.getAllByRole('listitem').filter((item) => item.hasAttribute('data-speaker'));
    expect(items.map((item) => item.getAttribute('data-speaker'))).toEqual(['caller', 'assistant']);
  });

  it('shows the cut short mark on a truncated turn', () => {
    renderView(
      makeConversation({
        turns: [turn({ id: 't1', position: 1, speaker: 'assistant', text: 'We can come out and', truncated: true })],
      }),
    );
    expect(screen.getByText(conversationCopy.truncated)).toBeInTheDocument();
  });

  it("says the transcript was not kept at the caller's request when a call did not store it", () => {
    renderView(
      makeConversation({
        calls: makeConversation().calls.map((call) => ({ ...call, transcriptStored: false })),
        turns: [turn({ id: 't1', callId: 'call1', position: 1, speaker: 'caller', text: null })],
      }),
    );
    expect(screen.getByText("Transcript not kept at the caller's request")).toBeInTheDocument();
    expect(screen.getByText("Transcript not kept at the caller's request")).toBe(
      screen.getByText(conversationCopy.transcriptNotKept),
    );
    expect(screen.queryByText(conversationCopy.transcriptRemoved)).toBeNull();
  });

  it('says the transcript was removed after the retention period when it was stored', () => {
    renderView(
      makeConversation({
        turns: [turn({ id: 't1', callId: 'call1', position: 1, speaker: 'caller', text: null })],
      }),
    );
    expect(screen.getByText('Transcript removed after the retention period')).toBeInTheDocument();
    expect(screen.queryByText(conversationCopy.transcriptNotKept)).toBeNull();
  });

  it('links each tool action card to its record, and shows a claim intake as plain text', () => {
    renderView(
      makeConversation({
        turns: [
          turn({
            id: 't1',
            position: 1,
            speaker: 'assistant',
            text: 'Booked you in',
            actions: [
              { tool: 'customer', ok: true, label: 'Saved Pat as a customer', link: { kind: 'customer', id: 'c1' } },
              { tool: 'job', ok: true, label: 'Opened roof repair job', link: { kind: 'job', id: 'j1' } },
              {
                tool: 'appointment',
                ok: true,
                label: 'Booked inspection Thu 10:00 with Sam',
                link: { kind: 'appointment', id: 'a1' },
              },
              { tool: 'claim', ok: true, label: 'Started a claim intake', link: { kind: 'claim_intake', id: 'ci1' } },
            ],
          }),
        ],
      }),
    );

    expect(screen.getByRole('link', { name: conversationCopy.linkCustomer })).toHaveAttribute('href', '/customers/c1');
    expect(screen.getByRole('link', { name: conversationCopy.linkJob })).toHaveAttribute('href', '/jobs/j1');
    expect(screen.getByRole('link', { name: conversationCopy.linkAppointment })).toHaveAttribute(
      'href',
      '/calendar/appointments/a1',
    );

    const claimText = screen.getByText('Started a claim intake');
    const claimCard = claimText.closest('li');
    expect(claimCard).not.toBeNull();
    expect(within(claimCard as HTMLElement).queryByRole('link')).toBeNull();
  });

  it('shows the did not work sentence on a failed action card', () => {
    renderView(
      makeConversation({
        turns: [
          turn({
            id: 't1',
            position: 1,
            speaker: 'assistant',
            text: 'Trying to book',
            actions: [{ tool: 'appointment', ok: false, label: 'Tried to book inspection', link: null }],
          }),
        ],
      }),
    );
    const card = screen.getByText('Tried to book inspection').closest('li') as HTMLElement;
    expect(within(card).getByText(conversationCopy.actionFailed)).toBeInTheDocument();
    expect(screen.queryByText(conversationCopy.actionFailed)).toBe(within(card).getByText(conversationCopy.actionFailed));
  });

  it('shows the empty transcript line when there are no turns', () => {
    renderView(makeConversation({ turns: [] }));
    expect(screen.getByText(conversationCopy.transcriptEmpty)).toBeInTheDocument();
    expect(screen.getByText(conversationCopy.transcriptHeading)).toBeInTheDocument();
  });

  it('falls back to the unknown caller line when there is no customer', () => {
    renderView(makeConversation({ customer: null, turns: [] }));
    expect(screen.getByText(conversationCopy.unknownCaller)).toBeInTheDocument();
    expect(screen.getByText('(555) 123-0000')).toBeInTheDocument();
  });
});
