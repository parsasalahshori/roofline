import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';

export type AuthConfig = { googleClientId: string | null };
export type CompanyDetails = { companyName: string; companyPhone: string; companyAddress: string };
export type SignUpBody = { name: string; email: string; password: string } & CompanyDetails;
/** First Google call sends only `credential`; after a 400 on `companyName` it also sends the company fields. */
export type GoogleBody = { credential: string } & Partial<CompanyDetails>;

/** Whether Google sign-in is set up (a client id) or not (null). Never changes during a page's life. */
export function useAuthConfig() {
  return useQuery({
    queryKey: ['auth-config'],
    queryFn: () => apiFetch<AuthConfig>('/api/auth/config', { redirectOn401: false }),
    staleTime: Infinity,
  });
}

/** Creates the account and company. The page navigates afterwards. */
export function useSignUp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SignUpBody) => apiFetch<unknown>('/api/auth/signup', { method: 'POST', body, redirectOn401: false }),
    onSuccess: () => {
      queryClient.clear();
    },
  });
}

/** Signs in (or, with company details, signs up) with a Google credential. The page navigates afterwards. */
export function useGoogleSignIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: GoogleBody) => apiFetch<unknown>('/api/auth/google', { method: 'POST', body, redirectOn401: false }),
    onSuccess: () => {
      queryClient.clear();
    },
  });
}
