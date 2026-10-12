// Task 4 package B: yes replies, ad budgets, circle math, storm day labels.
import { localDate } from './time-zone.ts';

/** Google Ads' minimum radius for a targeting circle, in metres. */
export const GOOGLE_MIN_CIRCLE_RADIUS_M = 1000;

/** Meta's minimum radius for a targeting circle, in metres (1 mile). Callers apply it; see nextCircleRadiusM. */
export const META_MIN_CIRCLE_RADIUS_M = 1609;

/** The whole-message replies that count as a homeowner saying yes to a storm offer. */
const YES_SET: ReadonlySet<string> = new Set([
  'yes',
  'y',
  'yeah',
  'yep',
  'sure',
  'ok',
  'okay',
  'please',
  'book',
  '\u{1F44D}', // thumbs-up
]);

/** A letter, digit or pictographic symbol: anything that is part of a word, as opposed to punctuation or space. */
const EDGE_PUNCT = /^[^\p{L}\p{N}\p{Extended_Pictographic}]+|[^\p{L}\p{N}\p{Extended_Pictographic}]+$/gu;

/**
 * True when the whole reply is one of the yes words (or a thumbs-up), ignoring case, edge
 * punctuation, emoji variation selectors and skin tones, and extra spaces. Any other word makes it
 * false, so "yes stop" and "yes please call me" are not a yes. Punctuation inside a word is kept,
 * so "y'es" and "yes, thanks" do not match.
 */
export function isYesReply(body: string): boolean {
  const s = body
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\u{FE0F}|\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF}/gu, '')
    .replace(EDGE_PUNCT, '')
    .trim()
    .replace(/\s+/g, ' ');
  return YES_SET.has(s);
}

/**
 * Splits a daily or campaign budget (integer cents) between Google and Meta. `googleSharePct` is
 * clamped to 0..100 and the Google share is rounded to the nearest cent; Meta gets the rest, so
 * `google + meta === totalCents` always. A negative, NaN or infinite total is treated as 0 (a
 * fractional total is floored).
 */
export function splitAdBudget(totalCents: number, googleSharePct: number): { google: number; meta: number } {
  const total = Number.isFinite(totalCents) ? Math.max(0, Math.floor(totalCents)) : 0;
  const pct = Number.isNaN(googleSharePct) ? 0 : Math.min(100, Math.max(0, googleSharePct));
  const google = Math.round((total * pct) / 100);
  return { google, meta: total - google };
}

/**
 * The per-day spend that keeps `days` days of spend within `maxCents`: floor(max / days), so
 * `daily * days <= maxCents`. Returns 0 when `days` is below 1 or not finite, or the maximum is 0
 * or less (or not finite).
 */
export function dailyBudgetCents(maxCents: number, days: number): number {
  if (!Number.isFinite(days) || days < 1) return 0;
  if (!Number.isFinite(maxCents) || maxCents <= 0) return 0;
  return Math.floor(maxCents / days);
}

/**
 * The next targeting-circle radius (metres) after `prevM`: double it, never below Google's
 * 1000 m minimum. A zero, negative or NaN previous radius starts at 1000. Meta's 1609 m minimum
 * is applied by the caller (META_MIN_CIRCLE_RADIUS_M).
 */
export function nextCircleRadiusM(prevM: number): number {
  if (!(prevM > 0)) return GOOGLE_MIN_CIRCLE_RADIUS_M;
  return Math.max(GOOGLE_MIN_CIRCLE_RADIUS_M, prevM * 2);
}

/** Distance between centres of neighbouring hexagons in a honeycomb of circles of `radiusM`: r * sqrt(3). */
export function hexCenterSpacingM(radiusM: number): number {
  return radiusM * Math.sqrt(3);
}

/**
 * A short label for a storm's convective day (`YYYY-MM-DD`) as seen from `now` in zone `tz`:
 * 'today', 'yesterday', or 'on <weekday>' (for example 'on Tuesday'). Dates are compared in the
 * company's zone, not UTC.
 */
export function stormDayLabel(convectiveDay: string, now: Date, tz: string): string {
  const today = localDate(now, tz);
  if (convectiveDay === today) return 'today';
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const yesterday = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  if (convectiveDay === yesterday) return 'yesterday';
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(`${convectiveDay}T12:00:00Z`),
  );
  return `on ${weekday}`;
}
