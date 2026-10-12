import { withTenant } from '@roofline/db';
import { companiesWithExpiredDrafts } from '@roofline/db/system';
import type { AppDeps } from '../../app.ts';
import { systemContext } from '../../permissions.ts';
import { expireOverdueTasks } from '../../tasks/service.ts';
import { reportJobError } from './report.ts';

/**
 * The expiry job (every 5 minutes): drafts whose time ran out (`expires_at < now`) become
 * `expired`, so they leave the approval queue and show "Expired — run again?". app_system lists the
 * companies that have one (ids and timing only); each company's drafts are then expired in that
 * company's own app_tenant transaction, under RLS. A plan already past the draft stage (partly
 * approved, running, declined) never expires, and an expired plan's steps stay `pending`.
 *
 * One company failing is logged and does not stop the others. Returns how many plans it expired.
 */
export async function expireDrafts(deps: AppDeps, now: Date): Promise<{ expired: number }> {
  let expired = 0;
  for (const companyId of await companiesWithExpiredDrafts(deps.pools.system, now)) {
    const ctx = systemContext(companyId);
    try {
      expired += (await withTenant(deps.pools, ctx, (tx) => expireOverdueTasks(tx, ctx, now))).length;
    } catch (err) {
      reportJobError(deps, err, `expire-drafts: company ${companyId}`);
    }
  }
  return { expired };
}
