import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';
import { keys } from '../../api/keys.ts';
import type { MeasurementPatch, MeasurementView } from './types.ts';

// The key stays local to this file: nothing else reads or writes a measurement's cache entry.
const measurementKey = (id: string) => ['measurement', id] as const;

export function useMeasurement(id: string): UseQueryResult<MeasurementView> {
  return useQuery({
    queryKey: measurementKey(id),
    queryFn: ({ signal }) => apiFetch<MeasurementView>(`/api/measurements/${id}`, { signal }),
    enabled: id !== '',
  });
}

/** PATCH /api/measurements/:id. Debounce is NOT here (the window debounces 500 ms). */
export function usePatchMeasurement(id: string): UseMutationResult<MeasurementView, Error, MeasurementPatch> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: MeasurementPatch) =>
      apiFetch<MeasurementView>(`/api/measurements/${id}`, { method: 'PATCH', body }),
    onSuccess: (result) => {
      queryClient.setQueryData(measurementKey(id), result);
    },
  });
}

/** POST /api/measurements/:id/exact-report -> 201 { taskId }. */
export function useExactReport(id: string): UseMutationResult<{ taskId: string }, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ taskId: string }>(`/api/measurements/${id}/exact-report`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.approvals }),
  });
}

/** POST /api/proposals { measurementId } -> { id } (the proposal; T8 shape assumed). The window then opens /estimator/proposals/<id>. */
export function useMakeProposal(measurementId: string): UseMutationResult<{ id: string }, Error, void> {
  return useMutation({
    mutationFn: () => apiFetch<{ id: string }>('/api/proposals', { method: 'POST', body: { measurementId } }),
  });
}
