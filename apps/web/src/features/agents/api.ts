import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Agent,
  AgentDetail,
  AgentsOverview,
  FeedPage,
  RecountResult,
  RunNowResult,
  ScreenAgent,
  TimeBaselines,
  TimeBaselinesBody,
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
  overview: ['agents', 'overview'] as const,
  detail: (agent: ScreenAgent, period: TimePeriod) => ['agents', 'detail', agent, period] as const,
};

// --- Task 9: Agents window ---
/** GET /api/agents: the overview (cards, month totals, hourly rate). */
export function useAgentsOverview() {
  return useQuery({
    queryKey: agentsKeys.overview,
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
/** GET /api/agents/:agent?period= */
export function useAgentDetail(agent: ScreenAgent, period: TimePeriod) {
  return useQuery({
    queryKey: agentsKeys.detail(agent, period),
    queryFn: ({ signal }) => apiFetch<AgentDetail>(`/api/agents/${agent}?period=${period}`, { signal }),
    placeholderData: keepPreviousData,
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

// --- Task 12: time baselines ---
export const timeBaselinesKey = [...agentsKeys.all, 'time-baselines'] as const;

/** GET /api/agents/time-baselines (owner and office; a rep gets 403). */
export function useTimeBaselines() {
  return useQuery({
    queryKey: timeBaselinesKey,
    queryFn: ({ signal }) => apiFetch<TimeBaselines>('/api/agents/time-baselines', { signal }),
  });
}

/** PUT /api/agents/time-baselines (owner): only the changed keys; null resets a key. Invalidates agentsKeys.all. */
export function useSaveTimeBaselines() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: TimeBaselinesBody) => apiFetch<TimeBaselines>('/api/agents/time-baselines', { method: 'PUT', body }),
    onSuccess: (saved) => {
      queryClient.setQueryData(timeBaselinesKey, saved);
      return queryClient.invalidateQueries({ queryKey: agentsKeys.all });
    },
  });
}

/** POST /api/agents/time-baselines/recount (owner). dryRun true adds ?dryRun=1 and changes nothing. A real run invalidates agentsKeys.all. */
export function useRecount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dryRun: boolean) =>
      apiFetch<RecountResult>(`/api/agents/time-baselines/recount${dryRun ? '?dryRun=1' : ''}`, { method: 'POST' }),
    onSuccess: (result) => (result.dryRun ? undefined : queryClient.invalidateQueries({ queryKey: agentsKeys.all })),
  });
}
