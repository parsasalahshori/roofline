// Zone helpers for the calendar. Everything goes through Intl.DateTimeFormat in the company zone;
// Date local-time getters and setters are never used. Pure UTC arithmetic (Date.UTC) only carries
// calendar days, and the instant of a zone midnight is resolved from the zone's own offsets.
export type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    partsFormatters.set(zone, formatter);
  }
  return formatter;
}

/** A cached en-US formatter for `options` in `zone` (the options are fixed per call site). */
function cachedFormatter(key: string, zone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const cacheKey = `${key}|${zone}`;
  let formatter = formatterCache.get(cacheKey);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone });
    formatterCache.set(cacheKey, formatter);
  }
  return formatter;
}

/** Wall-clock parts of `date` in `zone`. `weekday`: 1 = Monday ... 7 = Sunday. */
export function zonedParts(date: Date, zone: string): ZonedParts {
  const values: Record<string, string> = {};
  for (const part of partsFormatter(zone).formatToParts(date)) {
    values[part.type] = part.value;
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: WEEKDAYS[values.weekday ?? ''] ?? 0,
  };
}

/** The wall clock of `instant` in `zone`, read as if it were UTC (milliseconds). */
function wallAsUtc(instant: number, zone: string): number {
  const p = zonedParts(new Date(instant), zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** The zone's offset from UTC at `instant`, in milliseconds (positive east of Greenwich). */
function offsetAt(instant: number, zone: string): number {
  const wholeSeconds = instant - (((instant % 1000) + 1000) % 1000);
  return wallAsUtc(wholeSeconds, zone) - wholeSeconds;
}

/** The instant of 00:00 on the zone's calendar day y-m-d. Re-checks the offset once so that DST days land on the right instant. */
function zonedMidnight(year: number, month: number, day: number, zone: string): Date {
  const wall = Date.UTC(year, month - 1, day, 0, 0, 0);
  const firstOffset = offsetAt(wall, zone);
  const firstGuess = wall - firstOffset;
  const secondOffset = offsetAt(firstGuess, zone);
  if (secondOffset === firstOffset) return new Date(firstGuess);
  return new Date(wall - secondOffset);
}

/** The instant of 00:00 on the zone's calendar day containing `date` (DST-safe). */
export function startOfZonedDay(date: Date, zone: string): Date {
  const p = zonedParts(date, zone);
  return zonedMidnight(p.year, p.month, p.day, zone);
}

/** The instant of 00:00, `days` calendar days after the zone day containing `date` (days may be negative; DST-safe). */
export function addZonedDays(date: Date, days: number, zone: string): Date {
  const p = zonedParts(date, zone);
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return zonedMidnight(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), zone);
}

/** 00:00 of the Monday of the zone's week containing `date`. */
export function weekStart(date: Date, zone: string): Date {
  const p = zonedParts(date, zone);
  return addZonedDays(date, -(p.weekday - 1), zone);
}

/** Short clock time such as "9:30 AM" in the zone. */
export function formatTime(date: Date, zone: string): string {
  const formatter = cachedFormatter('time', zone, { hour: 'numeric', minute: '2-digit' });
  // Recent ICU puts a narrow no-break space before AM/PM; a plain space reads and tests the same.
  return formatter.format(date).replace(/[\u00a0\u202f]/g, ' ');
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** "YYYY-MM-DD" of the zone day containing `date`. */
export function zonedDateKey(date: Date, zone: string): string {
  const p = zonedParts(date, zone);
  return `${String(p.year).padStart(4, '0')}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** The instant of 00:00 of zone day "YYYY-MM-DD". */
export function dateKeyToInstant(key: string, zone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (match === null) throw new RangeError(`Not a calendar day: ${key}`);
  return zonedMidnight(Number(match[1]), Number(match[2]), Number(match[3]), zone);
}

/**
 * The instant whose wall clock in `zone` on `dateKey` (YYYY-MM-DD) reads hour:minute. Correct on 23 and 25
 * hour days; a wall time inside a spring-forward gap resolves to the following valid minute.
 */
export function zonedWallToInstant(dateKey: string, hour: number, minute: number, zone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (match === null) throw new RangeError(`Not a calendar day: ${dateKey}`);
  const target = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hour, minute);
  let instant = dateKeyToInstant(dateKey, zone).getTime() + (hour * 60 + minute) * 60_000;
  // Read the wall clock back and move by the difference; two passes settle across a clock change.
  for (let pass = 0; pass < 2; pass += 1) {
    const diff = target - wallAsUtc(instant, zone);
    if (diff === 0) break;
    instant += diff;
  }
  return new Date(instant);
}

/** Minutes since the zone-day start of `dayStart` (a startOfZonedDay result) to `instant`; real elapsed minutes, so DST days are 23h or 25h. */
export function minutesIntoDay(dayStart: Date, instant: Date): number {
  return (instant.getTime() - dayStart.getTime()) / 60_000;
}

/** Long label such as "Mon, Nov 2" for the zone day of `date`. */
export function formatDayLabel(date: Date, zone: string): string {
  return cachedFormatter('day', zone, { weekday: 'short', month: 'short', day: 'numeric' }).format(date).replace(/[\u00a0\u202f]/g, ' ');
}

/**
 * Label of the range, e.g. "Nov 2 - Nov 8, 2026". `to` is exclusive (the first instant after the
 * range), so the last day shown is the zone day before it.
 */
export function formatRangeLabel(from: Date, to: Date, zone: string): string {
  const last = addZonedDays(to, -1, zone);
  const fromParts = zonedParts(from, zone);
  const lastParts = zonedParts(last, zone);
  const startLabel = cachedFormatter('rangeStart', zone, { month: 'short', day: 'numeric' }).format(from);
  const endLabel = cachedFormatter('rangeEnd', zone, { month: 'short', day: 'numeric', year: 'numeric' }).format(last);
  // A range that crosses a new year names the year on both ends
  const start = fromParts.year === lastParts.year ? startLabel : `${startLabel}, ${fromParts.year}`;
  return `${start} - ${endLabel}`.replace(/[\u00a0\u202f]/g, ' ');
}

/** Time zone name for the note, e.g. "Central Time". */
export function zoneName(zone: string): string {
  try {
    const part = cachedFormatter('zoneName', zone, { timeZoneName: 'longGeneric' })
      .formatToParts(new Date())
      .find((candidate) => candidate.type === 'timeZoneName');
    return part?.value ?? zone;
  } catch {
    return zone;
  }
}

/** The browser's zone (Intl.DateTimeFormat().resolvedOptions().timeZone). */
export function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
