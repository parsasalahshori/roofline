import type { ScanDetailView, ScanMark, ScanOutcome, ScanQueueView } from '@roofline/shared';
import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';
import { FILTER_STATUS, type QueueFilter } from './scanMarks.ts';

// The keys stay local to this feature: nothing else reads a scan.
const queueKey = (filter: QueueFilter) => ['window-scans', 'queue', filter] as const;
const ANY_QUEUE = ['window-scans', 'queue'] as const;
const detailKey = (id: string) => ['window-scans', 'detail', id] as const;
const path = (id: string) => `/api/window-scans/${encodeURIComponent(id)}`;

/** GET /api/window-scans?status=...: the queue for a filter, with the count in each status. Fresh every half minute. */
export function useScanQueue(filter: QueueFilter): UseQueryResult<ScanQueueView> {
  return useQuery({
    queryKey: queueKey(filter),
    queryFn: ({ signal }) => apiFetch<ScanQueueView>(`/api/window-scans?status=${FILTER_STATUS[filter]}`, { signal }),
    refetchInterval: 30_000,
    placeholderData: (previous) => previous,
  });
}

/** GET /api/window-scans/:id. */
export function useScan(id: string): UseQueryResult<ScanDetailView> {
  return useQuery({
    queryKey: detailKey(id),
    queryFn: ({ signal }) => apiFetch<ScanDetailView>(path(id), { signal }),
    enabled: id !== '',
    refetchInterval: 60_000,
  });
}

function useScanMutation<V>(id: string, call: (variables: V) => Promise<ScanDetailView>): UseMutationResult<ScanDetailView, Error, V> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: (view) => {
      queryClient.setQueryData(detailKey(id), view);
      void queryClient.invalidateQueries({ queryKey: ANY_QUEUE });
    },
  });
}

/** PATCH /:id/marks: the reviewer's marks replace the scan's; the answer has the result worked out again. */
export const useSaveMarks = (id: string) => useScanMutation(id, (marks: ScanMark[]) => apiFetch<ScanDetailView>(`${path(id)}/marks`, { method: 'PATCH', body: { marks } }));
/** POST /:id/submit: the first reviewer is done. */
export const useSubmitScan = (id: string) => useScanMutation(id, () => apiFetch<ScanDetailView>(`${path(id)}/submit`, { method: 'POST', body: {} }));
/** POST /:id/finalize: the senior reviewer's word. */
export const useFinalizeScan = (id: string) =>
  useScanMutation(id, (body: { outcome: ScanOutcome; reason?: string; override?: boolean }) => apiFetch<ScanDetailView>(`${path(id)}/finalize`, { method: 'POST', body }));
/** POST /:id/expedite. */
export const useExpediteScan = (id: string) => useScanMutation(id, (expedite: boolean) => apiFetch<ScanDetailView>(`${path(id)}/expedite`, { method: 'POST', body: { expedite } }));
