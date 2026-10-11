import { audit, withTenant } from '@roofline/db';
import { endExpiredTrials } from '@roofline/db/system';
import type { AppDeps } from '../../app.ts';
import { systemContext } from '../../permissions.ts';
import { reportJobError } from './report.ts';

/**
 * Scheduled job: ends trials that ran out (every 5 minutes, in the worker, with the clock's time).
 * app_system flips each company still on `trial` whose `trial_ends_at` has passed to `trial_ended`,
 * in one statement; then each ended company gets one `billing.trial_ended` audit row in its own
 * app_tenant transaction, under RLS. A second run finds nothing left to end, so no second row.
 *
 * One company failing is logged and does not stop the others.
 */
export async function endTrials(deps: AppDeps, now: Date): Promise<void> {
  const ids = await endExpiredTrials(deps.pools.system, now);
  for (const id of ids) {
    const ctx = systemContext(id);
    try {
      await withTenant(deps.pools, ctx, (tx) =>
        audit(tx, ctx, {
          action: 'billing.trial_ended',
          targetType: 'company',
          targetId: id,
          at: now,
        }),
      );
    } catch (err) {
      reportJobError(deps, err, `end-trials: company ${id}`);
    }
  }
}
