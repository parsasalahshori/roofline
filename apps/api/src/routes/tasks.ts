import { Router } from 'express';
import { z } from 'zod';
import { withTenant } from '@roofline/db';
import { AGENTS, TASK_STATUSES } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { canReview, listTaskFeed, workingCount } from '../tasks/service.ts';
import { limitParam, parse } from '../validate.ts';

const SINCE_MESSAGE = 'Please give a date and time such as 2026-10-12T15:00:00Z.';

const FeedQuery = z.object({
  agent: z.enum(AGENTS, { error: 'Please pick a valid agent.' }).optional(),
  status: z.enum(TASK_STATUSES, { error: 'Please pick a valid status.' }).optional(),
  since: z.iso
    .datetime({ offset: true, error: SINCE_MESSAGE })
    .transform((v) => new Date(v))
    .optional(),
  limit: limitParam,
});

/**
 * `/api/tasks`: what the agents have been doing.
 * - `GET /?agent=&status=&since=&limit=` the activity feed: the company's tasks in any status,
 *   newest first, as `{ tasks }` of list views (no payloads). `since` keeps tasks created at or
 *   after that time; `limit` is 50 by default and at most 200.
 * - `GET /summary` `{ working }`: how many tasks have a step queued or running (the "N agents
 *   working" line).
 * For the owner and the office. A rep gets `{ tasks: [] }` and `{ working: 0 }`, whatever they ask.
 */
export function taskRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    const { ctx } = req;
    if (!canReview(ctx)) {
      res.json({ tasks: [] });
      return;
    }
    const query = parse(FeedQuery, req.query);
    const tasks = await withTenant(pools, ctx, (tx) =>
      listTaskFeed(
        tx,
        ctx,
        {
          ...(query.agent !== undefined && { agent: query.agent }),
          ...(query.status !== undefined && { status: query.status }),
          ...(query.since !== undefined && { since: query.since }),
          ...(query.limit !== undefined && { limit: query.limit }),
        },
        clock.now(),
      ),
    );
    res.json({ tasks });
  });

  router.get('/summary', async (req, res) => {
    const { ctx } = req;
    if (!canReview(ctx)) {
      res.json({ working: 0 });
      return;
    }
    res.json({ working: await withTenant(pools, ctx, (tx) => workingCount(tx, ctx)) });
  });

  return router;
}
