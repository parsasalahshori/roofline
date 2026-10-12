import { eq } from 'drizzle-orm';
import { defaultPricebook, defaultScope, type Pricebook, type PricebookView, type QuoteDefaults } from '@roofline/shared';
import { pricebooks } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/**
 * The quote defaults a company starts with: the non-price fields of v1's default scope, so a new
 * quote's waste, markup, tax and material come from one place. Prices are never written here.
 */
export const DEFAULT_QUOTE_DEFAULTS: QuoteDefaults = {
  wastePercent: defaultScope.wastePercent,
  markupPercent: defaultScope.markupPercent,
  taxPercent: defaultScope.taxPercent,
  material: defaultScope.material,
};

/**
 * The company's pricebook. A company that never saved one sees v1's example prices, marked
 * `isExample` so the screen can say so. RLS already limits the read to the company; the filter is
 * repeated so the query is correct without relying on it alone.
 */
export async function getPricebook(tx: Tx, ctx: TenantContext): Promise<PricebookView> {
  const [row] = await tx.select().from(pricebooks).where(eq(pricebooks.companyId, ctx.companyId)).limit(1);
  if (!row) return { prices: defaultPricebook, defaults: DEFAULT_QUOTE_DEFAULTS, isExample: true };
  return {
    prices: row.prices as Pricebook,
    defaults: { ...DEFAULT_QUOTE_DEFAULTS, ...(row.defaults as Partial<QuoteDefaults>) },
    isExample: false,
  };
}

/** Saves the company's pricebook (one row per company, replaced on each save). */
export async function savePricebook(
  tx: Tx,
  ctx: TenantContext,
  p: { prices: Pricebook; defaults: QuoteDefaults },
  now: Date,
): Promise<PricebookView> {
  const { prices, defaults } = p;
  await tx
    .insert(pricebooks)
    .values({
      companyId: ctx.companyId,
      prices,
      defaults,
      updatedByUserId: ctx.userId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: pricebooks.companyId,
      set: { prices, defaults, updatedByUserId: ctx.userId, updatedAt: now },
    });
  return { prices, defaults, isExample: false };
}
