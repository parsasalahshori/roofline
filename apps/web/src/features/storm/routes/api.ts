import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../../api/client.ts';
import { keys } from '../../../api/keys.ts';
import type { MyRoutesList, OutcomeResult, RecordOutcomeVars, RouteDetailView } from './types.ts';

/** The signed-in rep's routes. */
export function useMyRoutes() {
  return useQuery<MyRoutesList>({
    queryKey: keys.myRoutes,
    queryFn: ({ signal }) => apiFetch<MyRoutesList>('/api/routes/mine', { signal }),
  });
}

/** One route with its stops in order. */
export function useRoute(routeId: string) {
  return useQuery<RouteDetailView>({
    queryKey: keys.route(routeId),
    queryFn: ({ signal }) => apiFetch<RouteDetailView>(`/api/routes/${encodeURIComponent(routeId)}`, { signal }),
    enabled: routeId !== '',
  });
}

/** Records one door's outcome. The route and the list are read again afterwards. */
export function useRecordOutcome() {
  const queryClient = useQueryClient();
  return useMutation<OutcomeResult, Error, RecordOutcomeVars>({
    mutationFn: ({ routeId, stopId, outcome, lead }) =>
      apiFetch<OutcomeResult>(
        `/api/routes/${encodeURIComponent(routeId)}/stops/${encodeURIComponent(stopId)}/outcome`,
        { method: 'POST', body: lead ? { outcome, lead } : { outcome } },
      ),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: keys.route(vars.routeId) });
      void queryClient.invalidateQueries({ queryKey: keys.myRoutes });
    },
  });
}
