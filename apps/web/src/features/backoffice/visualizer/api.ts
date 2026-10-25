import type { HouseVisual, Placement } from '@roofline/shared';
import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import { ApiError, apiFetch } from '../../../api/client.ts';
import { quotePath } from '../designer/api.ts';

export const visualKey = (id: string) => ['backoffice', 'visual', id] as const;
export const visualPath = (id: string) => `${quotePath(id)}/visual`;
/** Where the house photo is served (same origin, cookie auth): used as an <img> source. */
export const visualPhotoSrc = (id: string, photoUploadId: string) => `${visualPath(id)}/photo?v=${encodeURIComponent(photoUploadId)}`;

/** GET /api/backoffice/quotes/:id/visual. */
export function useHouseVisual(id: string): UseQueryResult<HouseVisual> {
  return useQuery({
    queryKey: visualKey(id),
    queryFn: ({ signal }) => apiFetch<HouseVisual>(visualPath(id), { signal }),
    enabled: id !== '',
    refetchOnWindowFocus: false,
  });
}

export type VisualPut = { photoUploadId: string | null; placements: Placement[] };

/** PUT /api/backoffice/quotes/:id/visual. */
export function usePutVisual(id: string): UseMutationResult<HouseVisual, Error, VisualPut> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch<HouseVisual>(visualPath(id), { method: 'PUT', body }),
    onSuccess: (saved) => queryClient.setQueryData(visualKey(id), saved),
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** An upload that sends nothing for this long has stalled: it is stopped so the person can try again. */
export const UPLOAD_STALL_MS = 45_000;

/**
 * POST /api/backoffice/quotes/:id/visual/photo (multipart, field "photo") -> the visual with its new photoUploadId.
 * XHR so the person sees progress (0..1). Rejects with ApiError status 0 when the connection fails or stalls.
 */
export function uploadHousePhoto(id: string, file: File, onProgress: (share: number) => void): Promise<HouseVisual> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let stall: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(stall);
      reject(new ApiError(0, ''));
    };
    const watch = () => {
      clearTimeout(stall);
      stall = setTimeout(() => {
        xhr.abort?.();
        fail();
      }, UPLOAD_STALL_MS);
    };
    xhr.open('POST', `${visualPath(id)}/photo`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      watch();
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onabort = fail;
    xhr.onerror = fail;
    xhr.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(stall);
      const body = parseJson(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300 && body !== null && typeof body === 'object') resolve(body as HouseVisual);
      else reject(new ApiError(xhr.status, body !== null && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : ''));
    };
    const form = new FormData();
    form.append('photo', file);
    watch();
    xhr.send(form);
  });
}
