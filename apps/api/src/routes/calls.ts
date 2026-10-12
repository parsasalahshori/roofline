import { Router } from 'express';
import { markCallSpam, withTenant } from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { UUID } from '../validate.ts';

const NOT_BUILT = 'This part of Front Desk (calls) is not built yet.';

/** Only the owner and the office may mark a call as spam (the same roles that manage the blocklist). */
const canManageSpam = (role: string): boolean => role === 'owner' || role === 'office';

/**
 * `/api/calls`: the calls the Front Desk took.
 * - `POST /:id/spam` (owner, office): marks one call as spam. It blocks the caller's number, sets
 *   the call's spam reason to `marked_by_team`, and sets its conversation outcome to `spam`.
 *   Answers `{ id, spam: true, blockedNumberId }`. A rep gets 403; an id that is not a UUID, or
 *   one of another company, gets 404.
 *
 * New call routes go above the catch-all, which answers 501 for anything not built yet.
 */
export function callRoutes(deps: AppDeps): Router {
  const { pools } = deps;
  const router = Router();

  /** `:id` as a lowercase UUID; anything else cannot be a call, so it is a 404 like a missing one. */
  const callId = (raw: unknown): string => {
    const id = (typeof raw === 'string' ? raw : '').toLowerCase();
    if (!UUID.test(id)) throw new AppError(404, MESSAGES.notFound);
    return id;
  };

  router.post('/:id/spam', async (req, res) => {
    const { ctx } = req;
    if (!canManageSpam(ctx.role)) throw new AppError(403, MESSAGES.roleCannot);
    const id = callId(req.params.id);
    const result = await withTenant(pools, ctx, (tx) => markCallSpam(tx, ctx, id, { userId: ctx.userId }));
    if (!result) throw new AppError(404, MESSAGES.notFound);
    res.json({ id: result.callId, spam: true, blockedNumberId: result.blockedNumberId });
  });

  router.all('/{*rest}', (_req, res) => {
    res.status(501).json({ error: NOT_BUILT });
  });
  return router;
}
