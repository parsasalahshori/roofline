import { isAgentPaused, type TenantContext, withTenant } from '@roofline/db';
import type { AppDeps } from '../app.ts';

/**
 * Drafts the approval plan for one company storm. Stub from S1 Task 7; Task 11 fills the body below the pause
 * check and must keep that check before it creates the draft task.
 */
export async function draftStormPlan(deps: AppDeps, companyId: string, companyStormId: string): Promise<void> {
  const ctx: TenantContext = { companyId, userId: null, role: 'system', canApproveSpend: false };
  if (await withTenant(deps.pools, ctx, (tx) => isAgentPaused(tx, ctx, 'storm_scout'))) return; // paused: no new storm plan (alerts still go out)
  void companyStormId; // used by the body Task 11 adds
  throw new Error('not yet');
}
