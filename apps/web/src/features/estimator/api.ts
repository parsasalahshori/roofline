import type { MeasurementView, ProposalView } from '@roofline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';
import { keys } from '../../api/keys.ts';
import type { PropertyRecord } from '../create/api.ts';
import type { NewCustomerInput, ProposalFilter, ProposalList } from './types.ts';

const proposalsKey = ['estimator', 'proposals'] as const;

/** GET /api/proposals?status=&q= -> { proposals, total } */
export function useProposals(filter: ProposalFilter): UseQueryResult<ProposalList> {
  const params: string[] = [];
  if (filter.status !== undefined) params.push(`status=${encodeURIComponent(filter.status)}`);
  if (filter.q !== undefined) params.push(`q=${encodeURIComponent(filter.q)}`);
  const query = params.length > 0 ? `?${params.join('&')}` : '';
  return useQuery({
    queryKey: [...proposalsKey, filter],
    queryFn: ({ signal }) => apiFetch<ProposalList>(`/api/proposals${query}`, { signal }),
  });
}

/** GET /api/properties?q=<q>&limit=8 -> { properties, total }; idle while q is blank. */
export function useHomeSearch(q: string): UseQueryResult<{ properties: PropertyRecord[]; total: number }> {
  const term = q.trim();
  return useQuery({
    queryKey: ['estimator', 'homes', term],
    enabled: term !== '',
    queryFn: ({ signal }) =>
      apiFetch<{ properties: PropertyRecord[]; total: number }>(`/api/properties?q=${encodeURIComponent(term)}&limit=8`, { signal }),
  });
}

/** POST /api/measurements { propertyId | address } -> MeasurementView */
export function useMeasure(): UseMutationResult<MeasurementView, Error, { propertyId?: string; address?: string }> {
  return useMutation({
    mutationFn: (input: { propertyId?: string; address?: string }) =>
      apiFetch<MeasurementView>('/api/measurements', { method: 'POST', body: input }),
  });
}

/** POST /api/proposals { measurementId, customer? } -> ProposalView */
export function useBuildProposal(): UseMutationResult<ProposalView, Error, { measurementId: string; customer?: NewCustomerInput }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { measurementId: string; customer?: NewCustomerInput }) =>
      apiFetch<ProposalView>('/api/proposals', { method: 'POST', body: input }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: proposalsKey }),
  });
}

/** POST /api/proposals/:id/send -> { taskId }. Does not navigate; the caller does. */
export function useSendProposal(): UseMutationResult<{ taskId: string }, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<{ taskId: string }>(`/api/proposals/${id}/send`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: proposalsKey });
      void queryClient.invalidateQueries({ queryKey: keys.approvals });
    },
  });
}
