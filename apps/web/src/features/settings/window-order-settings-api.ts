import type { WindowOrderSettings, WindowOrderSettingsPatch } from '@roofline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';

/*
 * Hooks behind Settings -> Prices -> Factory orders, on GET/PUT /api/window-order-settings. Everyone signed in
 * reads; the owner saves. PUT replaces the stored changes, so the body holds only what differs from the
 * standard values, and `{}` goes back to them.
 */

const windowOrderSettingsKey = ['window-order-settings'] as const;
const PATH = '/api/window-order-settings';

export function useWindowOrderSettings() {
  return useQuery({
    queryKey: windowOrderSettingsKey,
    queryFn: ({ signal }) => apiFetch<WindowOrderSettings>(PATH, { signal }),
  });
}

/** Saves the company's changes (owner only). The answer, the settings in force, replaces the cache. */
export function useSaveWindowOrderSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: WindowOrderSettingsPatch) => apiFetch<WindowOrderSettings>(PATH, { method: 'PUT', body: patch }),
    onSuccess: (answer) => queryClient.setQueryData(windowOrderSettingsKey, answer),
  });
}
