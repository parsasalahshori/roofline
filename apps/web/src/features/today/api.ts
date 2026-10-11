import { useMutation } from '@tanstack/react-query';
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
