import { useQuery } from '@tanstack/react-query';
import type { ConversationPage } from '@roofline/shared';
import { apiFetch } from '../../api/client.ts';
import { IDLE_POLL_MS } from './inbox-api.ts';

/** The dock badge's query key. Anything that changes a conversation invalidates it. */
export const UNREAD_COUNT_KEY = ['front-desk', 'unread-count'] as const;

/** Conversations that need a person: unread, or flagged. Zero while loading or on error. */
export function useFrontDeskUnread(): number {
  const { data } = useQuery({
    queryKey: UNREAD_COUNT_KEY,
    queryFn: ({ signal }) => apiFetch<ConversationPage>('/api/conversations?filter=needs_attention', { signal }),
    refetchInterval: IDLE_POLL_MS,
    refetchIntervalInBackground: false,
  });
  return (data?.items ?? []).filter((row) => row.unreadCount > 0 || row.needsAttention).length;
}
export { useConversations, useDayStats, useWeekStats, inboxPollInterval, LIVE_POLL_MS, IDLE_POLL_MS } from './inbox-api.ts';
