import { upsertSpotterReports } from '@roofline/db/system';
import type { AppDeps } from '../../app.ts';
import { syncSpotter } from '../../storm/spotter.ts';

/** Every 30 minutes: pulls storm spotter reports (S1 Task 8). */
export async function spotterSync(deps: AppDeps, now: Date): Promise<void> {
  await syncSpotter({ store: (reports) => upsertSpotterReports(deps.pools.system, reports) }, now);
}
