import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { AppointmentView } from '@roofline/shared';
import { calendar } from '../../copy/calendar.ts';
import { formatDayLabel, formatTime, startOfZonedDay, zonedDateKey, zonedParts } from './time.ts';
import type { GridViewProps } from './types.ts';
import styles from './TimeGrid.module.css';

/** The visible window in minutes since midnight: 06:00 to 21:00. */
const WINDOW_START = 360;
const WINDOW_END = 1260;
const ROW_MINUTES = 30;
const ROW_COUNT = (WINDOW_END - WINDOW_START) / ROW_MINUTES;
const ROW_PX = 24;
/** The scroll container opens at 07:00, two rows down. */
const SCROLL_TO_ROW = 2;
const DAY_MINUTES = 1440;
const GUTTER_PX = 56;
const COLUMN_MIN_PX = 120;

/** Wall-clock minutes since midnight of `instant` in `zone`. */
function wallMinutes(instant: Date, zone: string): number {
  const parts = zonedParts(instant, zone);
  return parts.hour * 60 + parts.minute;
}

/** Minutes of `instant` within the column's zone day `dayKey`: earlier days count as 0, later days as a full day. */
function minuteInDay(instant: Date, dayKey: string, zone: string): number {
  const key = zonedDateKey(instant, zone);
  if (key < dayKey) return 0;
  if (key > dayKey) return DAY_MINUTES;
  return wallMinutes(instant, zone);
}

/** Whether [start, end) belongs in the column for zone day `dayKey`. All-day: every zone day it covers (end exclusive). Timed: its start day, plus later days whose visible window it reaches. */
function onDay(start: string, end: string, allDay: boolean, dayKey: string, zone: string): boolean {
  const startKey = zonedDateKey(new Date(start), zone);
  if (allDay) {
    const lastKey = zonedDateKey(new Date(Math.max(Date.parse(start), Date.parse(end) - 1)), zone);
    return startKey <= dayKey && dayKey <= lastKey;
  }
  if (startKey === dayKey) return true;
  return startKey < dayKey && minuteInDay(new Date(end), dayKey, zone) > WINDOW_START;
}

/** Row index (0 = 06:00) of a minute, clamped into the window. */
function rowOf(minute: number): number {
  const clamped = Math.min(Math.max(minute, WINDOW_START), WINDOW_END);
  return Math.round((clamped - WINDOW_START) / ROW_MINUTES);
}

/** Where [start, end) sits in the column for `dayKey`: first row and number of rows (at least one). */
function placeInDay(startsAt: string, endsAt: string, dayKey: string, zone: string): { row: number; span: number } {
  const from = minuteInDay(new Date(startsAt), dayKey, zone);
  const to = minuteInDay(new Date(endsAt), dayKey, zone);
  const row = Math.min(rowOf(from), ROW_COUNT - 1);
  return { row, span: Math.max(1, rowOf(to) - row) };
}

/**
 * The instant at which the zone's wall clock shows `minute` on the day starting at `dayStart`.
 * Corrects the elapsed-time guess until the wall clock agrees, so DST days land on the right label.
 */
function instantAtMinute(dayStart: Date, minute: number, zone: string): Date {
  let at = dayStart.getTime() + minute * 60_000;
  for (let attempt = 0; attempt < 3; attempt++) {
    const diff = minute - wallMinutes(new Date(at), zone);
    if (diff === 0) break;
    at += diff * 60_000;
  }
  return new Date(at);
}

/** Lanes for overlapping items: each item gets a lane, and `lanes` is the widest overlap in its cluster. */
function layoutLanes(items: { row: number; span: number }[]): { lane: number; lanes: number }[] {
  const order = items.map((_, index) => index).sort((a, b) => items[a].row - items[b].row || items[b].span - items[a].span || a - b);
  const result = items.map(() => ({ lane: 0, lanes: 1 }));
  let cluster: number[] = [];
  let clusterEnd = 0;
  let laneEnds: number[] = [];

  const closeCluster = () => {
    for (const index of cluster) result[index] = { lane: result[index].lane, lanes: laneEnds.length };
    cluster = [];
    laneEnds = [];
  };

  for (const index of order) {
    const item = items[index];
    const end = item.row + item.span;
    if (cluster.length > 0 && item.row >= clusterEnd) closeCluster();
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= item.row);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    result[index] = { lane, lanes: 1 };
    clusterEnd = cluster.length === 0 ? end : Math.max(clusterEnd, end);
    cluster.push(index);
  }
  closeCluster();
  return result;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** The shared time grid for the Week and Day views: a day header, an all-day row and 06:00 to 21:00 in 30-minute rows. */
export function TimeGrid({ zone, days, appointments, busy, people, showCanceled, now, onSlot, onOpen }: GridViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = SCROLL_TO_ROW * ROW_PX;
  }, []);

  const dayStarts = days.map((day) => startOfZonedDay(day, zone));
  const dayKeys = days.map((day) => zonedDateKey(day, zone));
  const nowKey = zonedDateKey(now, zone);
  const nowMinute = wallMinutes(now, zone);
  const shownAppointments = showCanceled ? appointments : appointments.filter((appt) => appt.status !== 'canceled');

  const colorOf = (appt: AppointmentView): string => people.find((person) => person.userId === appt.assigned?.userId)?.color ?? 'var(--st-inst)';

  /** Arrow keys walk the appointments in DOM order; Enter opens the focused one. */
  const onItemKeyDown = (event: KeyboardEvent<HTMLElement>, appointmentId: string) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onOpen(appointmentId);
      return;
    }
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const items = Array.from(gridRef.current?.querySelectorAll<HTMLElement>('[data-appt]') ?? []);
    const next = items[items.indexOf(event.currentTarget) + step];
    next?.focus();
  };

  const onSlotKeyDown = (event: KeyboardEvent<HTMLElement>, startIso: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSlot(startIso);
    }
  };

  const labels = dayStarts.length > 0 ? Array.from({ length: ROW_COUNT }, (_, row) => {
    const minute = WINDOW_START + row * ROW_MINUTES;
    return minute % 60 === 0 ? formatTime(instantAtMinute(dayStarts[0], minute, zone), zone) : null;
  }) : [];

  const columns = dayKeys.map((dayKey, col) => {
    const allDay: ReactNode[] = [];
    const timed: ReactNode[] = [];
    const busyTimed: ReactNode[] = [];

    const dayAppointments = shownAppointments.filter((appt) => onDay(appt.startsAt, appt.endsAt, appt.allDay, dayKey, zone));
    for (const appt of dayAppointments.filter((appt) => appt.allDay)) {
      allDay.push(
        <div
          key={appt.id}
          role="link"
          tabIndex={0}
          className={styles.allDayItem}
          data-testid={`allday-${appt.id}`}
          data-appt={appt.id}
          data-status={appt.status}
          style={{ '--person': colorOf(appt) } as CSSProperties}
          onClick={() => onOpen(appt.id)}
          onKeyDown={(event) => onItemKeyDown(event, appt.id)}
        >
          <span className={styles.itemTitle}>{appt.title}</span>
          {appt.customerName ? <span>{appt.customerName}</span> : null}
        </div>,
      );
    }

    const timedAppointments = dayAppointments
      .filter((appt) => !appt.allDay)
      .map((appt) => ({ appt, ...placeInDay(appt.startsAt, appt.endsAt, dayKey, zone) }));
    const lanes = layoutLanes(timedAppointments);
    timedAppointments.forEach(({ appt, row, span }, index) => {
      const { lane, lanes: laneCount } = lanes[index];
      const range = `${formatTime(new Date(appt.startsAt), zone)} - ${formatTime(new Date(appt.endsAt), zone)}`;
      timed.push(
        <div
          key={appt.id}
          role="link"
          tabIndex={0}
          className={styles.appt}
          data-testid={`appt-${appt.id}`}
          data-appt={appt.id}
          data-status={appt.status}
          data-row-start={row}
          data-row-span={span}
          data-lane={lane}
          data-lanes={laneCount}
          style={{
            '--person': colorOf(appt),
            top: `calc(${row} * var(--row-h))`,
            height: `calc(${span} * var(--row-h) - 2px)`,
            left: `${(lane * 100) / laneCount}%`,
            width: `${100 / laneCount}%`,
          } as CSSProperties}
          onClick={() => onOpen(appt.id)}
          onKeyDown={(event) => onItemKeyDown(event, appt.id)}
        >
          <span className={styles.itemTitle}>{appt.title}</span>
          {appt.customerName ? <span>{appt.customerName}</span> : null}
          <span className={styles.itemTime}>{range}</span>
        </div>,
      );
    });

    busy.forEach((block, index) => {
      if (!onDay(block.start, block.end, block.allDay, dayKey, zone)) return;
      if (block.allDay) {
        allDay.push(
          <div key={`busy-${index}`} className={styles.allDayBusy} data-testid={`busy-${index}`}>
            {calendar.busy}
          </div>,
        );
        return;
      }
      const { row, span } = placeInDay(block.start, block.end, dayKey, zone);
      busyTimed.push(
        <div
          key={`busy-${index}`}
          className={styles.busy}
          data-testid={`busy-${index}`}
          data-row-start={row}
          data-row-span={span}
          style={{ top: `calc(${row} * var(--row-h))`, height: `calc(${span} * var(--row-h) - 2px)` } as CSSProperties}
        >
          {calendar.busy}
        </div>,
      );
    });

    const slots = Array.from({ length: ROW_COUNT }, (_, row) => {
      const minute = WINDOW_START + row * ROW_MINUTES;
      const hhmm = `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
      const start = instantAtMinute(dayStarts[col], minute, zone);
      const startIso = start.toISOString();
      return (
        <div
          key={hhmm}
          role="button"
          tabIndex={-1}
          className={styles.slot}
          aria-label={`${formatDayLabel(days[col], zone)} ${formatTime(start, zone)}`}
          data-testid={`slot-${dayKey}-${hhmm}`}
          data-half={minute % 60 === 30 ? 'true' : 'false'}
          onClick={() => onSlot(startIso)}
          onKeyDown={(event) => onSlotKeyDown(event, startIso)}
        />
      );
    });

    const nowRow = (nowMinute - WINDOW_START) / ROW_MINUTES;
    const showNow = dayKey === nowKey && nowMinute >= WINDOW_START && nowMinute <= WINDOW_END;

    return { dayKey, allDay, timed, busyTimed, slots, showNow, nowRow };
  });

  return (
    <div ref={scrollRef} className={styles.scroll} data-testid="time-grid" role="region" aria-label={calendar.gridLabel} tabIndex={0}>
      <div
        ref={gridRef}
        className={styles.grid}
        style={{
          '--row-h': `${ROW_PX}px`,
          gridTemplateColumns: `${GUTTER_PX}px repeat(${days.length}, minmax(${COLUMN_MIN_PX}px, 1fr))`,
        } as CSSProperties}
      >
        <div className={styles.corner} />
        {dayKeys.map((dayKey, col) => (
          <div key={dayKey} className={styles.dayHead} data-day={dayKey}>
            {formatDayLabel(days[col], zone)}
          </div>
        ))}

        <div className={styles.gutterAllDay}>{calendar.allDay}</div>
        {columns.map((column) => (
          <div key={column.dayKey} className={styles.allDayCell} data-day={column.dayKey}>
            {column.allDay}
          </div>
        ))}

        <div className={styles.gutter}>
          {labels.map((label, row) => (
            <div key={row} className={styles.gutterCell} data-hour={label ? 'true' : 'false'}>
              {label}
            </div>
          ))}
        </div>
        {columns.map((column) => (
          <div key={column.dayKey} className={styles.column} data-day={column.dayKey}>
            <div className={styles.slots}>{column.slots}</div>
            {column.busyTimed}
            {column.timed}
            {column.showNow ? (
              <div
                data-testid="now-line"
                className={styles.now}
                style={{ top: `calc(${column.nowRow} * var(--row-h))` } as CSSProperties}
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
