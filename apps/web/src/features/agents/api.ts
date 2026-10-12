import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Agent,
  AgentDetail,
  AgentsOverview,
  FeedPage,
  RunNowResult,
  ScreenAgent,
  TimePeriod,
  WaitingList,
} from '@roofline/shared';
import { apiFetch } from '../../api/client.ts';

/**
 * Agents screen data layer. The hooks arrive in A1 tasks 9 to 12; they extend this module and use these keys.
 */
export const agentsKeys = {
  all: ['agents'] as const,
  feed: ['agents', 'feed'] as const,
  waiting: ['agents', 'waiting'] as const,
};

// --- Task 9: Agents window ---
/** GET /api/agents: the overview (cards, month totals, hourly rate). */
export function useAgentsOverview() {
  return useQuery({
    queryKey: agentsKeys.all,
    queryFn: ({ signal }) => apiFetch<AgentsOverview>('/api/agents', { signal }),
  });
}

// --- Task 11: feed and waiting ---
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

// --- Task 10: agent page ---
export const agentDetailKey = (agent: ScreenAgent, period: TimePeriod) => ['agents', 'detail', agent, period] as const;

/** GET /api/agents/:agent?period= */
export function useAgentDetail(agent: ScreenAgent, period: TimePeriod) {
  return useQuery({
    queryKey: agentDetailKey(agent, period),
    queryFn: ({ signal }) => apiFetch<AgentDetail>(`/api/agents/${agent}?period=${period}`, { signal }),
  });
}

/** PUT /api/agents/:agent/paused (owner). */
export function usePauseAgent(agent: ScreenAgent) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (paused: boolean) => apiFetch<unknown>(`/api/agents/${agent}/paused`, { method: 'PUT', body: { paused } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: agentsKeys.all }),
  });
}

/** POST /api/agents/:agent/run: 202 RunNowResult; a 409 is an ApiError whose message is a plain sentence. */
export function useRunNow(agent: ScreenAgent) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<RunNowResult>(`/api/agents/${agent}/run`, { method: 'POST' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: agentsKeys.all }),
  });
}
