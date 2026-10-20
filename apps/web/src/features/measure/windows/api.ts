import type { WindowMeasurementPatch, WindowMeasurementView, WindowPhotoUpload, WindowQuote } from '@roofline/shared';
import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import { ApiError, apiFetch } from '../../../api/client.ts';

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
export function useWindowPreview(id: string, version: string): UseQueryResult<{ quotes: WindowQuote[] | null }> {
  return useQuery({
    queryKey: [...windowsKey(id), 'preview', version] as const,
    queryFn: ({ signal }) => apiFetch<{ quotes: WindowQuote[] | null }>(`${windowsPath(id)}/preview`, { signal }),
    enabled: id !== '',
    placeholderData: (previous) => previous,
  });
}

/** Where an on-site window photo is served (same origin, cookie auth). */
export const uploadSrc = (id: string, uploadId: string) => `${windowsPath(id)}/uploads/${encodeURIComponent(uploadId)}`;


/** An upload that sends nothing for this long has stalled (a dead site connection): it is stopped and tried again. */
export const UPLOAD_STALL_MS = 45_000;
/** No upload takes longer than this, however slowly it moves (12 MB at 200 kbit/s is about 8 minutes). */
export const UPLOAD_MAX_MS = 10 * 60_000;

/**
 * POST /api/window-measurements/:id/uploads (multipart, field "photo") -> 201 WindowPhotoUpload. XHR, not fetch, so the
 * person sees the upload's progress (0..1) on a slow site connection. Rejects with ApiError status 0 when the
 * connection fails or stalls (nothing sent for UPLOAD_STALL_MS) so the caller can try again.
 */
export function uploadWindowPhoto(id: string, file: File, onProgress: (share: number) => void, o: { stallMs?: number; maxMs?: number } = {}): Promise<WindowPhotoUpload> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let stall: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = () => {
      settled = true;
      clearTimeout(stall);
    };
    const fail = () => {
      if (settled) return;
      finish();
      reject(new ApiError(0, ''));
    };
    const watch = () => {
      clearTimeout(stall);
      stall = setTimeout(() => {
        // abort() fires onabort (fail) where the browser has it; fail() covers stand-ins without it
        xhr.abort?.();
        fail();
      }, o.stallMs ?? UPLOAD_STALL_MS);
    };
    xhr.open('POST', `${windowsPath(id)}/uploads`);
    xhr.withCredentials = true;
    xhr.timeout = o.maxMs ?? UPLOAD_MAX_MS;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      watch();
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.ontimeout = fail;
    xhr.onabort = fail;
    xhr.onload = () => {
      if (settled) return;
      finish();
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && body !== null && typeof body === 'object') resolve(body as WindowPhotoUpload);
      else {
        const message = body !== null && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : '';
        reject(new ApiError(xhr.status, message));
      }
    };
    xhr.onerror = fail;
    const form = new FormData();
    form.append('photo', file);
    watch();
    xhr.send(form);
  });
}
