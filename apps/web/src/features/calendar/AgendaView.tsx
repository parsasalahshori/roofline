import type { AppointmentStatus, AppointmentView } from '@roofline/shared';
import { Button, EmptyState, Icon, Panel, Table, Tag, Td, Th, Tr, type IconName, type TagTone } from '@roofline/ui';
import type { MouseEvent } from 'react';
import { calendar } from '../../copy/calendar.ts';
import { useIsPhone } from '../../shell/useIsPhone.ts';
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

function StatusTag({ appointment }: { appointment: AppointmentView }) {
  const tag = STATUS_TAGS[appointment.status];
  if (tag === undefined) return null;
  return (
    <Tag tone={tag.tone} icon={tag.icon}>
      {calendar.status[appointment.status]}
    </Tag>
  );
}

function Person({ appointment, people }: { appointment: AppointmentView; people: CalendarPerson[] }) {
  if (appointment.assigned === null) return <span className={styles.nobody}>{calendar.unassigned}</span>;
  return (
    <span className={styles.person}>
      <span className={styles.dot} style={{ background: colorOfAppointment(appointment, people) }} aria-hidden="true" />
      {appointment.assigned.name}
    </span>
  );
}

/** The time of a visit as the list says it: "9:30 AM", or "All day". */
function timeOf(appointment: AppointmentView, zone: string): string {
  return appointment.allDay ? calendar.allDay : formatTime(new Date(appointment.startsAt), zone);
}

/** The name of a visit as a button: the one control a keyboard reaches in its row. Its title tells where and when in full. */
function VisitButton({ appointment, zone, onOpen }: { appointment: AppointmentView; zone: string; onOpen: (id: string) => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={styles.open}
      title={calendar.eventTitle([
        appointment.title,
        ...(appointment.addressLine !== null ? [appointment.addressLine] : []),
        ...(appointment.allDay
          ? []
          : [calendar.timeRange(formatTime(new Date(appointment.startsAt), zone), formatTime(new Date(appointment.endsAt), zone))]),
      ])}
      data-testid={`agenda-item-${appointment.id}`}
      data-status={appointment.status}
      onClick={() => onOpen(appointment.id)}
    >
      {appointment.title}
    </Button>
  );
}

/** A click anywhere on a row opens it, except on the row's own button or link, which already did. */
function rowClick(event: MouseEvent<HTMLElement>, appointmentId: string, onOpen: (id: string) => void) {
  if (!(event.target as HTMLElement).closest('button, a')) onOpen(appointmentId);
}

type DayRowsProps = {
  day: Day;
  zone: string;
  people: CalendarPerson[];
  hasStatus: boolean;
  onOpen: (id: string) => void;
};

/** One day as a table: time, visit, customer, address, person and (when any visit here is not simply scheduled) status. */
function DayTable({ day, zone, people, hasStatus, onOpen }: DayRowsProps) {
  return (
    <Table className={styles.table}>
      <thead>
        <tr>
          <Th className={styles.colTime}>{calendar.columns.time}</Th>
          <Th>{calendar.columns.visit}</Th>
          <Th className={styles.colCustomer}>{calendar.columns.customer}</Th>
          <Th className={styles.colAddress}>{calendar.columns.address}</Th>
          <Th className={styles.colPerson}>{calendar.columns.person}</Th>
          {hasStatus ? <Th className={styles.colStatus}>{calendar.columns.status}</Th> : null}
        </tr>
      </thead>
      <tbody>
        {day.items.map((appointment) => (
          <Tr key={appointment.id} className={styles.row} data-status={appointment.status} onClick={(event) => rowClick(event, appointment.id, onOpen)}>
            <Td className={styles.time}>{timeOf(appointment, zone)}</Td>
            <Td className={styles.visit}>
              <VisitButton appointment={appointment} zone={zone} onOpen={onOpen} />
            </Td>
            <Td className={styles.cut}>{appointment.customerName ?? <span className={styles.nobody}>{calendar.noCustomer}</span>}</Td>
            <Td className={`${styles.cut} ${styles.address}`}>{appointment.addressLine}</Td>
            <Td>
              <Person appointment={appointment} people={people} />
            </Td>
            {hasStatus ? (
              <Td>
                <StatusTag appointment={appointment} />
              </Td>
            ) : null}
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

/** One day on a phone: a row for each visit, its time at the left and the rest stacked, so nothing runs past the screen. */
function DayList({ day, zone, people, onOpen }: Omit<DayRowsProps, 'hasStatus'>) {
  return (
    <ul className={styles.pList}>
      {day.items.map((appointment) => {
        const where = [appointment.customerName, appointment.addressLine].filter((part): part is string => part !== null && part !== '');
        return (
          <li key={appointment.id} className={styles.pRow} data-status={appointment.status} onClick={(event) => rowClick(event, appointment.id, onOpen)}>
            <span className={styles.pTime}>{timeOf(appointment, zone)}</span>
            <div className={styles.pBody}>
              <VisitButton appointment={appointment} zone={zone} onOpen={onOpen} />
              {where.length > 0 ? <span className={styles.pMeta}>{where.join(calendar.metaSeparator)}</span> : null}
              <span className={styles.pFoot}>
                <Person appointment={appointment} people={people} />
                <StatusTag appointment={appointment} />
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The list: one panel for each day, soonest first, each a table of its visits (time, visit, customer, address, person, status).
 * The tables share their column widths, so the days line up. A row opens its appointment; the visit's name is the one control a
 * keyboard reaches. On a phone each visit is a row of its own with its time at the left, so nothing scrolls sideways.
 */
export function AgendaView(props: AgendaViewProps) {
  const { zone, people, todayKey, onOpen, onLoadMore } = props;
  const phone = useIsPhone();
  const days = groupByDay(props);
  // The status column is drawn when any visit shown is not simply scheduled, and then in every day's table
  const hasStatus = days.some((day) => day.items.some((appointment) => appointment.status !== 'scheduled'));

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
          {phone ? (
            <DayList day={day} zone={zone} people={people} onOpen={onOpen} />
          ) : (
            <DayTable day={day} zone={zone} people={people} hasStatus={hasStatus} onOpen={onOpen} />
          )}
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
