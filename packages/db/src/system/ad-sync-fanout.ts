import { sql } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { CREATING_SWEEP_AFTER_MS } from '../repos/ad-campaign-sync.ts';

/*
 * The ad-spend-sync fan-out lists companies on the app_system pool (column grants on ad_accounts: company_id, status;
 * on ad_campaigns: id, company_id, status, external_campaign_id, platform, paused_by, updated_at); the work itself runs
 * per company in withTenant from the 'ad-sync-company' job. companiesNeedingAdSync is the union of the two lists.
 * A campaign needs guarding while it exists on the platform and Roofline has not confirmed it off: 'active', or
 * 'paused' / 'failed' / 'creating' for over an hour with paused_by not 'roofline' (same rule as listActiveCampaigns).
 */

/** The ad_campaigns rows to guard (the where clause of the two queries below). */
const liveCampaignRows = (now: Date) => sql`external_campaign_id is not null and (
  status = 'active'
  or (paused_by is distinct from 'roofline' and (
    status in ('paused', 'failed')
    or (status = 'creating' and updated_at < ${new Date(now.getTime() - CREATING_SWEEP_AFTER_MS)})
  ))
)`;

/** The companies (each once, ordered by id) that have an ad_accounts row with status 'pending'. */
export async function companiesWithPendingAdAccounts(sys: Db): Promise<{ companyId: string }[]> {
  const result = await sys.execute(
    sql`select distinct company_id as "companyId" from ad_accounts where status = 'pending' order by 1`,
  );
  return result.rows.map((r) => ({ companyId: String(r.companyId) }));
}

/** The companies (each once, ordered by id) that have an ad_campaigns row to guard. */
export async function companiesWithLiveCampaigns(sys: Db, now: Date = new Date()): Promise<{ companyId: string }[]> {
  const result = await sys.execute(
    sql`select distinct company_id as "companyId" from ad_campaigns where ${liveCampaignRows(now)} order by 1`,
  );
  return result.rows.map((r) => ({ companyId: String(r.companyId) }));
}

/** The companies (each once, ordered by id) with a pending ad account or a campaign to guard: one union statement. */
export async function companiesNeedingAdSync(sys: Db, now: Date = new Date()): Promise<{ companyId: string }[]> {
  const result = await sys.execute(
    sql`select company_id as "companyId" from ad_accounts where status = 'pending'
        union
        select company_id as "companyId" from ad_campaigns where ${liveCampaignRows(now)}
        order by 1`,
  );
  return result.rows.map((r) => ({ companyId: String(r.companyId) }));
}
