import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { calendarConnections } from '../schema/index.ts';

/*
 * The calendar pull's fan-out. Runs on the app_system pool, which may read only a few columns of
 * calendar_connections (id, company, user, status and last_synced_at; never credentials or cursors).
 * It only LISTS the connections due; the pulling is done per company, inside `withTenant`.
 */

const PULL_EVERY_MS = 5 * 60 * 1000;

/** Connected calendars not synced in the last five minutes: never-synced first, then the oldest. */
export async function connectionsDueForPull(
  system: Db,
  now: Date,
  limit: number,
): Promise<{ companyId: string; userId: string }[]> {
  const cutoff = new Date(now.getTime() - PULL_EVERY_MS);
  return system
    .select({ companyId: calendarConnections.companyId, userId: calendarConnections.userId })
    .from(calendarConnections)
    .where(
      and(
        eq(calendarConnections.status, 'connected'),
        or(isNull(calendarConnections.lastSyncedAt), lte(calendarConnections.lastSyncedAt, cutoff)),
      ),
    )
    .orderBy(sql`${calendarConnections.lastSyncedAt} asc nulls first`, asc(calendarConnections.id))
    .limit(limit);
}
