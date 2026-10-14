import { isFootprintQuadkey, isUsStateCode } from '@roofline/shared';
import {
  beatFootprintTile,
  claimFootprintTile,
  failFootprintTile,
  finishFootprintTile,
  insertFootprints,
  LOAD_HEARTBEAT_MS,
  LOAD_HEARTBEAT_STALE_MS,
  type FootprintInput,
} from '@roofline/db/system';
import type { AppDeps } from '../app.ts';
import { reportJobError } from '../jobs/scheduler/report.ts';
import type { JobMeta } from '../jobs/queue.ts';

export const FOOTPRINT_BATCH_SIZE = 2000;
/** What the tile row says when a load fails: our own sentence, never the provider's text. */
export const FOOTPRINT_LOAD_FAILED_PLAIN = "We couldn't load the building outlines for this area. We'll try again.";
/** A load stops beating after this long, so one stuck for good goes stale and can be taken over. */
const MAX_HEARTBEAT_MS = 60 * 60 * 1000;

/** What a load call did: loaded the tile, found someone else loading it (or it ready), or had nothing to do. */
export type TileLoadResult = 'loaded' | 'busy' | 'skipped';

/**
 * Loads one footprint tile (a zoom-9 quadkey) into the global table as app_system: from the `footprints-load`
 * job, and from a measurement that needs the tile now (estimator/footprint-tiles.ts). Safe to retry: a
 * failure clears the tile's partial rows and marks it failed, and the next attempt re-claims it (which
 * clears the tile's rows again). A call for a tile already loading or ready does nothing ('busy'), and so
 * does one whose key is not a zoom-9 quadkey ('skipped'). A tile with no files (open water, outside the US)
 * is marked ready with no buildings.
 *
 * While it loads it beats every LOAD_HEARTBEAT_MS (the claim's started_at moves forward), so a claim left by a
 * process that stopped mid-load goes stale after LOAD_HEARTBEAT_STALE_MS and the next load takes it over.
 *
 * `state` is the requesting home's state. A tile spans state lines, so it is not written on the rows
 * (building_footprints.state stays null for tile rows); it is only used in the error report.
 */
export async function loadFootprintTile(
  deps: AppDeps,
  quadkey: string,
  meta: JobMeta,
  state?: string,
  opts: { staleMs?: number } = {},
): Promise<TileLoadResult> {
  const q = quadkey.trim();
  if (!deps.footprints.configured) return 'skipped';
  if (!isFootprintQuadkey(q)) return 'skipped';
  const system = deps.pools.system;
  if (!(await claimFootprintTile(system, q, deps.clock.now(), opts.staleMs ?? LOAD_HEARTBEAT_STALE_MS))) return 'busy';
  const began = Date.now();
  const heartbeat = setInterval(() => {
    if (Date.now() - began > MAX_HEARTBEAT_MS) {
      clearInterval(heartbeat);
      return;
    }
    beatFootprintTile(system, q, deps.clock.now()).catch(() => undefined);
  }, LOAD_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    const urls = await deps.footprints.tileUrls(q);
    let total = 0;
    let batch: FootprintInput[] = [];
    const target = { tile: q, state: null };
    if (urls.length > 0) {
      for await (const feature of deps.footprints.features(q)) {
        batch.push({ sourceRef: feature.sourceRef, ring: feature.ring });
        if (batch.length >= FOOTPRINT_BATCH_SIZE) {
          total += await insertFootprints(system, target, batch);
          batch = [];
        }
      }
      if (batch.length > 0) total += await insertFootprints(system, target, batch);
    }
    clearInterval(heartbeat);
    await finishFootprintTile(system, q, total, urls.length > 0 ? urls.join(' ') : null, deps.clock.now());
    return 'loaded';
  } catch (err) {
    clearInterval(heartbeat);
    try {
      await failFootprintTile(system, q, FOOTPRINT_LOAD_FAILED_PLAIN, deps.clock.now());
    } catch {
      // The original error is the one to rethrow; a stale claim is taken over later.
    }
    const where = state !== undefined && isUsStateCode(state) ? ` (${state.trim().toUpperCase()})` : '';
    if (meta.lastAttempt) reportJobError(deps, err, `footprints-load ${q}${where}`);
    throw err;
  }
}
