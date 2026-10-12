import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';
import { keys } from '../../api/keys.ts';
import type { AdAccount, AdAccountsBody } from '../../api/types.ts';

/*
 * The ad accounts under Settings, Connections (S1 Task 27). The ad API itself is built later
 * (Task 16); these hooks follow the shapes in api/types.ts.
 */

/** How often the accounts are asked again while one waits for the person to accept it. */
const POLL_MS = 15_000;

/** Roofline's ad accounts, with its Google manager ID and Meta Business ID for the steps. */
export function useAdAccounts() {
  return useQuery({
    queryKey: keys.adAccounts,
    queryFn: ({ signal }) => apiFetch<AdAccountsBody>('/api/ads/accounts', { signal }),
    // Only while an account is pending: then the answer is checked again every 15 seconds
    refetchInterval: (query) =>
      query.state.data?.accounts.some((account) => account.status === 'pending') ? POLL_MS : false,
  });
}

/** Links a Google Ads customer (owner only). The ID is sent as typed; it may have dashes. */
export function useConnectGoogle() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (customerId: string) =>
      apiFetch<{ account: AdAccount; instructions: { managerId: string } }>('/api/ads/accounts/google', {
        method: 'POST',
        body: { customerId },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.adAccounts }),
  });
}

/** Links a Meta ad account (owner only). It may start with act_ or be just the digits. */
export function useConnectMeta() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (adAccountId: string) =>
      apiFetch<{ account: AdAccount }>('/api/ads/accounts/meta', { method: 'POST', body: { adAccountId } }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.adAccounts }),
  });
}

/** Asks the platform again whether the account is accepted yet (owner only). */
export function useCheckAdAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<AdAccount>('/api/ads/accounts/' + encodeURIComponent(id) + '/check', { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.adAccounts }),
  });
}

/** Removes an account from Roofline (owner only). The answer is the account, now revoked. */
export function useRemoveAdAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<AdAccount>('/api/ads/accounts/' + encodeURIComponent(id), { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.adAccounts }),
  });
}
