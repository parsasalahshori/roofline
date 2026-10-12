import { and, isNull, lt } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { earlyDeliveryReports } from '../schema/index.ts';

/**
 * Deletes the early delivery reports that never found their message: unapplied (`applied_at` is
 * null) and received before `cutoff`. Runs on app_system, across companies, and only ever deletes;
 * a report that was applied is kept. Returns how many rows it deleted, so a second run with the
 * same cutoff deletes nothing.
 */
export async function pruneEarlyDeliveryReports(system: Db, cutoff: Date): Promise<number> {
  const rows = await system
    .delete(earlyDeliveryReports)
    .where(and(isNull(earlyDeliveryReports.appliedAt), lt(earlyDeliveryReports.receivedAt, cutoff)))
    .returning({ id: earlyDeliveryReports.id });
  return rows.length;
}
