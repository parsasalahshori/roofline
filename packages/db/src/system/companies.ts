import { eq } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { companies } from '../schema/index.ts';

/*
 * Finding a company by its slug, on the app_system pool (companies is a global table, and outside
 * a company's own transaction app_tenant cannot see any of them). For operator tools such as the
 * demo seed; a request never needs it.
 */

export type CompanyBySlug = { id: string; name: string; slug: string };

/** The company with this slug (slugs are stored lowercase), or null. */
export async function findCompanyBySlug(system: Db, slug: string): Promise<CompanyBySlug | null> {
  const [row] = await system
    .select({ id: companies.id, name: companies.name, slug: companies.slug })
    .from(companies)
    .where(eq(companies.slug, slug))
    .limit(1);
  return row ?? null;
}
