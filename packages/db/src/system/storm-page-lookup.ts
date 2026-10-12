import { eq } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { companies, stormPages } from '../schema/index.ts';

/** A storm page and the company behind it, as the public landing page needs them. */
export type StormPageLookup = {
  pageId: string;
  companyId: string;
  companyStormId: string;
  code: string;
  activeUntil: Date;
  company: {
    name: string;
    slug: string;
    phoneE164: string | null;
  };
};

/**
 * The page for a code with its company, in any activity state (the caller checks `activeUntil`).
 * Codes are stored lowercase, so the code is lowercased here. Any company status. Null when there
 * is no such code. Reads only the columns app_system is granted on storm_pages and companies.
 */
export async function stormPageForCode(system: Db, code: string): Promise<StormPageLookup | null> {
  const [row] = await system
    .select({
      pageId: stormPages.id,
      companyId: stormPages.companyId,
      companyStormId: stormPages.companyStormId,
      code: stormPages.code,
      activeUntil: stormPages.activeUntil,
      name: companies.name,
      slug: companies.slug,
      phoneE164: companies.phoneE164,
    })
    .from(stormPages)
    .innerJoin(companies, eq(companies.id, stormPages.companyId))
    .where(eq(stormPages.code, code.toLowerCase()))
    .limit(1);
  if (row === undefined) return null;
  return {
    pageId: row.pageId,
    companyId: row.companyId,
    companyStormId: row.companyStormId,
    code: row.code,
    activeUntil: row.activeUntil,
    company: { name: row.name, slug: row.slug, phoneE164: row.phoneE164 },
  };
}
