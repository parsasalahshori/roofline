import type { GutterAdjustmentsPatch, GutterMeasurementView } from '@roofline/shared';
import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from '../../../api/client.ts';

// The key stays local to this file: nothing else reads or writes a measurement's gutters.
const guttersKey = (id: string) => ['measurement-gutters', id] as const;

export const guttersPath = (id: string) => `/api/measurements/${encodeURIComponent(id)}/gutters`;

/** GET /api/measurements/:id/gutters. */
export function useGutters(id: string): UseQueryResult<GutterMeasurementView> {
  return useQuery({
    queryKey: guttersKey(id),
    queryFn: ({ signal }) => apiFetch<GutterMeasurementView>(guttersPath(id), { signal }),
    enabled: id !== '',
  });
}

/** PATCH /api/measurements/:id/gutters. Debounce is NOT here (the window debounces 500 ms). */
export function usePatchGutters(id: string): UseMutationResult<GutterMeasurementView, Error, GutterAdjustmentsPatch> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch<GutterMeasurementView>(guttersPath(id), { method: 'PATCH', body }),
    onSuccess: (result) => queryClient.setQueryData(guttersKey(id), result),
  });
}
