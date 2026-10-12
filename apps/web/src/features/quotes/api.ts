import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QuoteView } from '@roofline/shared';
import { ApiError, apiFetch } from '../../api/client.ts';
import { useToast } from '@roofline/ui';
import { quotes } from '../../copy/quotes.ts';
import type { SaveQuoteBody } from './draft.ts';

/** Query keys of the quote feature. */
export const quotesKeys = {
  one: (id: string) => ['quote', id] as const,
};

/** The PDF of a quote (served by the API; always available, also for drafts). */
export const quotePdfHref = (id: string): string => `/api/quotes/${id}/pdf`;

/** One quote with its frozen prices, scope and calculation. */
export function useQuote(id: string) {
  return useQuery<QuoteView>({
    queryKey: quotesKeys.one(id),
    queryFn: ({ signal }) => apiFetch<QuoteView>(`/api/quotes/${id}`, { signal }),
  });
}

/** Saves a draft (`PATCH /api/quotes/:id`). The answer is the updated quote, which replaces the cached one. */
export function useSaveQuote(id: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation<QuoteView, Error, SaveQuoteBody>({
    mutationFn: (body) => apiFetch<QuoteView>(`/api/quotes/${id}`, { method: 'PATCH', body }),
    onSuccess: (view) => {
      queryClient.setQueryData(quotesKeys.one(id), view);
      toast.show(quotes.saved, 'success');
    },
    onError: (error) => {
      toast.show(error instanceof ApiError ? error.message : quotes.saveFailed, 'error');
    },
  });
}

/** Marks a quote final (`POST /api/quotes/:id/finalize`). The quote is frozen from then on. */
export function useFinalizeQuote(id: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation<QuoteView, Error, void>({
    mutationFn: () => apiFetch<QuoteView>(`/api/quotes/${id}/finalize`, { method: 'POST' }),
    onSuccess: (view) => {
      queryClient.setQueryData(quotesKeys.one(id), view);
      toast.show(quotes.finalized, 'success');
    },
    onError: (error) => {
      toast.show(error instanceof ApiError ? error.message : quotes.finalizeFailed, 'error');
    },
  });
}

/**
 * Copies a quote to a new draft (`POST /api/quotes/:id/copy`, 201). The new quote is cached under
 * its own id; the caller navigates to it.
 */
export function useCopyQuote(id: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation<QuoteView, Error, void>({
    mutationFn: () => apiFetch<QuoteView>(`/api/quotes/${id}/copy`, { method: 'POST' }),
    onSuccess: (view) => {
      queryClient.setQueryData(quotesKeys.one(view.id), view);
    },
    onError: (error) => {
      toast.show(error instanceof ApiError ? error.message : quotes.copyFailed, 'error');
    },
  });
}
