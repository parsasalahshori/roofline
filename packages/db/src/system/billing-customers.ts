import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { companies } from '../schema/index.ts';

/*
 * Stripe customer ids on the app_system pool. Checkout can race with itself (two tabs, a retry),
 * so the first customer id written to a company wins and every later caller gets that same id.
 */

/**
 * Stores `customerId` on the company when it has none yet, then returns the id now stored. When
 * another caller already stored one, that id is returned and `customerId` is not written. Throws
 * when the company is missing or has no customer id after the write.
 */
export async function setStripeCustomerIfMissing(system: Db, companyId: string, customerId: string): Promise<string> {
  await system
    .update(companies)
    .set({ stripeCustomerId: customerId })
    .where(and(eq(companies.id, companyId), isNull(companies.stripeCustomerId)));
  const [row] = await system
    .select({ stripeCustomerId: companies.stripeCustomerId })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (!row?.stripeCustomerId) throw new Error(`setStripeCustomerIfMissing: no stripe customer for ${companyId}`);
  return row.stripeCustomerId;
}
