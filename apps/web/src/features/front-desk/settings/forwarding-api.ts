import type { ForwardingTestView } from '@roofline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../../api/client.ts';

/* SHELL: Package B replaces the bodies. Names and signatures below are the contract. */

export const forwardingKeys = {
  test: (id: string) => ['front-desk', 'forwarding-test', id] as const,
};

/** POST /api/front-desk/forwarding-test -> { id }. */
export function useStartForwardingTest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<Pick<ForwardingTestView, 'id'>>('/api/front-desk/forwarding-test', { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['front-desk', 'settings'] });
    },
  });
}

/** GET /api/front-desk/forwarding-test/:id; refetches every 2000 ms while status is 'calling', else stops. Disabled when id is null. */
export function useForwardingTest(id: string | null) {
  return useQuery({
    queryKey: forwardingKeys.test(id ?? ''),
    enabled: id !== null,
    queryFn: ({ signal }) => apiFetch<ForwardingTestView>(`/api/front-desk/forwarding-test/${id}`, { signal }),
    refetchInterval: (query) => (query.state.data?.status === 'calling' ? 2000 : false),
  });
}
