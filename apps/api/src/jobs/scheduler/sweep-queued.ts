import { reclaimExpiredLeases, withTenant } from '@roofline/db';
import { companiesWithExpiredLeases, stepsQueuedLongerThan } from '@roofline/db/system';
import type { AppDeps } from '../../app.ts';
import { systemContext } from '../../permissions.ts';
import { reportJobError } from './report.ts';

/** A step still `queued` after this long is handed to the queue again. */
export const QUEUED_TOO_LONG_MS = 2 * 60 * 1000;

/**
 * The sweeper (every minute). Two kinds of step can be stranded, and both are handed to the queue
 * again:
 *
 * 1. **Queued too long:** a step `queued` for more than `QUEUED_TOO_LONG_MS`. Its approval
 *    committed but the hand-over to the queue failed, or the job was lost. Re-sending is safe: the
 *    queue keeps one waiting job per step (pg-boss `singletonKey` = step id), and a delivery of a
 *    step that is already running does nothing (the runner's claim).
 * 2. **A run that died:** a `running` step whose run lease has passed. app_system only lists the
 *    companies that have one; each company's steps are put back to `queued` in that company's own
 *    app_tenant transaction (`reclaimExpiredLeases`, which skips rows someone else holds, so two
 *    sweepers never wait on each other), and the ids are handed to the queue only after that
 *    transaction has committed. A parked step (`running` with no lease) is never touched.
 *
 * A refusal from the queue, or one company failing, is logged and the sweep goes on: whatever it
 * missed is still queued, so the next sweep picks it up. Returns how many stranded steps were
 * re-sent (step 1, handed over successfully) and how many dead runs were put back (step 2).
 */
export async function sweepQueued(deps: AppDeps, now: Date): Promise<{ resent: number; reclaimed: number }> {
  let resent = 0;
  for (const { companyId, stepId } of await stepsQueuedLongerThan(deps.pools.system, QUEUED_TOO_LONG_MS, now)) {
    if (await handOver(deps, companyId, stepId)) resent += 1;
  }

  let reclaimed = 0;
  for (const companyId of await companiesWithExpiredLeases(deps.pools.system, now)) {
    const ctx = systemContext(companyId);
    let stepIds: string[];
    try {
      stepIds = await withTenant(deps.pools, ctx, (tx) => reclaimExpiredLeases(tx, ctx, now));
    } catch (err) {
      reportJobError(deps, err, `sweep-queued: company ${companyId}`);
      continue;
    }
    // Committed: the steps are queued now, so a worker that picks one up can claim it.
    reclaimed += stepIds.length;
    for (const stepId of stepIds) await handOver(deps, companyId, stepId);
  }
  return { resent, reclaimed };
}

/** Gives one step to the queue; true when it was taken. A refusal is logged, not thrown. */
async function handOver(deps: AppDeps, companyId: string, stepId: string): Promise<boolean> {
  try {
    await deps.queue.enqueueStep(companyId, stepId);
    return true;
  } catch (err) {
    reportJobError(deps, err, `sweep-queued: step ${stepId}`);
    return false;
  }
}
