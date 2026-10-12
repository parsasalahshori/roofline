import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiFetch } from '../../api/client.ts';
import { keys } from '../../api/keys.ts';
import type { StormPhoto, StormSettingsBody, StormSettingsPatch } from '../../api/types.ts';
import { common } from '../../copy/common.ts';
import { errors } from '../../copy/errors.ts';

/*
 * The Storm settings and ad photos (Settings, Storm tab). A photo goes up as its own raw bytes with
 * its own Content-Type, not as a form: the server reads the body as the picture.
 */

/** Sends the photo as raw bytes. Errors are built as apiFetch builds them. */
export async function uploadStormPhoto(file: File): Promise<StormPhoto> {
  let response: Response;
  let text: string;
  try {
    response = await fetch('/api/storm/photos', {
      method: 'POST',
      body: file,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': file.type },
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
  if (response.status >= 200 && response.status < 300) return body as StormPhoto;
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const message = typeof record.error === 'string' ? record.error : errors.generic;
  const field = typeof record.field === 'string' ? record.field : undefined;
  throw new ApiError(response.status, message, field);
}

/** The company's storm settings, with the photos and the standard texts. `enabled` false keeps it from being read. */
export function useStormSettings(enabled = true) {
  return useQuery({
    queryKey: keys.stormSettings,
    queryFn: ({ signal }) => apiFetch<StormSettingsBody>('/api/storm/settings', { signal }),
    enabled,
  });
}

/** Saves the changed fields only; the answer replaces the cached settings. */
export function useSaveStormSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: StormSettingsPatch) => apiFetch<StormSettingsBody>('/api/storm/settings', { method: 'PUT', body: patch }),
    onSuccess: (body) => {
      client.setQueryData(keys.stormSettings, body);
    },
  });
}

export function useUploadStormPhoto() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => uploadStormPhoto(file),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.stormSettings }),
  });
}

export function useDeleteStormPhoto() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/api/storm/photos/${id}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.stormSettings }),
  });
}
