import { useMutation, useQuery } from '@tanstack/react-query';
import type { TodayView } from '@roofline/shared';
import { apiFetch } from '../../api/client.ts';

/*
 * The one write the Today window makes. It is asked once per day per person when they open the
 * map home page; the answer says whether the Today window should open.
 */

/** Records that Today was shown to this person today, and answers whether it should open now. */
export function useTodayShown() {
  return useMutation({
    mutationFn: () => apiFetch<{ show: boolean }>('/api/me/today-shown', { method: 'POST' }),
  });
}

/** Today's appointments and the jobs to follow up today, for the signed-in person. */
export function useToday() {
  return useQuery({
    queryKey: ['today', 'view'],
    queryFn: () => apiFetch<TodayView>('/api/today'),
  });
}
