import { desc, eq } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { googleRetentionRuns } from '../schema/index.ts';

/* The google-retention job's run log (google_retention_runs, global, app_system). Counts only. */

/** Records that a run started; returns its id. */
export async function startGoogleRetentionRun(system: Db, opts: { startedAt: Date; retentionDays: number }): Promise<string> {
  const [row] = await system
    .insert(googleRetentionRuns)
    .values({ startedAt: opts.startedAt, retentionDays: opts.retentionDays })
    .returning({ id: googleRetentionRuns.id });
  return row!.id;
}

/** Records how a run ended: its counts, and a plain reason when it stopped early. */
export async function finishGoogleRetentionRun(
  system: Db,
  id: string,
  opts: { finishedAt: Date; counts: Record<string, number>; errorPlain?: string | null },
): Promise<void> {
  await system
    .update(googleRetentionRuns)
    .set({ finishedAt: opts.finishedAt, counts: opts.counts, errorPlain: opts.errorPlain ?? null })
    .where(eq(googleRetentionRuns.id, id));
}

export type GoogleRetentionRun = typeof googleRetentionRuns.$inferSelect;

/** The newest runs, newest first. */
export async function latestGoogleRetentionRuns(system: Db, limit = 10): Promise<GoogleRetentionRun[]> {
  return system.select().from(googleRetentionRuns).orderBy(desc(googleRetentionRuns.startedAt)).limit(limit);
}
