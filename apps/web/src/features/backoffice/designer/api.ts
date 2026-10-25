import type { BackofficeQuote, ProductCatalog, QuoteDocument } from '@roofline/shared';
import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from '../../../api/client.ts';
import type { QuoteDraft } from './pricing.ts';

export const quoteKey = (id: string) => ['backoffice', 'quote', id] as const;
export const catalogKey = ['backoffice', 'catalog'] as const;

export const quotePath = (id: string) => `/api/backoffice/quotes/${encodeURIComponent(id)}`;

/** Where a document of the quote opens (a PDF). */
export const documentHref = (id: string, kind: QuoteDocument) => `${quotePath(id)}/documents/${encodeURIComponent(kind)}`;

/** GET /api/backoffice/quotes/:id. */
export function useBackofficeQuote(id: string): UseQueryResult<BackofficeQuote> {
  return useQuery({
    queryKey: quoteKey(id),
    queryFn: ({ signal }) => apiFetch<BackofficeQuote>(quotePath(id), { signal }),
    enabled: id !== '',
    // The editor holds the live draft; a refetch behind it must not move what the person is drawing
    refetchOnWindowFocus: false,
  });
}

/** GET /api/backoffice/catalog: the company's products, options, accessories and tier names. */
export function useBackofficeCatalog(): UseQueryResult<ProductCatalog> {
  return useQuery({
    queryKey: catalogKey,
    queryFn: ({ signal }) => apiFetch<ProductCatalog>('/api/backoffice/catalog', { signal }),
    staleTime: 60_000,
  });
}

/** PUT /api/backoffice/quotes/:id with what a person edits; the answer has the prices the server worked out. */
export function usePutQuote(id: string): UseMutationResult<BackofficeQuote, Error, QuoteDraft> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft) => apiFetch<BackofficeQuote>(quotePath(id), { method: 'PUT', body: draft }),
    onSuccess: (saved) => {
      // The server's prices, on what the person has now (they may have kept drawing while this was in flight)
      queryClient.setQueryData<BackofficeQuote>(quoteKey(id), (current) => (current ? { ...saved, ...pickDraft(current) } : saved));
    },
  });
}

export const pickDraft = (q: QuoteDraft): QuoteDraft => ({ status: q.status, tier: q.tier, designs: q.designs, accessories: q.accessories, discountPercent: q.discountPercent });
