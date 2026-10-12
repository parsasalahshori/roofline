import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { TimelineItem, TimelinePage } from '@roofline/shared';
import { apiFetch } from '../../api/client.ts';

export type TimelineSubject = { customerId?: string; jobId?: string };

export const timelineKeys = {
  list: (s: TimelineSubject) => ['timeline', s] as const,
};

/** The query string that names the subject: `customerId=` or `jobId=`. */
function subjectParam(subject: TimelineSubject): string {
  return subject.jobId !== undefined ? `jobId=${encodeURIComponent(subject.jobId)}` : `customerId=${encodeURIComponent(subject.customerId ?? '')}`;
}

/** Newest first. Each page holds the `nextBefore` cursor for the page older than it. */
export function useTimeline(subject: TimelineSubject) {
  return useInfiniteQuery<TimelinePage, Error, InfiniteData<TimelinePage, string | null>, ReturnType<typeof timelineKeys.list>, string | null>({
    queryKey: timelineKeys.list(subject),
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) => {
      const before = typeof pageParam === 'string' ? `&before=${encodeURIComponent(pageParam)}` : '';
      return apiFetch<TimelinePage>(`/api/timeline?${subjectParam(subject)}${before}`, { signal });
    },
    getNextPageParam: (last) => last.nextBefore,
  });
}

export type AddNoteInput = { subjectType: 'customer' | 'job'; subjectId: string; body: string };

/**
 * Posts a note on the subject and puts the saved item at the top of the first page of the cached
 * timeline. With nothing cached for the subject, the timeline is refetched instead.
 */
export function useAddNote(subject: TimelineSubject) {
  const queryClient = useQueryClient();
  const key = timelineKeys.list(subject);
  return useMutation<TimelineItem, Error, AddNoteInput>({
    mutationFn: (input) => apiFetch<TimelineItem>('/api/notes', { method: 'POST', body: input }),
    onSuccess: (item) => {
      const cached = queryClient.getQueryData<InfiniteData<TimelinePage, string | null>>(key);
      if (cached === undefined || cached.pages.length === 0) {
        void queryClient.invalidateQueries({ queryKey: key });
        return;
      }
      queryClient.setQueryData<InfiniteData<TimelinePage, string | null>>(key, {
        ...cached,
        pages: cached.pages.map((page, index) => (index === 0 ? { ...page, items: [item, ...page.items] } : page)),
      });
    },
  });
}
