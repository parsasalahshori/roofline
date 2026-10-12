import { sql } from 'drizzle-orm';
import type { Db } from '../pools.ts';

/*
 * The ad-spend-sync fan-out lists companies on the app_system pool (column grant on ad_accounts: company_id, status);
 * the work itself runs per company in withTenant from the 'ad-sync-company' job.
 * Task 19 adds a companies-with-live-campaigns list beside this one.
 */

/** The companies (each once, ordered by id) that have an ad_accounts row with status 'pending'. */
export async function companiesWithPendingAdAccounts(sys: Db): Promise<{ companyId: string }[]> {
  const result = await sys.execute(
    sql`select distinct company_id as "companyId" from ad_accounts where status = 'pending' order by 1`,
  );
  return result.rows.map((r) => ({ companyId: String(r.companyId) }));
}
