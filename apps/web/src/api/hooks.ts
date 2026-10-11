import { useToast } from '@roofline/ui';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { ApiError, apiFetch } from './client.ts';
import { keys } from './keys.ts';
import type {
  Account,
  ApprovalsList,
  Bbox,
  CurrentWeather,
  MapArea,
  PinsResult,
  SearchResult,
  SignInResult,
  TaskView,
} from './types.ts';

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
 * is signed in updates at once. It goes home (the map), and everything else that was loaded for the
 * old company is reset, which drops its cached data (the old company's pins, search and drafts never
 * render again) and reloads the queries that are on screen. These run here, not in the caller, so
 * they still happen when the caller has gone (a menu closed before the switch was answered). A
 * failure is a toast for the same reason.
 */
export function useSwitchCompany() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  return useMutation({
    mutationFn: (companyId: string) =>
      apiFetch<Account>('/api/auth/switch-company', { method: 'POST', body: { companyId } }),
    onSuccess: (account) => {
      queryClient.setQueryData(keys.me, account);
      // Navigating first unmounts the old company's id-based pages, so the reset does not refetch them
      void navigate('/');
      return queryClient.resetQueries({ predicate: (query) => query.queryKey[0] !== keys.me[0] });
    },
    onError: (error) => toast.show(error.message, 'error'),
  });
}

/** The company's service area and the box that fits it. It changes rarely, so it is kept for a while. */
export function useMapArea() {
  return useQuery({
    queryKey: keys.mapArea,
    queryFn: ({ signal }) => apiFetch<MapArea>('/api/map/area', { signal }),
    staleTime: 5 * 60_000,
  });
}

/**
 * The pins inside a box on the map. With no box (the map has not told us its view yet) nothing is
 * asked. While the next box loads, the last answer stays, so the pins do not blink on every move.
 */
export function useMapPins(bbox: Bbox | null) {
  const bboxKey = bbox === null ? null : bbox.join(',');
  return useQuery({
    queryKey: keys.pins(bboxKey ?? ''),
    queryFn: ({ signal }) => apiFetch<PinsResult>(`/api/map/pins?bbox=${bboxKey}&layers=customers,jobs`, { signal }),
    enabled: bboxKey !== null,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

/** How often the shell's counts are asked for again, and the weather (the server caches it for as long). */
const COUNTS_EVERY = 30_000;
const WEATHER_EVERY = 30 * 60_000;

/** The plans the agents drafted. Asked again every 30 seconds and when the window is focused again. */
export function useApprovals() {
  return useQuery({
    queryKey: keys.approvals,
    queryFn: ({ signal }) => apiFetch<ApprovalsList>('/api/approvals', { signal }),
    refetchInterval: COUNTS_EVERY,
    refetchOnWindowFocus: true,
  });
}

/** How many tasks are running right now (`data.working`). Asked again every 30 seconds. */
export function useTasksSummary() {
  return useQuery({
    queryKey: keys.summary,
    queryFn: ({ signal }) => apiFetch<{ working: number }>('/api/tasks/summary', { signal }),
    refetchInterval: COUNTS_EVERY,
  });
}

/** How many tasks need attention: `data` is a number. Asked again every 30 seconds. */
export function useAttentionCount() {
  return useQuery({
    queryKey: keys.attention,
    queryFn: ({ signal }) => apiFetch<{ tasks: TaskView[] }>('/api/tasks?status=needs_attention&limit=200', { signal }),
    select: (result) => result.tasks.length,
    refetchInterval: COUNTS_EVERY,
  });
}

/** The weather at the company: `data.weather` is null when there is none. Asked again every 30 minutes. */
export function useWeather() {
  return useQuery({
    queryKey: keys.weather,
    queryFn: ({ signal }) => apiFetch<{ weather: CurrentWeather | null }>('/api/weather', { signal }),
    refetchInterval: WEATHER_EVERY,
    staleTime: WEATHER_EVERY,
  });
}

/**
 * Customers, jobs and addresses that match what was typed. `q` goes to the server exactly as
 * typed, encoded; nothing is asked until it has at least 2 characters (not counting spaces at
 * either end).
 */
export function useSearch(q: string) {
  return useQuery({
    queryKey: keys.search(q),
    queryFn: ({ signal }) => apiFetch<SearchResult>('/api/search?q=' + encodeURIComponent(q), { signal }),
    enabled: q.trim().length >= 2,
    staleTime: 30_000,
  });
}
