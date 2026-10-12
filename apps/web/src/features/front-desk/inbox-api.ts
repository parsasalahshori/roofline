import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { ConversationFilter, ConversationListItem, ConversationPage, FrontDeskWeekStats } from '@roofline/shared';
import { apiFetch } from '../../api/client.ts';

/*
 * The Front Desk inbox's reads: the conversation list (paged, polled) and the week's stats. Each
 * hook is keyed under ['front-desk', ...] so the inbox can be refreshed without touching other keys.
 */

/** How often the list is asked for again while a call is live on any row, in milliseconds. */
export const LIVE_POLL_MS = 5000;
/** How often the list is asked for again when no call is live, in milliseconds. */
export const IDLE_POLL_MS = 30_000;

/** The `refetchInterval` for the list: LIVE_POLL_MS while any row has a live call, else IDLE_POLL_MS. */
export function inboxPollInterval(items: ConversationListItem[] | undefined): number {
  return items?.some((row) => row.liveCall !== null) ? LIVE_POLL_MS : IDLE_POLL_MS;
}

/** Every row of every loaded page, in the order the pages came. */
export function flattenItems(pages: ConversationPage[] | undefined): ConversationListItem[] {
  return pages?.flatMap((page) => page.items) ?? [];
}

/**
 * The conversations for one filter, one page at a time. The list is asked for again every
 * `inboxPollInterval` (5 s while a call is live, else 30 s). Background polling is off.
 */
export function useConversations(filter: ConversationFilter) {
  return useInfiniteQuery({
    queryKey: ['front-desk', 'conversations', filter],
    queryFn: ({ signal, pageParam }) => {
      const cursor = pageParam === null ? '' : `&cursor=${encodeURIComponent(pageParam)}`;
      return apiFetch<ConversationPage>(`/api/conversations?filter=${filter}${cursor}`, { signal });
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: (query) => inboxPollInterval(flattenItems(query.state.data?.pages)),
    refetchIntervalInBackground: false,
  });
}

/** The week's counts and timings. `week` is the Monday (YYYY-MM-DD, company time zone); omitted, the server picks the current week. */
export function useWeekStats(week?: string) {
  const query = week === undefined ? '' : `?week=${week}`;
  return useQuery({
    queryKey: ['front-desk', 'stats', week ?? 'current'],
    queryFn: ({ signal }) => apiFetch<FrontDeskWeekStats>(`/api/front-desk/stats${query}`, { signal }),
    refetchInterval: IDLE_POLL_MS,
    refetchIntervalInBackground: false,
  });
}
