import { cleanup, screen, within } from '@testing-library/react';
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

function item(overrides: Record<string, unknown> & { id: string }): TimelineItem {
  return {
    at: '2026-10-10T15:00:00.000Z',
    type: 'activity',
    kind: 'note',
    summary: 'Plain summary',
    actor: { type: 'agent', name: 'front_desk' },
    subject: { type: 'job', id: 'j1' },
    text: null,
    ...overrides,
  } as TimelineItem;
}

function show(items: TimelineItem[]) {
  api = stubApi({ 'GET /api/timeline?jobId=j1': () => ({ body: { items, nextBefore: null } }) });
  renderAt(<Timeline jobId="j1" />);
}

const data = { summary: 'Booked an inspection', outcome: 'booked', conversationId: 'c-1', followUps: [] };

describe('timeline front desk card', () => {
  it('a call activity shows summary, outcome chip and a conversation link', async () => {
    show([item({ id: 'a', kind: 'call', summary: 'Call', data })]);
    await screen.findByText('Booked an inspection');
    const row = screen.getByText('Booked an inspection').closest('li') as HTMLElement;
    expect(row).toHaveAttribute('data-type', 'front-desk');
    expect(within(row).getByText(timeline.frontDesk.outcome.booked)).toBeInTheDocument();
    expect(within(row).getByText(timeline.frontDesk.callLabel)).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: timeline.frontDesk.open })).toHaveAttribute('href', '/front-desk/c-1');
  });

  it('a text conversation shows the text label', async () => {
    show([item({ id: 'a', kind: 'text_conversation', summary: 'Texts', data })]);
    await screen.findByText('Booked an inspection');
    expect(screen.getByText(timeline.frontDesk.textLabel)).toBeInTheDocument();
  });

  it('a call without data is a plain activity row', async () => {
    show([item({ id: 'a', kind: 'call', summary: 'Plain call' })]);
    await screen.findByText('Plain call');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('Plain call').closest('li')).toHaveAttribute('data-type', 'activity');
  });

  it('a note is unchanged', async () => {
    show([item({ id: 'a', kind: 'note', summary: 'A note', data })]);
    await screen.findByText('A note');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('A note').closest('li')).toHaveAttribute('data-type', 'activity');
  });
});
