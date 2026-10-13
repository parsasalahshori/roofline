import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../../api/client.ts';

/** What `GET /api/home/signed` answers. Money is in cents; `goalCents` is null when the company has no goal. */
export type SignedSummary = {
  monthTotalCents: number;
  goalCents: number | null;
  weekly: { weekStart: string; totalCents: number }[];
  openPipelineCents: number;
};

/** The numbers behind the "Signed this month" card. */
export function useSignedSummary() {
  return useQuery({
    queryKey: ['home', 'signed'],
    queryFn: ({ signal }) => apiFetch<SignedSummary>('/api/home/signed', { signal }),
  });
}
