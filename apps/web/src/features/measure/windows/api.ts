import type { WindowMeasurementPatch, WindowMeasurementView, WindowQuote } from '@roofline/shared';
import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from '../../../api/client.ts';

// The keys stay local to this file: nothing else reads or writes a window measurement's cache entry.
const windowsKey = (id: string) => ['window-measurement', id] as const;

export const windowsPath = (id: string) => `/api/window-measurements/${encodeURIComponent(id)}`;

/** Where a measurement's photo is served (same origin, cookie auth): used as an <img> source. */
export const photoSrc = (id: string, photoId: string) => `${windowsPath(id)}/photos/${encodeURIComponent(photoId)}`;

/** GET /api/window-measurements/:id. */
export function useWindowMeasurement(id: string): UseQueryResult<WindowMeasurementView> {
  return useQuery({
    queryKey: windowsKey(id),
    queryFn: ({ signal }) => apiFetch<WindowMeasurementView>(windowsPath(id), { signal }),
    enabled: id !== '',
  });
}

/** POST /api/window-measurements {address} or {propertyId} -> 201 the new measurement (put in the cache). */
export function useCreateWindowMeasurement(): UseMutationResult<WindowMeasurementView, Error, { address: string } | { propertyId: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch<WindowMeasurementView>('/api/window-measurements', { method: 'POST', body }),
    onSuccess: (created) => queryClient.setQueryData(windowsKey(created.id), created),
  });
}

/** PATCH /api/window-measurements/:id. Debounce is NOT here (the window debounces 500 ms). */
export function usePatchWindowMeasurement(id: string): UseMutationResult<WindowMeasurementView, Error, WindowMeasurementPatch> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch<WindowMeasurementView>(windowsPath(id), { method: 'PATCH', body }),
    onSuccess: (result) => queryClient.setQueryData(windowsKey(id), result),
  });
}

/**
 * GET /api/window-measurements/:id/preview: Good, Better and Best at the company's prices for what is saved.
 * `version` follows the saved adjustments, so a saved change asks for the prices again.
 */
export function useWindowPreview(id: string, version: string): UseQueryResult<{ quotes: WindowQuote[] }> {
  return useQuery({
    queryKey: [...windowsKey(id), 'preview', version] as const,
    queryFn: ({ signal }) => apiFetch<{ quotes: WindowQuote[] }>(`${windowsPath(id)}/preview`, { signal }),
    enabled: id !== '',
    placeholderData: (previous) => previous,
  });
}
