import type { BillingView } from '@roofline/shared';
import { useToast } from '@roofline/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import { billing } from '../../copy/billing.ts';

/** Where the browser leaves for Stripe. Tests spy on `go.assign`. */
export const go = { assign: (url: string) => window.location.assign(url) };

export const billingKey = ['billing'] as const;

/** The plan, usage and plans. Only the owner may read it, so nobody else asks. */
export function useBilling() {
  const me = useMe();
  return useQuery({
    queryKey: billingKey,
    queryFn: ({ signal }) => apiFetch<BillingView>('/api/billing', { signal }),
    enabled: me.data?.role === 'owner',
  });
}

/** Starts Stripe Checkout for a plan and follows the returned address. */
export function useCheckout() {
  return useMutation({
    mutationFn: (planKey: string) =>
      apiFetch<{ url: string }>('/api/billing/checkout', { method: 'POST', body: { planKey } }),
    onSuccess: ({ url }) => {
      go.assign(url);
    },
  });
}

/** Opens the Stripe customer portal (invoices, card) and follows the returned address. */
export function usePortal() {
  return useMutation({
    mutationFn: () => apiFetch<{ url: string }>('/api/billing/portal', { method: 'POST' }),
    onSuccess: ({ url }) => {
      go.assign(url);
    },
  });
}

/** Moves a subscribed company to another plan. */
export function useChangePlan() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (planKey: string) =>
      apiFetch<{ ok: true }>('/api/billing/plan', { method: 'POST', body: { planKey } }),
    onSuccess: () => {
      toast.show(billing.planChangeRequested);
      void queryClient.invalidateQueries({ queryKey: billingKey });
    },
  });
}
