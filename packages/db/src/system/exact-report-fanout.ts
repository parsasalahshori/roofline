import { and, asc, eq, isNull, lte, or } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { exactReportOrders } from '../schema/index.ts';

/*
 * The exact-report poll's fan-out. Runs on the app_system pool, which may read only id, company_id,
 * status and last_polled_at of exact_report_orders. It only LISTS the companies with a report still
 * to poll; the polling itself is done per company inside `withTenant`.
 */

/** Companies with a 'waiting' order not polled since `cutoff`, each once. */
export async function companiesWithWaitingExactOrders(system: Db, cutoff: Date): Promise<string[]> {
  const rows = await system
    .selectDistinct({ companyId: exactReportOrders.companyId })
    .from(exactReportOrders)
    .where(
      and(
        eq(exactReportOrders.status, 'waiting'),
        or(isNull(exactReportOrders.lastPolledAt), lte(exactReportOrders.lastPolledAt, cutoff)),
      ),
    )
    .orderBy(asc(exactReportOrders.companyId));
  return rows.map((r) => r.companyId);
}
