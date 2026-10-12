/**
 * Agents screen data layer. The hooks arrive in A1 tasks 9 to 12; they extend this module and use these keys.
 */
export const agentsKeys = {
  all: ['agents'] as const,
  feed: ['agents', 'feed'] as const,
  waiting: ['agents', 'waiting'] as const,
};

// --- Task 11: feed and waiting ---
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { Agent, FeedPage, WaitingList } from '@roofline/shared';
import { apiFetch } from '../../api/client.ts';

/** The activity feed, newest first, 'Show more' pages by cursor. `agent` filters to one agent. */
export function useAgentFeed(agent?: Agent) {
  return useInfiniteQuery({
    queryKey: [...agentsKeys.feed, agent ?? 'all'] as const,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      if (agent) params.set('agent', agent);
      if (pageParam) params.set('cursor', pageParam);
      const query = params.toString();
      return apiFetch<FeedPage>(`/api/agents/feed${query ? `?${query}` : ''}`, { signal });
    },
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** Everything waiting on somebody, with who it waits on. */
export function useWaiting() {
  return useQuery({
    queryKey: agentsKeys.waiting,
    queryFn: ({ signal }) => apiFetch<WaitingList>('/api/agents/waiting', { signal }),
  });
}
