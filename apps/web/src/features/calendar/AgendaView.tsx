import type { AppointmentStatus, AppointmentView } from '@roofline/shared';
import { Button, EmptyState, Icon, Panel, Table, Tag, Td, Th, Tr, type IconName, type TagTone } from '@roofline/ui';
import { calendar } from '../../copy/calendar.ts';
import { colorOfAppointment } from './colors.ts';
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
  const firstKey = days[0]?.key ?? '';
  for (const appointment of sorted) {
    const startKey = zonedDateKey(new Date(appointment.startsAt), zone);
    if (appointment.allDay) {
      // Every listed day it covers (end exclusive), as the grid does
      const lastKey = zonedDateKey(new Date(Math.max(Date.parse(appointment.startsAt), Date.parse(appointment.endsAt) - 1)), zone);
      for (const day of days) {
        if (startKey <= day.key && day.key <= lastKey) day.items.push(appointment);
      }
    } else {
      // A timed item that started before the range sits on the first listed day
      const day = byKey.get(startKey < firstKey ? firstKey : startKey);
      if (day) day.items.push(appointment);
    }
  }
  return days.filter((day) => day.items.length > 0);
}

/** The tag for a visit that is no longer simply scheduled; a scheduled one has none. Icon and word, never colour alone. */
const STATUS_TAGS: Partial<Record<AppointmentStatus, { tone: TagTone; icon: IconName }>> = {
  completed: { tone: 'ok', icon: 'check' },
  canceled: { tone: 'neutral', icon: 'x' },
  no_show: { tone: 'warn', icon: 'alert' },
};

function Person({ appointment, people }: { appointment: AppointmentView; people: CalendarPerson[] }) {
  if (appointment.assigned === null) return <span className={styles.nobody}>{calendar.unassigned}</span>;
  return (
    <span className={styles.person}>
      <span className={styles.dot} style={{ background: colorOfAppointment(appointment, people) }} aria-hidden="true" />
      {appointment.assigned.name}
    </span>
  );
}

/**
 * The list: one panel for each day, newest to come first, each a table of its visits (time, visit, customer, address,
 * person, status). A row opens its appointment; the visit's name is the one control a keyboard reaches. On a phone the
 * customer moves under the visit and the address goes, so the table never scrolls sideways.
 */
export function AgendaView(props: AgendaViewProps) {
  const { zone, people, todayKey, onOpen, onLoadMore } = props;
  const days = groupByDay(props);

  return (
    <div className={styles.agenda}>
      {days.length === 0 ? (
        <div className={styles.empty}>
          <EmptyState
            title={calendar.empty}
            body={calendar.emptyHint}
            action={
              <Button variant="default" href="/calendar/new">
                {calendar.newAppointment}
              </Button>
            }
          />
          <div className={styles.ghosts} aria-hidden="true">
            {[0, 1, 2].map((row) => (
              <span key={row} className={styles.ghost}>
                <span className={styles.ghostTime} />
                <span className={styles.ghostLine} />
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {days.map((day) => (
        <Panel
          key={day.key}
          as="section"
          title={formatDayLabel(day.start, zone)}
          tag={calendar.count(day.items.length)}
          actions={day.key === todayKey ? <Tag tone="brand">{calendar.todayTag}</Tag> : undefined}
          padded={false}
          data-testid={`agenda-day-${day.key}`}
        >
          <Table>
            <thead>
              <tr>
                <Th>{calendar.columns.time}</Th>
                <Th>{calendar.columns.visit}</Th>
                <Th className={styles.wide}>{calendar.columns.customer}</Th>
                <Th className={styles.wide}>{calendar.columns.address}</Th>
                <Th className={styles.wide}>{calendar.columns.person}</Th>
                <Th>{calendar.columns.status}</Th>
              </tr>
            </thead>
            <tbody>
              {day.items.map((appointment) => {
                const tag = STATUS_TAGS[appointment.status];
                return (
                  <Tr
                    key={appointment.id}
                    className={styles.row}
                    data-status={appointment.status}
                    onClick={(event) => {
                      // A click on the visit's own button opens it once; anywhere else on the row opens it too
                      if (!(event.target as HTMLElement).closest('button, a')) onOpen(appointment.id);
                    }}
                  >
                    <Td className={styles.time}>{appointment.allDay ? calendar.allDay : formatTime(new Date(appointment.startsAt), zone)}</Td>
                    <Td className={styles.visit}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={styles.open}
                        title={calendar.eventTitle([
                          appointment.title,
                          ...(appointment.addressLine !== null ? [appointment.addressLine] : []),
                          ...(appointment.allDay ? [] : [calendar.timeRange(formatTime(new Date(appointment.startsAt), zone), formatTime(new Date(appointment.endsAt), zone))]),
                        ])}
                        data-testid={`agenda-item-${appointment.id}`}
                        data-status={appointment.status}
                        onClick={() => onOpen(appointment.id)}
                      >
                        {appointment.title}
                      </Button>
                      {appointment.customerName !== null ? <span className={styles.under}>{appointment.customerName}</span> : null}
                    </Td>
                    <Td className={styles.wide}>{appointment.customerName ?? <span className={styles.nobody}>{calendar.noCustomer}</span>}</Td>
                    <Td className={`${styles.wide} ${styles.address}`}>{appointment.addressLine}</Td>
                    <Td className={styles.wide}>
                      <Person appointment={appointment} people={people} />
                    </Td>
                    <Td>
                      {tag !== undefined ? (
                        <Tag tone={tag.tone} icon={tag.icon}>
                          {calendar.status[appointment.status]}
                        </Tag>
                      ) : null}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </Panel>
      ))}
      <div className={styles.more}>
        <Button variant="default" onClick={onLoadMore}>
          <Icon name="plus" size={16} />
          {calendar.loadMore}
        </Button>
      </div>
    </div>
  );
}
