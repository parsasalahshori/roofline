import { Router } from 'express';
import { z } from 'zod';
import { type ActivityRow, listActivities, withTenant } from '@roofline/db';
import { ACTIVITY_SUBJECT_TYPES } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { limitParam, offsetParam, parse, UUID } from '../validate.ts';

const ListQuery = z.object({
  subjectType: z.enum(ACTIVITY_SUBJECT_TYPES, { error: 'Please pick customer, property, job or message.' }),
  subjectId: z
    .string({ error: MESSAGES.checkField })
    .refine((v) => UUID.test(v), MESSAGES.checkField)
    .transform((v) => v.toLowerCase()),
  limit: limitParam,
  offset: offsetParam,
});

function activityBody(row: ActivityRow) {
  return {
    id: row.id,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    kind: row.kind,
    summary: row.summary,
    data: row.data,
    actorType: row.actorType,
    actorUserId: row.actorUserId,
    actorAgent: row.actorAgent,
    at: row.at,
  };
}

/**
 * `GET /api/activities?subjectType=&subjectId=`: the timeline of one customer, property, job or message,
 * newest first, as `{ activities, total }` (`limit` default 50, at most 200, and `offset`).
 * Row-level security keeps it to the member's company, and the same visibility rule as the subject
 * itself applies: a subject the member cannot open (another company's, a customer a rep did not
 * create, one that does not exist) is a 404, never an empty list.
 */
export function activityRoutes(deps: AppDeps): Router {
  const { pools } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    const { ctx } = req;
    const query = parse(ListQuery, req.query);
    const result = await withTenant(pools, ctx, (tx) => listActivities(tx, ctx, query));
    if (!result) throw new AppError(404, MESSAGES.notFound);
    res.json({ activities: result.activities.map(activityBody), total: result.total });
  });

  return router;
}
