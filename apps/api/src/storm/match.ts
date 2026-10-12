import {
  candidateStormsForCompany,
  companySettings,
  countHomes,
  findCompanyStorm,
  maxInInArea,
  refreshHits,
  upsertCompanyStorm,
  withTenant,
} from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { reportJobError } from '../jobs/scheduler/report.ts';
import { systemContext } from '../permissions.ts';
import { candidateDays } from './candidate-days.ts';

/**
 * Matches one company's service area against the recent storms (the 'storm-match-company' job body).
 * Everything is read and written in ONE app_tenant transaction under RLS. The company's threshold is
 * `company_settings.hail_threshold_in` (1 inch when it has no row). For each storm of the candidate days
 * (today and the three before, UTC) in order:
 *
 * - a storm the company dismissed is left alone;
 * - a final storm is matched once more after it became final (`last_matched_at >= final_at` means that
 *   already happened), then skipped;
 * - a storm whose highest contour inside the service area is below the threshold (or that misses the area)
 *   gets no row;
 * - otherwise the home count and the customer hits (`storm_hits`, never deleted) are refreshed and the
 *   company storm is created or updated.
 *
 * A storm is "grown" when it existed and its max hail, customers or homes went up.
 * `storm-draft` is queued once per newly created company storm, after the transaction committed; a failed
 * send is reported and does not throw (the next run does not re-create the row, so it is only logged).
 */
export async function matchCompany(
  deps: AppDeps,
  companyId: string,
  now: Date,
): Promise<{ created: string[]; grown: string[] }> {
  const created: string[] = [];
  const grown: string[] = [];

  await withTenant(deps.pools, systemContext(companyId), async (tx) => {
    const [settings] = await tx.select({ threshold: companySettings.hailThresholdIn }).from(companySettings);
    const threshold = settings?.threshold ?? 1;
    const storms = await candidateStormsForCompany(tx, candidateDays(now));

    for (const storm of storms) {
      const existing = await findCompanyStorm(tx, storm.id);
      if (existing?.status === 'dismissed') continue;
      if (
        existing &&
        storm.status === 'final' &&
        storm.finalAt !== null &&
        existing.lastMatchedAt.getTime() >= storm.finalAt.getTime()
      ) {
        continue;
      }
      const inside = await maxInInArea(tx, storm.id);
      if (inside === null || inside < threshold) continue;

      const homes = await countHomes(tx, storm.id, threshold);
      const first = await upsertCompanyStorm(tx, {
        stormId: storm.id,
        maxIn: inside,
        customersHit: existing?.customersHit ?? 0,
        homesHit: homes,
        now,
      });
      const { customersHit } = await refreshHits(tx, first.companyStorm.id, storm.id, threshold);
      await upsertCompanyStorm(tx, { stormId: storm.id, maxIn: inside, customersHit, homesHit: homes, now });

      if (first.created) {
        created.push(first.companyStorm.id);
      } else if (existing && (inside > existing.maxIn || customersHit > existing.customersHit || homes > existing.homesHit)) {
        grown.push(first.companyStorm.id);
      }
    }
  });

  for (const companyStormId of created) {
    try {
      await deps.jobs.send('storm-draft', { companyId, companyStormId }, { singletonKey: companyStormId });
    } catch (err) {
      reportJobError(deps, err, `storm-match: company ${companyId}`);
    }
  }
  return { created, grown };
}

/** The 'storm-match-company' job handler: matches the company at the app clock's time. */
export async function matchCompanyStorms(deps: AppDeps, companyId: string): Promise<void> {
  await matchCompany(deps, companyId, deps.clock.now());
}
