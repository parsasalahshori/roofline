import type { AppointmentKind, AppointmentView } from '@roofline/shared';
import { formatTime } from '../calendar/time.ts';

/** The colour of the 3px bar beside a visit: its kind, from the stage palette (installs indigo, inspections teal). */
export const KIND_COLOR: Record<AppointmentKind, string> = {
  inspection: 'var(--st-insp)',
  install: 'var(--st-inst)',
  adjuster: 'var(--st-prop)',
  other: 'var(--ink-3)',
};

/** A visit's clock time split for display: "8:00" and "AM". The meridiem is small and quiet beside the big time. */
export function visitTime(startsAt: string, zone: string): { clock: string; meridiem: string } {
  const text = formatTime(new Date(startsAt), zone);
  const [clock = text, meridiem = ''] = text.split(' ');
  return { clock, meridiem };
}

/** The visits that are still on: a canceled one is not today's work. Earliest first, all-day ones before the clock times. */
export function liveVisits(appointments: readonly AppointmentView[]): AppointmentView[] {
  return appointments
    .filter((a) => a.status !== 'canceled')
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || Date.parse(a.startsAt) - Date.parse(b.startsAt));
}
