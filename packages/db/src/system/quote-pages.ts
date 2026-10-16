import { and, eq } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { companies, companySettings } from '../schema/index.ts';

/** The company behind an instant quote slug: just enough to open its tenant transaction. */
export type QuotePageCompany = { companyId: string; status: string };

/**
 * The company whose instant quote page has this slug and is turned on, through the system pool (the page is signed
 * out, so there is no tenant yet). app_system may read only company_id, quote_slug and quote_enabled of
 * company_settings (0035), so nothing else of the settings is selected here. Null for an unknown slug, a page that
 * is off, or a company that is canceled.
 */
export async function companyForQuoteSlug(system: Db, slug: string): Promise<QuotePageCompany | null> {
  const [row] = await system
    .select({ companyId: companySettings.companyId, status: companies.status })
    .from(companySettings)
    .innerJoin(companies, eq(companies.id, companySettings.companyId))
    .where(and(eq(companySettings.quoteSlug, slug.toLowerCase()), eq(companySettings.quoteEnabled, true)))
    .limit(1);
  if (!row || row.status === 'canceled') return null;
  return row;
}
