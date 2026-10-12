import { Router } from 'express';
import { canPlayCallRecording, findCallRecording, markCallSpam, withTenant } from '@roofline/db';
import type { RecordingLink } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { ObjectStoreUnavailableError } from '../providers/object-store.ts';
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
 * - `GET /:id/recording` (owner, office; a rep only for their own customers and never for a
 *   transferred leg): 302 to a 5-minute signed URL of the stored recording, or, with
 *   `Accept: application/json`, `{ url, expiresAt }`. 403 when not allowed, 404 when the call is
 *   missing, another company's, or has no stored recording. `Cache-Control: no-store`.
 *
 * New call routes go above the catch-all, which answers 501 for anything not built yet.
 */
export function callRoutes(deps: AppDeps): Router {
  const { pools, objectStore, clock } = deps;
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

  router.get('/:id/recording', async (req, res) => {
    const { ctx } = req;
    const id = callId(req.params.id);
    const found = await withTenant(pools, ctx, async (tx) => {
      const r = await findCallRecording(tx, ctx, id);
      if (!r) return null;
      return { r, ok: await canPlayCallRecording(tx, ctx, r) };
    });
    if (!found) throw new AppError(404, MESSAGES.notFound);
    if (!found.ok) throw new AppError(403, MESSAGES.roleCannot);
    const { r } = found;
    const playable = r.recordingStatus === 'stored' || r.recordingStatus === 'stopped_by_caller';
    if (!r.recordingKey || !playable) throw new AppError(404, MESSAGES.notFound);
    const SECONDS = 300;
    let url: string;
    try {
      url = await objectStore.signedGetUrl(r.recordingKey, SECONDS);
    } catch (err) {
      if (err instanceof ObjectStoreUnavailableError) throw new AppError(503, "File storage isn't set up.");
      throw err;
    }
    res.set('Cache-Control', 'no-store');
    if ((req.get('accept') ?? '').includes('application/json')) {
      const link: RecordingLink = { url, expiresAt: new Date(clock.now().getTime() + SECONDS * 1000).toISOString() };
      res.json(link);
      return;
    }
    res.redirect(302, url);
  });

  router.all('/{*rest}', (_req, res) => {
    res.status(501).json({ error: NOT_BUILT });
  });
  return router;
}
