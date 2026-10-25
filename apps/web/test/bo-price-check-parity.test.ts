import { DEFAULT_PRODUCT_CATALOG, NO_SAFETY_ANSWERS, priceQuote, TIERS, type WindowDesign } from '@roofline/shared';
import { describe, expect, it } from 'vitest';
import { priceCheck } from '../src/features/backoffice/products/pricing.ts';

// The products page's Price check must quote what a drawn unit costs (the shared engine the quotes and the server use):
// one section, no grid lites, the product's default options, at sizes inside and past the price table.
describe('Price check agrees with the quote engine', () => {
  const catalog = { ...DEFAULT_PRODUCT_CATALOG, accessories: [] };
  const sizes: [number, number][] = [[24, 36], [36, 48], [36, 60], [48, 60]];
  for (const product of catalog.products.filter((p) => !p.archived)) {
    for (const [w, h] of sizes) {
      it(`${product.name} ${w} x ${h}`, () => {
        if (w < product.limits.minWidthIn || w > product.limits.maxWidthIn || h < product.limits.minHeightIn || h > product.limits.maxHeightIn) return;
        const defaults = catalog.options.filter((o) => o.isDefault && !o.archived && (o.productIds.length === 0 || o.productIds.includes(product.id)));
        const design: WindowDesign = {
          id: 'd1', label: 'Test', productId: product.id, quantity: 1, shape: product.shapes[0] ?? 'rect', widthIn: w, heightIn: h,
          layout: { kind: 'section', id: 's1', opening: product.openings[0]!, grid: '' },
          options: Object.fromEntries(defaults.map((o) => [o.group, o.id])),
          gridType: 'none', screen: 'none', safety: { ...NO_SAFETY_ANSWERS }, sizeSource: { kind: 'typed' }, notes: '',
        };
        const engine = priceQuote({ designs: [design], accessories: [], discountPercent: 0 }, catalog);
        const check = priceCheck(catalog, { productId: product.id, widthIn: w, heightIn: h, sections: 1, lites: 0, optionIds: defaults.map((o) => o.id) })!;
        for (const tier of TIERS) expect(check.tiers[tier].totalCents, tier).toBe(engine.totals[tier].totalCents);
      });
    }
  }
});
