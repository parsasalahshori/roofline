import { Router } from 'express';
import { companyLocation, withTenant } from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { WeatherCache } from '../weather/cache.ts';

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

  return router;
}
