import { Router } from 'express';
import { unblockNumber, withTenant } from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { UUID } from '../validate.ts';

const NOT_BUILT = 'This part of Front Desk (blocked numbers) is not built yet.';

/** Only the owner and the office may unblock a number (the same roles that mark spam). */
const canManageSpam = (role: string): boolean => role === 'owner' || role === 'office';

/**
 * `/api/blocked-numbers`: the company's blocklist.
 * - `DELETE /:id` (owner, office): removes one blocked number and answers 204. Calls from that
 *   number are screened again from the next call on. A rep gets 403; an id that is not a UUID,
 *   or one of another company, gets 404.
 */
export function blockedNumberRoutes(deps: AppDeps): Router {
  const { pools } = deps;
  const router = Router();

  /** `:id` as a lowercase UUID; anything else cannot be a blocked number, so it is a 404 like a missing one. */
  const blockedId = (raw: unknown): string => {
    const id = (typeof raw === 'string' ? raw : '').toLowerCase();
    if (!UUID.test(id)) throw new AppError(404, MESSAGES.notFound);
    return id;
  };

  router.delete('/:id', async (req, res) => {
    const { ctx } = req;
    if (!canManageSpam(ctx.role)) throw new AppError(403, MESSAGES.roleCannot);
    const id = blockedId(req.params.id);
    const removed = await withTenant(pools, ctx, (tx) => unblockNumber(tx, ctx, id));
    if (!removed) throw new AppError(404, MESSAGES.notFound);
    res.status(204).end();
  });

  router.all('/{*rest}', (_req, res) => {
    res.status(501).json({ error: NOT_BUILT });
  });
  return router;
}
