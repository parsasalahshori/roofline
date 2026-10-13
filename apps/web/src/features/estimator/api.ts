import type { MeasurementView, ProposalStatus, ProposalView } from '@roofline/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InfiniteData, UseInfiniteQueryResult, UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { ApiError, apiFetch } from '../../api/client.ts';
import { estimator } from '../../copy/estimator.ts';
import { keys } from '../../api/keys.ts';
import type { PropertyRecord } from '../create/api.ts';
import type { NewCustomerInput, ProposalList } from './types.ts';

/** The POST /api/proposals body. */
export type BuildProposalInput = { measurementId: string; jobId?: string; customer?: NewCustomerInput };

/** What to tell the person when making a proposal fails: the server's plain answer for 400, 403 and 409, else the general line. */
export function makeFailureMessage(error: unknown): string {
  if (error instanceof ApiError && [400, 403, 409].includes(error.status) && error.message !== '') return error.message;
  return estimator.makeFailed;
}

const proposalsKey = ['estimator', 'proposals'] as const;

/** Where each status stands in a group: the next offset to read, or null once everything is loaded. */
type GroupCursor = Record<string, number | null>;
type GroupPage = { proposals: ProposalView[]; totals: Record<string, number>; cursor: GroupCursor };

/**
 * GET /api/proposals?status=&q=&offset= for every status of one window group, a page at a time (the server
 * pages 50). `hasNextPage` stays true while any status has more than is loaded.
 */
export function useProposalGroup(statuses: readonly ProposalStatus[], q: string): UseInfiniteQueryResult<InfiniteData<GroupPage, GroupCursor>> {
  const term = q.trim();
  const first: GroupCursor = Object.fromEntries(statuses.map((status) => [status, 0]));
  return useInfiniteQuery({
    queryKey: [...proposalsKey, 'group', statuses.join(','), term],
    initialPageParam: first,
    queryFn: async ({ pageParam, signal }): Promise<GroupPage> => {
      const proposals: ProposalView[] = [];
      const totals: Record<string, number> = {};
      const cursor: GroupCursor = {};
      for (const status of statuses) {
        const offset = pageParam[status];
        if (offset === null || offset === undefined) {
          cursor[status] = null;
          continue;
        }
        const params = [`status=${encodeURIComponent(status)}`];
        if (term !== '') params.push(`q=${encodeURIComponent(term)}`);
        if (offset > 0) params.push(`offset=${offset}`);
        const page = await apiFetch<ProposalList>(`/api/proposals?${params.join('&')}`, { signal });
        proposals.push(...page.proposals);
        totals[status] = page.total;
        const loaded = offset + page.proposals.length;
        cursor[status] = page.proposals.length > 0 && loaded < page.total ? loaded : null;
      }
      return { proposals, totals, cursor };
    },
    getNextPageParam: (last) => (Object.values(last.cursor).some((next) => next !== null) ? last.cursor : undefined),
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

/** POST /api/proposals { measurementId, jobId?, customer? } -> ProposalView */
export function useBuildProposal(): UseMutationResult<ProposalView, Error, BuildProposalInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: BuildProposalInput) =>
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

/** GET /api/map/building-at: the building outline under a map point. */
export type BuildingAt = {
  footprintId: string;
  /** GeoJSON Polygon or MultiPolygon of the roof outline. */
  polygon: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown };
  centroid: unknown;
};

/** The building under a point, or null when the server answers 404 (no building there). */
export async function fetchBuildingAt(point: { lat: number; lng: number }, signal?: AbortSignal): Promise<BuildingAt | null> {
  const query = new URLSearchParams({ lat: String(point.lat), lng: String(point.lng) });
  try {
    return await apiFetch<BuildingAt>(`/api/map/building-at?${query.toString()}`, { signal });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** Looks up the building under a map click (owner and office; the map decides when to ask). */
export function useBuildingAt(): UseMutationResult<BuildingAt | null, Error, { lat: number; lng: number }> {
  return useMutation({ mutationFn: (point: { lat: number; lng: number }) => fetchBuildingAt(point) });
}

/** POST /api/estimator/from-footprint { footprintId, lat, lng } -> { measurementId }: a measurement started from the outline. */
export function useEstimateFromFootprint(): UseMutationResult<{ measurementId: string }, Error, { footprintId: string; lat: number; lng: number }> {
  return useMutation({
    mutationFn: (input: { footprintId: string; lat: number; lng: number }) =>
      apiFetch<{ measurementId: string }>('/api/estimator/from-footprint', { method: 'POST', body: input }),
  });
}
