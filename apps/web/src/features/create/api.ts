import type { JobSource, JobStage } from '@roofline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';

/** Hooks behind New customer, New job and Add a home. Shared by every package of Task 22; do not change signatures. */

export type PhoneInput = { number: string; label?: string; primary?: boolean };
export type CustomerInput = {
  displayName: string;
  firstName?: string;
  lastName?: string;
  phones?: PhoneInput[];
  emails?: string[];
  /** 'express' when the texting checkbox is ticked. */
  smsConsentStatus?: 'express';
};
export type CustomerRecord = { id: string; displayName: string; firstName: string | null; lastName: string | null };
export type PropertyInput = { customerId: string; addressLine: string; city: string; state: string; zip: string };
/** lat/lng null means the server could not place the home on the map. */
export type PropertyRecord = { id: string; customerId: string | null; addressLine: string; city: string; state: string; zip: string; lat: number | null; lng: number | null };
export type JobInput = { customerId: string; propertyId: string; stage?: JobStage; source?: JobSource; valueCents?: number; assignedUserId?: string };
export type JobRecord = { id: string };

const createKey = ['create'] as const;

export function useCreateCustomer() {
  return useMutation({
    mutationFn: (input: CustomerInput) => apiFetch<CustomerRecord>('/api/customers', { method: 'POST', body: input }),
  });
}

/** No lat/lng is sent: the server geocodes. */
export function useCreateProperty() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PropertyInput) => apiFetch<PropertyRecord>('/api/properties', { method: 'POST', body: input }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: createKey }),
  });
}

export function useCreateJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: JobInput) => apiFetch<JobRecord>('/api/jobs', { method: 'POST', body: input }),
    onSuccess: () => {
      // The shell map remains mounted while creating a job; refresh it and cached lists/search.
      for (const key of ['pins', 'jobs-board', 'customers', 'search']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

/** `GET /api/customers?q=<q>&limit=8`; idle while q is empty. */
export function useCustomerSearch(q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: [...createKey, 'customers', term],
    enabled: term !== '',
    queryFn: ({ signal }) =>
      apiFetch<{ customers: CustomerRecord[]; total: number }>(`/api/customers?q=${encodeURIComponent(term)}&limit=8`, { signal }),
  });
}

/** `GET /api/properties?customerId=<id>`; idle while customerId is null. */
export function useCustomerHomes(customerId: string | null) {
  return useQuery({
    queryKey: [...createKey, 'homes', customerId],
    enabled: customerId !== null,
    queryFn: ({ signal }) =>
      apiFetch<{ properties: PropertyRecord[]; total: number }>(`/api/properties?customerId=${customerId ?? ''}`, { signal }),
  });
}
