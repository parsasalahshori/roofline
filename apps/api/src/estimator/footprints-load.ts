import { isUsStateCode } from '@roofline/shared';
import { claimFootprintState, failFootprintState, finishFootprintState, insertFootprints, type FootprintInput } from '@roofline/db/system';
import type { AppDeps } from '../app.ts';
import { reportJobError } from '../jobs/scheduler/report.ts';
import type { JobMeta } from '../jobs/queue.ts';

export const FOOTPRINT_BATCH_SIZE = 2000;
/** What the state row says when a load fails: our own sentence, never the provider's text. */
export const FOOTPRINT_LOAD_FAILED_PLAIN = "We couldn't load the building outlines for this state. We'll try again.";

/**
 * Loads one state's building outlines into the global table (a long job as app_system). Safe to
 * retry: a failure clears the partial rows and marks the state failed, and the next attempt
 * re-claims it (which clears the state's rows again). A duplicate job for a state already loading
 * or ready does nothing, and so does one for a code that is not a US state (or DC).
 */
export async function loadFootprintState(deps: AppDeps, state: string, meta: JobMeta): Promise<void> {
  const s = state.trim().toUpperCase();
  if (!deps.footprints.configured) return;
  // A code with no footprint file (a territory, a typo) has nothing to load: done, not retried.
  if (!isUsStateCode(s)) return;
  const system = deps.pools.system;
  const url = deps.footprints.stateFileUrl(s);
  if (!(await claimFootprintState(system, s, url, deps.clock.now()))) return;
  try {
    let total = 0;
    let batch: FootprintInput[] = [];
    for await (const feature of deps.footprints.features(s)) {
      batch.push({ sourceRef: feature.sourceRef, ring: feature.ring });
      if (batch.length >= FOOTPRINT_BATCH_SIZE) {
        total += await insertFootprints(system, s, batch);
        batch = [];
      }
    }
    if (batch.length > 0) total += await insertFootprints(system, s, batch);
    await finishFootprintState(system, s, total, deps.clock.now());
  } catch (err) {
    try {
      await failFootprintState(system, s, FOOTPRINT_LOAD_FAILED_PLAIN, deps.clock.now());
    } catch {
      // The original error is the one to rethrow; a stale claim is taken over after six hours.
    }
    if (meta.lastAttempt) reportJobError(deps, err, `footprints-load ${s}`);
    throw err;
  }
}
