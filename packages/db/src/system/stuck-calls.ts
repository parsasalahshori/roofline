import { and, asc, inArray, lt } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { calls } from '../schema/index.ts';
import { LIVE_CALL_WINDOW_MS } from '../repos/calls.ts';

/**
 * Ends calls stuck in 'ringing', 'ai' or 'ringing_team' with started_at older than 35 minutes before `now`
 * (status 'ended', ended_at = now), at most `limit` per call, across companies. Returns the ended calls.
 * Runs on app_system (RLS bypassed through the app_system_all policy).
 */
export async function endStuckCalls(system: Db, now: Date, limit: number): Promise<Array<{ companyId: string; callSid: string }>> {
  const cutoff = new Date(now.getTime() - LIVE_CALL_WINDOW_MS);
  const live = ['ringing', 'ai', 'ringing_team'] as const;
  const stale = await system
    .select({ id: calls.id })
    .from(calls)
    .where(and(inArray(calls.status, [...live]), lt(calls.startedAt, cutoff)))
    .orderBy(asc(calls.startedAt))
    .limit(limit);
  if (stale.length === 0) return [];
  return system
    .update(calls)
    .set({ status: 'ended', endedAt: now })
    .where(
      and(
        inArray(
          calls.id,
          stale.map((r) => r.id),
        ),
        inArray(calls.status, [...live]),
      ),
    )
    .returning({ companyId: calls.companyId, callSid: calls.callSid });
}
