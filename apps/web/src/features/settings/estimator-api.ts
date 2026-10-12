import type { EstimatorSettings, EstimatorSettingsPatch, TierTemplate } from '@roofline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';

/*
 * Hooks behind Settings -> Prices (E1 Task 18). The API (E1 Task 8) is not built yet: the shapes below
 * follow the spec (GET/PUT /api/tier-templates, GET/PUT /api/estimator/settings). Owners edit; office reads.
 */

export const estimatorKeys = {
  templates: ['tier-templates'] as const,
  settings: ['estimator-settings'] as const,
};

/** The three templates, good, better, best. */
export function useTierTemplates() {
  return useQuery({
    queryKey: estimatorKeys.templates,
    queryFn: ({ signal }) => apiFetch<{ templates: TierTemplate[] }>('/api/tier-templates', { signal }),
  });
}

/** Saves the templates (owner only). Body: { templates: TierTemplate[] } (all three). The answer replaces the cache. */
export function useSaveTierTemplates() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (templates: TierTemplate[]) =>
      apiFetch<{ templates: TierTemplate[] }>('/api/tier-templates', { method: 'PUT', body: { templates } }),
    onSuccess: (answer) => queryClient.setQueryData(estimatorKeys.templates, answer),
  });
}

export function useEstimatorSettings() {
  return useQuery({
    queryKey: estimatorKeys.settings,
    queryFn: ({ signal }) => apiFetch<EstimatorSettings>('/api/estimator/settings', { signal }),
  });
}

/** Saves some settings (owner only). The answer replaces the cache. */
export function useSaveEstimatorSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: EstimatorSettingsPatch) =>
      apiFetch<EstimatorSettings>('/api/estimator/settings', { method: 'PUT', body: patch }),
    onSuccess: (answer) => queryClient.setQueryData(estimatorKeys.settings, answer),
  });
}
