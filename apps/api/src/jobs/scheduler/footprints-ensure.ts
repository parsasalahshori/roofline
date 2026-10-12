import { statesNeedingFootprintsFor } from '@roofline/db/system';
import type { AppDeps } from '../../app.ts';
import { reportJobError } from './report.ts';

/**
 * Every 15 minutes: queues a footprints-load job for each state the companies need and that is not
 * ready or already loading. The singleton key (the state) keeps a slow load from being queued twice.
 * One state failing to queue does not stop the others.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the scheduler passes the time; this job does not need it
export async function ensureFootprints(deps: AppDeps, _now: Date): Promise<void> {
  for (const { state, companyId } of await statesNeedingFootprintsFor(deps.pools.system)) {
    try {
      await deps.jobs.send('footprints-load', { companyId, state }, { singletonKey: state });
    } catch (err) {
      reportJobError(deps, err, `footprints-ensure ${state}`);
    }
  }
}
