// The price and problems the editor shows while a rep draws: the shared helpers (packages/shared/src/backoffice-price.ts)
// the server runs too, so the browser's preview and the saved quote agree. Money is in cents; sizes in inches.
import {
  chosenOption as sharedChosenOption,
  priceDesign,
  priceQuote,
  type BackofficeQuote,
  type OptionChoice,
  type OptionGroup,
  type Product,
  type ProductCatalog,
  type Tier,
  type WindowDesign,
} from '@roofline/shared';

export type QuoteDraft = Pick<BackofficeQuote, 'status' | 'tier' | 'designs' | 'accessories' | 'discountPercent'>;
export type QuotePreview = Pick<BackofficeQuote, 'lines' | 'totals' | 'issues' | 'discountNeedsApproval'>;

export const productOf = (catalog: ProductCatalog, id: string): Product | undefined => catalog.products.find((p) => p.id === id);

/** The choices a unit can pick in a group: not archived, and for its product. */
export function choicesFor(catalog: ProductCatalog, group: OptionGroup, productId: string): OptionChoice[] {
  return catalog.options.filter((o) => o.group === group && !o.archived && (o.productIds.length === 0 || o.productIds.includes(productId)));
}

/** The choice a unit stands at in a group (grid and screen follow the unit's own grid type and screen). */
export function chosenOption(catalog: ProductCatalog, design: WindowDesign, group: OptionGroup): OptionChoice | undefined {
  const product = productOf(catalog, design.productId);
  return product ? (sharedChosenOption(design, product, catalog, group) ?? undefined) : undefined;
}

/** One unit's price, each, for a tier. */
export const unitPriceCents = (catalog: ProductCatalog, design: WindowDesign, tier: Tier): number => priceDesign(design, catalog, tier).unitCents;

/** Lines, totals and problems for a draft, for all three tiers. */
export function previewQuote(draft: Pick<QuoteDraft, 'designs' | 'accessories' | 'discountPercent'>, catalog: ProductCatalog): QuotePreview {
  const { lines, totals, issues, discountNeedsApproval } = priceQuote(draft, catalog);
  return { lines, totals, issues, discountNeedsApproval };
}

export const dollars = (cents: number): string => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
