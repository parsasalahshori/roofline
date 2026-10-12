import { z } from 'zod';
import { type Clock, systemClock } from '../clock.ts';
import type { CurrentWeather, HourlyForecast, WeatherIcon, WeatherSource } from './source.ts';

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
// The periods are checked one at a time: `current` reads only the first, so a bad later one does not
// matter; `hourly` reads the first `hours` and a bad one among them makes the whole answer "no weather".
const HourlyAnswer = z.object({ properties: z.object({ periods: z.array(z.unknown()).min(1) }) });
const Period = z.object({
  temperature: z.number(),
  temperatureUnit: z.enum(['F', 'C']).nullish(),
  shortForecast: z.string().min(1),
  isDaytime: z.boolean(),
  startTime: z.unknown().optional(),
});
// One hourly period. `probabilityOfPrecipitation.value` is null for 0% (the service's own choice), and
// the gust is missing or given as text, or as an object, depending on the period.
const HourlyPeriod = z.object({
  startTime: z.string().refine((s) => !Number.isNaN(new Date(s).getTime()), 'not a date'),
  probabilityOfPrecipitation: z.object({ value: z.number().nullish() }).nullish(),
  windSpeed: z.string().nullish(),
  windGust: z
    .union([z.string(), z.object({ unitCode: z.string().nullish(), value: z.number().nullish() }), z.null()])
    .nullish(),
});

/**
 * The gust in whole mph for one hourly period. If the service gives a gust (text like `25 mph`, or
 * an object whose `value` is a number), that is the gust. Otherwise the hourly periods usually lack
 * one, so the HIGHER number in `windSpeed` (`10 mph`, or `5 to 10 mph` gives 10) stands in for it.
 * That stand-in is deliberately conservative: it can say a gust is stronger than it was, never
 * weaker, so a weather watch errs toward warning. Neither usable gives `null`. An object gust is
 * converted from its `unitCode` (km/h, m/s, knots or mph) to mph; an unknown unit is ignored.
 */
export function gustMph(
  windGust: z.infer<typeof HourlyPeriod>['windGust'],
  windSpeed: string | null | undefined,
): number | null {
  let gust: number | null = null;
  if (typeof windGust === 'string') {
    const found = /\d+(\.\d+)?/.exec(windGust);
    if (found) gust = Number(found[0]);
  } else if (windGust) {
    const value = windGust.value;
    const unit = windGust.unitCode ?? '';
    // NWS quantitative values carry a WMO unit code (gusts normally `wmoUnit:km_h-1`); convert to mph.
    // An unrecognised unit is not guessed at: the gust is treated as absent and windSpeed stands in.
    if (typeof value === 'number') {
      if (unit === '' || unit.includes('mi_h')) gust = value;
      else if (unit.includes('km_h')) gust = value / 1.609344;
      else if (unit.includes('m_s')) gust = value * 2.236936;
      else if (unit.includes('kn')) gust = value * 1.150779;
    }
  }
  if (gust !== null && Number.isFinite(gust)) return Math.round(gust);

  const speeds = [...(windSpeed ?? '').matchAll(/\d+(\.\d+)?/g)].map((m) => Number(m[0]));
  if (speeds.length === 0) return null;
  return Math.round(Math.max(...speeds));
}

/** Chance of rain as a whole percent, 0 to 100; an absent or null value (0% at NWS) is 0. */
function precipPercent(probability: z.infer<typeof HourlyPeriod>['probabilityOfPrecipitation']): number {
  const value = probability?.value;
  if (typeof value !== 'number') return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

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
 * The weather from api.weather.gov, from the place's hourly forecast: `current` is its first period,
 * and `hourly` is its first `hours` periods (precipitation chance and wind gust). Each call takes
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

  /**
   * The next `hours` hourly periods, soonest first, from the same forecast `current` reads. Any
   * period among those `hours` that does not parse makes the whole answer `null` (a partial forecast
   * is not trusted). A forecast shorter than `hours` gives the periods that exist.
   */
  async hourly(lat: number, lng: number, hours: number): Promise<HourlyForecast[] | null> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (!Number.isInteger(hours) || hours < 1) return null;
    try {
      const points = PointsAnswer.safeParse(await this.get(`${API}/points/${lat.toFixed(4)},${lng.toFixed(4)}`));
      if (!points.success) return null;
      const hourlyUrl = points.data.properties.forecastHourly;
      // The link comes from the service's answer. It is followed only if it stays on the service.
      if (new URL(hourlyUrl).origin !== API) return null;

      const answer = HourlyAnswer.safeParse(await this.get(hourlyUrl));
      if (!answer.success) return null;

      const forecast: HourlyForecast[] = [];
      for (const raw of answer.data.properties.periods.slice(0, hours)) {
        const period = HourlyPeriod.safeParse(raw);
        if (!period.success) return null;
        forecast.push({
          at: new Date(period.data.startTime).toISOString(),
          precipPct: precipPercent(period.data.probabilityOfPrecipitation),
          gustMph: gustMph(period.data.windGust, period.data.windSpeed),
        });
      }
      return forecast;
    } catch {
      // The same failures as `current`: a timeout, a refused connection, a body that is not JSON, a bad link.
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
