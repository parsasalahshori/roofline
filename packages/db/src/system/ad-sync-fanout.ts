import { sql } from 'drizzle-orm';
import type { Db } from '../pools.ts';

/*
 * The ad-spend-sync fan-out lists companies on the app_system pool (column grants on ad_accounts: company_id, status;
 * on ad_campaigns: id, company_id, status, external_campaign_id, platform); the work itself runs per company in
 * withTenant from the 'ad-sync-company' job. companiesNeedingAdSync is the union of the two lists.
 */

/** The companies (each once, ordered by id) that have an ad_accounts row with status 'pending'. */
export async function companiesWithPendingAdAccounts(sys: Db): Promise<{ companyId: string }[]> {
  const result = await sys.execute(
    sql`select distinct company_id as "companyId" from ad_accounts where status = 'pending' order by 1`,
  );
  return result.rows.map((r) => ({ companyId: String(r.companyId) }));
}

/** The companies (each once, ordered by id) that have an ad_campaigns row with status 'active'. */
export async function companiesWithLiveCampaigns(sys: Db): Promise<{ companyId: string }[]> {
  const result = await sys.execute(
    sql`select distinct company_id as "companyId" from ad_campaigns where status = 'active' order by 1`,
  );
  return result.rows.map((r) => ({ companyId: String(r.companyId) }));
}

/** The companies (each once, ordered by id) with a pending ad account or a live campaign: one union statement. */
export async function companiesNeedingAdSync(sys: Db): Promise<{ companyId: string }[]> {
  const result = await sys.execute(
    sql`select company_id as "companyId" from ad_accounts where status = 'pending'
        union
        select company_id as "companyId" from ad_campaigns where status = 'active'
        order by 1`,
  );
  return result.rows.map((r) => ({ companyId: String(r.companyId) }));
}
