import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { apiFetch } from '../../api/client.ts';
import type { AppointmentsBody } from './types.ts';

export type AppointmentsQuery = { from: string; to: string; userIds: string[] };

/**
 * GET /api/appointments?from&to&userIds=a,b&withBusy=true. The busy blocks come in the same answer.
 * With no people chosen the userIds parameter is left out altogether.
 */
export function useAppointments({ from, to, userIds, enabled = true }: AppointmentsQuery & { enabled?: boolean }) {
  const people = userIds.join(',');
  return useQuery({
    queryKey: ['calendar', 'appointments', from, to, people],
    queryFn: ({ signal }) => {
      const peoplePart = userIds.length > 0 ? `&userIds=${people}` : '';
      return apiFetch<AppointmentsBody>(
        `/api/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${peoplePart}&withBusy=true`,
        { signal },
      );
    },
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** POST /api/calendar/sync once per mount of the caller. A failed sync is silent; the appointments are read either way. */
export function useSyncNow(): void {
  const queryClient = useQueryClient();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    apiFetch('/api/calendar/sync', { method: 'POST' })
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: ['calendar', 'appointments'] });
      })
      .catch(() => {
        // Swallowed on purpose: a failed sync leaves the last synced appointments on screen
      });
  }, [queryClient]);
}
