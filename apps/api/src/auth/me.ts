import { Router } from 'express';
import { markTodayShown } from '@roofline/db/system';
import type { AppDeps } from '../app.ts';

/**
 * `/api/me`: things about the signed-in member themselves. Any member may call it (a rep too),
 * and it lives under auth/ because it reads and writes the membership through the system pool.
 * - `POST /today-shown` → `{ show }`. True the first time it is called on a given day in the
 *   company's time zone, false after that, so the Today window opens once per person per day even
 *   with several tabs or devices open. The check and the write are one statement (markTodayShown).
 */
export function meRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  router.post('/today-shown', async (req, res) => {
    const { companyId, userId } = req.session;
    res.json({ show: await markTodayShown(pools.system, companyId, userId, clock.now()) });
  });

  return router;
}
