import { eq } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { companies } from '../schema/index.ts';

/** The company details the hosted privacy and terms pages show. */
export type PolicyCompany = {
  name: string;
  legalName: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phoneE164: string | null;
  email: string | null;
  website: string | null;
};

/**
 * The company behind a policy page slug, found by companies.slug (stored lowercase, so the slug is
 * lowercased here). Any status: a suspended company's pages still resolve. Null when there is none.
 */
export async function companyForPolicyPage(system: Db, slug: string): Promise<PolicyCompany | null> {
  const [row] = await system
    .select({
      name: companies.name,
      legalName: companies.legalName,
      street: companies.addressStreet,
      city: companies.addressCity,
      state: companies.addressState,
      zip: companies.addressZip,
      phoneE164: companies.phoneE164,
      email: companies.email,
      website: companies.website,
    })
    .from(companies)
    .where(eq(companies.slug, slug.toLowerCase()))
    .limit(1);
  return row ?? null;
}
