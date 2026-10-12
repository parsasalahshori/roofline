import type { TimePeriod } from './agents-api.ts';
import { localDate } from './time-zone.ts';

/*
 * A1 Task 5. Pure, no DB, no clock: period boundaries in the company's time zone as UTC instants.
 * Calendar dates are YYYY-MM-DD strings; the only zone math is Intl.
 */

/** Same shape as `MetricsWindow` in @roofline/db (structurally compatible). */
export type PeriodWindow = {
  timeZone: string;
  todayStart: Date;
  tomorrowStart: Date;
  /** now minus 30 days. */
  since30: Date;
  monthStart: Date;
  /** Start of the local day 13 days before today. */
  chartStart: Date;
};

const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, f);
  }
  return f;
}

/** The zone's offset from UTC, in milliseconds, at the instant `ms` (positive east of Greenwich). */
function zoneOffsetMs(ms: number, zone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(zone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const wallAsUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return wallAsUtc - Math.floor(ms / 1000) * 1000;
}

function parseDate(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number);
  return { y: y!, m: m!, d: d! };
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The UTC instant at which local day `date` (YYYY-MM-DD) starts in `zone` (DST safe). When local midnight
 * does not exist (the clocks jump at midnight), the day starts at the first instant that is on that date. */
export function startOfLocalDay(date: string, zone: string): Date {
  const { y, m, d } = parseDate(date);
  const guess = Date.UTC(y, m - 1, d);
  // Offsets a day either side cover both sides of any transition near this midnight.
  const candidates = new Set<number>();
  for (const probe of [guess - DAY_MS, guess, guess + DAY_MS]) {
    candidates.add(guess - zoneOffsetMs(probe, zone));
  }
  const sorted = [...candidates].sort((a, b) => a - b);
  const onDate = sorted.filter((ms) => localDate(new Date(ms), zone) === date);
  if (onDate.length > 0) return new Date(onDate[0]!);
  // No candidate lands on the date (the jump skips midnight): the first instant of the date is the first
  // whole hour after the skipped gap. Walk forward from the earliest candidate until the date matches.
  let ms = sorted[0]!;
  for (let i = 0; i < 26 * 4 && localDate(new Date(ms), zone) !== date; i += 1) ms += 15 * 60_000;
  return new Date(ms);
}

/** Adds `days` (may be negative) to a YYYY-MM-DD string using calendar arithmetic. */
export function addDays(date: string, days: number): string {
  const { y, m, d } = parseDate(date);
  return formatDate(Date.UTC(y, m - 1, d + days));
}

export function metricsWindow(now: Date, zone: string): PeriodWindow {
  const today = localDate(now, zone);
  return {
    timeZone: zone,
    todayStart: startOfLocalDay(today, zone),
    tomorrowStart: startOfLocalDay(addDays(today, 1), zone),
    since30: new Date(now.getTime() - 30 * DAY_MS),
    monthStart: startOfLocalDay(`${today.slice(0, 7)}-01`, zone),
    chartStart: startOfLocalDay(addDays(today, -13), zone),
  };
}

/** [from, to) for a period: today = today start..tomorrow start; week = Monday of this local week..next Monday;
 * month = first of local month..first of next month; last90 = start of local day 89 days ago..tomorrow start. */
export function periodRange(now: Date, zone: string, period: TimePeriod): { from: Date; to: Date } {
  const today = localDate(now, zone);
  switch (period) {
    case 'today':
      return {
        from: startOfLocalDay(today, zone),
        to: startOfLocalDay(addDays(today, 1), zone),
      };
    case 'week': {
      const { y, m, d } = parseDate(today);
      // getUTCDay: 0 = Sunday. Days since Monday: Monday 0, Sunday 6.
      const sinceMonday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
      const monday = addDays(today, -sinceMonday);
      return {
        from: startOfLocalDay(monday, zone),
        to: startOfLocalDay(addDays(monday, 7), zone),
      };
    }
    case 'month': {
      const { y, m } = parseDate(today);
      // Date.UTC month index m is the month after 1-based m, so this is the next month's first day.
      return {
        from: startOfLocalDay(`${today.slice(0, 7)}-01`, zone),
        to: startOfLocalDay(formatDate(Date.UTC(y, m, 1)), zone),
      };
    }
    case 'last90':
      return {
        from: startOfLocalDay(addDays(today, -89), zone),
        to: startOfLocalDay(addDays(today, 1), zone),
      };
  }
}

/** The 14 local dates (YYYY-MM-DD), oldest first, ending today. */
export function chartDates(now: Date, zone: string): string[] {
  const today = localDate(now, zone);
  return Array.from({ length: 14 }, (_, i) => addDays(today, i - 13));
}
