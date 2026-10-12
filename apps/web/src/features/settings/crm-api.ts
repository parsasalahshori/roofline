import type {
  CalendarConnectionView,
  PricebookView,
  QuoteDefaults,
  Pricebook,
  ScheduleSettings,
  WorkHours,
} from '@roofline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';
import { setupKey } from '../setup/api.ts';

/*
 * The hooks behind Settings Prices, Schedule and Your calendar (C1 Task 25). Query keys are local to
 * this feature. Shared by the three tabs, so no tab file defines its own query.
 */

export const crmKeys = {
  pricebook: ['crm', 'pricebook'] as const,
  schedule: ['crm', 'schedule'] as const,
  myHours: ['crm', 'my-hours'] as const,
  connection: ['crm', 'calendar-connection'] as const,
  calendars: ['crm', 'calendar-connection', 'calendars'] as const,
};

/** A calendar the person can write to, as `GET /api/calendar/connection/calendars` lists it. */
export type ExternalCalendar = { id: string; name: string; primary?: boolean };

/** The person's own weekly hours: `custom` is false when they follow the company's hours. */
export type MyHours = { workHours: WorkHours; custom: boolean };

/** `PUT /api/pricebook` body. */
export type PricebookSave = { prices: Pricebook; defaults: QuoteDefaults };

/** The price list and quote defaults. Owner and office; a rep gets a 403. */
export function usePricebook() {
  return useQuery({
    queryKey: crmKeys.pricebook,
    queryFn: ({ signal }) => apiFetch<PricebookView>('/api/pricebook', { signal }),
  });
}

/** Saves the whole pricebook (owner only); the answer replaces what was loaded. */
export function useSavePricebook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PricebookSave) => apiFetch<PricebookView>('/api/pricebook', { method: 'PUT', body }),
    onSuccess: (view) => queryClient.setQueryData(crmKeys.pricebook, view),
  });
}

/** The company's work hours, travel buffer, minimum notice and stuck days. Any member reads them. */
export function useScheduleSettings() {
  return useQuery({
    queryKey: crmKeys.schedule,
    queryFn: ({ signal }) => apiFetch<ScheduleSettings>('/api/calendar/settings', { signal }),
  });
}

/** Saves the company's schedule settings (owner only). */
export function useSaveScheduleSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ScheduleSettings) => apiFetch<ScheduleSettings>('/api/calendar/settings', { method: 'PUT', body }),
    onSuccess: (view) => queryClient.setQueryData(crmKeys.schedule, view),
  });
}

/** The signed-in person's own hours. */
export function useMyHours() {
  return useQuery({
    queryKey: crmKeys.myHours,
    queryFn: ({ signal }) => apiFetch<MyHours>('/api/calendar/my-hours', { signal }),
  });
}

/** Saves the person's hours; `workHours: null` goes back to the company hours. */
export function useSaveMyHours() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { workHours: WorkHours | null }) => apiFetch<MyHours>('/api/calendar/my-hours', { method: 'PUT', body }),
    onSuccess: (view) => queryClient.setQueryData(crmKeys.myHours, view),
  });
}

/** The person's calendar connection (or none), with which providers are set up. */
export function useCalendarConnection() {
  return useQuery({
    queryKey: crmKeys.connection,
    queryFn: ({ signal }) => apiFetch<CalendarConnectionView>('/api/calendar/connection', { signal }),
  });
}

/** The writable calendars on the connected account. Only asked for while `enabled`. */
export function useCalendars(enabled: boolean) {
  return useQuery({
    queryKey: crmKeys.calendars,
    enabled,
    queryFn: ({ signal }) => apiFetch<ExternalCalendar[]>('/api/calendar/connection/calendars', { signal }),
  });
}

/** Picks which calendar appointments go to. */
export function useChooseCalendar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (calendarId: string) =>
      apiFetch<CalendarConnectionView>('/api/calendar/connection', { method: 'PATCH', body: { calendarId } }),
    onSuccess: (view) => queryClient.setQueryData(crmKeys.connection, view),
  });
}

/** Disconnects the person's calendar. */
export function useDisconnectCalendar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<unknown>('/api/calendar/connection', { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: crmKeys.connection });
      void queryClient.invalidateQueries({ queryKey: setupKey });
    },
  });
}
