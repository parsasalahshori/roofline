import { listSettleCandidates, withTenant } from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { reportJobError } from '../jobs/scheduler/report.ts';
import { systemContext } from '../permissions.ts';
import { alertUnalerted } from './alerts.ts';
import { candidateDays } from './candidate-days.ts';

/** The minutes after `last_grew_at` at which a provisional storm counts as settled. */
export const SETTLE_MINUTES = 90;

export type ShouldDraftCompanyStorm = { status: 'new' | 'planned' | 'dismissed'; planTaskId: string | null; planStatus: 'draft' | 'other' | null };
export type ShouldDraftStorm = { status: 'provisional' | 'final'; lastGrewAt: Date };

/**
 * Decides what to do with a company storm: 'skip' when dismissed, or when a plan exists and is not a draft
 * that the storm outgrew ('redraft'; an approved or running plan is never replaced); with no plan, 'draft'
 * once the storm is final or SETTLE_MINUTES passed since it last grew, else 'wait'. The machine never
 * re-drafts an expired or declined plan (planStatus 'other'); only the owner does, through the route.
 */
export function shouldDraft(cs: ShouldDraftCompanyStorm, storm: ShouldDraftStorm, now: Date, grownSinceDraft: boolean): 'draft' | 'redraft' | 'wait' | 'skip' {
  if (cs.status === 'dismissed') return 'skip';
  if (cs.planTaskId !== null) return cs.planStatus === 'draft' && grownSinceDraft ? 'redraft' : 'skip';
  if (storm.status === 'final' || now.getTime() - storm.lastGrewAt.getTime() >= SETTLE_MINUTES * 60_000) return 'draft';
  return 'wait';
}

/**
 * Runs after matchCompany committed: alerts every unalerted recent storm once (alertUnalerted; the db list is
 * bounded to the last 3 days, so a storm whose alert failed on an earlier run is retried here), then queues 'storm-draft'
 * for every candidate storm that shouldDraft says to draft or redraft (singletonKey = company storm id).
 * A redraft replaces only a draft plan. The 10 minute storm-match cadence drives the 90 minute settle: each
 * run re-checks. Failures are reported, never thrown.
 */
export async function afterMatch(deps: AppDeps, companyId: string, now: Date, result: { created: string[]; grown: string[] }): Promise<void> {
  try {
    await alertUnalerted(deps, companyId);
  } catch (err) {
    reportJobError(deps, err, `storm-match: alert company ${companyId}`);
  }

  let rows: Awaited<ReturnType<typeof listSettleCandidates>>;
  try {
    rows = await withTenant(deps.pools, systemContext(companyId), (tx) => listSettleCandidates(tx, candidateDays(now)));
  } catch (err) {
    reportJobError(deps, err, `storm-match: settle company ${companyId}`);
    return;
  }
  for (const row of rows) {
    const verdict = shouldDraft(
      { status: row.status, planTaskId: row.planTaskId, planStatus: row.planStatus },
      { status: row.stormStatus, lastGrewAt: row.lastGrewAt },
      now,
      result.grown.includes(row.companyStormId),
    );
    if (verdict !== 'draft' && verdict !== 'redraft') continue;
    try {
      await deps.jobs.send('storm-draft', { companyId, companyStormId: row.companyStormId }, { singletonKey: row.companyStormId });
    } catch (err) {
      reportJobError(deps, err, `storm-match: draft company ${companyId}`);
    }
  }
}
