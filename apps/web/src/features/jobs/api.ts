import { useMutation, useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { BOARD_STAGES, type BoardColumn, type BoardStage, type BoardView, type JobCard, type JobStage } from '@roofline/shared';
import { ApiError, apiFetch } from '../../api/client.ts';
import { jobs } from '../../copy/jobs.ts';
import { useToast } from '@roofline/ui';
import { useState } from 'react';

/** Query params of GET /api/jobs/board (all optional). */
export type BoardFilterParams = {
  assigned?: string; // 'me' | 'unassigned' | <user id>
  source?: string;
  q?: string;
  archived?: boolean;
};

export type MoveJobInput = { jobId: string; to: JobStage; valueCents?: number; lostReason?: string };

export const jobsKeys = {
  board: (f: BoardFilterParams) => ['jobs-board', f] as const,
  column: (stage: BoardStage, f: BoardFilterParams, offset: number) => ['jobs-board', 'column', stage, f, offset] as const,
};

/** The board's query string: only the params that have a value; `archived` only when true. */
function boardQuery(filter: BoardFilterParams, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  if (filter.assigned) params.set('assigned', filter.assigned);
  if (filter.source) params.set('source', filter.source);
  if (filter.q) params.set('q', filter.q);
  if (filter.archived === true) params.set('archived', 'true');
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  const text = params.toString();
  return text === '' ? '/api/jobs/board' : `/api/jobs/board?${text}`;
}

export function useBoard(filter: BoardFilterParams) {
  return useQuery<BoardView>({
    queryKey: jobsKeys.board(filter),
    queryFn: ({ signal }) => apiFetch<BoardView>(boardQuery(filter), { signal }),
  });
}

export function useBoardColumnPage(stage: BoardStage, filter: BoardFilterParams, offset: number, enabled = true) {
  return useQuery<BoardColumn>({
    queryKey: jobsKeys.column(stage, filter, offset),
    queryFn: ({ signal }) => apiFetch<BoardColumn>(boardQuery(filter, { stage, offset: String(offset) }), { signal }),
    enabled,
  });
}

/** Adds the jobs of a page that are not listed yet, keeping the order they came in. */
function appendUnique(listed: JobCard[], more: JobCard[]): JobCard[] {
  const seen = new Set(listed.map((job) => job.id));
  const added = more.filter((job) => {
    if (seen.has(job.id)) return false;
    seen.add(job.id);
    return true;
  });
  return added.length === 0 ? listed : [...listed, ...added];
}

/**
 * The jobs of one stage as loaded so far: the first page from the board plus the pages asked for
 * with 'Show N more', and how many are still left. `more` asks for the next page (or again, after a failed one).
 */
export function useColumnPages(column: BoardColumn, filter: BoardFilterParams) {
  // Pages after the first one, in the order the server sent them
  const [extra, setExtra] = useState<JobCard[]>([]);
  const [wantMore, setWantMore] = useState(false);
  // The last page already added to `extra`, so one page is never added twice
  const [applied, setApplied] = useState<BoardColumn | undefined>(undefined);
  // The column the loaded pages belong to; when the column changes, they are dropped
  const [shownFor, setShownFor] = useState(column);

  // The offset counts every row the column has loaded so far, first page and extra pages alike
  const offset = column.jobs.length + extra.length;
  const page = useBoardColumnPage(column.stage, filter, offset, wantMore);
  const pageData = page.data;

  // React Query keeps the same object when a refetch returns equal data, so this only fires on a real change
  if (shownFor !== column) {
    setShownFor(column);
    setExtra([]);
    setApplied(undefined);
    setWantMore(false);
  }

  // A page that has arrived is added while rendering (React's own pattern for state that follows state)
  if (wantMore && pageData !== undefined && pageData !== applied) {
    setApplied(pageData);
    setExtra((listed) => appendUnique(listed, pageData.jobs));
    setWantMore(false);
  }

  // A card listed by the first page is never shown twice; one that moved out of this stage is not shown
  const firstIds = new Set(column.jobs.map((job) => job.id));
  const visible = [...column.jobs, ...extra.filter((job) => job.stage === column.stage && !firstIds.has(job.id))];
  const remaining = column.count - visible.length;

  const more = () => {
    // A page that failed is asked for again; the next press after that starts a new page
    if (wantMore) void page.refetch();
    else setWantMore(true);
  };

  return { visible, remaining, busy: wantMore && page.isFetching, more };
}

/** A card loaded into any cached column page (the first page or a 'Show N more' page). */
export function findCachedColumnJob(queryClient: QueryClient, jobId: string): JobCard | undefined {
  for (const [, data] of queryClient.getQueriesData<BoardColumn>({ queryKey: ['jobs-board', 'column'] })) {
    const job = data?.jobs.find((candidate) => candidate.id === jobId);
    if (job !== undefined) return job;
  }
  return undefined;
}

const isBoardStage = (stage: JobStage): stage is BoardStage => (BOARD_STAGES as readonly JobStage[]).includes(stage);

const isBoardView = (data: unknown): data is BoardView =>
  typeof data === 'object' && data !== null && 'columns' in data && 'lost' in data;

/**
 * The board as it will look once the job has moved: the card leaves its column (counts and totals
 * follow), joins the top of the destination column when that is a board stage, and Lost counts up.
 * A job that is not on this board (the Lost drawer, another filter) leaves the board unchanged.
 */
export function applyMove(view: BoardView, { jobId, to, valueCents }: MoveJobInput): BoardView {
  const source = view.columns.flatMap((column) => column.jobs).find((job) => job.id === jobId);
  if (source === undefined) return view;

  const moved: JobCard = {
    ...source,
    stage: to,
    daysInStage: 0,
    stuck: false,
    ...(valueCents !== undefined && { valueCents }),
  };

  const columns = view.columns.map((column) => {
    let next = column;
    const held = column.jobs.find((job) => job.id === jobId);
    if (held !== undefined) {
      next = {
        ...next,
        count: next.count - 1,
        totalCents:
          next.totalCents !== null && held.valueCents !== null ? next.totalCents - held.valueCents : next.totalCents,
        jobs: next.jobs.filter((job) => job.id !== jobId),
      };
    }
    if (isBoardStage(to) && column.stage === to) {
      next = {
        ...next,
        count: next.count + 1,
        totalCents:
          next.totalCents !== null && moved.valueCents !== null ? next.totalCents + moved.valueCents : next.totalCents,
        jobs: [moved, ...next.jobs],
      };
    }
    return next;
  });

  return {
    ...view,
    columns,
    lost: to === 'lost' ? { count: view.lost.count + 1 } : view.lost,
  };
}

type MoveContext = { snapshots: Array<[QueryKey, unknown]> };

/**
 * Moves a job to another stage (`PATCH /api/jobs/:id`). Every cached board moves the card at once;
 * a refusal puts every board back and says why in a toast. The boards and the job are asked for
 * again when it settles.
 */
export function useMoveJob() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation<unknown, Error, MoveJobInput, MoveContext>({
    mutationFn: ({ jobId, to, valueCents, lostReason }) =>
      apiFetch('/api/jobs/' + jobId, {
        method: 'PATCH',
        body: {
          stage: to,
          ...(valueCents !== undefined && { valueCents }),
          ...(lostReason !== undefined && { lostReason }),
        },
      }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: ['jobs-board'] });
      const snapshots = queryClient.getQueriesData<unknown>({ queryKey: ['jobs-board'] });
      for (const [key, data] of snapshots) {
        if (isBoardView(data)) queryClient.setQueryData<BoardView>(key, applyMove(data, input));
      }
      return { snapshots };
    },
    onError: (error, _input, context) => {
      for (const [key, data] of context?.snapshots ?? []) {
        if (data !== undefined) queryClient.setQueryData(key, data);
      }
      toast.show(error instanceof ApiError ? error.message : jobs.moveFailed, 'error');
    },
    onSettled: (_data, _error, input) => {
      void queryClient.invalidateQueries({ queryKey: ['jobs-board'] });
      void queryClient.invalidateQueries({ queryKey: ['job', input.jobId] });
      void queryClient.invalidateQueries({ queryKey: ['timeline'] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}
