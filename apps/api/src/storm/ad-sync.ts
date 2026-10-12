import type { AppDeps } from '../app.ts';
import { recheckPendingAdAccounts } from './ad-recheck.ts';

/** Syncs one company's ad accounts and (Task 19) ad spend. Today: the recheck of accounts waiting to be accepted. */
export async function syncCompanyAds(deps: AppDeps, companyId: string): Promise<void> {
  await recheckPendingAdAccounts(deps, companyId);
  // Task 19 adds the campaign spend sync and the 95% pause here, beside the recheck.
}
