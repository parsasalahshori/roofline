import { Router } from 'express';
import { stormLayer, withTenant } from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';

const BBOX_MESSAGE = 'Please give the map area as west,south,east,north.';
const ZOOM_MESSAGE = 'Please give the map zoom as a whole number from 0 to 22.';
const DAYS_MESSAGE = 'Please give the number of days as a whole number from 1 to 30.';

const ZOOM_MIN = 0;
const ZOOM_MAX = 22;
const ZOOM_DEFAULT = 10;
const DAYS_MIN = 1;
const DAYS_MAX = 30;
const DAYS_DEFAULT = 7;

/** A plain decimal number: an optional sign, digits and an optional fraction. No exponent, no `Infinity`, no blank. */
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
const WHOLE = /^\d+$/;

/**
 * `bbox=west,south,east,north` in degrees: four numbers with -180 <= west < east <= 180 and
 * -90 <= south < north <= 90. A box across the antimeridian is not supported.
 */
function parseBbox(value: unknown): [number, number, number, number] {
  if (typeof value !== 'string') throw new AppError(400, BBOX_MESSAGE, 'bbox');
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length !== 4 || !parts.every((part) => DECIMAL.test(part))) throw new AppError(400, BBOX_MESSAGE, 'bbox');
  const [west, south, east, north] = parts.map(Number) as [number, number, number, number];
  const inRange =
    [west, south, east, north].every(Number.isFinite) &&
    west >= -180 &&
    east <= 180 &&
    west < east &&
    south >= -90 &&
    north <= 90 &&
    south < north;
  if (!inRange) throw new AppError(400, BBOX_MESSAGE, 'bbox');
  return [west, south, east, north];
}

/** An optional whole number in [min, max]; `fallback` when left out. */
function parseWhole(value: unknown, field: string, message: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !WHOLE.test(value.trim())) throw new AppError(400, message, field);
  const n = Number(value.trim());
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new AppError(400, message, field);
  return n;
}

function layerHandler(deps: AppDeps): Router {
  const router = Router();
  router.get('/', async (req, res) => {
    const bbox = parseBbox(req.query['bbox']);
    const zoom = parseWhole(req.query['zoom'], 'zoom', ZOOM_MESSAGE, ZOOM_MIN, ZOOM_MAX, ZOOM_DEFAULT);
    const days = parseWhole(req.query['days'], 'days', DAYS_MESSAGE, DAYS_MIN, DAYS_MAX, DAYS_DEFAULT);
    const now = deps.clock.now();
    const { swaths, spots, newestRunAt } = await withTenant(deps.pools, req.ctx, (tx) => stormLayer(tx, { bbox, days, zoom, now }));
    const stale = newestRunAt === null || now.getTime() - newestRunAt.getTime() > deps.config.HAIL_STALE_MINUTES * 60_000;
    res.json({ swaths, spots, newestRunAt: newestRunAt === null ? null : newestRunAt.toISOString(), stale });
  });
  return router;
}

/**
 * `GET /storm-layer?bbox=w,s,e,n&zoom=10&days=7`: the hail swaths and spotter reports in the box,
 * `{ swaths, spots, newestRunAt, stale }`. Any member may call it; the data is global.
 * Mounted at `/api/map` (app.ts: `app.use('/api/map', stormLayerRoutes(deps))`).
 */
export function stormLayerRoutes(deps: AppDeps): Router {
  const router = Router();
  router.use('/storm-layer', layerHandler(deps));
  return router;
}

/** `/api/storms`: `GET /layer` is the same storm layer; the rest answers 404 until later S1 tasks build it. */
export function stormRoutes(deps: AppDeps): Router {
  const router = Router();
  router.use('/layer', layerHandler(deps));
  router.use((_req, _res, next) => {
    next(new AppError(404, MESSAGES.notFound));
  });
  return router;
}
