import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { AppointmentStatus, AppointmentView } from '@roofline/shared';
import { Button, Icon, type IconName } from '@roofline/ui';
import { calendar } from '../../copy/calendar.ts';
import { colorOfAppointment } from './colors.ts';
import {
  formatCompactRange,
  formatCompactTime,
  formatDayLabel,
  formatDayNumber,
  formatTime,
  formatWeekday,
  startOfZonedDay,
  zonedDateKey,
  zonedParts,
} from './time.ts';
import type { GridViewProps } from './types.ts';
import { visitKind } from './visit.ts';
import styles from './TimeGrid.module.css';

/** The visible window in minutes since midnight: 06:00 to 21:00. */
const WINDOW_START = 360;
const WINDOW_END = 1260;
const ROW_MINUTES = 30;
const ROW_COUNT = (WINDOW_END - WINDOW_START) / ROW_MINUTES;
/** A row is 32px: a 30 minute visit has one line, an hour has the three it needs. */
const ROW_PX = 32;
/** The grid opens at 07:00, two rows down, unless today is shown. */
const SCROLL_TO_ROW = 2;
const DAY_MINUTES = 1440;
const GUTTER_PX = 72;
const COLUMN_MIN_PX = 120;
/** A character of the mono type a block's hours are set in: 0.6em of the 12px minimum. */
const CHAR_PX = 7.2;
/** What a block spends before its words: the 3px edge, 8px of padding on each side, and the 2px its width gives up. */
const BLOCK_CHROME_PX = 21;
/** A column with room for 19 characters writes every range whole ("10:00 AM - 11:00 AM"); with room for 12 it writes them shorter ("10 - 11 AM"). */
const WHOLE_CHARS = 19;
const SHORT_CHARS = 12;
/** The room a block needs beside the kind of visit to show the word of a mark ("Done", "No-show"), not only its glyph. */
const WORD_ROOM_PX = 150;
/** Narrower than this, a block cannot hold the kind of visit and the glyph of its status on one line: the glyph takes the line of its own. */
const MARK_BESIDE_PX = 60;

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

/** The part of a place [row, row + span) that is at or below row `from`: null when it ends above it. */
function inView(row: number, span: number, from: number): { row: number; span: number } | null {
  if (row + span <= from) return null;
  const shownRow = Math.max(row, from);
  return { row: shownRow, span: row + span - shownRow };
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

/** Whether the clock is inside the hours the grid shows, on a day that is shown. */
function clockInView(todayShown: boolean, nowMinute: number): boolean {
  return todayShown && nowMinute >= WINDOW_START && nowMinute <= WINDOW_END;
}

/**
 * The row the grid opens on: a few rows above the clock when today is shown, else 07:00, and never below the first visit of the
 * days shown (with a row of air above it), so a tall visit that began before the clock still has its name in view.
 */
function openingRow(todayShown: boolean, nowMinute: number, firstVisitRow: number | null): number {
  const base = clockInView(todayShown, nowMinute) ? Math.max(0, Math.floor((nowMinute - WINDOW_START) / ROW_MINUTES) - 3) : SCROLL_TO_ROW;
  return firstVisitRow === null ? base : Math.max(0, Math.min(base, firstVisitRow - 1));
}

/**
 * The row a grid starts at on a phone, where the page scrolls and the grid does not: a row above the first visit of the days shown,
 * so the first thing under the controls is the day's work and not empty morning hours (a phone shows about eight rows there). With no
 * visit it starts a few rows above the clock when today is shown, and otherwise at the top of the window: nothing is pulled out of view.
 */
function phoneLeadRow(todayShown: boolean, nowMinute: number, firstVisitRow: number | null): number {
  if (firstVisitRow !== null) return Math.max(0, firstVisitRow - 1);
  return clockInView(todayShown, nowMinute) ? Math.max(0, Math.floor((nowMinute - WINDOW_START) / ROW_MINUTES) - 3) : 0;
}

/** How a visit that is not simply scheduled is marked on its block: a glyph, a word and a tone, never the tone alone. */
const STATUS_MARK: Partial<Record<AppointmentStatus, { icon: IconName; tone: 'ok' | 'warn' | 'neutral' }>> = {
  completed: { icon: 'check', tone: 'ok' },
  no_show: { icon: 'alert', tone: 'warn' },
  canceled: { icon: 'x', tone: 'neutral' },
};

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * The shared time grid for the Week and Day views: a head with the days, an all-day row and 06:00 to 21:00 in 30-minute rows
 * on faint hairlines (an hour's line is the stronger one). A visit is a tinted block with a 3px edge in its person's colour;
 * what does not fit a block is cut with an ellipsis and told in full by the block's title. Today has a brand line for the time now.
 */
export function TimeGrid({ zone, days, appointments, busy, people, showCanceled, now, pageScrolls = false, onSlot, onOpen }: GridViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const dayStarts = days.map((day) => startOfZonedDay(day, zone));
  const dayKeys = days.map((day) => zonedDateKey(day, zone));
  const nowKey = zonedDateKey(now, zone);
  const nowMinute = wallMinutes(now, zone);
  const shownAppointments = showCanceled ? appointments : appointments.filter((appt) => appt.status !== 'canceled');

  // The first row of a timed visit on the days shown (null with none)
  const visitRows = dayKeys.flatMap((dayKey) =>
    shownAppointments
      .filter((appt) => !appt.allDay && onDay(appt.startsAt, appt.endsAt, false, dayKey, zone))
      .map((appt) => placeInDay(appt.startsAt, appt.endsAt, dayKey, zone).row),
  );
  const firstVisitRow = visitRows.length > 0 ? Math.min(...visitRows) : null;
  const todayShown = dayKeys.includes(nowKey);

  // A grid that is its own scroll box opens by scrolling, once
  const [startRow] = useState(() => openingRow(todayShown, nowMinute, firstVisitRow));
  useEffect(() => {
    const element = scrollRef.current;
    if (element && !pageScrolls) element.scrollTop = startRow * ROW_PX;
  }, [startRow, pageScrolls]);

  // A grid on a page that scrolls (a phone's day) starts at the day's first visit instead: its rows before that are not drawn, it
  // follows the days shown, and a tap on the row of "earlier hours" brings them back
  const [showEarlier, setShowEarlier] = useState(false);
  const leadRow = pageScrolls && !showEarlier ? phoneLeadRow(todayShown, nowMinute, firstVisitRow) : 0;

  // How wide a day's column is, so each block can write its hours at the length that fits it (null until it is measured)
  const [columnPx, setColumnPx] = useState<number | null>(null);
  const dayCount = days.length;
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const read = () => setColumnPx(element.clientWidth > 0 ? Math.max(COLUMN_MIN_PX, (element.clientWidth - GUTTER_PX) / Math.max(1, dayCount)) : null);
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [dayCount]);

  /**
   * How a time is written in a block `lanes` side by side in a column (candidates, whole first): every block of a column takes the same
   * way, the longest the column has room for, so the grid does not mix "9:00 AM - 10:00 AM" with "10 - 11 AM"; a block whose own text
   * is still too long takes the next shorter one, and a block with no room even for the shortest leaves its time out (the pointer
   * finds it), so a number is never cut in the middle. Before the column is measured, the number of lanes decides: whole alone,
   * shorter in two, the start in more.
   */
  const fitHours = (candidates: readonly string[], lanes: number): string => {
    const last = candidates.length - 1;
    if (columnPx === null) return candidates[Math.min(Math.max(lanes, 1), candidates.length) - 1] ?? candidates[last] ?? '';
    const chars = Math.floor((columnPx / lanes - BLOCK_CHROME_PX) / CHAR_PX);
    const tier = chars >= WHOLE_CHARS ? 0 : chars >= SHORT_CHARS ? 1 : 2;
    for (let way = Math.min(tier, last); way <= last; way += 1) {
      const text = candidates[way] ?? '';
      if (text.length <= chars) return text;
    }
    return '';
  };

  /** Whether a block `lanes` side by side has room for the word of its status mark (before the column is measured, only a block alone has). */
  const hasWordRoom = (lanes: number): boolean => (columnPx === null ? lanes === 1 : columnPx / lanes - BLOCK_CHROME_PX >= WORD_ROOM_PX);

  /** Whether a block `lanes` side by side is too narrow for the kind of visit and its status glyph on one line (unmeasured, none is). */
  const isNarrow = (lanes: number): boolean => columnPx !== null && columnPx / lanes - BLOCK_CHROME_PX < MARK_BESIDE_PX;

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

  /** What the pointer finds on a block: everything it shows, and the parts that may have been cut short. */
  const tipOf = (appt: AppointmentView, range: string | null): string =>
    calendar.eventTitle([
      visitKind(appt.title, appt.customerName),
      ...(appt.customerName ? [appt.customerName] : []),
      ...(range !== null ? [range] : []),
      ...(appt.assigned ? [appt.assigned.name] : []),
      ...(STATUS_MARK[appt.status] !== undefined ? [calendar.status[appt.status]] : []),
    ]);

  /**
   * A canceled, done or no-show visit says so on its block: a glyph and the word, in the status's tone. Where the block is narrow
   * the word is dropped from the sight, not from the page, and what the pointer finds says it. Never colour alone.
   */
  const statusMark = (appt: AppointmentView, lanes: number): ReactNode => {
    const mark = STATUS_MARK[appt.status];
    if (mark === undefined) return null;
    return (
      <span className={styles.status} data-tone={mark.tone} data-word={hasWordRoom(lanes) ? 'true' : 'false'}>
        <Icon name={mark.icon} size={16} />
        <span className={styles.statusWord}>{calendar.status[appt.status]}</span>
      </span>
    );
  };

  const labels =
    dayStarts.length > 0
      ? Array.from({ length: ROW_COUNT - leadRow }, (_, index) => {
          const minute = WINDOW_START + (leadRow + index) * ROW_MINUTES;
          return minute % 60 === 0 ? formatTime(instantAtMinute(dayStarts[0], minute, zone), zone) : null;
        })
      : [];

  const columns = dayKeys.map((dayKey, col) => {
    const allDay: ReactNode[] = [];
    const timed: ReactNode[] = [];
    const busyTimed: ReactNode[] = [];

    const dayAppointments = shownAppointments.filter((appt) => onDay(appt.startsAt, appt.endsAt, appt.allDay, dayKey, zone));
    for (const appt of dayAppointments.filter((candidate) => candidate.allDay)) {
      allDay.push(
        <div
          key={appt.id}
          role="link"
          tabIndex={0}
          className={styles.allDayItem}
          title={tipOf(appt, null)}
          data-testid={`allday-${appt.id}`}
          data-appt={appt.id}
          data-status={appt.status}
          style={{ '--person': colorOfAppointment(appt, people) } as CSSProperties}
          onClick={() => onOpen(appt.id)}
          onKeyDown={(event) => onItemKeyDown(event, appt.id)}
        >
          <span className={styles.itemTitle}>{visitKind(appt.title, appt.customerName)}</span>
          {appt.customerName ? <span className={styles.itemSub}>{appt.customerName}</span> : null}
          {statusMark(appt, 1)}
        </div>,
      );
    }

    const timedAppointments = dayAppointments
      .filter((candidate) => !candidate.allDay)
      .map((appt) => ({ appt, ...placeInDay(appt.startsAt, appt.endsAt, dayKey, zone) }));
    const lanes = layoutLanes(timedAppointments);
    timedAppointments.forEach(({ appt, row: firstRowOfVisit, span: rowsOfVisit }, index) => {
      // A grid that starts later than a visit's first row (never the case for the day's first visit, only for a visit that ran
      // through the night, or a busy block) draws the part that is in view
      const shown = inView(firstRowOfVisit, rowsOfVisit, leadRow);
      if (shown === null) return;
      const { row, span } = shown;
      const { lane, lanes: laneCount } = lanes[index];
      const startAt = new Date(appt.startsAt);
      const endAt = new Date(appt.endsAt);
      const start = formatTime(startAt, zone);
      const range = calendar.timeRange(start, formatTime(endAt, zone));
      // A block is narrow, and narrower side by side: its hours are written whole, then shorter ("8 - 11 AM"), then as the start ("8 AM")
      const compactStart = formatCompactTime(startAt, zone);
      const hours = fitHours([range, formatCompactRange(startAt, endAt, zone), compactStart], laneCount);
      const startText = fitHours([start, compactStart], laneCount);
      const kind = visitKind(appt.title, appt.customerName);
      const mark = statusMark(appt, laneCount);
      // A narrow block gives the kind the whole line and the status glyph the line the hours would have had: the start is on the grid's own axis
      const markBelow = mark !== null && isNarrow(laneCount);
      timed.push(
        <div
          key={appt.id}
          role="link"
          tabIndex={0}
          className={styles.appt}
          title={tipOf(appt, range)}
          data-testid={`appt-${appt.id}`}
          data-appt={appt.id}
          data-status={appt.status}
          data-size={span === 1 ? 'short' : 'tall'}
          data-row-start={firstRowOfVisit}
          data-row-span={rowsOfVisit}
          data-lane={lane}
          data-lanes={laneCount}
          style={{
            '--person': colorOfAppointment(appt, people),
            top: `calc(${row - leadRow} * var(--row-h))`,
            height: `calc(${span} * var(--row-h) - 2px)`,
            left: `calc(${(lane * 100) / laneCount}% + 1px)`,
            width: `calc(${100 / laneCount}% - 2px)`,
          } as CSSProperties}
          onClick={() => onOpen(appt.id)}
          onKeyDown={(event) => onItemKeyDown(event, appt.id)}
        >
          {span === 1 ? (
            <>
              {startText !== '' ? <span className={styles.itemTime}>{startText}</span> : null}
              <span className={styles.itemTitle}>{kind}</span>
              {mark}
            </>
          ) : (
            <>
              <span className={styles.itemHead}>
                <span className={styles.itemTitle}>{kind}</span>
                {markBelow ? null : mark}
              </span>
              {appt.customerName ? <span className={styles.itemSub}>{appt.customerName}</span> : null}
              {markBelow ? mark : hours !== '' ? <span className={styles.itemTime}>{hours}</span> : null}
            </>
          )}
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
      const placed = placeInDay(block.start, block.end, dayKey, zone);
      const shown = inView(placed.row, placed.span, leadRow);
      if (shown === null) return;
      busyTimed.push(
        <div
          key={`busy-${index}`}
          className={styles.busy}
          data-testid={`busy-${index}`}
          data-row-start={placed.row}
          data-row-span={placed.span}
          style={{ top: `calc(${shown.row - leadRow} * var(--row-h))`, height: `calc(${shown.span} * var(--row-h) - 2px)` } as CSSProperties}
        >
          {calendar.busy}
        </div>,
      );
    });

    const slots = Array.from({ length: ROW_COUNT - leadRow }, (_, index) => {
      const minute = WINDOW_START + (leadRow + index) * ROW_MINUTES;
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

    const nowRow = (nowMinute - WINDOW_START) / ROW_MINUTES - leadRow;
    const showNow = dayKey === nowKey && nowMinute >= WINDOW_START + leadRow * ROW_MINUTES && nowMinute <= WINDOW_END;

    return { dayKey, allDay, timed, busyTimed, slots, showNow, nowRow };
  });

  // The row for all-day visits is drawn only when some day shown has one, so an empty row does not take room from the hours
  const hasAllDay = columns.some((column) => column.allDay.length > 0);

  return (
    <>
      {leadRow > 0 && dayStarts.length > 0 ? (
        <Button variant="ghost" className={styles.earlier} data-testid="earlier-hours" onClick={() => setShowEarlier(true)}>
          {calendar.earlierHours(
            formatTime(instantAtMinute(dayStarts[0], WINDOW_START, zone), zone),
            formatTime(instantAtMinute(dayStarts[0], WINDOW_START + leadRow * ROW_MINUTES, zone), zone),
          )}
        </Button>
      ) : null}
      <div
        ref={scrollRef}
        className={styles.scroll}
        data-single={days.length === 1 ? 'true' : undefined}
        data-testid="time-grid"
        role="region"
        aria-label={calendar.gridLabel}
        tabIndex={0}
      >
        <div
          ref={gridRef}
          className={styles.grid}
          data-single={days.length === 1 ? 'true' : undefined}
          data-lead-rows={leadRow > 0 ? leadRow : undefined}
          style={{
            '--row-h': `${ROW_PX}px`,
            gridTemplateColumns: `${GUTTER_PX}px repeat(${days.length}, minmax(${COLUMN_MIN_PX}px, 1fr))`,
          } as CSSProperties}
        >
          <div className={styles.corner} />
          {dayKeys.map((dayKey, col) => (
            <div key={dayKey} className={styles.dayHead} data-day={dayKey} data-today={dayKey === nowKey ? 'true' : undefined}>
              <span className={styles.weekday} aria-hidden="true">
                {formatWeekday(days[col], zone)}
              </span>
              <span className={styles.dayNumber} aria-hidden="true">
                {formatDayNumber(days[col], zone)}
              </span>
              <span className="visually-hidden">{formatDayLabel(days[col], zone)}</span>
            </div>
          ))}

          {hasAllDay ? (
            <>
              <div className={styles.gutterAllDay}>{calendar.allDay}</div>
              {columns.map((column) => (
                <div key={column.dayKey} className={styles.allDayCell} data-day={column.dayKey} data-today={column.dayKey === nowKey ? 'true' : undefined}>
                  {column.allDay}
                </div>
              ))}
            </>
          ) : null}

          <div className={styles.gutter}>
            {labels.map((label, row) => (
              <div key={row} className={styles.gutterCell} data-hour={label ? 'true' : 'false'}>
                {label}
              </div>
            ))}
          </div>
          {columns.map((column) => (
            <div key={column.dayKey} className={styles.column} data-day={column.dayKey} data-today={column.dayKey === nowKey ? 'true' : undefined}>
              <div className={styles.slots}>{column.slots}</div>
              {column.busyTimed}
              {column.timed}
              {column.showNow ? <div data-testid="now-line" className={styles.now} style={{ top: `calc(${column.nowRow} * var(--row-h))` } as CSSProperties} /> : null}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
