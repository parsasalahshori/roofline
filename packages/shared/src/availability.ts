export const APPOINTMENT_KINDS = ['inspection', 'install', 'adjuster', 'other'] as const;
export type AppointmentKind = (typeof APPOINTMENT_KINDS)[number];
export const APPOINTMENT_STATUSES = ['scheduled', 'completed', 'canceled', 'no_show'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
export const APPOINTMENT_SOURCES = ['manual', 'front_desk', 'scheduler', 'external'] as const;
export type AppointmentSource = (typeof APPOINTMENT_SOURCES)[number];
export const CALENDAR_PROVIDERS = ['google', 'microsoft'] as const;
export type CalendarProvider = (typeof CALENDAR_PROVIDERS)[number];
export const CALENDAR_CONNECTION_STATUSES = ['connected', 'error', 'revoked'] as const;
export type CalendarConnectionStatus = (typeof CALENDAR_CONNECTION_STATUSES)[number];
export const QUOTE_STATUSES = ['draft', 'final'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

import { z } from 'zod';
import { localDate } from './time-zone.ts';

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type WorkHours = Record<Weekday, [string, string][]>;
export const DEFAULT_DURATION_MINUTES: Record<'inspection' | 'adjuster' | 'other', number> = { inspection: 60, adjuster: 60, other: 30 };
export const SLOT_STEP_MINUTES = 30;
export const MAX_AVAILABILITY_DAYS = 14;
export type Interval = { start: Date; end: Date };
export type BusyItem = Interval & { propertyId: string | null };
export type SlotQuery = {
  workHours: WorkHours; busy: readonly BusyItem[]; propertyId: string | null; durationMinutes: number;
  bufferMinutes: number; from: Date; to: Date; timeZone: string; stepMinutes?: number; minNoticeMinutes: number; now: Date;
};

const MINUTES_PER_DAY = 24 * 60;
const MAX_RANGES_PER_DAY = 3;
const START_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const END_TIME = /^(?:([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const TIME_FORMAT_HINT = 'use 24-hour HH:MM times, such as 08:00 (an end may also be 24:00)';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Minutes after local midnight for an 'HH:MM' time ('24:00' is 1440). */
function clockMinutes(time: string): number {
  const [hours, minutes] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

export const DEFAULT_WORK_HOURS: WorkHours = {
  mon: [['08:00', '18:00']],
  tue: [['08:00', '18:00']],
  wed: [['08:00', '18:00']],
  thu: [['08:00', '18:00']],
  fri: [['08:00', '18:00']],
  sat: [['08:00', '12:00']],
  sun: [],
};

function checkDay(day: Weekday, value: unknown, ctx: z.RefinementCtx): void {
  const fail = (message: string): void => {
    ctx.addIssue({ code: 'custom', message: `${day}: ${message}` });
  };
  if (!Array.isArray(value)) {
    fail('list the ranges as an array, or [] for a day with no work hours');
    return;
  }
  if (value.length > MAX_RANGES_PER_DAY) fail(`at most ${MAX_RANGES_PER_DAY} ranges a day`);
  let previous: { start: number; end: number } | null = null;
  for (const range of value) {
    if (!Array.isArray(range) || range.length !== 2 || typeof range[0] !== 'string' || typeof range[1] !== 'string') {
      fail('each range is a start and an end time, such as ["08:00", "17:00"]');
      return;
    }
    const [start, end] = range as [string, string];
    if (!START_TIME.test(start)) {
      fail(`start "${start}" is not a time; ${TIME_FORMAT_HINT}`);
      return;
    }
    if (!END_TIME.test(end)) {
      fail(`end "${end}" is not a time; ${TIME_FORMAT_HINT}`);
      return;
    }
    const startMinutes = clockMinutes(start);
    const endMinutes = end === '24:00' ? MINUTES_PER_DAY : clockMinutes(end);
    if (startMinutes >= endMinutes) fail(`the range ${start}-${end} must end after it starts`);
    if (previous && startMinutes < previous.start) fail('ranges must be listed in time order');
    else if (previous && startMinutes < previous.end) fail('ranges must not overlap');
    previous = { start: startMinutes, end: endMinutes };
  }
}

const weekdaySet: ReadonlySet<string> = new Set(WEEKDAYS);

const WorkHoursShape = z.unknown().superRefine((value, ctx) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    ctx.addIssue({ code: 'custom', message: 'work hours need one entry for each day, mon through sun' });
    return;
  }
  const record = value as Record<string, unknown>;
  for (const day of WEEKDAYS) {
    if (!Object.prototype.hasOwnProperty.call(record, day)) {
      ctx.addIssue({ code: 'custom', message: `${day}: missing; use [] for a day with no work hours` });
    } else {
      checkDay(day, record[day], ctx);
    }
  }
  for (const key of Object.keys(record)) {
    if (!weekdaySet.has(key)) ctx.addIssue({ code: 'custom', message: `${key}: not a weekday; use mon through sun` });
  }
});

/** Weekly work hours, checked day by day. Every issue message starts with the day it is about. */
export const WorkHoursSchema: z.ZodType<WorkHours> = WorkHoursShape.transform((value) => {
  const record = value as Record<Weekday, [string, string][]>;
  const copy = {} as WorkHours;
  for (const day of WEEKDAYS) copy[day] = record[day].map(([start, end]): [string, string] => [start, end]);
  return copy;
});

// Local wall-clock math: every offset comes from Intl, never from Date local-time methods.
const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = partFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    partFormatters.set(zone, formatter);
  }
  return formatter;
}

/** The zone's UTC offset in minutes at an instant (ms since epoch), e.g. -300 for CDT. */
function zoneOffsetMinutes(instant: number, zone: string): number {
  const parts: Record<string, number> = {};
  for (const part of partFormatter(zone).formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const wallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const wholeSecond = Math.floor(instant / 1000) * 1000;
  return Math.round((wallAsUtc - wholeSecond) / 60000);
}

/** The instant (ms since epoch) of a local wall-clock time; minutesOfDay 1440 is the next midnight. */
function localToInstant(year: number, month: number, day: number, minutesOfDay: number, zone: string): number {
  const guess = Date.UTC(year, month - 1, day, 0, minutesOfDay);
  const firstTry = guess - zoneOffsetMinutes(guess, zone) * 60000;
  return guess - zoneOffsetMinutes(firstTry, zone) * 60000;
}

/** The work hours as UTC instants for every local day that touches [from, to), clipped to it. */
export function workIntervals(hours: WorkHours, from: Date, to: Date, timeZone: string): Interval[] {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  if (toMs <= fromMs) return [];
  const [firstYear, firstMonth, firstDay] = localDate(from, timeZone).split('-').map(Number) as [number, number, number];
  const [lastYear, lastMonth, lastDay] = localDate(to, timeZone).split('-').map(Number) as [number, number, number];
  const lastCursor = Date.UTC(lastYear, lastMonth - 1, lastDay);
  const found: Interval[] = [];
  for (let cursor = Date.UTC(firstYear, firstMonth - 1, firstDay); cursor <= lastCursor; cursor += DAY_MS) {
    const calendarDay = new Date(cursor);
    const year = calendarDay.getUTCFullYear();
    const month = calendarDay.getUTCMonth() + 1;
    const dayOfMonth = calendarDay.getUTCDate();
    const weekday = WEEKDAYS[(calendarDay.getUTCDay() + 6) % 7];
    for (const [start, end] of hours[weekday]) {
      const startMs = localToInstant(year, month, dayOfMonth, clockMinutes(start), timeZone);
      const endMs = localToInstant(year, month, dayOfMonth, end === '24:00' ? MINUTES_PER_DAY : clockMinutes(end), timeZone);
      const lo = Math.max(startMs, fromMs);
      const hi = Math.min(endMs, toMs);
      if (hi > lo) found.push({ start: new Date(lo), end: new Date(hi) });
    }
  }
  return mergeIntervals(found);
}

/** Sorted copies of the non-empty intervals, with overlapping or touching ones merged. The input is not changed. */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = list
    .filter((interval) => interval.end.getTime() > interval.start.getTime())
    .map((interval) => ({ start: new Date(interval.start.getTime()), end: new Date(interval.end.getTime()) }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: Interval[] = [];
  for (const current of sorted) {
    const last = merged[merged.length - 1];
    if (last && current.start.getTime() <= last.end.getTime()) {
      if (current.end.getTime() > last.end.getTime()) last.end = current.end;
    } else {
      merged.push(current);
    }
  }
  return merged;
}

const MINUTE_MS = 60_000;

// Minute-of-hour of an instant in the company zone. Intl only; no Date local-time methods.
function localMinute(ms: number, fmt: Intl.DateTimeFormat): number {
  const part = fmt.formatToParts(new Date(ms)).find((p) => p.type === 'minute');
  return Number(part?.value ?? 0);
}

// First instant at or after `ms` that starts a whole minute whose local minute-of-hour is a multiple of `stepMinutes`.
function alignUp(ms: number, stepMinutes: number, fmt: Intl.DateTimeFormat): number {
  const wholeMinute = Math.ceil(ms / MINUTE_MS) * MINUTE_MS;
  const m = localMinute(wholeMinute, fmt);
  const skip = (stepMinutes - (m % stepMinutes)) % stepMinutes;
  return wholeMinute + skip * MINUTE_MS;
}

// Free when no busy item overlaps [start - buf, end + buf) (half-open, so touching edges are fine).
function isFree(
  start: number,
  end: number,
  busy: readonly { start: number; end: number; sameHome: boolean }[],
  bufferMs: number,
): boolean {
  for (const b of busy) {
    const buf = b.sameHome ? 0 : bufferMs;
    if (start - buf < b.end && end + buf > b.start) return false;
  }
  return true;
}

export function findSlots(q: SlotQuery): Interval[] {
  const stepMinutes = q.stepMinutes ?? SLOT_STEP_MINUTES;
  const fromMs = q.from.getTime();
  const toMs = q.to.getTime();
  if (q.durationMinutes <= 0 || fromMs >= toMs) return [];
  if (!(stepMinutes > 0)) return [];

  const durMs = q.durationMinutes * MINUTE_MS;
  const stepMs = stepMinutes * MINUTE_MS;
  const bufferMs = q.bufferMinutes * MINUTE_MS;
  const earliest = Math.max(fromMs, q.now.getTime() + q.minNoticeMinutes * MINUTE_MS);

  const work = mergeIntervals(workIntervals(q.workHours, q.from, q.to, q.timeZone))
    .slice()
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: q.timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const busy = q.busy.map((b) => ({
    start: b.start.getTime(),
    end: b.end.getTime(),
    sameHome: q.propertyId !== null && q.propertyId === b.propertyId,
  }));

  const out: Interval[] = [];
  for (const w of work) {
    const windowEnd = Math.min(w.end.getTime(), toMs);
    const windowStart = Math.max(w.start.getTime(), earliest);
    for (let t = alignUp(windowStart, stepMinutes, fmt); t + durMs <= windowEnd; t += stepMs) {
      const end = t + durMs;
      if (isFree(t, end, busy, bufferMs)) {
        out.push({ start: new Date(t), end: new Date(end) });
      }
    }
  }
  return out;
}
