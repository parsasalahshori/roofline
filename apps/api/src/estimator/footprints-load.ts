import { isFootprintQuadkey, isUsStateCode } from '@roofline/shared';
import { claimFootprintTile, failFootprintTile, finishFootprintTile, insertFootprints, type FootprintInput } from '@roofline/db/system';
import type { AppDeps } from '../app.ts';
import { reportJobError } from '../jobs/scheduler/report.ts';
import type { JobMeta } from '../jobs/queue.ts';

export const FOOTPRINT_BATCH_SIZE = 2000;
/** What the tile row says when a load fails: our own sentence, never the provider's text. */
export const FOOTPRINT_LOAD_FAILED_PLAIN = "We couldn't load the building outlines for this area. We'll try again.";

/**
 * Loads one footprint tile (a zoom-9 quadkey) into the global table: a long job as app_system. Safe to
 * retry: a failure clears the tile's partial rows and marks it failed, and the next attempt re-claims it
 * (which clears the tile's rows again). A duplicate job for a tile already loading or ready does nothing,
 * and so does one whose key is not a zoom-9 quadkey. A tile with no files (open water, outside the US) is
 * marked ready with no buildings.
 *
 * `state` is the requesting home's state. A tile spans state lines, so it is not written on the rows
 * (building_footprints.state stays null for tile rows); it is only used in the error report.
 */
export async function loadFootprintTile(deps: AppDeps, quadkey: string, meta: JobMeta, state?: string): Promise<void> {
  const q = quadkey.trim();
  if (!deps.footprints.configured) return;
  if (!isFootprintQuadkey(q)) return;
  const system = deps.pools.system;
  if (!(await claimFootprintTile(system, q, deps.clock.now()))) return;
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
    await finishFootprintTile(system, q, total, urls.length > 0 ? urls.join(' ') : null, deps.clock.now());
  } catch (err) {
    try {
      await failFootprintTile(system, q, FOOTPRINT_LOAD_FAILED_PLAIN, deps.clock.now());
    } catch {
      // The original error is the one to rethrow; a stale claim is taken over after six hours.
    }
    const where = state !== undefined && isUsStateCode(state) ? ` (${state.trim().toUpperCase()})` : '';
    if (meta.lastAttempt) reportJobError(deps, err, `footprints-load ${q}${where}`);
    throw err;
  }
}
