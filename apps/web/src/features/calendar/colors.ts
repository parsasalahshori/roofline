import type { AppointmentKind, AppointmentView } from '@roofline/shared';
import type { CalendarPerson } from './types.ts';

/** The colour of each person, in team order. Stage and hail tokens only: they are the palette the app already uses. */
export const PERSON_COLORS = [
  'var(--st-lead)',
  'var(--st-insp)',
  'var(--st-prop)',
  'var(--st-won)',
  'var(--st-inst)',
  'var(--hail-3)',
  'var(--hail-4)',
  'var(--hail-5)',
] as const;

/** The colour for the person at `index` in team order; the palette repeats after eight people. */
export function colorFor(index: number): string {
  const color = PERSON_COLORS[index % PERSON_COLORS.length];
  return color ?? PERSON_COLORS[0];
}

/** The colour of a kind of visit, for an appointment that nobody who is shown is assigned to. */
export function kindColor(kind: AppointmentKind): string {
  switch (kind) {
    case 'inspection':
      return 'var(--st-insp)';
    case 'install':
      return 'var(--st-inst)';
    case 'adjuster':
      return 'var(--st-prop)';
    default:
      return 'var(--ink-3)';
  }
}

/** The colour of an appointment's left edge: its person's, else its kind's. Never red, which is for holds and errors. */
export function colorOfAppointment(appointment: AppointmentView, people: ReadonlyArray<CalendarPerson>): string {
  const userId = appointment.assigned?.userId;
  const person = userId === undefined ? undefined : people.find((candidate) => candidate.userId === userId);
  return person?.color ?? kindColor(appointment.kind);
}
