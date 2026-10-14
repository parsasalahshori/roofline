import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.ts';
import { estimateFromFootprint, estimateFromPoint, FootprintAddressCache } from '../estimator/from-footprint.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { mapEstimateRateLimit } from '../rate-limit.ts';
import { assertKnownFields, parse } from '../validate.ts';

const CHECK_MESSAGE = 'Please check this field.';
const FIELDS = ['footprintId', 'lat', 'lng'] as const;
const POINT_FIELDS = ['lat', 'lng'] as const;

const PointBody = z
  .object({
    lat: z.number({ error: CHECK_MESSAGE }).finite(CHECK_MESSAGE).min(-90, CHECK_MESSAGE).max(90, CHECK_MESSAGE),
    lng: z.number({ error: CHECK_MESSAGE }).finite(CHECK_MESSAGE).min(-180, CHECK_MESSAGE).max(180, CHECK_MESSAGE),
  })
  .strict();

const Body = z
  .object({
    /** Footprint ids are the global table's bigserial numbers, written as strings. */
    footprintId: z.string({ error: CHECK_MESSAGE }).regex(/^\d{1,19}$/, CHECK_MESSAGE),
    lat: z.number({ error: CHECK_MESSAGE }).finite(CHECK_MESSAGE).min(-90, CHECK_MESSAGE).max(90, CHECK_MESSAGE),
    lng: z.number({ error: CHECK_MESSAGE }).finite(CHECK_MESSAGE).min(-180, CHECK_MESSAGE).max(180, CHECK_MESSAGE),
  })
  .strict();

/**
 * `POST /api/estimator/from-footprint` `{ footprintId, lat, lng }` (owner and office): "Estimate this roof" from the
 * map. 201 `{ measurementId }`; 404 `{ error: 'no_building' }` for an unknown building. One reverse lookup per
 * building, cached for the life of the process.
 * `POST /api/estimator/from-point` `{ lat, lng }` (owner and office): the same for a roof with no footprint (Google
 * Solar's): the address is the point's, the roof is measured at the point. 404 when the point has no address.
 */
export function estimatorMapRoutes(deps: AppDeps): Router {
  const router = Router();
  const cache = new FootprintAddressCache();

  router.post('/from-footprint', mapEstimateRateLimit(), async (req, res) => {
    const { ctx } = req;
    if (ctx.role !== 'owner' && ctx.role !== 'office') throw new AppError(403, MESSAGES.roleCannot);
    const body = parse(Body, assertKnownFields(req.body, FIELDS));
    const result = await estimateFromFootprint(deps, ctx, cache, { footprintId: body.footprintId, click: [body.lng, body.lat] });
    res.status(201).json(result);
  });

  // A roof with no footprint (Google Solar's roof under the click): the estimate starts from the point.
  router.post('/from-point', mapEstimateRateLimit(), async (req, res) => {
    const { ctx } = req;
    if (ctx.role !== 'owner' && ctx.role !== 'office') throw new AppError(403, MESSAGES.roleCannot);
    const body = parse(PointBody, assertKnownFields(req.body, POINT_FIELDS));
    const result = await estimateFromPoint(deps, ctx, cache, { click: [body.lng, body.lat] });
    res.status(201).json(result);
  });

  return router;
}
