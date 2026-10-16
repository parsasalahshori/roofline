import type { InstantQuoteSettings } from '@roofline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';

/** The owner's instant quote page settings, plus the page's public address once it has a slug. */
export type InstantQuoteSettingsView = InstantQuoteSettings & { pageUrl: string | null };

export const instantQuoteKey = ['instant-quote-settings'] as const;

export function useInstantQuoteSettings() {
  return useQuery({
    queryKey: instantQuoteKey,
    queryFn: ({ signal }) => apiFetch<InstantQuoteSettingsView>('/api/instant-quote/settings', { signal }),
  });
}

/** Saves the whole settings (owner only). The answer replaces the cache. */
export function useSaveInstantQuoteSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: InstantQuoteSettings) => apiFetch<InstantQuoteSettingsView>('/api/instant-quote/settings', { method: 'PUT', body }),
    onSuccess: (answer) => queryClient.setQueryData(instantQuoteKey, answer),
  });
}
