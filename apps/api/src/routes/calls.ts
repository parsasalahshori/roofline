import { Router } from 'express';
import { canPlayCallRecording, findCallRecording, markCallSpam, withTenant } from '@roofline/db';
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
 *   transferred leg): streams the stored recording through the API as `audio/mpeg` (no storage URL
 *   ever reaches the browser), with `Range` support (206, or 416 when unsatisfiable). 404 when
 *   the caller may not play it, the call is missing or belongs to another company, or it has no
 *   stored recording, 503
 *   when file storage isn't set up. `Cache-Control: no-store`.
 *
 * New call routes go above the catch-all, which answers 501 for anything not built yet.
 */
export function callRoutes(deps: AppDeps): Router {
  const { pools, objectStore } = deps;
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
    if (!found.ok) throw new AppError(404, MESSAGES.notFound);
    const { r } = found;
    const playable = r.recordingStatus === 'stored' || r.recordingStatus === 'stopped_by_caller';
    if (!r.recordingKey || !playable) throw new AppError(404, MESSAGES.notFound);
    let bytes: Uint8Array | null;
    try {
      bytes = await objectStore.get(r.recordingKey);
    } catch (err) {
      if (err instanceof ObjectStoreUnavailableError) throw new AppError(503, "File storage isn't set up.");
      throw err;
    }
    if (bytes === null) throw new AppError(404, MESSAGES.notFound);
    const total = bytes.byteLength;
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' });
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.get('range') ?? '');
    // A last position before the first (bytes=5-2) is not a valid range at all: ignore it and send the whole file (RFC 9110).
    const backwards = range !== null && range[1] !== '' && range[2] !== '' && Number(range[2]) < Number(range[1]);
    if (range && !backwards && (range[1] !== '' || range[2] !== '')) {
      let start: number;
      let end: number;
      if (range[1] === '') {
        // A suffix range: the last N bytes.
        const n = Number(range[2]);
        start = Math.max(total - n, 0);
        end = total - 1;
      } else {
        start = Number(range[1]);
        end = range[2] === '' ? total - 1 : Math.min(Number(range[2]), total - 1);
      }
      if (total === 0 || start >= total || start > end || (range[1] === '' && Number(range[2]) === 0)) {
        res.status(416).set('Content-Range', `bytes */${total}`).end();
        return;
      }
      const slice = bytes.subarray(start, end + 1);
      res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(slice.byteLength) });
      res.end(Buffer.from(slice));
      return;
    }
    res.status(200).set('Content-Length', String(total));
    res.end(Buffer.from(bytes));
  });

  router.all('/{*rest}', (_req, res) => {
    res.status(501).json({ error: NOT_BUILT });
  });
  return router;
}
