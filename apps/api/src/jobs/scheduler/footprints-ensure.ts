import { tilesNeedingRetry } from '@roofline/db/system';
import type { AppDeps } from '../../app.ts';
import { reportJobError } from './report.ts';

/**
 * Every 15 minutes: queues another footprints-load job for each footprint tile that failed (after
 * pg-boss's own retries) or whose loading claim went stale (a crashed worker). Tiles are first loaded on
 * demand, when a home in them is measured (measureProperty); this only retries. The singleton key (the
 * quadkey) keeps a tile from being queued twice. One tile failing to queue does not stop the others.
 */
export async function ensureFootprints(deps: AppDeps, now: Date): Promise<void> {
  for (const { quadkey, companyId } of await tilesNeedingRetry(deps.pools.system, now)) {
    try {
      await deps.jobs.send('footprints-load', { companyId, quadkey }, { singletonKey: quadkey });
    } catch (err) {
      reportJobError(deps, err, `footprints-ensure ${quadkey}`);
    }
  }
}
