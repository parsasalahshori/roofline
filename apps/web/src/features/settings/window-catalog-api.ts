import type { WindowCatalog } from '@roofline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';

/*
 * Hooks behind Settings -> Prices -> Windows catalog, on GET/PUT /api/window-catalog. Owner and office read; the owner
 * saves. PUT replaces the whole catalog and answers the one in force.
 */

export const windowCatalogKey = ['window-catalog'] as const;
const PATH = '/api/window-catalog';

export function useWindowCatalog() {
  return useQuery({
    queryKey: windowCatalogKey,
    queryFn: ({ signal }) => apiFetch<{ catalog: WindowCatalog }>(PATH, { signal }).then((r) => r.catalog),
    // A rep may not read it (the screens that only name a window's style then use the standard words): no second try
    retry: false,
  });
}

export function useSaveWindowCatalog() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (catalog: WindowCatalog) => apiFetch<{ catalog: WindowCatalog }>(PATH, { method: 'PUT', body: { catalog } }).then((r) => r.catalog),
    onSuccess: (answer) => queryClient.setQueryData(windowCatalogKey, answer),
  });
}
