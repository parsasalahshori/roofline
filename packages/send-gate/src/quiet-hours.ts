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
 * The place names ICU knows (`America/Chicago`, `Europe/Berlin`), read once at module load, plus
 * `UTC`, which `supportedValuesOf` leaves out. ICU lists its own older spellings of a few zones
 * (`America/Indianapolis`, `Asia/Calcutta`), which is why `isTimeZone` also resolves aliases.
 */
const KNOWN_ZONES: ReadonlySet<string> = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);

/**
 * True for a real zone name such as `America/Chicago`, and for another name for one such as
 * `America/Indiana/Indianapolis` or `US/Central`. False for everything else: fixed offsets
 * (`-06:00`, `+0500`, `+05`, `Etc/GMT+5`), which have no daylight saving and name no place;
 * keywords such as `local`; and text that is not a zone at all. A customer's zone must be a place,
 * so a fixed offset must never stand in for it.
 *
 * Only a name with a `/` is looked up as an alias, and it counts only if it resolves to a zone in
 * the known list. The check runs against the text exactly as given (no trimming).
 */
export function isTimeZone(zone: string): boolean {
  if (typeof zone !== 'string') return false;
  if (KNOWN_ZONES.has(zone)) return true;
  if (!zone.includes('/')) return false;
  try {
    return KNOWN_ZONES.has(new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone);
  } catch {
    return false; // Intl throws a RangeError for a name it does not know
  }
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
