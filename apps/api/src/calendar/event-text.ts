import type { AppointmentView } from '@roofline/shared';
import type { ExternalEventInput } from '../providers/calendar.ts';

/** The only place event text is written. Never includes phone, email or notes. */
export function eventInputFor(a: AppointmentView, o: { jobUrl: string | null; timeZone: string }): ExternalEventInput {
  return {
    title: a.customerName ? `${a.title} — ${a.customerName}` : a.title,
    location: a.addressLine,
    description: o.jobUrl ? `Open in Roofline: ${o.jobUrl}` : 'Open in Roofline',
    start: new Date(a.startsAt),
    end: new Date(a.endsAt),
    allDay: a.allDay,
    timeZone: o.timeZone,
  };
}
