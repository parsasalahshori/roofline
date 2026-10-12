import type { AppointmentView, CalendarConnectionView } from '@roofline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';
import type { AppointmentBody, AvailabilityQuery, SaveResult, Slot } from './types.ts';

/*
 * Appointment hooks. Every save or action invalidates the ['calendar'] prefix, which matches the
 * calendar keys in features/calendar/api.ts (['calendar', 'appointments', ...]), plus the
 * ['appointments'] prefix (this feature's own keys) and ['jobs'] (a job may have moved).
 */

/** Keys of this feature. The single appointment is ['appointments', 'one', id]. */
const oneKey = (id: string) => ['appointments', 'one', id] as const;

/** Refreshes what a save or an action can have made stale. */
function invalidateAfterChange(queryClient: ReturnType<typeof useQueryClient>): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['calendar'] }),
    queryClient.invalidateQueries({ queryKey: ['appointments'] }),
    queryClient.invalidateQueries({ queryKey: ['jobs'] }),
  ]);
}

/** GET /api/appointments/:id -> AppointmentView. queryKey ['appointments','one',id]. */
export function useAppointment(id: string | undefined): { data: AppointmentView | undefined; isPending: boolean; isError: boolean } {
  return useQuery({
    queryKey: id === undefined ? ['appointments', 'one', ''] : oneKey(id),
    queryFn: ({ signal }) => apiFetch<AppointmentView>(`/api/appointments/${encodeURIComponent(id ?? '')}`, { signal }),
    enabled: id !== undefined && id !== '',
  });
}

/** POST /api/appointments -> SaveResult. Invalidates ['calendar'], ['appointments'] and ['jobs']. */
export function useCreateAppointment(): { mutateAsync: (body: AppointmentBody) => Promise<SaveResult>; isPending: boolean } {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AppointmentBody) => apiFetch<SaveResult>('/api/appointments', { method: 'POST', body }),
    onSuccess: async (saved) => {
      if (saved.appointment) queryClient.setQueryData(oneKey(saved.appointment.id), saved.appointment);
      await invalidateAfterChange(queryClient);
    },
  });
}

/** PATCH /api/appointments/:id -> SaveResult (also used for the "Try again" no-op re-save with body {}). */
export function useUpdateAppointment(id: string): { mutateAsync: (body: Partial<AppointmentBody>) => Promise<SaveResult>; isPending: boolean } {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<AppointmentBody>) =>
      apiFetch<SaveResult>(`/api/appointments/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    onSuccess: async (saved) => {
      if (saved.appointment) queryClient.setQueryData(oneKey(id), saved.appointment);
      await invalidateAfterChange(queryClient);
    },
  });
}

/** POST /api/appointments/:id/{cancel|complete|no-show} -> AppointmentView. */
export function useAppointmentAction(id: string): { mutateAsync: (action: 'cancel' | 'complete' | 'no-show') => Promise<AppointmentView>; isPending: boolean } {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: 'cancel' | 'complete' | 'no-show') =>
      apiFetch<AppointmentView>(`/api/appointments/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} }),
    onSuccess: async (appointment) => {
      queryClient.setQueryData(oneKey(id), appointment);
      await invalidateAfterChange(queryClient);
    },
  });
}

/**
 * GET /api/calendar/availability?kind&from&to[&userId][&propertyId] -> { slots }, sorted by start.
 * Installs have no suggested times, so the query is skipped for them.
 */
export function useAvailability({
  kind,
  from,
  to,
  userId,
  propertyId,
  enabled = true,
}: AvailabilityQuery & { enabled?: boolean }): { data: { slots: Slot[] } | undefined; isPending: boolean; isError: boolean } {
  let url = `/api/calendar/availability?kind=${kind}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  if (userId !== undefined) url += `&userId=${encodeURIComponent(userId)}`;
  if (propertyId !== undefined) url += `&propertyId=${encodeURIComponent(propertyId)}`;
  return useQuery({
    queryKey: ['appointments', 'availability', kind, from, to, userId ?? null, propertyId ?? null],
    queryFn: ({ signal }) => apiFetch<{ slots: Slot[] }>(url, { signal }),
    enabled: enabled && kind !== 'install',
  });
}

/**
 * GET /api/calendar/connection -> CalendarConnectionView. Used only for the provider word of the
 * sync line. A failed read is not retried and reads as no provider (the sync line is then left out).
 */
export function useCalendarProvider(): 'google' | 'microsoft' | null {
  const query = useQuery({
    queryKey: ['calendar', 'connection'],
    queryFn: ({ signal }) => apiFetch<CalendarConnectionView>('/api/calendar/connection', { signal }),
    retry: false,
  });
  return query.data?.provider ?? null;
}
