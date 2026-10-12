import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ConversationListItem, ConversationPage, FrontDeskWeekStats } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../src/app/providers.tsx';
import {
  flattenItems,
  IDLE_POLL_MS,
  inboxPollInterval,
  LIVE_POLL_MS,
  useConversations,
  useWeekStats,
} from '../src/features/front-desk/inbox-api.ts';
import { stubApi } from './helpers.tsx';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function item(overrides: Partial<ConversationListItem> = {}): ConversationListItem {
  return {
    id: 'cv1',
    channel: 'call',
    status: 'open',
    customerId: null,
    name: null,
    phoneE164: '+15550100',
    outcome: null,
    summary: null,
    handledBy: 'ai',
    unreadCount: 0,
    needsAttention: false,
    urgent: false,
    lastMessageAt: '2026-10-12T14:00:00Z',
    liveCall: null,
    ...overrides,
  } as ConversationListItem;
}

function wrapperWith(client = createQueryClient()) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const LIVE = {
  callId: 'k1',
  status: 'ai' as const,
  startedAt: '2026-10-12T15:00:00Z',
};

describe('constants and pure helpers', () => {
  it('exports the live and idle poll intervals', () => {
    expect(LIVE_POLL_MS).toBe(5000);
    expect(IDLE_POLL_MS).toBe(30_000);
  });

  it('polls every 5 s while one item has a live call', () => {
    expect(inboxPollInterval([item(), item({ id: 'cv2', liveCall: LIVE })])).toBe(5000);
  });

  it('polls every 30 s when no item has a live call', () => {
    expect(inboxPollInterval([item(), item({ id: 'cv2' })])).toBe(30_000);
    expect(inboxPollInterval([])).toBe(30_000);
  });

  it('polls every 30 s when there is no data yet', () => {
    expect(inboxPollInterval(undefined)).toBe(30_000);
  });

  it('flattens all pages into one list, in order', () => {
    const a = item({ id: 'a' });
    const b = item({ id: 'b' });
    const c = item({ id: 'c' });
    const pages: ConversationPage[] = [
      { items: [a, b], nextCursor: 'x' },
      { items: [c], nextCursor: null },
    ];
    expect(flattenItems(pages).map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(flattenItems(undefined)).toEqual([]);
  });
});

describe('useConversations', () => {
  it('requests the first page for the filter and returns the body', async () => {
    const page: ConversationPage = {
      items: [item({ id: 'cv9' })],
      nextCursor: null,
    };
    const api = stubApi({
      'GET /api/conversations?filter=booked': () => ({ body: page }),
    });
    const { result } = renderHook(() => useConversations('booked'), {
      wrapper: wrapperWith(),
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(api.count('GET /api/conversations?filter=booked')).toBe(1);
    expect(result.current.data?.pages[0]).toEqual(page);
    expect(result.current.hasNextPage).toBe(false);
    expect(api.unexpected).toEqual([]);
  });

  it('asks for the next page with the cursor after fetchNextPage', async () => {
    const api = stubApi({
      'GET /api/conversations?filter=booked': () => ({
        body: { items: [item({ id: 'p1' })], nextCursor: 'abc' },
      }),
      'GET /api/conversations?filter=booked&cursor=abc': () => ({
        body: { items: [item({ id: 'p2' })], nextCursor: null },
      }),
    });
    const { result } = renderHook(() => useConversations('booked'), {
      wrapper: wrapperWith(),
    });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(api.count('GET /api/conversations?filter=booked&cursor=abc')).toBe(1);
    await waitFor(() => expect(flattenItems(result.current.data?.pages).map((row) => row.id)).toEqual(['p1', 'p2']));
    expect(result.current.hasNextPage).toBe(false);
    expect(api.unexpected).toEqual([]);
  });

  it('polls every 5 s while a row has a live call, and every 30 s otherwise', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let live = true;
    const api = stubApi({
      'GET /api/conversations?filter=all': () => ({
        body: {
          items: [item({ id: 'lv', liveCall: live ? LIVE : null })],
          nextCursor: null,
        },
      }),
    });
    const { result } = renderHook(() => useConversations('all'), {
      wrapper: wrapperWith(),
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    const key = 'GET /api/conversations?filter=all';
    expect(api.count(key)).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(api.count(key)).toBe(2);

    live = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    // the refetch at 5 s saw no live call, so the next one is 30 s away
    const afterLiveEnded = api.count(key);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(api.count(key)).toBe(afterLiveEnded);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(api.count(key)).toBe(afterLiveEnded + 1);
    expect(api.unexpected).toEqual([]);
  });
});

describe('useWeekStats', () => {
  const stats: FrontDeskWeekStats = {
    weekStart: '2026-10-12',
    answered: 9,
    booked: 3,
    transferred: 1,
    messages: 4,
    spam: 2,
    firstReplyMsP50: 1200,
    guardBlocks: 0,
    aiMinutesUsed: 212,
    aiMinutesIncluded: 500,
  };

  it('requests the current week when no week is given and returns the body', async () => {
    const api = stubApi({
      'GET /api/front-desk/stats': () => ({ body: stats }),
    });
    const { result } = renderHook(() => useWeekStats(), {
      wrapper: wrapperWith(),
    });
    await waitFor(() => expect(result.current.data).toEqual(stats));
    expect(api.count('GET /api/front-desk/stats')).toBe(1);
    expect(api.unexpected).toEqual([]);
  });

  it('requests the given week', async () => {
    const api = stubApi({
      'GET /api/front-desk/stats?week=2026-10-05': () => ({
        body: { ...stats, weekStart: '2026-10-05' },
      }),
    });
    const { result } = renderHook(() => useWeekStats('2026-10-05'), {
      wrapper: wrapperWith(),
    });
    await waitFor(() => expect(result.current.data?.weekStart).toBe('2026-10-05'));
    expect(api.count('GET /api/front-desk/stats?week=2026-10-05')).toBe(1);
    expect(api.unexpected).toEqual([]);
  });
});
