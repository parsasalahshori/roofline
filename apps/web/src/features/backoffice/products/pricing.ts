import { TIERS, type OptionChoice, type Product, type ProductCatalog, type Tier } from '@roofline/shared';

/**
 * A price for one unit at all three levels, from the price book as it is being edited. It follows the same steps as the
 * server's pricing (base from the rule, extra sections, option adders, then markup) so the office can try a price before
 * saving. When the shared pricing code lands, swap this body for a call to it.
 */
export type PriceCheckInput = { productId: string; widthIn: number; heightIn: number; sections: number; lites: number; optionIds: string[] };
export type PriceLine = { baseCents: number; sectionsCents: number; optionsCents: number; markupCents: number; totalCents: number };
export type PriceCheckResult = { tiers: Record<Tier, PriceLine>; pastTable: boolean; outsideLimits: boolean };

export function optionsFor(catalog: ProductCatalog, productId: string): OptionChoice[] {
  return catalog.options.filter((o) => !o.archived && (o.productIds.length === 0 || o.productIds.includes(productId)));
}

export function priceCheck(catalog: ProductCatalog, input: PriceCheckInput): PriceCheckResult | null {
  const product: Product | undefined = catalog.products.find((p) => p.id === input.productId);
  if (!product) return null;
  const { widthIn, heightIn } = input;
  const sections = Math.max(1, Math.floor(input.sections) || 1);
  const area = (widthIn * heightIn) / 144;
  const ui = Math.ceil(widthIn + heightIn);
  let pastTable = false;
  const chosen = optionsFor(catalog, product.id).filter((o) => input.optionIds.includes(o.id));

  const base = (tier: Tier): number => {
    if (product.price.kind === 'sq-ft') {
      return Math.max(product.price.minimumCents[tier], Math.round(product.price.centsPerSqFt[tier] * area));
    }
    const breaks = product.price.breaks;
    const row = breaks.find((b) => ui <= b.maxUi);
    if (!row) pastTable = true;
    return (row ?? breaks[breaks.length - 1])?.cents[tier] ?? 0;
  };

  const optionCents = chosen.reduce((sum, o) => {
    const times = o.adder.per === 'unit' ? 1 : o.adder.per === 'section' ? sections : o.adder.per === 'lite' ? Math.max(0, input.lites) : area;
    return sum + Math.round(o.adder.cents * times);
  }, 0);

  const tiers = {} as Record<Tier, PriceLine>;
  for (const tier of TIERS) {
    const baseCents = base(tier);
    const sectionsCents = product.perExtraSectionCents[tier] * (sections - 1);
    const subtotal = baseCents + sectionsCents + optionCents;
    const markupCents = Math.round((subtotal * catalog.markupPercent) / 100);
    tiers[tier] = { baseCents, sectionsCents, optionsCents: optionCents, markupCents, totalCents: subtotal + markupCents };
  }
  const l = product.limits;
  const outsideLimits = widthIn < l.minWidthIn || widthIn > l.maxWidthIn || heightIn < l.minHeightIn || heightIn > l.maxHeightIn || widthIn + heightIn > l.maxUnitedIn || sections > product.maxSections;
  return { tiers, pastTable, outsideLimits };
}
