import { Router } from 'express';
import { z } from 'zod';
import { searchAll, withTenant } from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { MESSAGES } from '../errors.ts';
import { parse } from '../validate.ts';

/** A search shorter than this (in characters) is not run: one letter matches nearly everything. */
const MIN_QUERY_LENGTH = 2;
/** Longer searches are cut to this, not refused. */
const MAX_QUERY_LENGTH = 100;
/** Matches shown in each of the three lists. */
const PER_LIST = 8;

const Query = z.object({ q: z.string({ error: MESSAGES.checkField }).optional() });

/**
 * What is searched for: trimmed, with any NUL character dropped (Postgres cannot store one in
 * text, so it could never match and would only fail the query), cut to 100 characters (counting
 * what a person sees as a character, so an emoji is not split in two) and trimmed again.
 */
function cleanQuery(raw: string): string {
  const trimmed = raw.replaceAll('\0', '').trim();
  return Array.from(trimmed).slice(0, MAX_QUERY_LENGTH).join('').trim();
}

/**
 * `/api/search`: the search box in the top bar.
 * - `GET /?q=` `{ customers, jobs, addresses }`, each list at most 8, for what the member may see
 *   (a rep sees their own side only). A missing `q`, or one under 2 characters after trimming, gets
 *   three empty lists and no database query. Longer than 100 characters is cut to 100.
 */
export function searchRoutes(deps: AppDeps): Router {
  const { pools } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    const { ctx } = req;
    const query = parse(Query, req.query);
    const q = cleanQuery(query.q ?? '');
    if (Array.from(q).length < MIN_QUERY_LENGTH) {
      res.json({ customers: [], jobs: [], addresses: [] });
      return;
    }
    res.json(await withTenant(pools, ctx, (tx) => searchAll(tx, ctx, q, PER_LIST)));
  });

  return router;
}
