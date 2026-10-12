import { companyIdsForRetention } from '@roofline/db/system';
import type { AppDeps } from '../../app.ts';
import { sweepCompanyRetention } from '../../front-desk/retention.ts';

/** Daily retention sweep for Front Desk recordings and transcripts. One company failing never stops the rest. */
export async function fdRetention(deps: AppDeps, now: Date): Promise<void> {
  const ids = await companyIdsForRetention(deps.pools.system);
  for (const id of ids) {
    try {
      await sweepCompanyRetention(deps, id, now);
    } catch {
      console.error(`Front Desk retention failed company=${id}`);
    }
  }
}
