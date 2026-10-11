import { Router } from 'express';
import { type Bbox, mapArea, mapPins, type PinLayer, withTenant } from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { AppError } from '../errors.ts';

const BBOX_MESSAGE = 'Please give the map area as west,south,east,north.';
const LAYERS_MESSAGE = 'Please pick customers, jobs or both.';

/** A plain decimal number: an optional sign, digits and an optional fraction. No exponent, no `Infinity`, no blank. */
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

const LAYERS: readonly PinLayer[] = ['customers', 'jobs'];

/**
 * `bbox=west,south,east,north` in degrees: four numbers with -180 <= west < east <= 180 and
 * -90 <= south < north <= 90. A box across the antimeridian is not supported.
 */
function parseBbox(value: unknown): Bbox {
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
  return { west, south, east, north };
}

/** `layers=customers,jobs`; left out, both. */
function parseLayers(value: unknown): ReadonlySet<PinLayer> {
  if (value === undefined) return new Set(LAYERS);
  if (typeof value !== 'string') throw new AppError(400, LAYERS_MESSAGE, 'layers');
  const picked = new Set<PinLayer>();
  for (const part of value.split(',').map((p) => p.trim())) {
    const layer = LAYERS.find((known) => known === part);
    if (layer === undefined) throw new AppError(400, LAYERS_MESSAGE, 'layers');
    picked.add(layer);
  }
  return picked;
}

/**
 * `/api/map`: what the map shows. Any member may call these; a rep sees only their own side.
 * - `GET /pins?bbox=w,s,e,n&layers=customers,jobs` the pins inside the box: `{ mode: 'points',
 *   customers, jobs }`, or above 2,000 pins in all `{ mode: 'clusters', clusters, total }`.
 * - `GET /area` `{ serviceArea, bounds }`: the company's service area (GeoJSON or null) and where
 *   the map should start (`[west, south, east, north]` or null).
 */
export function mapRoutes(deps: AppDeps): Router {
  const { pools } = deps;
  const router = Router();

  router.get('/pins', async (req, res) => {
    const { ctx } = req;
    const bbox = parseBbox(req.query['bbox']);
    const layers = parseLayers(req.query['layers']);
    res.json(await withTenant(pools, ctx, (tx) => mapPins(tx, ctx, bbox, layers)));
  });

  router.get('/area', async (req, res) => {
    const { ctx } = req;
    res.json(await withTenant(pools, ctx, (tx) => mapArea(tx, ctx)));
  });

  return router;
}
