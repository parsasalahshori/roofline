import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { ApiError, apiFetch } from './client.ts';
import { keys } from './keys.ts';
import type { Account, SignInResult } from './types.ts';

/*
 * The hooks every screen shares. Later tasks add theirs to this file, beside the query keys they use.
 */

/** Who is signed in. A 401 here means the session is gone, and `RequireSession` sends the person to sign in. */
export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: ({ signal }) => apiFetch<Account>('/api/auth/me', { signal }),
    // Many parts of a screen ask who this is; they should share one answer for a while, not one request each
    staleTime: 30_000,
  });
}

/**
 * Signs in with an email and a password. A wrong password is a 401 that belongs to the form, not
 * a lost session, so it does not send the person anywhere.
 */
export function useSignIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (credentials: { email: string; password: string }) =>
      apiFetch<SignInResult>('/api/auth/login', { method: 'POST', body: credentials, redirectOn401: false }),
    // Somebody else may have used this browser before, or this session may have ended: nothing from before is kept
    onSuccess: () => {
      queryClient.clear();
    },
  });
}

/** Ends the session, forgets everything that was loaded for it, and goes to the sign-in page. */
export function useSignOut() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async () => {
      try {
        await apiFetch<{ ok: true }>('/api/auth/logout', { method: 'POST', redirectOn401: false });
      } catch (error) {
        // A session that is already gone is what signing out was for
        if (!(error instanceof ApiError && error.status === 401)) throw error;
      }
    },
    onSuccess: () => {
      queryClient.clear();
      void navigate('/sign-in', { replace: true });
    },
  });
}

/**
 * Moves the session to another of the person's companies. The answer is the new account, so who
 * is signed in updates at once; everything else was loaded for the old company and is reloaded.
 */
export function useSwitchCompany() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (companyId: string) =>
      apiFetch<Account>('/api/auth/switch-company', { method: 'POST', body: { companyId } }),
    onSuccess: (account) => {
      queryClient.setQueryData(keys.me, account);
      return queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== keys.me[0] });
    },
  });
}
