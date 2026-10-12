/** G1 weather risk and claim status flow (Task 2a). */
import type { ClaimStatus } from './more-agents.ts';

/** One hourly forecast point. `at` is an ISO instant; `precipPct` is 0-100. */
export type HourlyForecast = { at: string; precipPct: number; gustMph: number | null };

/** Local work hours, 0-23, `end` exclusive (e.g. 7 and 18). */
export type LocalWorkHours = { start: number; end: number };

/** Company thresholds: `rainPct` (weather_rain_pct) and `gustMph` (weather_gust_mph). */
export type WeatherThresholds = { rainPct: number; gustMph: number };

export type WeatherRisk = {
  risky: boolean;
  reasons: ('rain' | 'wind')[];
  worstPrecipPct: number;
  worstGustMph: number | null;
};

/**
 * Weather risk over the forecast hours that fall inside work hours in `timeZone`.
 * Rain when precipPct >= rainPct; wind when gustMph is non-null and >= gustMph threshold.
 */
export function weatherRisk(
  hourly: readonly HourlyForecast[],
  workHours: LocalWorkHours,
  thresholds: WeatherThresholds,
  timeZone: string,
): WeatherRisk {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  });

  let rain = false;
  let wind = false;
  let worstPrecipPct = 0;
  let worstGustMph: number | null = null;

  for (const point of hourly) {
    const localHour = localHourOf(formatter, point.at);
    if (localHour < workHours.start || localHour >= workHours.end) continue;

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

function localHourOf(formatter: Intl.DateTimeFormat, iso: string): number {
  const part = formatter.formatToParts(new Date(iso)).find((p) => p.type === 'hour');
  const hour = Number(part?.value ?? NaN);
  // Some engines render midnight as 24 even with h23; normalize it to 0.
  return hour === 24 ? 0 : hour;
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
