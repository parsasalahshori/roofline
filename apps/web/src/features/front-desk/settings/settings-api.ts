import type {
  FrontDeskSettings,
  FrontDeskSettingsInput,
  FrontDeskVoice,
  TransferPhoneInput,
  TransferPhoneView,
} from '@roofline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../../api/client.ts';

/* Hooks behind Settings -> Front Desk and Your profile (Task 23). Response types come from @roofline/shared (Ruling DR). */

export const settingsKeys = {
  settings: ['front-desk', 'settings'] as const,
  voices: ['front-desk', 'voices'] as const,
  transferPhone: ['me', 'transfer-phone'] as const,
};

/** GET /api/front-desk/settings (owner and office). */
export function useFrontDeskSettings() {
  return useQuery({
    queryKey: settingsKeys.settings,
    queryFn: ({ signal }) => apiFetch<FrontDeskSettings>('/api/front-desk/settings', { signal }),
  });
}

/** PUT /api/front-desk/settings. The answer is the settings as saved and replaces the cache. A failure is an ApiError with `field`. */
export function useSaveFrontDeskSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: FrontDeskSettingsInput) =>
      apiFetch<FrontDeskSettings>('/api/front-desk/settings', { method: 'PUT', body: input }),
    onSuccess: (saved) => {
      queryClient.setQueryData(settingsKeys.settings, saved);
    },
  });
}

/** GET /api/front-desk/voices. `previewUrl` may be null: no preview control for that voice. */
export function useFrontDeskVoices() {
  return useQuery({
    queryKey: settingsKeys.voices,
    queryFn: ({ signal }) => apiFetch<FrontDeskVoice[]>('/api/front-desk/voices', { signal }),
  });
}

/** GET /api/me/transfer-phone. */
export function useTransferPhone() {
  return useQuery({
    queryKey: settingsKeys.transferPhone,
    queryFn: ({ signal }) => apiFetch<TransferPhoneView>('/api/me/transfer-phone', { signal }),
  });
}

/** PUT /api/me/transfer-phone {e164, ackRecording: true}. The answer is the view as saved. Also refreshes the settings (the on-call list shows phones). */
export function useSaveTransferPhone() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TransferPhoneInput) =>
      apiFetch<TransferPhoneView>('/api/me/transfer-phone', { method: 'PUT', body: input }),
    onSuccess: (saved) => {
      queryClient.setQueryData(settingsKeys.transferPhone, saved);
      void queryClient.invalidateQueries({ queryKey: settingsKeys.settings });
    },
  });
}
