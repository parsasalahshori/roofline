import type { WindowOrderPatch, WindowOrderView } from '@roofline/shared';
import { useMutation, useQuery, useQueryClient, type QueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import { ApiError, apiFetch } from '../../../../api/client.ts';
import { windowsPath } from '../api.ts';

// Two cache entries hold the same view: by order id, and by the measurement it was made from (null = no order yet).
const orderKey = (id: string) => ['window-order', id] as const;
const measurementOrderKey = (measurementId: string) => ['window-measurement-order', measurementId] as const;

export const orderPath = (id: string) => `/api/window-orders/${encodeURIComponent(id)}`;
export const measurementOrderPath = (measurementId: string) => `${windowsPath(measurementId)}/order`;

/** The factory sheet as CSV (only once the order is ready or sent). A plain download link: same origin, cookie auth. */
export const sheetCsvHref = (id: string) => `${orderPath(id)}/sheet.csv`;
/** The factory sheet as PDF (a draft's is watermarked DRAFT). */
export const sheetPdfHref = (id: string) => `${orderPath(id)}/sheet.pdf`;

/** Puts a fresh view in both cache entries. */
function remember(queryClient: QueryClient, view: WindowOrderView): void {
  queryClient.setQueryData(orderKey(view.id), view);
  queryClient.setQueryData(measurementOrderKey(view.windowMeasurementId), view);
}

/** GET /api/window-orders/:id. */
export function useWindowOrder(id: string): UseQueryResult<WindowOrderView> {
  return useQuery({
    queryKey: orderKey(id),
    queryFn: ({ signal }) => apiFetch<WindowOrderView>(orderPath(id), { signal }),
    enabled: id !== '',
  });
}

/** GET /api/window-measurements/:id/order: the measurement's order, or null when it has none yet (a 404). */
/** `enabled: false` skips the request (the windows screen asks only once photo windows exist). */
export function useMeasurementOrder(measurementId: string, enabled = true): UseQueryResult<WindowOrderView | null> {
  return useQuery({
    queryKey: measurementOrderKey(measurementId),
    queryFn: async ({ signal }) => {
      try {
        return await apiFetch<WindowOrderView>(measurementOrderPath(measurementId), { signal });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: enabled && measurementId !== '',
  });
}

/** POST /api/window-measurements/:id/order: makes the draft from the photo windows (201), or refreshes it (200). 422 = no photo windows. */
export function useCreateWindowOrder(measurementId: string): UseMutationResult<WindowOrderView, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<WindowOrderView>(measurementOrderPath(measurementId), { method: 'POST' }),
    onSuccess: (view) => remember(queryClient, view),
  });
}

/** PATCH /api/window-orders/:id. Debounce is NOT here (the order screen debounces). 409 = no longer a draft. */
export function usePatchWindowOrder(id: string): UseMutationResult<WindowOrderView, Error, WindowOrderPatch> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch<WindowOrderView>(orderPath(id), { method: 'PATCH', body }),
    onSuccess: (view) => remember(queryClient, view),
  });
}

/** POST /api/window-orders/:id/ready: locks the sizes. 403 for reps; 409 when a line is not orderable. */
export function useMarkReady(id: string): UseMutationResult<WindowOrderView, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<WindowOrderView>(`${orderPath(id)}/ready`, { method: 'POST' }),
    onSuccess: (view) => remember(queryClient, view),
  });
}

/** POST /api/window-orders/:id/reopen: ready back to draft (owner and office). */
export function useReopen(id: string): UseMutationResult<WindowOrderView, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<WindowOrderView>(`${orderPath(id)}/reopen`, { method: 'POST' }),
    onSuccess: (view) => remember(queryClient, view),
  });
}
