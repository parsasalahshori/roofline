import { asc, inArray } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { calls } from '../schema/index.ts';
import { STUCK_CALL_STATUSES } from '../repos/calls.ts';

/**
 * The companies that have a call in a live status ('ringing', 'ai' or 'ringing_team'), ids only, for
 * the fd-health stuck-call sweep (Ruling BJ). It reads only company_id and status on app_system; the
 * age bounds and the update run per company on the tenant pool (`endStuckCallsForCompany`).
 */
export async function companiesWithLiveCalls(system: Db): Promise<string[]> {
  const rows = await system
    .selectDistinct({ companyId: calls.companyId })
    .from(calls)
    .where(inArray(calls.status, [...STUCK_CALL_STATUSES]))
    .orderBy(asc(calls.companyId));
  return rows.map((r) => r.companyId);
}
