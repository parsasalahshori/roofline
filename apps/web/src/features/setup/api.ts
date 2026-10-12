import type { SetupItemKey, SetupView } from '@roofline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';
import { keys } from '../../api/keys.ts';

/** The setup query key lives here, not in api/keys.ts (ruling Q). */
export const setupKey = ['setup'] as const;

export function useSetup() {
  return useQuery({
    queryKey: setupKey,
    queryFn: ({ signal }) => apiFetch<SetupView>('/api/setup', { signal }),
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  });
}

export function useSkip() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (key: SetupItemKey) => apiFetch<SetupView>(`/api/setup/${key}/skip`, { method: 'POST' }),
    onSuccess: (view) => queryClient.setQueryData(setupKey, view),
  });
}

export function useUnskip() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (key: SetupItemKey) => apiFetch<SetupView>(`/api/setup/${key}/unskip`, { method: 'POST' }),
    onSuccess: (view) => queryClient.setQueryData(setupKey, view),
  });
}

export function useLocateCompany() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ located: true }>('/api/company/locate', { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.company });
      void queryClient.invalidateQueries({ queryKey: setupKey });
    },
  });
}

export function useServiceArea() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (radiusMiles: number) => apiFetch<unknown>('/api/company/service-area', { method: 'PUT', body: { radiusMiles } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.company });
      void queryClient.invalidateQueries({ queryKey: setupKey });
    },
  });
}
