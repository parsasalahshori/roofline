/**
 * Agents screen data layer. The hooks arrive in A1 tasks 9 to 12; they extend this module and use these keys.
 */
export const agentsKeys = {
  all: ['agents'] as const,
  feed: ['agents', 'feed'] as const,
  waiting: ['agents', 'waiting'] as const,
};

// --- Task 10: agent page ---
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentDetail, RunNowResult, ScreenAgent, TimePeriod } from '@roofline/shared';
import { apiFetch } from '../../api/client.ts';

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
