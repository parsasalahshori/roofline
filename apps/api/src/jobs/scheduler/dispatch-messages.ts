import { companiesWithDueMessages, companiesWithParkedSteps } from '@roofline/db/system';
import type { AppDeps } from '../../app.ts';
import { dispatchCompanyMessages, type DispatchSummary, emptySummary } from '../../messaging/dispatcher.ts';
import { reportJobError } from './report.ts';

/**
 * The dispatcher job (every minute). app_system lists the companies with something to do (ids
 * only): a text whose time has come (`scheduled`, `scheduled_for <= now`), or a parked step that may
 * be ready to finish. Each company is then handled by `dispatchCompanyMessages` (messaging/
 * dispatcher.ts) in its own app_tenant transactions, under RLS: the gate is asked again for every
 * due text, and batch steps whose texts are all dealt with are finished.
 *
 * One company failing is logged (`dispatch-messages: company <id>`) and does not stop the others;
 * its texts are still waiting, so the next minute tries again. `dispatchCompany` is the per-company
 * pass (tests swap it to make one company fail). Returns the counts over all companies.
 */
export async function dispatchDueMessages(
  deps: AppDeps,
  now: Date,
  dispatchCompany: (deps: AppDeps, companyId: string, now: Date) => Promise<DispatchSummary> = dispatchCompanyMessages,
): Promise<DispatchSummary> {
  const due = await companiesWithDueMessages(deps.pools.system, now);
  const parked = await companiesWithParkedSteps(deps.pools.system);
  const total = emptySummary();
  for (const companyId of [...new Set([...due, ...parked])].sort()) {
    try {
      const one = await dispatchCompany(deps, companyId, now);
      for (const key of Object.keys(total) as (keyof DispatchSummary)[]) total[key] += one[key];
    } catch (err) {
      reportJobError(deps, err, `dispatch-messages: company ${companyId}`);
    }
  }
  return total;
}
