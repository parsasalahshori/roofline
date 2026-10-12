import type { AppDeps } from '../../app.ts';
import { syncSpotterReports } from '../../storm/spotter.ts';

/** Every 30 minutes: pulls storm spotter reports (S1 Task 8). */
export async function spotterSync(deps: AppDeps, now: Date): Promise<void> {
  await syncSpotterReports(deps, now);
}
