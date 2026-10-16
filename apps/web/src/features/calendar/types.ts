import type { AppointmentView } from '@roofline/shared';

export type CalendarView = 'week' | 'day' | 'list';
export type BusyBlock = { userId: string; start: string; end: string; allDay: boolean };
export type AppointmentsBody = { appointments: AppointmentView[]; busy: BusyBlock[] };
export type CalendarPerson = { userId: string; name: string; color: string };

/** Props shared by the week and the day grid. `days` are the zone-day-start instants shown (7 for week, 1 for day). */
export type GridViewProps = {
  zone: string;
  days: Date[];
  appointments: AppointmentView[];
  busy: BusyBlock[];
  people: CalendarPerson[];
  showCanceled: boolean;
  now: Date;
  /** Called with the ISO instant of the clicked empty slot. */
  onSlot: (startIso: string) => void;
  onOpen: (appointmentId: string) => void;
};

export type AgendaViewProps = {
  zone: string;
  /** Zone-day-start of the first day. */
  from: Date;
  dayCount: number;
  appointments: AppointmentView[];
  people: CalendarPerson[];
  showCanceled: boolean;
  /** The zone day ("YYYY-MM-DD") that is today, so its panel can say so. */
  todayKey?: string;
  onOpen: (appointmentId: string) => void;
  onLoadMore: () => void;
};
