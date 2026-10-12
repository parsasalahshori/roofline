/** G1 weather risk and claim status flow (Task 2a). */
import { workIntervals, type WorkHours } from './availability.ts';
import type { ClaimStatus } from './more-agents.ts';

/** One hourly forecast point. `at` is an ISO instant; `precipPct` is 0-100. */
export type HourlyForecast = { at: string; precipPct: number; gustMph: number | null };

/** Company thresholds: `rainPct` (weather_rain_pct) and `gustMph` (weather_gust_mph). */
export type WeatherThresholds = { rainPct: number; gustMph: number };

export type WeatherRisk = {
  risky: boolean;
  reasons: ('rain' | 'wind')[];
  worstPrecipPct: number;
  worstGustMph: number | null;
};

const HOUR_MS = 60 * 60 * 1000;

/**
 * Weather risk over the forecast hours that overlap the company's work hours (C1's per-weekday
 * `WorkHours`, as stored in `company_settings.work_hours`) in `timeZone` (the company's zone).
 * A forecast point covers the hour starting at `at`; it counts when that hour overlaps a work
 * interval, so a 07:30 start counts the 07:00 hour and a day off counts nothing.
 * Rain when precipPct >= rainPct; wind when gustMph is non-null and >= the gust threshold.
 */
export function weatherRisk(
  hourly: readonly HourlyForecast[],
  workHours: WorkHours,
  thresholds: WeatherThresholds,
  timeZone: string,
): WeatherRisk {
  const points = hourly
    .map((p) => ({ ...p, startMs: Date.parse(p.at) }))
    .filter((p) => Number.isFinite(p.startMs));
  let intervals: { start: number; end: number }[] = [];
  if (points.length > 0) {
    const first = Math.min(...points.map((p) => p.startMs));
    const last = Math.max(...points.map((p) => p.startMs)) + HOUR_MS;
    intervals = workIntervals(workHours, new Date(first), new Date(last), timeZone).map((i) => ({
      start: i.start.getTime(),
      end: i.end.getTime(),
    }));
  }

  let rain = false;
  let wind = false;
  let worstPrecipPct = 0;
  let worstGustMph: number | null = null;

  for (const point of points) {
    const hourEnd = point.startMs + HOUR_MS;
    if (!intervals.some((i) => i.start < hourEnd && point.startMs < i.end)) continue;

    if (point.precipPct > worstPrecipPct) worstPrecipPct = point.precipPct;
    if (point.gustMph !== null && (worstGustMph === null || point.gustMph > worstGustMph)) {
      worstGustMph = point.gustMph;
    }
    if (point.precipPct >= thresholds.rainPct) rain = true;
    if (point.gustMph !== null && point.gustMph >= thresholds.gustMph) wind = true;
  }

  const reasons: ('rain' | 'wind')[] = [];
  if (rain) reasons.push('rain');
  if (wind) reasons.push('wind');

  return { risky: reasons.length > 0, reasons, worstPrecipPct, worstGustMph };
}

/** Claim status flow: the statuses the agent may move a claim to from a reply. */
export const CLAIM_STATUS_FLOW: Readonly<Record<ClaimStatus, readonly ClaimStatus[]>> = {
  // People may set any status in the job window (Task 6 decides); the flow is what the agent may do from a reply.
  not_filed: ['filed', 'closed'],
  filed: ['adjuster_scheduled', 'approved', 'partly_approved', 'denied', 'closed'],
  adjuster_scheduled: ['inspected', 'approved', 'partly_approved', 'denied', 'closed'],
  inspected: ['approved', 'partly_approved', 'denied', 'supplement_requested', 'closed'],
  approved: ['supplement_requested', 'closed'],
  partly_approved: ['supplement_requested', 'approved', 'closed'],
  denied: ['supplement_requested', 'closed'],
  supplement_requested: ['approved', 'partly_approved', 'denied', 'closed'],
  closed: [],
};

/** True when the agent may move a claim from `from` to `to` (same status is false). */
export function canMoveClaim(from: ClaimStatus, to: ClaimStatus): boolean {
  return CLAIM_STATUS_FLOW[from].includes(to);
}
