import { Router } from 'express';
import { z } from 'zod';
import { timelinePage, timelineSubjectVisible, type TimelineQuery, withTenant } from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { limitParam, parse, UUID } from '../validate.ts';

/** `?before=` must be a date the server can read; anything else is a bad request. */
const TimelineParams = z.object({
  customerId: z.string({ error: MESSAGES.checkField }).optional(),
  jobId: z.string({ error: MESSAGES.checkField }).optional(),
  before: z
    .string({ error: MESSAGES.checkField })
    .refine((value) => !Number.isNaN(Date.parse(value)), MESSAGES.checkField)
    .optional(),
  limit: limitParam,
});

/**
 * `/api/timeline`: one subject's merged timeline, newest first, a page at a time (C1 Task 7).
 * - Exactly one of `customerId` or `jobId`; neither or both is a 400.
 * - A subject the member may not see (another company's, out of their scope, or missing) is a 404,
 *   the same as an id that does not exist. A malformed id is a 404 too.
 */
export function timelineRoutes(deps: AppDeps): Router {
  const { pools } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    const { ctx } = req;
    const query = parse(TimelineParams, req.query);
    const byCustomer = query.customerId !== undefined;
    if (byCustomer === (query.jobId !== undefined)) throw new AppError(400, MESSAGES.checkField);

    const id = (byCustomer ? query.customerId : query.jobId) ?? '';
    const lower = id.toLowerCase();
    if (!UUID.test(lower)) throw new AppError(404, MESSAGES.notFound);

    const q: TimelineQuery = {
      ...(byCustomer ? { customerId: lower } : { jobId: lower }),
      ...(query.before !== undefined && { before: new Date(query.before) }),
      ...(query.limit !== undefined && { limit: query.limit }),
    };
    const page = await withTenant(pools, ctx, async (tx) =>
      (await timelineSubjectVisible(tx, ctx, q)) ? timelinePage(tx, ctx, q) : null,
    );
    if (page === null) throw new AppError(404, MESSAGES.notFound);
    res.json(page);
  });

  return router;
}
