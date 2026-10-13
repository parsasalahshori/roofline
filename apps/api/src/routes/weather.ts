import { Router } from 'express';
import {
  agentCompanyFacts,
  companyLocation,
  weatherInstallCandidates,
  weatherSettings,
  withTenant,
  zoneDayAfter,
  zoneDayStart,
} from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { localParts } from '../agents/schedule.ts';
import { WeatherCache } from '../weather/cache.ts';
import { weatherIcon } from '../weather/nws.ts';
import type { DailyForecast, WeatherIcon } from '../weather/source.ts';

/** Days the outlook shows, today first. */
const OUTLOOK_DAYS = 6;
/** The forecast is asked for a little more than it shows, because today's row may be dropped or thin. */
const FORECAST_ASK_DAYS = 8;
const FORECAST_TTL_MS = 30 * 60_000;

/** One tile of `GET /api/weather/outlook`. `risky`: the rain chance reaches the company's rain threshold (Scheduler's own rule). */
export type OutlookDay = {
  /** YYYY-MM-DD, the company's local date. */
  date: string;
  highF: number | null;
  precipChancePercent: number | null;
  icon: WeatherIcon;
  risky: boolean;
  /** Scheduled installs that day. Always 0 for a rep. */
  installs: number;
};

/** `GET /api/weather/outlook`: the days, the company's local today, and the installs on risky days. */
export type WeatherOutlook = {
  today: string;
  days: OutlookDay[];
  /** Installs scheduled on risky days. */
  atRisk: number;
  /** The risky day with the most installs (the earliest on a tie): the day the Scheduler would move them off. Null when no install is at risk. */
  worstDate: string | null;
};

/**
 * `GET /api/weather`: `{ weather }`, the current weather at the company's location, or
 * `{ weather: null }` when there is none to show (no location yet, or the weather service is
 * unavailable or does not cover the place). It is never an error: weather is a nicety, and the
 * screen hides it when it is null. Any signed-in member may read it.
 *
 * Everyone in a company shares one answer per place, kept for 30 minutes (weather/cache.ts).
 */
export function weatherRoutes(deps: AppDeps): Router {
  const { pools, clock, weather, logError } = deps;
  const cache = new WeatherCache(weather, clock);
  const router = Router();
  const forecasts = new Map<string, { at: number; days: DailyForecast[] | null }>();

  router.get('/', async (req, res) => {
    const { ctx } = req;
    const place = await withTenant(pools, ctx, (tx) => companyLocation(tx, ctx));
    if (!place) {
      res.json({ weather: null });
      return;
    }

    let current = null;
    try {
      // About a kilometre: a pin added next door does not ask the service again.
      current = await cache.get(`${ctx.companyId}:${place.lat.toFixed(2)},${place.lng.toFixed(2)}`, place.lat, place.lng);
    } catch (err) {
      // A source answers null for every failure it expects, so a throw is a bug worth a look. The
      // cache hands it only to the request that caused the miss, so it is logged once.
      logError?.(err, 'weather');
    }
    res.json({ weather: current });
  });

  /**
   * `GET /api/weather/outlook`: `{ outlook }`, the next six days of the forecast with the Scheduler's rain rule and the
   * installs it would move, or `{ outlook: null }` when there is no forecast to show (no location, or the service is
   * unavailable). Never an error. Install counts are 0 for a rep. The forecast is kept for 30 minutes per place.
   */
  router.get('/outlook', async (req, res) => {
    const { ctx } = req;
    const place = await withTenant(pools, ctx, (tx) => companyLocation(tx, ctx));
    if (!place) {
      res.json({ outlook: null });
      return;
    }
    const now = clock.now();
    const key = `${ctx.companyId}:${place.lat.toFixed(2)},${place.lng.toFixed(2)}`;
    let entry = forecasts.get(key);
    if (!entry || now.getTime() - entry.at >= FORECAST_TTL_MS) {
      let days: DailyForecast[] | null = null;
      try {
        days = await weather.daily(place.lat, place.lng, FORECAST_ASK_DAYS);
      } catch (err) {
        logError?.(err, 'weather');
      }
      entry = { at: now.getTime(), days };
      forecasts.set(key, entry);
    }
    const daily = entry.days;

    const facts = await withTenant(pools, ctx, async (tx) => {
      const company = await agentCompanyFacts(tx, ctx);
      const settings = await weatherSettings(tx, ctx);
      return company ? { tz: company.timeZone, rainPct: settings.rainPct } : null;
    });
    if (!facts || !daily) {
      res.json({ outlook: null });
      return;
    }
    const today = localParts(now, facts.tz).localDate;
    const shown = daily.filter((d) => d.date >= today).slice(0, OUTLOOK_DAYS);
    if (shown.length === 0) {
      res.json({ outlook: null });
      return;
    }

    // Installs per local day, for the days shown. A rep sees none: the counts are the company's schedule.
    const installs = new Map<string, number>();
    if (ctx.role !== 'rep') {
      const from = zoneDayStart(shown[0]!.date, facts.tz);
      const to = zoneDayStart(zoneDayAfter(shown[shown.length - 1]!.date), facts.tz);
      const found = await withTenant(pools, ctx, (tx) => weatherInstallCandidates(tx, ctx, { from, to }));
      for (const install of found) {
        const date = localParts(install.startsAt, facts.tz).localDate;
        installs.set(date, (installs.get(date) ?? 0) + 1);
      }
    }

    const days: OutlookDay[] = shown.map((d) => ({
      date: d.date,
      highF: d.highF,
      precipChancePercent: d.precipChancePercent,
      icon: weatherIcon(d.summary, true),
      risky: d.precipChancePercent !== null && d.precipChancePercent >= facts.rainPct,
      installs: installs.get(d.date) ?? 0,
    }));
    let atRisk = 0;
    let worst: OutlookDay | null = null;
    for (const d of days) {
      if (!d.risky || d.installs === 0) continue;
      atRisk += d.installs;
      if (worst === null || d.installs > worst.installs) worst = d;
    }
    const outlook: WeatherOutlook = { today, days, atRisk, worstDate: worst?.date ?? null };
    res.json({ outlook });
  });

  return router;
}
