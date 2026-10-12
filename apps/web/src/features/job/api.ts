import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JobSource, JobView } from '@roofline/shared';
import type { ProposalView } from '@roofline/shared';
import { ApiError, apiFetch } from '../../api/client.ts';
import type { ProposalList } from '../estimator/types.ts';

/**
 * Fields `PATCH /api/jobs/:id` takes from the edit sheet. Only the fields given are sent.
 * `null` clears a field (no value, no rep, no next step, no next-step date).
 */
export type JobEdit = {
  valueCents?: number | null;
  source?: JobSource;
  assignedUserId?: string | null;
  nextStep?: string | null;
  nextStepOn?: string | null;
};

/** The query key of one job's window. Every job mutation invalidates it. */
export const jobKey = (id: string) => ['job', id] as const;

/**
 * One job's view (`GET /api/jobs/:id/view`): the job, its customer and home, appointments, quotes,
 * agent tasks and what the signed-in person may see and change. A 404 is not retried: the job is
 * gone or hidden from this person, and asking again will not change that.
 */
export function useJobView(id: string) {
  return useQuery<JobView>({
    queryKey: jobKey(id),
    queryFn: ({ signal }) => apiFetch<JobView>('/api/jobs/' + id + '/view', { signal }),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 1,
  });
}

/**
 * Changes a job's value, source, rep or next step with `PATCH /api/jobs/:id`. Once it settles, the
 * job's view and the pipeline board are invalidated and refetched. There is no optimistic update.
 */
export function useUpdateJob(id: string) {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, JobEdit>({
    mutationFn: (edit) => apiFetch('/api/jobs/' + id, { method: 'PATCH', body: edit }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: jobKey(id) });
      void queryClient.invalidateQueries({ queryKey: ['jobs-board'] });
    },
  });
}

/**
 * Archives or restores a job. `mutate(true)` posts to `/api/jobs/:id/archive`, `mutate(false)` to
 * `/api/jobs/:id/unarchive`. Invalidates the job's view and the pipeline board once it settles.
 */
export function useArchiveJob(id: string) {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, boolean>({
    mutationFn: (archive) => apiFetch('/api/jobs/' + id + (archive ? '/archive' : '/unarchive'), { method: 'POST' }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: jobKey(id) });
      void queryClient.invalidateQueries({ queryKey: ['jobs-board'] });
    },
  });
}

/**
 * Starts a new draft quote on the job (`POST /api/jobs/:id/quotes`, body `{}`). Resolves to the new
 * quote's id, and invalidates the job's view on success so the quote shows up in the list.
 */
export function useCreateQuote(id: string) {
  const queryClient = useQueryClient();
  return useMutation<{ id: string }, Error, void>({
    mutationFn: () => apiFetch<{ id: string }>('/api/jobs/' + id + '/quotes', { method: 'POST', body: {} }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: jobKey(id) }),
  });
}

/**
 * This job's proposals, newest first as the server returns them. `GET /api/proposals` has no job
 * filter, so every page is read and then narrowed to the job here.
 */
export function useJobProposals(jobId: string) {
  return useQuery<ProposalList, Error, ProposalView[]>({
    queryKey: ['job', jobId, 'proposals'],
    queryFn: async ({ signal }) => {
      const all: ProposalView[] = [];
      let total = Infinity;
      while (all.length < total) {
        const path = all.length === 0 ? '/api/proposals' : '/api/proposals?offset=' + all.length;
        const page = await apiFetch<ProposalList>(path, { signal });
        total = page.total;
        if (page.proposals.length === 0) break;
        all.push(...page.proposals);
      }
      return { proposals: all, total: all.length };
    },
    select: (list) => list.proposals.filter((proposal) => proposal.jobId === jobId),
  });
}
