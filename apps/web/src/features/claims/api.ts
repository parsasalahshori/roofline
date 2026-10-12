import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClaimBoardRow, ClaimStatus, JobClaimResponse } from '@roofline/shared';
import { apiFetch } from '../../api/client.ts';
import { jobKey } from '../job/api.ts';

/** Fields `PUT /api/jobs/:jobId/claim` takes. Only the fields given are sent; null clears one. */
export type ClaimEdit = {
  insurer?: string | null;
  claimNumber?: string | null;
  dateOfLoss?: string | null;
  status?: ClaimStatus;
  adjusterName?: string | null;
  adjusterPhone?: string | null;
  adjusterEmail?: string | null;
  deductibleCents?: number | null;
  notes?: string | null;
};

/** One job's claim and, until a claim exists, its latest intake. */
export function useJobClaim(jobId: string) {
  return useQuery<JobClaimResponse>({
    queryKey: ['claim', jobId],
    queryFn: ({ signal }) => apiFetch<JobClaimResponse>('/api/jobs/' + jobId + '/claim', { signal }),
  });
}

/** Saves the claim; sets the claim query's data and refreshes the job (its timeline). */
export function useSaveClaim(jobId: string) {
  const queryClient = useQueryClient();
  return useMutation<JobClaimResponse, Error, ClaimEdit>({
    mutationFn: (edit) => apiFetch<JobClaimResponse>('/api/jobs/' + jobId + '/claim', { method: 'PUT', body: edit }),
    onSuccess: (data) => {
      queryClient.setQueryData(['claim', jobId], data);
      void queryClient.invalidateQueries({ queryKey: jobKey(jobId) });
    },
  });
}

/** The claims board rows, optionally for one status. */
export function useClaimsBoard(status?: ClaimStatus) {
  return useQuery<ClaimBoardRow[]>({
    queryKey: ['claims-board', status ?? 'all'],
    queryFn: ({ signal }) =>
      apiFetch<ClaimBoardRow[]>('/api/claims' + (status === undefined ? '' : '?status=' + status), { signal }),
  });
}
