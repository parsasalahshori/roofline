import { z } from 'zod';
import { type Clock, systemClock } from '../clock.ts';
import type { CurrentWeather, WeatherIcon, WeatherSource } from './source.ts';

const API = 'https://api.weather.gov';
const DEFAULT_TIMEOUT_MS = 4_000;

/** The icon for the forecast's words. The first rule that matches wins, so `Rain And Snow` is snow. */
const ICON_RULES: readonly (readonly [RegExp, WeatherIcon])[] = [
  [/thunder/, 'storm'],
  [/snow|sleet|flurr/, 'snow'],
  [/rain|shower|drizzle/, 'rain'],
  [/fog|haze/, 'fog'],
  [/wind|breez/, 'wind'],
  [/cloud|overcast/, 'cloud'],
];

/** Picks the icon from the National Weather Service's `shortForecast`; clear skies are sun by day and moon by night. */
export function weatherIcon(shortForecast: string, isDaytime: boolean): WeatherIcon {
  const words = shortForecast.toLowerCase();
  for (const [pattern, icon] of ICON_RULES) {
    if (pattern.test(words)) return icon;
  }
  return isDaytime ? 'sun' : 'moon';
}

// Only the pieces of the service's answers that are used. Anything else in them is ignored, and
// anything these do not accept makes the whole answer "no weather".
const PointsAnswer = z.object({ properties: z.object({ forecastHourly: z.string() }) });
// The periods are checked one at a time (only the first is read), so a bad later one does not matter.
const HourlyAnswer = z.object({ properties: z.object({ periods: z.array(z.unknown()).min(1) }) });
const Period = z.object({
  temperature: z.number(),
  temperatureUnit: z.enum(['F', 'C']).nullish(),
  shortForecast: z.string().min(1),
  isDaytime: z.boolean(),
  startTime: z.unknown().optional(),
});

export type NwsOptions = {
  /** Sent with every request. The service asks callers to say who they are (an address or a contact). */
  userAgent: string;
  /** Tests pass their own; it is looked up when a call is made, so a stubbed global works too. */
  fetch?: typeof fetch;
  /** For each request, not both together. */
  timeoutMs?: number;
  /** Where "now" comes from when a reading carries no usable start time. */
  clock?: Clock;
};

/**
 * The current weather from api.weather.gov: the place's hourly forecast, first period. That takes
 * two requests (the place's grid, then its forecast), each with its own timeout. Any failure along
 * the way, whether a status other than 200, a timeout, a network error or an answer that is not
 * what we expect, is `null`. This class never throws and logs nothing; the cache above it keeps a
 * `null` for a while so an outage is not asked about again at once.
 */
export class NwsWeatherSource implements WeatherSource {
  constructor(private readonly opts: NwsOptions) {}

  async current(lat: number, lng: number): Promise<CurrentWeather | null> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    try {
      const points = PointsAnswer.safeParse(await this.get(`${API}/points/${lat.toFixed(4)},${lng.toFixed(4)}`));
      if (!points.success) return null;
      const hourlyUrl = points.data.properties.forecastHourly;
      // The link comes from the service's answer. It is followed only if it stays on the service.
      if (new URL(hourlyUrl).origin !== API) return null;

      const hourly = HourlyAnswer.safeParse(await this.get(hourlyUrl));
      if (!hourly.success) return null;
      const period = Period.safeParse(hourly.data.properties.periods[0]);
      if (!period.success) return null;
      const { temperature, temperatureUnit, shortForecast, isDaytime, startTime } = period.data;

      return {
        tempF: Math.round(temperatureUnit === 'C' ? (temperature * 9) / 5 + 32 : temperature),
        summary: shortForecast,
        icon: weatherIcon(shortForecast, isDaytime),
        isDaytime,
        updatedAt: this.isoInstant(startTime),
      };
    } catch {
      // A timeout, a refused connection, a body that is not JSON, a link that is not a URL.
      return null;
    }
  }

  /** The JSON body of a 200 answer; anything else throws, and `current` turns that into null. */
  private async get(url: string): Promise<unknown> {
    const doFetch = this.opts.fetch ?? globalThis.fetch;
    const res = await doFetch(url, {
      headers: { 'User-Agent': this.opts.userAgent, Accept: 'application/geo+json' },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (res.status !== 200) throw new Error(`weather service answered ${res.status}`);
    return res.json();
  }

  /** `startTime` as an ISO instant, or the clock's now when it is missing or not a date. */
  private isoInstant(startTime: unknown): string {
    if (typeof startTime === 'string') {
      const at = new Date(startTime);
      if (!Number.isNaN(at.getTime())) return at.toISOString();
    }
    return (this.opts.clock ?? systemClock).now().toISOString();
  }
}
