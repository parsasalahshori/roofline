import type {
  BackofficeOrder,
  BackofficeQuote,
  BackofficeSettings,
  OrderStageMove,
  ProductCatalog,
} from '@roofline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';

export const boKeys = {
  catalog: ['backoffice', 'catalog'] as const,
  settings: ['backoffice', 'settings'] as const,
  quotes: ['backoffice', 'quotes'] as const,
  orders: ['backoffice', 'orders'] as const,
  order: (id: string) => ['backoffice', 'order', id] as const,
  jobs: ['backoffice', 'jobs'] as const,
};

/** A quote as the list shows it: the fields the Home page needs. The full quote has more. */
export type QuoteRow = Pick<BackofficeQuote, 'id' | 'jobId' | 'customerName' | 'address' | 'status' | 'tier' | 'updatedAt'> &
  Partial<Pick<BackofficeQuote, 'totals'>>;

/** The server answers a list as the array itself or as `{ key: [...] }`; accept both. */
function listOf<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[];
  const inner = (body as Record<string, unknown> | null)?.[key];
  return Array.isArray(inner) ? (inner as T[]) : [];
}

function orderOf(body: unknown): BackofficeOrder {
  const inner = (body as { order?: BackofficeOrder } | null)?.order;
  return inner ?? (body as BackofficeOrder);
}

export function useCatalog() {
  return useQuery({
    queryKey: boKeys.catalog,
    queryFn: ({ signal }) => apiFetch<ProductCatalog>('/api/backoffice/catalog', { signal }),
  });
}

/** One PUT saves the whole price book; the answer (with the new version) replaces the cache. */
export function useSaveCatalog() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (catalog: ProductCatalog) => apiFetch<ProductCatalog>('/api/backoffice/catalog', { method: 'PUT', body: catalog }),
    onSuccess: (saved) => queryClient.setQueryData(boKeys.catalog, saved),
  });
}

export function useBackofficeSettings() {
  return useQuery({
    queryKey: boKeys.settings,
    queryFn: ({ signal }) => apiFetch<BackofficeSettings>('/api/backoffice/settings', { signal }),
  });
}

export function useSaveBackofficeSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: BackofficeSettings) => apiFetch<BackofficeSettings>('/api/backoffice/settings', { method: 'PUT', body: settings }),
    onSuccess: (saved) => queryClient.setQueryData(boKeys.settings, saved),
  });
}

export function useQuotes() {
  return useQuery({
    queryKey: boKeys.quotes,
    queryFn: async ({ signal }) => listOf<QuoteRow>(await apiFetch<unknown>('/api/backoffice/quotes', { signal }), 'quotes'),
  });
}

/** What starting a quote gives back: its id, and (when it started from measured sizes) how many windows came in and how many were left out. */
export type CreatedQuote = { id: string; measured?: { kept: number; skipped: number } };

/** Starts a quote from a job, optionally from the sizes measured at the job's address; the answer carries the new quote's id. */
export function useCreateQuote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { jobId: string; importMeasured: boolean }): Promise<CreatedQuote> => {
      const body = await apiFetch<{ id?: string; quote?: { id: string }; designs?: unknown[]; skippedMeasured?: number }>('/api/backoffice/quotes', {
        method: 'POST',
        body: input.importMeasured ? { jobId: input.jobId, importMeasured: true } : { jobId: input.jobId },
      });
      const id = body.quote?.id ?? body.id;
      if (!id) throw new Error('No quote id');
      return { id, ...(input.importMeasured && { measured: { kept: body.designs?.length ?? 0, skipped: body.skippedMeasured ?? 0 } }) };
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: boKeys.quotes }),
  });
}

export function useOrders() {
  return useQuery({
    queryKey: boKeys.orders,
    queryFn: async ({ signal }) => listOf<BackofficeOrder>(await apiFetch<unknown>('/api/backoffice/orders', { signal }), 'orders'),
  });
}

export function useOrder(id: string) {
  return useQuery({
    queryKey: boKeys.order(id),
    queryFn: async ({ signal }) => orderOf(await apiFetch<unknown>('/api/backoffice/orders/' + id, { signal })),
  });
}

/** Moves an order to a stage. The order and the board refresh after it. */
export function useMoveOrder(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (move: OrderStageMove) => orderOf(await apiFetch<unknown>('/api/backoffice/orders/' + id + '/stage', { method: 'PATCH', body: move })),
    onSuccess: (order) => {
      queryClient.setQueryData(boKeys.order(id), order);
      void queryClient.invalidateQueries({ queryKey: boKeys.orders });
    },
  });
}

/** The jobs a new quote can start from: every card on the Jobs board. */
export type JobChoice = { id: string; customerName: string; addressLine: string };

export function useJobChoices(enabled: boolean) {
  return useQuery({
    queryKey: boKeys.jobs,
    enabled,
    queryFn: async ({ signal }): Promise<JobChoice[]> => {
      const board = await apiFetch<{ columns: { jobs: JobChoice[] }[] }>('/api/jobs/board', { signal });
      return board.columns.flatMap((column) => column.jobs.map((job) => ({ id: job.id, customerName: job.customerName, addressLine: job.addressLine })));
    },
  });
}
