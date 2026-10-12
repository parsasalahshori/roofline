import { companiesWithCandidateStorms } from '@roofline/db/system';
import type { AppDeps } from '../../app.ts';
import { candidateDays } from '../../storm/candidate-days.ts';
import { reportJobError } from './report.ts';

/**
 * The storm-match schedule (every 10 minutes): queues one 'storm-match-company' job per company
 * whose service area meets a storm of the last four convective days. app_system only lists the
 * companies; each job does the matching inside that company's own transaction. The singleton key is
 * the company id, so a company already waiting in the queue is not queued twice.
 *
 * One company failing to queue is logged and does not stop the others.
 */
export async function stormMatch(deps: AppDeps, now: Date): Promise<void> {
  const days = candidateDays(now);
  for (const { companyId } of await companiesWithCandidateStorms(deps.pools.system, { days })) {
    try {
      await deps.jobs.send('storm-match-company', { companyId }, { singletonKey: companyId });
    } catch (err) {
      reportJobError(deps, err, `storm-match: company ${companyId}`);
    }
  }
}
