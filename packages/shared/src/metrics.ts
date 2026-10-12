/*
 * Agents screen (A1) display metrics: success rate and the "about ... hours" / "≈ $..." labels.
 * Pure functions: no DB, no clock. `hoursLabel` already says "about"; `moneyLabel` starts with "≈". The caller
 * adds "(estimate)" next to every time or money figure (spec 3.3).
 */

/** A success rate needs at least this many runs; below it the rate is not shown. */
const MIN_RUNS_FOR_RATE = 5;

/**
 * Share of runs that went well: a done run counts 1, a partly done run counts 0.5.
 * Null when fewer than 5 runs (or a non-finite run count), so no rate is shown.
 */
export function successRate(i: {
  done: number;
  partlyDone: number;
  ran: number;
}): number | null {
  if (!Number.isFinite(i.ran) || i.ran < MIN_RUNS_FOR_RATE) return null;
  return (i.done + 0.5 * i.partlyDone) / i.ran;
}

/** Negative, NaN and infinite minute values count as zero. */
function safeMinutes(minutes: number): number {
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
}

/**
 * Hours as a short phrase: under 10 hours round to the nearest half hour, otherwise to the nearest hour.
 * Examples: 1860 -> 'about 31 hours', 270 -> 'about 4.5 hours', 60 -> 'about 1 hour', 30 -> 'about 0.5 hours'.
 */
export function hoursLabel(minutes: number): string {
  const hours = safeMinutes(minutes) / 60;
  const rounded = hours < 10 ? Math.round(hours * 2) / 2 : Math.round(hours);
  const unit = rounded === 1 ? "hour" : "hours";
  return `about ${rounded} ${unit}`;
}

/** Whole-dollar estimate of the time's worth at the hourly rate (cents), e.g. '≈ $870'. Uses the true minutes. */
export function moneyLabel(minutes: number, hourlyRateCents: number): string {
  const rate =
    Number.isFinite(hourlyRateCents) && hourlyRateCents > 0
      ? hourlyRateCents
      : 0;
  const dollars = Math.round(((safeMinutes(minutes) / 60) * rate) / 100);
  return `≈ $${dollars.toLocaleString("en-US")}`;
}
