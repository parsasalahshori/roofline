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
  /**
   * The page scrolls through the grid and the grid does not (a phone's day): the grid starts where the day's work does, a row above
   * the first visit, and the hours before it are one tap away. Left out, the grid is its own scroll box and opens there by scrolling.
   */
  pageScrolls?: boolean;
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
