import { Router } from 'express';
import { z } from 'zod';
import { timelinePage, timelineSubjectVisible, type TimelineQuery, withTenant } from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { limitParam, parse, UUID } from '../validate.ts';

/** `?before=` is a page's `nextBefore` (`<iso>~<id>`) or a plain date; anything else is a bad request. */
const CURSOR = /^([^~]+)(?:~([0-9a-f-]{36}))?$/i;
const readCursor = (value: string): { at: Date; id: string | null } | null => {
  const m = CURSOR.exec(value);
  if (!m || Number.isNaN(Date.parse(m[1]!))) return null;
  const at = new Date(m[1]!);
  // Postgres cannot store a timestamp outside years 1 to 9999; keep to a sane range.
  if (at.getUTCFullYear() < 1900 || at.getUTCFullYear() > 9999) return null;
  const id = m[2]?.toLowerCase() ?? null;
  if (id !== null && !UUID.test(id)) return null;
  return { at, id };
};
const TimelineParams = z.object({
  customerId: z.string({ error: MESSAGES.checkField }).optional(),
  jobId: z.string({ error: MESSAGES.checkField }).optional(),
  before: z
    .string({ error: MESSAGES.checkField })
    .refine((value) => readCursor(value) !== null, MESSAGES.checkField)
    .optional(),
  limit: limitParam,
});

/**
 * `/api/timeline`: one subject's merged timeline, newest first, a page at a time (C1 Task 7).
 * - Exactly one of `customerId` or `jobId`; neither or both is a 400.
 * - A subject the member may not see (another company's, out of their scope, or missing) is a 404,
 *   the same as an id that does not exist. A malformed id is a 404 too.
 */
function cursorQuery(value: string): Pick<TimelineQuery, 'before' | 'beforeId'> {
  const cursor = readCursor(value);
  if (cursor === null) return {};
  return cursor.id === null ? { before: cursor.at } : { before: cursor.at, beforeId: cursor.id };
}

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
      ...(query.before !== undefined && cursorQuery(query.before)),
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
