import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@roofline/shared';
import { Timeline } from '../src/features/timeline/Timeline.tsx';
import { timeline } from '../src/copy/timeline.ts';
import { renderAt, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** A timeline item as the server sends it. Pass what differs. */
function item(overrides: Partial<TimelineItem> & { id: string; at: string }): TimelineItem {
  return {
    type: 'activity',
    kind: 'job_stage_changed',
    summary: 'Moved to Inspection',
    actor: { type: 'user', name: 'Sam Roofer' },
    subject: { type: 'job', id: 'j1' },
    text: null,
    ...overrides,
  };
}

const list = () => screen.getByRole('list', { name: timeline.label });
const rows = () => within(list()).getAllByRole('listitem');

describe('timeline', () => {
  it('timeline renders items newest first', async () => {
    api = stubApi({
      'GET /api/timeline?jobId=j1': () => ({
        body: {
          items: [
            item({ id: 'a', at: '2026-10-10T15:00:00.000Z', summary: 'Newest event' }),
            item({ id: 'b', at: '2026-10-10T12:00:00.000Z', summary: 'Middle event' }),
            item({ id: 'c', at: '2026-10-09T09:00:00.000Z', summary: 'Oldest event' }),
          ],
          nextBefore: null,
        },
      }),
    });
    renderAt(<Timeline jobId="j1" />);

    await screen.findByRole('list', { name: timeline.label });
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('Newest event'),
      expect.stringContaining('Middle event'),
      expect.stringContaining('Oldest event'),
    ]);
  });

  it('Show older sends before', async () => {
    api = stubApi({
      'GET /api/timeline?jobId=j1': () => ({
        body: {
          items: [item({ id: 'new', at: '2026-10-05T10:00:00.000Z', summary: 'Recent event' })],
          nextBefore: '2026-10-01T10:00:00.000Z',
        },
      }),
      'GET /api/timeline?jobId=j1&before=2026-10-01T10%3A00%3A00.000Z': () => ({
        body: {
          items: [item({ id: 'old', at: '2026-09-30T10:00:00.000Z', summary: 'Older event' })],
          nextBefore: null,
        },
      }),
    });
    const { user } = renderAt(<Timeline jobId="j1" />);

    await user.click(await screen.findByRole('button', { name: timeline.showOlder }));
    await screen.findByText('Older event');

    expect(api.count('GET /api/timeline?jobId=j1&before=2026-10-01T10%3A00%3A00.000Z')).toBe(1);
    expect(rows().map((row) => row.textContent)).toEqual([expect.stringContaining('Recent event'), expect.stringContaining('Older event')]);
    expect(screen.queryByRole('button', { name: timeline.showOlder })).not.toBeInTheDocument();
  });

  it('a note posts and appears at the top', async () => {
    api = stubApi({
      'GET /api/timeline?jobId=j1': () => ({
        body: { items: [item({ id: 'old', at: '2026-10-09T09:00:00.000Z', summary: 'Existing event' })], nextBefore: null },
      }),
      'POST /api/notes': () => ({
        body: item({ id: 'note', at: new Date().toISOString(), kind: 'note', summary: 'Called the homeowner', actor: { type: 'user', name: 'Sam Roofer' } }),
      }),
    });
    const { user } = renderAt(<Timeline jobId="j1" />);

    await screen.findByText('Existing event');
    await user.type(screen.getByLabelText(timeline.noteLabel), 'Called the homeowner');
    await user.click(screen.getByRole('button', { name: timeline.noteAdd }));

    await waitFor(() => expect(rows()[0]).toHaveTextContent('Called the homeowner'));
    expect(api.sent('POST /api/notes')).toEqual([{ subjectType: 'job', subjectId: 'j1', body: 'Called the homeowner' }]);
    expect(screen.getByLabelText(timeline.noteLabel)).toHaveValue('');
  });

  it('a text shows its direction and its message status', async () => {
    api = stubApi({
      'GET /api/timeline?jobId=j1': () => ({
        body: {
          items: [
            {
              ...item({ id: 'in', at: '2026-10-10T12:00:00.000Z' }),
              type: 'text',
              kind: 'text_message',
              summary: 'Text from the homeowner',
              text: { direction: 'in', body: 'Is Tuesday ok?', status: 'received' },
            },
            {
              ...item({ id: 'out', at: '2026-10-10T11:00:00.000Z' }),
              type: 'text',
              kind: 'text_message',
              summary: 'Text to the homeowner',
              text: { direction: 'out', body: 'See you then', status: 'failed' },
            },
          ],
          nextBefore: null,
        },
      }),
    });
    renderAt(<Timeline jobId="j1" />);

    await screen.findByText('Is Tuesday ok?');
    const inBubble = screen.getByText('Is Tuesday ok?').closest('[data-direction]');
    const outBubble = screen.getByText('See you then').closest('[data-direction]');
    expect(inBubble).toHaveAttribute('data-direction', 'in');
    expect(outBubble).toHaveAttribute('data-direction', 'out');
    expect(within(list()).getByText(timeline.messageStatus.received)).toBeInTheDocument();
    expect(within(list()).getByText(timeline.messageStatus.failed)).toBeInTheDocument();
  });

  it('counts the note with a thousands separator, as the limit message writes it', async () => {
    api = stubApi({
      'GET /api/timeline?jobId=j1': () => ({ body: { items: [], nextBefore: null } }),
    });
    renderAt(<Timeline jobId="j1" />);

    const field = await screen.findByLabelText(timeline.noteLabel);
    expect(screen.getByText('0 of 2,000')).toBeInTheDocument();
    fireEvent.change(field, { target: { value: 'a'.repeat(1234) } });
    expect(screen.getByText('1,234 of 2,000')).toBeInTheDocument();
    expect(timeline.noteTooLong).toContain('2,000');
  });

  it('2001 characters is refused', async () => {
    api = stubApi({
      'GET /api/timeline?jobId=j1': () => ({ body: { items: [], nextBefore: null } }),
    });
    const { user } = renderAt(<Timeline jobId="j1" />);

    const field = await screen.findByLabelText(timeline.noteLabel);
    fireEvent.change(field, { target: { value: 'a'.repeat(timeline.noteMax + 1) } });
    await user.click(screen.getByRole('button', { name: timeline.noteAdd }));

    expect(await screen.findByText(timeline.noteTooLong)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: timeline.noteAdd })).toBeDisabled();
    expect(api.count('POST /api/notes')).toBe(0);
  });

  it('shows the relative time and the absolute time in the title', async () => {
    const at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    api = stubApi({
      'GET /api/timeline?jobId=j1': () => ({ body: { items: [item({ id: 'a', at, summary: 'Two hours back' })], nextBefore: null } }),
    });
    renderAt(<Timeline jobId="j1" />);

    await screen.findByText('Two hours back');
    const time = within(list()).getByText(timeline.hoursAgo(2));
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('datetime', at);
    expect(time).toHaveAttribute('title', new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at)));
  });
});
