import { signaturesWithoutPdf, withTenant } from '@roofline/db';
import { companiesWithSignedProposals } from '@roofline/db/system';
import type { AppDeps } from '../../app.ts';
import { systemContext } from '../../permissions.ts';
import { reportJobError } from './report.ts';

/** A signature this old with no PDF is no longer waiting on its own job's first tries. */
export const SIGNED_PDF_GRACE_MS = 10 * 60_000;

/**
 * Every 15 minutes: queues the 'signed-pdf' job again for each signature older than 10 minutes that
 * still has no signed PDF (its retries ran out during a storage outage, or the queue send after the
 * signature failed). The job is safe to repeat, and the singleton key (the proposal id) keeps one
 * waiting job per proposal. app_system lists the companies with a signed proposal; each company's
 * signatures are read in its own withTenant. One company failing never stops the rest.
 */
export async function sweepSignedPdfs(deps: AppDeps, now: Date): Promise<{ queued: number }> {
  const before = new Date(now.getTime() - SIGNED_PDF_GRACE_MS);
  let queued = 0;
  for (const companyId of await companiesWithSignedProposals(deps.pools.system)) {
    const ctx = systemContext(companyId);
    try {
      const proposalIds = await withTenant(deps.pools, ctx, (tx) => signaturesWithoutPdf(tx, ctx, before));
      for (const proposalId of proposalIds) {
        await deps.jobs.send('signed-pdf', { companyId, proposalId }, { singletonKey: proposalId });
        queued += 1;
      }
    } catch (err) {
      reportJobError(deps, err, `signed-pdf-sweep: company ${companyId}`);
    }
  }
  return { queued };
}
