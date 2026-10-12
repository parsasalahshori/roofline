import { Router } from 'express';
import {
  audit,
  companyStormRef,
  dismissCompanyStorm,
  getCompanyStormSummary,
  listCompanyStorms,
  stormLayer,
  stormSwath,
  withTenant,
} from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { requireCapability } from '../permissions.ts';
import { draftStormPlan } from '../storm/plan.ts';
import { stormResults } from '../storm/results.ts';
import { UUID } from '../validate.ts';

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

const DISMISSED_MESSAGE = 'This storm was dismissed, so no plan is drafted.';
const PLAN_EXISTS_MESSAGE = 'This storm already has a plan. Open it in your tasks.';
const PLAN_CHANGED_MESSAGE = 'The plan changed while we were drafting. Please try again.';
const PLAN_NOT_FOUND_MESSAGE = 'We could not find that storm.';

/** Only a draft plan may be drafted again (T11 draftStormPlan replaces a draft only). */
const REDRAFTABLE: readonly string[] = ['draft'];

/** The :id of a request as a lowercase UUID, or a 404 for anything else. */
function stormId(raw: unknown): string {
  const id = (typeof raw === 'string' ? raw : '').toLowerCase();
  if (!UUID.test(id)) throw new AppError(404, MESSAGES.notFound);
  return id;
}

/**
 * `/api/storms`: `GET /layer` is the same storm layer; `GET /` and `GET /:id` list and show the company's
 * storms (any member); `POST /:id/dismiss` and `POST /:id/plan` need `approve_internal`. `:id` is the
 * company_storms id. Everything else answers 404.
 */
export function stormRoutes(deps: AppDeps): Router {
  const router = Router();
  const guard = requireCapability('approve_internal');
  // '/layer' stays ahead of '/:id'.
  router.use('/layer', layerHandler(deps));

  router.get('/', async (req, res) => {
    const storms = await withTenant(deps.pools, req.ctx, (tx) => listCompanyStorms(tx, req.ctx));
    res.json({ storms });
  });

  router.get('/:id', async (req, res) => {
    const id = stormId(req.params.id);
    const body = await withTenant(deps.pools, req.ctx, async (tx) => {
      const storm = await getCompanyStormSummary(tx, req.ctx, id);
      const ref = await companyStormRef(tx, req.ctx, id);
      if (!storm || !ref) throw new AppError(404, MESSAGES.notFound);
      const swath = await stormSwath(tx, ref.stormId);
      const results = await stormResults(tx, req.ctx, id);
      const plan = storm.planTaskId === null ? null : { taskId: storm.planTaskId, status: storm.planStatus ?? 'draft' };
      return { storm, swath, results, plan };
    });
    res.json(body);
  });

  router.post('/:id/dismiss', guard, async (req, res) => {
    const id = stormId(req.params.id);
    const now = deps.clock.now();
    await withTenant(deps.pools, req.ctx, async (tx) => {
      if (!(await dismissCompanyStorm(tx, req.ctx, id, now))) throw new AppError(404, MESSAGES.notFound);
      await audit(tx, req.ctx, {
        action: 'storm.dismiss',
        targetType: 'company_storm',
        targetId: id,
        ip: req.ip ?? null,
        at: now,
      });
    });
    res.json({ ok: true });
  });

  router.post('/:id/plan', guard, async (req, res) => {
    const id = stormId(req.params.id);
    const { storm, ref } = await withTenant(deps.pools, req.ctx, async (tx) => ({
      storm: await getCompanyStormSummary(tx, req.ctx, id),
      ref: await companyStormRef(tx, req.ctx, id),
    }));
    if (!storm || !ref) throw new AppError(404, MESSAGES.notFound);
    if (ref.status === 'dismissed') throw new AppError(409, DISMISSED_MESSAGE);
    if (storm.planTaskId !== null && !REDRAFTABLE.includes(storm.planStatus ?? '')) {
      throw new AppError(409, PLAN_EXISTS_MESSAGE);
    }
    try {
      const { taskId } = await draftStormPlan(deps, req.ctx.companyId, id, deps.clock.now());
      res.json({ taskId });
    } catch (err) {
      const message = err instanceof Error && !(err instanceof AppError) ? err.message : '';
      if (message === DISMISSED_MESSAGE || message === PLAN_CHANGED_MESSAGE) throw new AppError(409, message);
      if (message === PLAN_NOT_FOUND_MESSAGE) throw new AppError(404, MESSAGES.notFound);
      throw err;
    }
  });

  router.use((_req, _res, next) => {
    next(new AppError(404, MESSAGES.notFound));
  });
  return router;
}
