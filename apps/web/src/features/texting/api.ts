import type { BrandInfo, TextingView } from '@roofline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';
import { keys } from '../../api/keys.ts';

/** What the registration POST sends. */
export type RegistrationBody = { brand: BrandInfo; useHostedPolicyPages: boolean };

/** The company's texting registration: GET /api/texting. */
export function useTexting() {
  return useQuery({
    queryKey: keys.texting,
    queryFn: ({ signal }) => apiFetch<TextingView>('/api/texting', { signal }),
  });
}

/** Sends the registration (POST /api/texting/registration); the 202 answer replaces the cached view. */
export function useSubmitRegistration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RegistrationBody) =>
      apiFetch<TextingView>('/api/texting/registration', { method: 'POST', body }),
    onSuccess: (view) => {
      queryClient.setQueryData(keys.texting, view);
    },
  });
}
