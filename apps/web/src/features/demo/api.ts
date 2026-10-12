import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';

/** The four things the presenter can make happen (POST /api/demo/simulate/:kind). */
export const SIMULATIONS = ['text', 'call', 'storm', 'sign'] as const;
export type Simulation = (typeof SIMULATIONS)[number];

/** What a simulation answers: ok, the ids it touched and a sentence for the presenter. */
export type SimulateResult = { ok: true; message: string } & Record<string, unknown>;

export const demoKey = ['demo'] as const;

/**
 * Whether the API runs in demo mode: GET /api/demo answers 200 { demo: true } only then. A 404 (demo off) or any
 * other failure reads as "not a demo"; it is asked once per session and never retried.
 */
export function useDemoMode(): boolean {
  const query = useQuery<boolean>({
    queryKey: demoKey,
    queryFn: async ({ signal }) => {
      try {
        const body = await apiFetch<{ demo?: unknown }>('/api/demo', { signal, redirectOn401: false });
        return body.demo === true;
      } catch {
        return false;
      }
    },
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return query.data === true;
}

/**
 * Runs one simulation. On success every screen's data is read again (except the demo probe), so the inbox, the map,
 * the storms and the proposals show what just happened.
 */
export function useSimulate() {
  const queryClient = useQueryClient();
  return useMutation<SimulateResult, Error, Simulation>({
    mutationFn: (kind) => apiFetch<SimulateResult>(`/api/demo/simulate/${kind}`, { method: 'POST', body: {} }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== demoKey[0] });
    },
  });
}
