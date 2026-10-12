import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ImportMapping, ImportView } from '@roofline/shared';
import { ApiError, apiFetch } from '../../api/client.ts';
import { common } from '../../copy/common.ts';
import { errors } from '../../copy/errors.ts';

/** Sends the file as raw bytes. Always octet-stream (Ruling AJ). Errors are built as apiFetch builds them. */
export async function uploadImport(file: File): Promise<ImportView> {
  let response: Response;
  let text: string;
  try {
    response = await fetch('/api/imports?fileName=' + encodeURIComponent(file.name), {
      method: 'POST',
      body: file,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/octet-stream' },
    });
    text = await response.text();
  } catch {
    throw new ApiError(0, common.networkError);
  }
  let body: unknown;
  try {
    body = text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    body = undefined;
  }
  if (response.status >= 200 && response.status < 300) return body as ImportView;
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const message = typeof record.error === 'string' ? record.error : errors.generic;
  const field = typeof record.field === 'string' ? record.field : undefined;
  throw new ApiError(response.status, message, field);
}

export function useUploadImport() {
  return useMutation({ mutationFn: (file: File) => uploadImport(file) });
}

/** The import; polls every 2 seconds while queued or processing. */
export function useImport(id: string, attested: boolean) {
  return useQuery({
    queryKey: ['import', id, attested] as const,
    queryFn: ({ signal }) => apiFetch<ImportView>(`/api/imports/${id}?attested=${attested}`, { signal }),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'queued' || status === 'processing' ? 2000 : false;
    },
  });
}

const setAll = (client: QueryClient, id: string, view: ImportView) =>
  client.setQueriesData({ queryKey: ['import', id] }, view);

/** Saves the column mapping; the answer replaces the cached import. */
export function useSetMapping(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (mapping: ImportMapping) => apiFetch<ImportView>(`/api/imports/${id}`, { method: 'PATCH', body: { mapping } }),
    onSuccess: (view) => setAll(client, id, view),
  });
}

export type StartBody = { consentAttested: false } | { consentAttested: true; consentText: string };

export function useStartImport(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: StartBody) => apiFetch<ImportView>(`/api/imports/${id}/start`, { method: 'POST', body }),
    onSuccess: (view) => setAll(client, id, view),
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) void client.invalidateQueries({ queryKey: ['import', id] });
    },
  });
}

export function useRetryImport(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<ImportView>(`/api/imports/${id}/retry`, { method: 'POST' }),
    onSuccess: (view) => setAll(client, id, view),
  });
}
