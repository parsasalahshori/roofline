import { companiesNeedingAdSync } from '@roofline/db/system';
import type { AppDeps } from '../../app.ts';
import { reportJobError } from './report.ts';

/**
 * The ad sync schedule (hourly): queues one 'ad-sync-company' job per company that has an ad account
 * waiting to be accepted or a live (active) campaign. app_system only lists the companies; each job works inside that company's own
 * transaction. The singleton key is the company id, so a company already waiting is not queued twice.
 *
 * One company failing to queue is logged and does not stop the others.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the schedule passes the time; the job uses the clock
export async function adSpendSync(deps: AppDeps, _now: Date): Promise<void> {
  for (const { companyId } of await companiesNeedingAdSync(deps.pools.system)) {
    try {
      await deps.jobs.send('ad-sync-company', { companyId }, { singletonKey: companyId });
    } catch (err) {
      reportJobError(deps, err, `ad-spend-sync: company ${companyId}`);
    }
  }
}
