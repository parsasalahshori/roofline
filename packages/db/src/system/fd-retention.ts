import { asc } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { companies } from '../schema/index.ts';

/** Every company id, oldest id first. Runs on app_system (the companies table is global). */
export async function companyIdsForRetention(system: Db): Promise<string[]> {
  const rows = await system.select({ id: companies.id }).from(companies).orderBy(asc(companies.id));
  return rows.map((r) => r.id);
}
