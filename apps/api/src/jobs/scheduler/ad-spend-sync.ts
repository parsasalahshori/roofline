import { companiesWithPendingAdAccounts } from '@roofline/db/system';
import type { AppDeps } from '../../app.ts';
import { reportJobError } from './report.ts';

/**
 * The ad sync schedule (hourly): queues one 'ad-sync-company' job per company that has an ad account
 * waiting to be accepted. app_system only lists the companies; each job works inside that company's own
 * transaction. The singleton key is the company id, so a company already waiting is not queued twice.
 * Task 19 widens the list to companies with live campaigns (a union).
 *
 * One company failing to queue is logged and does not stop the others.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the time is not needed until Task 19
export async function adSpendSync(deps: AppDeps, _now: Date): Promise<void> {
  for (const { companyId } of await companiesWithPendingAdAccounts(deps.pools.system)) {
    try {
      await deps.jobs.send('ad-sync-company', { companyId }, { singletonKey: companyId });
    } catch (err) {
      reportJobError(deps, err, `ad-spend-sync: company ${companyId}`);
    }
  }
}
