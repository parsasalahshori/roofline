import { and, eq, lte } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { companies } from '../schema/index.ts';

/**
 * Ends the trials that ran out: every company still on `trial` whose `trial_ends_at` is at or
 * before `now` becomes `trial_ended`. Runs on app_system, which may write the billing columns of
 * companies; takes the app clock's `now`, so the cut-off is the clock's, not the database's. It is
 * one statement, so a second run finds nothing left to change. Returns the ids it ended, sorted.
 * The caller writes the audit row for each company, inside that company's own transaction.
 */
export async function endExpiredTrials(system: Db, now: Date): Promise<string[]> {
  const rows = await system
    .update(companies)
    .set({ status: 'trial_ended', updatedAt: now })
    .where(and(eq(companies.status, 'trial'), lte(companies.trialEndsAt, now)))
    .returning({ id: companies.id });
  return rows.map((r) => r.id).sort();
}
