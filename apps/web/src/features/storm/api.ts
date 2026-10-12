import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';
import { keys } from '../../api/keys.ts';
import type { StormDetailView, StormLayerView, StormsList } from './types.ts';

/** How often a running plan's results are read again. */
const RESULTS_POLL_MS = 60_000;
/** How often the storm layer's freshness is read again. */
const LAYER_POLL_MS = 5 * 60_000;

/** The company's storms, newest first. */
export function useStorms() {
  return useQuery<StormsList>({
    queryKey: ['storms'],
    queryFn: ({ signal }) => apiFetch<StormsList>('/api/storms', { signal }),
  });
}

/** One storm with its swath, results and plan. Read again every 60 s, and only while the plan runs. */
export function useStorm(id: string) {
  return useQuery<StormDetailView>({
    queryKey: ['storm', id],
    queryFn: ({ signal }) => apiFetch<StormDetailView>(`/api/storms/${encodeURIComponent(id)}`, { signal }),
    enabled: id !== '',
    refetchInterval: (query) => (query.state.data?.plan?.status === 'running' ? RESULTS_POLL_MS : false),
  });
}

/** Dismisses a storm; the list and that storm are read again. */
export function useDismissStorm() {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (id) => apiFetch<unknown>(`/api/storms/${encodeURIComponent(id)}/dismiss`, { method: 'POST', body: {} }),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: ['storms'] });
      void queryClient.invalidateQueries({ queryKey: ['storm', id] });
    },
  });
}

/** Drafts the storm's plan again; the new task waits in the approvals. */
export function useRedraftStorm() {
  const queryClient = useQueryClient();
  return useMutation<{ taskId: string }, Error, string>({
    mutationFn: (id) =>
      apiFetch<{ taskId: string }>(`/api/storms/${encodeURIComponent(id)}/plan`, { method: 'POST', body: {} }),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: ['storms'] });
      void queryClient.invalidateQueries({ queryKey: ['storm', id] });
      void queryClient.invalidateQueries({ queryKey: keys.approvals });
    },
  });
}

/** The storm layer of the last 7 days (the Storm window reads only `stale`). */
export function useStormLayer() {
  return useQuery<StormLayerView>({
    queryKey: ['storm-layer'],
    queryFn: ({ signal }) => apiFetch<StormLayerView>('/api/map/storm-layer?days=7', { signal }),
    refetchInterval: LAYER_POLL_MS,
  });
}
