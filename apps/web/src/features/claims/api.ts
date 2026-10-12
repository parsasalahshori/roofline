import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClaimBoardRow, ClaimPacketInfo, ClaimStatus, ClaimView, JobClaimResponse } from '@roofline/shared';
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

/** Saves the claim (`PUT` answers the saved `ClaimView`); updates the claim query and refreshes the job (its timeline). */
export function useSaveClaim(jobId: string) {
  const queryClient = useQueryClient();
  return useMutation<ClaimView, Error, ClaimEdit>({
    mutationFn: (edit) => apiFetch<ClaimView>('/api/jobs/' + jobId + '/claim', { method: 'PUT', body: edit }),
    onSuccess: (claim) => {
      queryClient.setQueryData<JobClaimResponse>(['claim', jobId], (old) => ({ claim, intake: old?.intake ?? null, packet: old?.packet ?? null }));
      void queryClient.invalidateQueries({ queryKey: jobKey(jobId) });
    },
  });
}

// G1 Task 7: where the newest claim packet is downloaded from.
export function claimPacketUrl(jobId: string): string {
  return '/api/jobs/' + jobId + '/claim/packet';
}

// G1 Task 7: builds a new claim packet now (`POST` answers `{ packet }`); the download link then shows its date.
export function useBuildClaimPacket(jobId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ packet: ClaimPacketInfo }, Error, void>({
    mutationFn: () => apiFetch<{ packet: ClaimPacketInfo }>(claimPacketUrl(jobId), { method: 'POST' }),
    onSuccess: ({ packet }) => {
      queryClient.setQueryData<JobClaimResponse>(['claim', jobId], (old) => (old ? { ...old, packet } : old));
      void queryClient.invalidateQueries({ queryKey: jobKey(jobId) });
    },
  });
}

/** The claims board rows, optionally for one status (`GET /api/claims` answers `{ claims }`). */
export function useClaimsBoard(status?: ClaimStatus) {
  return useQuery<ClaimBoardRow[]>({
    queryKey: ['claims-board', status ?? 'all'],
    queryFn: async ({ signal }) =>
      (await apiFetch<{ claims: ClaimBoardRow[] }>('/api/claims' + (status === undefined ? '' : '?status=' + status), { signal }))
        .claims,
  });
}
