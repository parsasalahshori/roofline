import { cleanup, render, screen, within } from '@testing-library/react';
import type { ConversationDetail } from '@roofline/shared';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { conversationCopy } from '../src/copy/front-desk-conversation.ts';
import { TranscriptPanel } from '../src/features/front-desk/detail/TranscriptPanel.tsx';
import { makeCall, makeConversation, turn } from './front-desk-fixtures.ts';

// What was said: line by line in time order, who said it, when, the cards for what the assistant did, and the lines with no words.

const copy = conversationCopy;
const ZONE = 'America/Chicago';

afterEach(() => {
  cleanup();
});

function renderTranscript(conversation: ConversationDetail) {
  const router = createMemoryRouter([{ path: '*', element: <TranscriptPanel conversation={conversation} zone={ZONE} /> }], { initialEntries: ['/'] });
  render(<RouterProvider router={router} />);
}

/** The conversation's lines in the order they are drawn: the bubbles and notes, not the day dividers or the action cards. */
const drawn = () => screen.getAllByRole('listitem').filter((item) => item.hasAttribute('data-speaker'));

describe('TranscriptPanel lines', () => {
  it('shows each speaker by name, with a matching data-speaker, on the side the person speaks from', () => {
    renderTranscript(
      makeConversation({
        turns: [
          turn('t1', 'caller', 'My roof leaks', 1),
          turn('t2', 'assistant', 'I can book that', 2),
          turn('t3', 'team', 'I will take it from here', 3),
          turn('t4', 'system', 'Call connected', 4),
        ],
      }),
    );

    for (const speaker of ['caller', 'assistant', 'team', 'system'] as const) {
      const item = screen.getByText(copy.speaker[speaker]).closest('li');
      expect(item).not.toBeNull();
      expect(item).toHaveAttribute('data-speaker', speaker);
    }
    // The caller speaks from the left; the assistant and the team from the right; a note belongs to neither
    const side = (speaker: string) => drawn().find((item) => item.getAttribute('data-speaker') === speaker)?.getAttribute('data-side');
    expect(side('caller')).toBe('left');
    expect(side('assistant')).toBe('right');
    expect(side('team')).toBe('right');
    expect(side('system')).toBeNull();
  });

  it('says what was said, in the heading with a count of lines', () => {
    renderTranscript(makeConversation());
    expect(screen.getByRole('heading', { level: 3, name: copy.transcriptHeading })).toBeInTheDocument();
    expect(screen.getByText(copy.messageCount(2))).toBeInTheDocument();
    cleanup();

    renderTranscript(makeConversation({ turns: [turn('t1', 'caller', 'Hello', 1)] }));
    expect(screen.getByText('1 message')).toBeInTheDocument();
  });

  it('lists turns in position order', () => {
    renderTranscript(
      makeConversation({
        turns: [turn('t2', 'assistant', 'Second line', 2), turn('t1', 'caller', 'First line', 1)],
      }),
    );
    expect(drawn().map((item) => item.getAttribute('data-speaker'))).toEqual(['caller', 'assistant']);
  });

  it('lists a text line (position 0) among the turns in time order', () => {
    renderTranscript(
      makeConversation({
        channel: 'sms',
        calls: [],
        turns: [
          turn('t2', 'assistant', 'We can come Thursday', 2, { callId: null, at: '2026-10-11T14:05:00.000Z' }),
          turn('m9', 'team', 'This is Sam, see you then', 0, { callId: null, at: '2026-10-11T14:10:00.000Z' }),
          turn('m8', 'caller', 'Are you coming Thursday', 0, { callId: null, at: '2026-10-11T14:00:00.000Z' }),
        ],
      }),
    );
    const lines = drawn().map((item) => item.textContent ?? '');
    const order = ['Are you coming Thursday', 'We can come Thursday', 'This is Sam, see you then'].map((words) => lines.findIndex((line) => line.includes(words)));
    expect(order).toEqual([0, 1, 2]);
  });

  it('shows how far into a call a line was spoken, in mono, as m:ss', () => {
    renderTranscript(
      makeConversation({
        turns: [
          turn('t1', 'assistant', 'Thanks for calling', 1, { at: '2026-10-11T14:00:00.000Z' }),
          turn('t2', 'caller', 'Hi, I need a quote', 2, { at: '2026-10-11T14:00:18.000Z' }),
          turn('t3', 'assistant', 'Is this on Walnut Hill Drive', 3, { at: '2026-10-11T14:01:36.000Z' }),
        ],
      }),
    );
    const stamps = screen.getAllByText(/^\d+:\d\d$/).map((node) => node.textContent);
    expect(stamps).toEqual(['0:00', '0:18', '1:36']);
    expect(screen.getAllByText('0:18')[0]?.tagName).toBe('TIME');
  });

  it('shows the clock time of a text on the company clock instead, and a day heading where the day changes', () => {
    renderTranscript(
      makeConversation({
        channel: 'sms',
        calls: [],
        turns: [
          // 23:30 and 23:50 UTC are 6:30 and 6:50 PM on the 11th in Chicago; 03:10 UTC on the 12th is still the 11th (10:10 PM)
          turn('a', 'caller', 'Are you open Sunday', 0, { callId: null, at: '2026-10-11T23:30:00.000Z' }),
          turn('b', 'assistant', 'Not on Sundays, sorry', 0, { callId: null, at: '2026-10-11T23:50:00.000Z' }),
          turn('c', 'caller', 'Monday then', 0, { callId: null, at: '2026-10-12T03:10:00.000Z' }),
          turn('d', 'team', 'Monday at 9 works', 0, { callId: null, at: '2026-10-12T15:05:00.000Z' }),
        ],
      }),
    );
    expect(screen.getByText('6:30 PM')).toBeInTheDocument();
    expect(screen.getByText('6:50 PM')).toBeInTheDocument();
    expect(screen.getByText('10:10 PM')).toBeInTheDocument();
    expect(screen.getByText('10:05 AM')).toBeInTheDocument();
    // Two days: a heading above each one's first line, and none between lines of the same day
    const days = screen.getAllByRole('listitem').filter((item) => !item.hasAttribute('data-speaker') && item.textContent?.match(/Oct/));
    expect(days.map((item) => item.textContent)).toEqual(['Sun, Oct 11', 'Mon, Oct 12']);
  });

  it('draws no day heading in the lines of a call, which are counted from its start', () => {
    renderTranscript(makeConversation());
    expect(screen.getAllByRole('listitem').filter((item) => !item.hasAttribute('data-speaker'))).toHaveLength(0);
  });

  it('shows the cut short mark, with a glyph, on a truncated turn', () => {
    renderTranscript(makeConversation({ turns: [turn('t1', 'assistant', 'We can come out and', 1, { truncated: true })] }));
    const mark = screen.getByText(copy.truncated);
    expect(mark.closest('li')).toHaveAttribute('data-speaker', 'assistant');
    expect(mark.closest('span')?.querySelector('svg') ?? mark.querySelector('svg')).not.toBeNull();
  });

  it('shows the empty line, under the heading, when there are no turns', () => {
    renderTranscript(makeConversation({ turns: [] }));
    expect(screen.getByText(copy.transcriptEmpty)).toBeInTheDocument();
    expect(screen.getByText(copy.transcriptHeading)).toBeInTheDocument();
    expect(screen.getByText(copy.messageCount(0))).toBeInTheDocument();
  });
});

describe('TranscriptPanel lines with no words', () => {
  it("says the transcript was not kept at the caller's request when the call did not store it", () => {
    renderTranscript(
      makeConversation({
        calls: [makeCall({ transcriptStored: false })],
        turns: [turn('t1', 'caller', null, 1)],
      }),
    );
    expect(screen.getByText("Transcript not kept at the caller's request")).toBe(screen.getByText(copy.transcriptNotKept));
    expect(screen.queryByText(copy.transcriptRemoved)).toBeNull();
  });

  it('says the transcript was removed after the retention period when it was stored', () => {
    renderTranscript(makeConversation({ turns: [turn('t1', 'caller', null, 1)] }));
    expect(screen.getByText('Transcript removed after the retention period')).toBeInTheDocument();
    expect(screen.queryByText(copy.transcriptNotKept)).toBeNull();
  });

  it('says a text had no words (a photo or an empty text) rather than that retention removed it', () => {
    renderTranscript(
      makeConversation({
        channel: 'sms',
        calls: [],
        turns: [turn('m1', 'caller', null, 0, { callId: null, noWords: true })],
      }),
    );
    expect(screen.getByText('Photo or empty text')).toBeInTheDocument();
    expect(screen.queryByText(copy.transcriptRemoved)).toBeNull();
  });

  it('ties each turn to its own call when several calls exist', () => {
    renderTranscript(
      makeConversation({
        calls: [makeCall({ id: 'kept', transcriptStored: true }), makeCall({ id: 'dropped', transcriptStored: false })],
        turns: [turn('t1', 'caller', null, 1, { callId: 'kept' }), turn('t2', 'caller', null, 2, { callId: 'dropped' })],
      }),
    );
    expect(screen.getAllByText(copy.transcriptRemoved)).toHaveLength(1);
    expect(screen.getAllByText(copy.transcriptNotKept)).toHaveLength(1);
  });
});

describe('TranscriptPanel action cards', () => {
  const actions = [
    { tool: 'customer', ok: true, label: 'Saved Pat as a customer', link: { kind: 'customer', id: 'c1' } },
    { tool: 'job', ok: true, label: 'Opened roof repair job', link: { kind: 'job', id: 'j1' } },
    { tool: 'appointment', ok: true, label: 'Booked inspection Thu 10:00 with Sam', link: { kind: 'appointment', id: 'a1' } },
    { tool: 'claim', ok: true, label: 'Started a claim intake', link: { kind: 'claim_intake', id: 'ci1' } },
  ] as const;

  it('links each card to its record, and shows a claim intake as plain text', () => {
    renderTranscript(makeConversation({ turns: [turn('t1', 'assistant', 'Booked you in', 1, { actions: [...actions] })] }));

    expect(screen.getByRole('link', { name: new RegExp(copy.linkCustomer) })).toHaveAttribute('href', '/customers/c1');
    expect(screen.getByRole('link', { name: new RegExp(copy.linkJob) })).toHaveAttribute('href', '/jobs/j1');
    expect(screen.getByRole('link', { name: new RegExp(copy.linkAppointment) })).toHaveAttribute('href', '/calendar/appointments/a1');

    const claimCard = screen.getByText('Started a claim intake').closest('li') as HTMLElement;
    expect(within(claimCard).queryByRole('link')).toBeNull();
  });

  it('puts the cards under the line that did them, and not among the lines', () => {
    renderTranscript(makeConversation({ turns: [turn('t1', 'assistant', 'Booked you in', 1, { actions: [...actions] })] }));
    const line = screen.getByText('Booked you in').closest('li') as HTMLElement;
    expect(within(line).getByText('Booked inspection Thu 10:00 with Sam')).toBeInTheDocument();
    expect(drawn()).toHaveLength(1);
  });

  it('says in words, with a glyph, that a card did not work', () => {
    renderTranscript(
      makeConversation({
        turns: [turn('t1', 'assistant', 'Trying to book', 1, { actions: [{ tool: 'appointment', ok: false, label: 'Tried to book inspection', link: null }] })],
      }),
    );
    const card = screen.getByText('Tried to book inspection').closest('li') as HTMLElement;
    const failed = within(card).getByText(copy.actionFailed);
    expect(failed).toBeInTheDocument();
    expect(failed.querySelector('svg')).not.toBeNull();
    expect(card).toHaveAttribute('data-ok', 'false');
    expect(screen.getAllByText(copy.actionFailed)).toHaveLength(1);
  });
});
