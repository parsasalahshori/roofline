import { useMutation, useQuery } from '@tanstack/react-query';
import type { FrontDeskWeekStats, ProposalView, TodayView } from '@roofline/shared';
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

/** Proposals signed on `dateKey` (the company-zone calendar day, YYYY-MM-DD). */
export function useSignedToday(dateKey: string) {
  return useQuery({
    queryKey: ['today', 'signed', dateKey],
    queryFn: ({ signal }) =>
      apiFetch<{ proposals: ProposalView[]; total: number }>(
        '/api/proposals?status=signed&signedOn=' + encodeURIComponent(dateKey),
        { signal },
      ),
  });
}

/** The Front Desk's counts for this week. Owner and office only: a rep is refused, so the caller passes `enabled` false for one. */
export function useFrontDeskWeek(enabled: boolean) {
  return useQuery({
    enabled,
    // The same key as the Front Desk inbox's week stats, so the two share one answer
    queryKey: ['front-desk', 'stats', 'current'],
    queryFn: ({ signal }) => apiFetch<FrontDeskWeekStats>('/api/front-desk/stats', { signal }),
  });
}
