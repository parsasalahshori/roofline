import type { ConsentStatus, CustomerSource, CustomerView } from '@roofline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';

/** Hooks behind the Customers list and the customer window. Shared by every package of Task 21; do not change signatures. */

/** One row of `GET /api/customers` (the F1 shape: no city, no jobs count). */
export type CustomerListItem = {
  id: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  phones: { number: string; label: string | null; primary: boolean }[];
  emails: string[];
  tags: string[];
  doNotContact: boolean;
  smsConsent: { status: ConsentStatus; source: string | null; at: string | null };
  source: CustomerSource;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type CustomerListPage = { customers: CustomerListItem[]; total: number };

/** Rows per page of the customers list. */
export const PAGE_SIZE = 50;

export const customerKeys = {
  all: ['customers'] as const,
  list: (params: { q: string; archived: boolean; offset: number }) => ['customers', 'list', params] as const,
  view: (id: string) => ['customers', 'view', id] as const,
};

export type CustomersParams = { q: string; archived: boolean; offset: number };

/** `GET /api/customers?q=&limit=50&offset=&includeArchived=true` (the last only when `archived`). Already sorted by name. */
export function useCustomers({ q, archived, offset }: CustomersParams) {
  const term = q.trim();
  return useQuery({
    queryKey: customerKeys.list({ q: term, archived, offset }),
    queryFn: ({ signal }) => {
      const query = new URLSearchParams();
      if (term !== '') query.set('q', term);
      query.set('limit', String(PAGE_SIZE));
      query.set('offset', String(offset));
      if (archived) query.set('includeArchived', 'true');
      return apiFetch<CustomerListPage>(`/api/customers?${query.toString()}`, { signal });
    },
    placeholderData: (previous) => previous,
  });
}

/** `GET /api/customers/:id/view`. */
export function useCustomerView(id: string) {
  return useQuery({
    queryKey: customerKeys.view(id),
    queryFn: ({ signal }) => apiFetch<CustomerView>(`/api/customers/${encodeURIComponent(id)}/view`, { signal }),
  });
}

/** What `PATCH /api/customers/:id` takes. Phone numbers may be typed any way; the server turns them into E.164. */
export type CustomerPatch = {
  displayName?: string;
  firstName?: string | null;
  lastName?: string | null;
  phones?: { number: string; label?: string; primary?: boolean }[];
  emails?: string[];
  tags?: string[];
  /** Owner and office only (a rep gets 403). 'attested' is refused by the server. */
  smsConsentStatus?: ConsentStatus;
  /** Only together with smsConsentStatus 'written'. */
  consentNote?: string;
  doNotContact?: boolean;
};

/** `PATCH /api/customers/:id`; refreshes the customer's view and every list. A duplicate phone is a 409 ApiError with field `phones.<index>.number`. */
export function useUpdateCustomer(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: CustomerPatch) => apiFetch<unknown>(`/api/customers/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: customerKeys.all });
      void queryClient.invalidateQueries({ queryKey: ['timeline'] });
    },
  });
}

/** `POST /api/customers/:id/archive` for `true`, `/unarchive` for `false`; refreshes the view and lists. */
export function useArchiveCustomer(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (archive: boolean) =>
      apiFetch<unknown>(`/api/customers/${encodeURIComponent(id)}/${archive ? 'archive' : 'unarchive'}`, { method: 'POST' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: customerKeys.all }),
  });
}

/** `POST /api/properties/:id/locate` with the property id as the variable; refreshes customer views. */
export function useLocateProperty() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (propertyId: string) => apiFetch<unknown>(`/api/properties/${encodeURIComponent(propertyId)}/locate`, { method: 'POST' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: customerKeys.all }),
  });
}
