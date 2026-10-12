import { cleanup, screen, waitFor, within } from '@testing-library/react';
import type { FeedItem } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agents } from '../src/copy/agents.ts';
import { AGENT_LABEL } from '../src/copy/status.ts';
import { ActivityFeed } from '../src/features/agents/ActivityFeed.tsx';
import { type Routes, renderAt, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

function item(id: string, overrides: Partial<FeedItem> = {}): FeedItem {
  return { id, agent: 'storm_scout', kind: 'k', text: `Did thing ${id}`, at: '2026-10-12T15:05:00.000Z', href: null, ...overrides };
}

function show(routes: Routes) {
  api = stubApi(routes);
  return renderAt(<ActivityFeed />);
}

describe('ActivityFeed', () => {
  it('lists rows with agent name, text, and an Open link only when there is an href', async () => {
    show({
      'GET /api/agents/feed': () => ({
        body: { items: [item('a', { agent: 'estimator', href: '/jobs/j1' }), item('b')], nextCursor: null },
      }),
    });
    const list = await screen.findByRole('list', { name: agents.feedListLabel });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText(AGENT_LABEL.estimator)).toBeTruthy();
    expect(within(rows[0]!).getByText('Did thing a')).toBeTruthy();
    expect(within(rows[0]!).getByRole('link', { name: agents.feedOpen }).getAttribute('href')).toBe('/jobs/j1');
    expect(within(rows[1]!).getByText(AGENT_LABEL.storm_scout)).toBeTruthy();
    expect(within(rows[1]!).queryByRole('link')).toBeNull();
    expect(rows[0]!.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-12T15:05:00.000Z');
  });

  it('filters by agent and back to All', async () => {
    const { user } = show({
      'GET /api/agents/feed': () => ({ body: { items: [item('a')], nextCursor: null } }),
      'GET /api/agents/feed?agent=estimator': () => ({
        body: { items: [item('e', { agent: 'estimator', text: 'Estimate sent' })], nextCursor: null },
      }),
    });
    await screen.findByText('Did thing a');
    const group = screen.getByRole('group', { name: agents.feedFiltersLabel });
    await user.click(within(group).getByRole('button', { name: AGENT_LABEL.estimator }));
    expect(await screen.findByText('Estimate sent')).toBeTruthy();
    expect(within(group).getByRole('button', { name: AGENT_LABEL.estimator }).getAttribute('aria-pressed')).toBe('true');
    await user.click(within(group).getByRole('button', { name: agents.feedFilterAll }));
    expect(await screen.findByText('Did thing a')).toBeTruthy();
  });

  it('shows more by cursor, appending rows, and hides the button on the last page', async () => {
    const { user } = show({
      'GET /api/agents/feed': () => ({ body: { items: [item('a')], nextCursor: 'c2' } }),
      'GET /api/agents/feed?cursor=c2': () => ({ body: { items: [item('b')], nextCursor: null } }),
    });
    await screen.findByText('Did thing a');
    await user.click(screen.getByRole('button', { name: agents.feedShowMore }));
    expect(await screen.findByText('Did thing b')).toBeTruthy();
    expect(screen.getByText('Did thing a')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: agents.feedShowMore })).toBeNull());
  });

  it('shows the empty line when there is nothing', async () => {
    show({ 'GET /api/agents/feed': () => ({ body: { items: [], nextCursor: null } }) });
    expect(await screen.findByText(agents.feedEmpty)).toBeTruthy();
    expect(screen.queryByRole('button', { name: agents.feedShowMore })).toBeNull();
  });

  it('shows the load error', async () => {
    show({ 'GET /api/agents/feed': () => ({ status: 500, body: { error: 'x' } }) });
    expect(await screen.findByText(agents.feedLoadError)).toBeTruthy();
  });
});
