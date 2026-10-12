import { useQuery } from '@tanstack/react-query';
import type { AgentsOverview } from '@roofline/shared';
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
