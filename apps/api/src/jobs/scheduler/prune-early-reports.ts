import { pruneEarlyDeliveryReports } from '@roofline/db/system';
import type { AppDeps } from '../../app.ts';

/** An early delivery report that has waited this long for its message is dropped. */
export const EARLY_REPORT_MAX_AGE_DAYS = 7;

/**
 * Scheduled job: deletes the early delivery reports that never found their message (daily, in the
 * worker, at 03:17 UTC, with the clock's time). A report is kept while it is applied; an unapplied
 * one received more than `EARLY_REPORT_MAX_AGE_DAYS` before `now` is deleted, across companies,
 * in one statement on app_system. A second run deletes nothing new. Errors propagate to the
 * worker, which logs them.
 */
export async function pruneEarlyReports(deps: AppDeps, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - EARLY_REPORT_MAX_AGE_DAYS * 86_400_000);
  await pruneEarlyDeliveryReports(deps.pools.system, cutoff);
}
