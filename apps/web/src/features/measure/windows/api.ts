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
export function useWindowPreview(id: string, version: string): UseQueryResult<{ quotes: WindowQuote[] }> {
  return useQuery({
    queryKey: [...windowsKey(id), 'preview', version] as const,
    queryFn: ({ signal }) => apiFetch<{ quotes: WindowQuote[] }>(`${windowsPath(id)}/preview`, { signal }),
    enabled: id !== '',
    placeholderData: (previous) => previous,
  });
}

/** Where an on-site window photo is served (same origin, cookie auth). */
export const uploadSrc = (id: string, uploadId: string) => `${windowsPath(id)}/uploads/${encodeURIComponent(uploadId)}`;

/** The photo types and size the upload takes. */
export const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/heif'] as const;
export const UPLOAD_MAX_BYTES = 12 * 1024 * 1024;

/**
 * POST /api/window-measurements/:id/uploads (multipart, field "photo") -> 201 WindowPhotoUpload. XHR, not fetch, so the
 * person sees the upload's progress (0..1) on a slow site connection.
 */
export function uploadWindowPhoto(id: string, file: File, onProgress: (share: number) => void): Promise<WindowPhotoUpload> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${windowsPath(id)}/uploads`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
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
    xhr.onerror = () => reject(new ApiError(0, ''));
    const form = new FormData();
    form.append('photo', file);
    xhr.send(form);
  });
}
