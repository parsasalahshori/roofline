import type { AppointmentView } from '@roofline/shared';
import { Button, EmptyState } from '@roofline/ui';
import { calendar } from '../../copy/calendar.ts';
import { addZonedDays, formatDayLabel, formatTime, zonedDateKey } from './time.ts';
import type { AgendaViewProps, CalendarPerson } from './types.ts';
import styles from './AgendaView.module.css';

type Day = { key: string; start: Date; items: AppointmentView[] };

/** The days in range, each with its appointments in start order. Days with nothing on them are left out. */
function groupByDay(props: AgendaViewProps): Day[] {
  const { zone, from, dayCount, appointments, showCanceled } = props;
  const days: Day[] = [];
  for (let offset = 0; offset < dayCount; offset += 1) {
    const start = addZonedDays(from, offset, zone);
    days.push({ key: zonedDateKey(start, zone), start, items: [] });
  }
  const byKey = new Map(days.map((day) => [day.key, day]));
  const visible = showCanceled ? appointments : appointments.filter((a) => a.status !== 'canceled');
  const sorted = [...visible].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  for (const appointment of sorted) {
    const day = byKey.get(zonedDateKey(new Date(appointment.startsAt), zone));
    if (day) day.items.push(appointment);
  }
  return days.filter((day) => day.items.length > 0);
}

/** The colour dot for an appointment: its assignee's colour, or none when nobody is assigned or the person is not shown. */
function colorOf(appointment: AppointmentView, people: CalendarPerson[]): string | undefined {
  const userId = appointment.assigned?.userId;
  if (userId === undefined) return undefined;
  return people.find((person) => person.userId === userId)?.color;
}

/** The agenda: the next days as a list, grouped by day in the company zone. Each row opens its appointment. */
export function AgendaView(props: AgendaViewProps) {
  const { zone, people, onOpen, onLoadMore } = props;
  const days = groupByDay(props);

  return (
    <div className={styles.agenda}>
      {days.length === 0 ? <EmptyState title={calendar.empty} /> : null}
      {days.map((day) => (
        <section key={day.key} className={styles.day}>
          <h2 className={styles.heading} data-testid={`agenda-day-${day.key}`}>
            {formatDayLabel(day.start, zone)}
          </h2>
          <ul className={styles.list}>
            {day.items.map((appointment) => {
              const color = colorOf(appointment, people);
              return (
                <li key={appointment.id} className={styles.item}>
                  <Button
                    variant="ghost"
                    className={styles.row}
                    data-testid={`agenda-item-${appointment.id}`}
                    data-status={appointment.status}
                    onClick={() => onOpen(appointment.id)}
                  >
                    <span className={styles.time}>
                      {appointment.allDay ? calendar.allDay : formatTime(new Date(appointment.startsAt), zone)}
                    </span>
                    {color !== undefined ? (
                      <span className={styles.dot} style={{ background: color }} aria-hidden="true" />
                    ) : null}
                    <span className={styles.text}>
                      <span className={styles.title}>{appointment.title}</span>
                      {appointment.customerName !== null ? (
                        <span className={styles.customer}>{appointment.customerName}</span>
                      ) : null}
                    </span>
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <div className={styles.more}>
        <Button variant="ghost" onClick={onLoadMore}>
          {calendar.loadMore}
        </Button>
      </div>
    </div>
  );
}
