import { asc, ne } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { companies } from '../schema/index.ts';

/*
 * The companies the G1 agent jobs fan out over, on the app_system pool. companies is a global table;
 * app_system has no grant on company_settings (0024), so the reminder hour is read per company inside
 * withTenant by the job that needs it, not here.
 */

export type CompanyForAgentJobs = { id: string; timeZone: string };

/** Every company that is not canceled, oldest first, with its time zone. */
export async function companiesForAgentJobs(system: Db): Promise<CompanyForAgentJobs[]> {
  return system
    .select({ id: companies.id, timeZone: companies.timezone })
    .from(companies)
    .where(ne(companies.status, 'canceled'))
    .orderBy(asc(companies.createdAt), asc(companies.id));
}
