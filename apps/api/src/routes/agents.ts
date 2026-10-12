/*
 * `/api/agents` (A1 Task 5). This router defines only `GET /` (the overview) and `GET /:agent` (one
 * agent's detail, `?period=today|week|month|last90`, default month).
 *
 * Mount order: app.ts mounts the feed router (agents-feed.ts) first, this router (GET / and GET /:agent)
 * after it, and the settings router (agents-settings.ts) later. `/:agent` answers only for a real screen
 * agent and calls next() for anything else (e.g. /time-baselines), so the later routers get it. Anything
 * still unmatched gets the app's 404 `{ error }`.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant } from '@roofline/db';
import { isScreenAgent, TIME_PERIODS } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { buildDetail, buildOverview } from '../agents/metrics.ts';
import { parse } from '../validate.ts';

const PERIOD_MESSAGE = 'Please pick today, week, month or last90.';

const PeriodQuery = z.object({
  period: z.enum(TIME_PERIODS, { error: PERIOD_MESSAGE }).optional(),
});

/** `/api/agents`: the Agents screen. Totals are role-scoped: a rep sees only the work on their own jobs and customers. */
export function agentsRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    const { ctx } = req;
    const overview = await withTenant(pools, ctx, (tx) => buildOverview(tx, ctx, clock.now()));
    res.json(overview);
  });

  router.get('/:agent', async (req, res, next) => {
    const agent = req.params.agent;
    if (!isScreenAgent(agent)) {
      next();
      return;
    }
    const query = parse(PeriodQuery, req.query);
    const period = query.period ?? 'month';
    const { ctx } = req;
    const detail = await withTenant(pools, ctx, (tx) => buildDetail(tx, ctx, clock.now(), agent, period));
    res.json(detail);
  });

  return router;
}
