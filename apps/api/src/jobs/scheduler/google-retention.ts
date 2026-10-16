import { companyIdsForRetention, finishGoogleRetentionRun, startGoogleRetentionRun } from '@roofline/db/system';
import { emptyRetentionCounts, type GoogleRetentionCounts } from '@roofline/shared';
import type { AppDeps } from '../../app.ts';
import { describeErrorForLog } from '../../errors.ts';
import { retentionDaysOf, sweepCompanyGoogle, sweepGoogleOrphans, type SweepOptions } from '../../estimator/google-retention.ts';

/** The whole sweep: every company, then the orphans. One company failing never stops the rest. Counts only. */
export async function sweepGoogleRetention(deps: AppDeps, now: Date, o: SweepOptions = {}): Promise<GoogleRetentionCounts> {
  const counts = emptyRetentionCounts();
  const inUse = new Set<string>();
  let keysComplete = true;
  for (const id of await companyIdsForRetention(deps.pools.system)) {
    try {
      for (const key of await sweepCompanyGoogle(deps, id, now, counts, o)) inUse.add(key);
    } catch {
      counts.companiesFailed += 1;
      keysComplete = false;
      console.error(`google-retention: company failed company=${id}`);
    }
  }
  await sweepGoogleOrphans(deps, now, inUse, keysComplete, counts);
  return counts;
}

/**
 * Daily (and at worker start) deletion of Google content past its days (docs/compliance/google-data-retention.md):
 * one run row in google_retention_runs with its counts, and one log line of counts. A run that cannot record itself
 * still deletes. Never logs keys, addresses or content.
 */
export async function googleRetention(deps: AppDeps, now: Date): Promise<void> {
  const retentionDays = retentionDaysOf(deps);
  let runId: string | null = null;
  try {
    runId = await startGoogleRetentionRun(deps.pools.system, { startedAt: now, retentionDays });
  } catch (err) {
    console.error(`google-retention: could not record the run (${describeErrorForLog(err)})`);
  }
  try {
    const counts = await sweepGoogleRetention(deps, now);
    console.log(`google-retention: ${JSON.stringify({ retentionDays, ...counts })}`);
    if (runId !== null) await finishGoogleRetentionRun(deps.pools.system, runId, { finishedAt: deps.clock.now(), counts });
  } catch (err) {
    if (runId !== null) {
      await finishGoogleRetentionRun(deps.pools.system, runId, { finishedAt: deps.clock.now(), counts: {}, errorPlain: 'The sweep stopped early.' }).catch(() => undefined);
    }
    throw err;
  }
}
