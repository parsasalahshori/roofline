import type { ConversationDetail, HandlingInput, ReplyInput, ReplyResult } from '@roofline/shared';
import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';
import { IDLE_POLL_MS, LIVE_POLL_MS } from './inbox-api.ts';

/** Query key for one conversation. Local to this file (keys.ts is not ours). */
export const conversationKey = (id: string) => ['front-desk', 'conversation', id] as const;

/**
 * Refresh what an inbox change touches: the lists, open conversations, the week stats and the dock badge.
 * Never the whole ['front-desk'] tree, which would also refetch settings and voices.
 */
export function invalidateInbox(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['front-desk', 'conversations'] }),
    queryClient.invalidateQueries({ queryKey: ['front-desk', 'conversation'] }),
    queryClient.invalidateQueries({ queryKey: ['front-desk', 'stats'] }),
    queryClient.invalidateQueries({ queryKey: ['front-desk', 'unread-count'] }),
  ]);
}

/** A call still in progress: the open conversation is polled faster while one is. */
const LIVE_CALL_STATUSES: ReadonlySet<string> = new Set(['ringing', 'ai', 'ringing_team']);

/** The `refetchInterval` for an open conversation: LIVE_POLL_MS while one of its calls is live, else IDLE_POLL_MS (as the inbox). */
export function conversationPollInterval(conversation: ConversationDetail | undefined): number {
  return conversation?.calls.some((call) => LIVE_CALL_STATUSES.has(call.status)) ? LIVE_POLL_MS : IDLE_POLL_MS;
}

/**
 * GET /api/conversations/:id. Asked for again like the inbox (5 s while a call is live, else 30 s), so
 * new texts and replies show up without a reload. Background polling is off.
 */
export function useConversation(id: string | undefined) {
  return useQuery({
    queryKey: conversationKey(id ?? ''),
    queryFn: ({ signal }) => apiFetch<ConversationDetail>(`/api/conversations/${id}`, { signal }),
    enabled: id !== undefined && id !== '',
    refetchInterval: (query) => conversationPollInterval(query.state.data),
    refetchIntervalInBackground: false,
  });
}

/** POST /api/conversations/:id/read. Call once when the conversation opens. */
export function useMarkRead(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<unknown>(`/api/conversations/${id}/read`, { method: 'POST', body: {} }),
    onSuccess: () => invalidateInbox(queryClient),
  });
}

/** Sends the read receipt once for each conversation that opens, even when the effect runs twice (StrictMode). */
export function useMarkReadOnOpen(id: string) {
  const { mutate } = useMarkRead(id);
  const markedId = useRef<string | null>(null);
  useEffect(() => {
    if (id === '' || markedId.current === id) return;
    markedId.current = id;
    mutate();
  }, [id, mutate]);
}

/**
 * POST /api/conversations/:id/reply {body}: `ReplyResult` when it was sent or scheduled. A reply the
 * send gate blocked, or that could not be sent, is an ApiError (422) whose message is a plain sentence.
 */
export function useSendReply(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ReplyInput) => apiFetch<ReplyResult>(`/api/conversations/${id}/reply`, { method: 'POST', body: input }),
    onSuccess: () => Promise.all([queryClient.invalidateQueries({ queryKey: conversationKey(id) }), invalidateInbox(queryClient)]),
  });
}

/** POST /api/conversations/:id/handling {by}. */
export function useSetHandling(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: HandlingInput) => apiFetch<unknown>(`/api/conversations/${id}/handling`, { method: 'POST', body: input }),
    onSuccess: () => invalidateInbox(queryClient),
  });
}

/** POST /api/calls/:id/spam. */
export function useMarkSpam(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (callId: string) => apiFetch<unknown>(`/api/calls/${callId}/spam`, { method: 'POST', body: {} }),
    onSuccess: () => invalidateInbox(queryClient),
    meta: { conversationId },
  });
}
