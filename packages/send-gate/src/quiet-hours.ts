import { isTimeZone } from '@roofline/shared';
import { DateTime } from 'luxon';

/** Texts go out from 08:00 local time. */
const WINDOW_START_HOUR = 8;
/** ...until 21:00 local time, the standard end of the window. */
const STANDARD_END_HOUR = 21;
/** Florida, Oklahoma and Maryland cut the window short at 20:00 (and cap marketing at 3 per 24 hours). */
const STRICT_END_HOUR = 20;
const STRICT_STATES: ReadonlySet<string> = new Set(['FL', 'OK', 'MD']);

/** True for the states with the shorter window and the 3-per-24-hours limit. Case and spaces are ignored. */
export function isStrictState(state: string | null | undefined): boolean {
  return state != null && STRICT_STATES.has(state.trim().toUpperCase());
}

/**
 * The earliest moment at or after `t` when a text may go out to someone in `tz`: 08:00 to 21:00 on
 * the wall clock there, or to 20:00 when `state` is FL, OK or MD (case and spaces ignored).
 *
 * - Inside the window: `t` itself.
 * - Before the window opens: 08:00 the same local day.
 * - At or after the window closes: 08:00 the next local day.
 *
 * The arithmetic is on the local wall clock, so it holds across daylight saving: 08:00 exists on
 * both change days (the changes happen in the small hours), and "tomorrow at 08:00" is 08:00 local
 * whether the night was 23 or 25 hours long.
 *
 * Throws on an invalid date or an unknown zone: a wrong guess here would text someone at night.
 */
export function nextAllowedTime(t: Date, tz: string, state: string | null): Date {
  if (Number.isNaN(t.getTime())) throw new RangeError('nextAllowedTime: invalid date');
  if (!isTimeZone(tz)) throw new RangeError(`nextAllowedTime: unknown time zone "${tz}"`);

  const local = DateTime.fromJSDate(t, { zone: tz });
  const atHour = (day: DateTime, hour: number) => day.set({ hour, minute: 0, second: 0, millisecond: 0 });

  const opens = atHour(local, WINDOW_START_HOUR);
  const closes = atHour(local, isStrictState(state) ? STRICT_END_HOUR : STANDARD_END_HOUR);

  if (local.toMillis() < opens.toMillis()) return opens.toJSDate();
  if (local.toMillis() >= closes.toMillis()) return atHour(local.plus({ days: 1 }), WINDOW_START_HOUR).toJSDate();
  return new Date(t.getTime());
}
