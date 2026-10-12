import type { ConversationDetail, HandlingInput, RecordingLink, ReplyInput } from '@roofline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';

/** Query key for one conversation. Local to this file (keys.ts is not ours). */
export const conversationKey = (id: string) => ['front-desk', 'conversation', id] as const;

/** GET /api/conversations/:id. */
export function useConversation(id: string) {
  return useQuery({
    queryKey: conversationKey(id),
    queryFn: ({ signal }) => apiFetch<ConversationDetail>(`/api/conversations/${id}`, { signal }),
  });
}

/** POST /api/conversations/:id/read. Call once when the conversation opens. */
export function useMarkRead(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<unknown>(`/api/conversations/${id}/read`, { method: 'POST', body: {} }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['front-desk'] }),
  });
}

/** POST /api/conversations/:id/reply {body}. A send-gate error is an ApiError whose message is a plain sentence. */
export function useSendReply(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ReplyInput) => apiFetch<unknown>(`/api/conversations/${id}/reply`, { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: conversationKey(id) }),
  });
}

/** POST /api/conversations/:id/handling {by}. */
export function useSetHandling(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: HandlingInput) => apiFetch<unknown>(`/api/conversations/${id}/handling`, { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['front-desk'] }),
  });
}

/** POST /api/calls/:id/spam. */
export function useMarkSpam(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (callId: string) => apiFetch<unknown>(`/api/calls/${callId}/spam`, { method: 'POST', body: {} }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['front-desk'] }),
    meta: { conversationId },
  });
}

/** GET /api/calls/:id/recording: call `mutateAsync(callId)` only when the person presses play. Never a query. */
export function useRecordingLink() {
  return useMutation({
    mutationFn: (callId: string) => apiFetch<RecordingLink>(`/api/calls/${callId}/recording`),
  });
}
