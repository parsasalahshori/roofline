import { mapCopy } from '../../copy/map.ts';
import { HAIL_LEVEL_SIZES_IN } from '../../shell/map/stormLayer.ts';
import type { HailLevel } from './layerTypes.ts';

/*
 * A storm's day is a calendar day in the company's zone ("2026-10-13"), with no time of day. It is read as noon UTC and
 * printed in UTC, so no zone can move it to the day before or after.
 */
const short = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const long = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

function atNoon(day: string): Date | null {
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Tue, Oct 13". A value that is not a day is shown as it came. */
export function stormDay(day: string): string {
  const date = atNoon(day);
  return date === null ? day : short.format(date);
}

/** "Tuesday, October 13": the mono eyebrow over a storm's name. */
export function stormDayLong(day: string): string {
  const date = atNoon(day);
  return date === null ? day : long.format(date);
}

/** Hail sizes as the key reads them, from 1 (the smallest) to 5. Anything under the first size is still level 1. */
export function hailLevel(inches: number): HailLevel {
  let level = 1;
  HAIL_LEVEL_SIZES_IN.forEach((size, index) => {
    if (inches >= size) level = index + 1;
  });
  return level as HailLevel;
}

/** What that size is in a hand: "Penny", "Ping-pong". */
export function hailName(inches: number): string {
  return mapCopy.hailSizeNames[hailLevel(inches) - 1] ?? '';
}

/** Two decimals, as the radar numbers are quoted: 1.50. */
export function hailSize(inches: number): string {
  return inches.toFixed(2);
}

const whole = new Intl.NumberFormat('en-US');
/** A count with its thousands separator: 1,280. */
export function count(n: number): string {
  return whole.format(n);
}
