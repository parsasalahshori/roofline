import { asc, isNull } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { usageEvents } from '../schema/index.ts';

/*
 * The usage reporter's fan-out. Runs on the app_system pool, which may read only a few columns of
 * usage_events (id, company, kind and reported_to_stripe_at; never quantities, descriptions or
 * Stripe ids). It only LISTS the companies with usage still to report; the reporting itself is done
 * per company by the caller, inside `withTenant`, as app_tenant and under RLS.
 */

/** The companies that have usage not yet reported to Stripe (`reported_to_stripe_at` is null), each once. */
export async function companiesWithUnreportedUsage(system: Db): Promise<string[]> {
  const rows = await system
    .selectDistinct({ companyId: usageEvents.companyId })
    .from(usageEvents)
    .where(isNull(usageEvents.reportedToStripeAt))
    .orderBy(asc(usageEvents.companyId));
  return rows.map((r) => r.companyId);
}
