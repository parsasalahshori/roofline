// The price and problems the editor shows while a rep draws. This is a LOCAL ADAPTER: the same maths the server runs,
// kept behind one function so it can be swapped for the shared helpers (packages/shared/src/backoffice-price.ts, from
// branch winchoice/backoffice-api) in this one file. Money is in cents; sizes in inches.
import { TIERS, fractionInches, type BackofficeQuote, type BackofficeQuoteLine, type DesignIssue, type OptionChoice, type OptionGroup, type Product, type ProductCatalog, type QuoteTotals, type Tier, type WindowDesign } from '@roofline/shared';
import { listSections } from '../drawing/layout.ts';
import { parsePattern, sashPatterns } from '../drawing/UnitDrawing.tsx';

export type QuoteDraft = Pick<BackofficeQuote, 'status' | 'tier' | 'designs' | 'accessories' | 'discountPercent'>;
export type QuotePreview = Pick<BackofficeQuote, 'lines' | 'totals' | 'issues' | 'discountNeedsApproval'>;

export const productOf = (catalog: ProductCatalog, id: string): Product | undefined => catalog.products.find((p) => p.id === id);

/** The choices a unit can pick in a group: not archived, and for its product. */
export function choicesFor(catalog: ProductCatalog, group: OptionGroup, productId: string): OptionChoice[] {
  return catalog.options.filter((o) => o.group === group && !o.archived && (o.productIds.length === 0 || o.productIds.includes(productId)));
}

/** The choice a unit has in a group: its own, else the product's default for that group. */
export function chosenOption(catalog: ProductCatalog, design: WindowDesign, group: OptionGroup): OptionChoice | undefined {
  const all = choicesFor(catalog, group, design.productId);
  const own = design.options[group];
  return all.find((o) => o.id === own) ?? all.find((o) => o.isDefault);
}

/** How many lites a unit has in all (for per-lite grid prices). */
export function liteCount(design: Pick<WindowDesign, 'layout' | 'gridType'>): number {
  if (design.gridType === 'none') return 0;
  return listSections(design.layout).reduce((sum, s) => {
    const count = (p: string) => {
      const lites = parsePattern(p);
      return lites === null ? 0 : lites.across * lites.down;
    };
    if (s.opening === 'hung-sash') {
      const { top, bottom } = sashPatterns(s.grid);
      return sum + count(top) + count(bottom);
    }
    return sum + count(sashPatterns(s.grid).top);
  }, 0);
}

function basePriceCents(product: Product, design: WindowDesign, tier: Tier): number {
  const rule = product.price;
  if (rule.kind === 'sq-ft') {
    const sqFt = (design.widthIn * design.heightIn) / 144;
    return Math.max(rule.minimumCents[tier], Math.round(rule.centsPerSqFt[tier] * sqFt));
  }
  const ui = Math.ceil(design.widthIn + design.heightIn);
  const breaks = [...rule.breaks].sort((a, b) => a.maxUi - b.maxUi);
  const hit = breaks.find((b) => ui <= b.maxUi) ?? breaks[breaks.length - 1];
  return hit ? hit.cents[tier] : 0;
}

/** One unit's price, each, for a tier. */
export function unitPriceCents(catalog: ProductCatalog, design: WindowDesign, tier: Tier): number {
  const product = productOf(catalog, design.productId);
  if (!product) return 0;
  const sections = listSections(design.layout).length;
  let cents = basePriceCents(product, design, tier) + Math.max(sections - 1, 0) * product.perExtraSectionCents[tier];
  const sqFt = (design.widthIn * design.heightIn) / 144;
  const lites = liteCount(design);
  for (const group of ['exterior-color', 'interior-color', 'glass', 'grid', 'screen', 'obscure', 'tempered', 'hardware'] as const) {
    const choice = chosenOption(catalog, design, group);
    if (!choice) continue;
    const { per, cents: c } = choice.adder;
    cents += per === 'unit' ? c : per === 'section' ? c * sections : per === 'lite' ? c * lites : Math.round(c * sqFt);
  }
  return cents;
}

const sizeText = (d: WindowDesign) => `${fractionInches(d.widthIn)} x ${fractionInches(d.heightIn)}`;

function issuesFor(catalog: ProductCatalog, design: WindowDesign): DesignIssue[] {
  const out: DesignIssue[] = [];
  const add = (level: DesignIssue['level'], field: string, message: string) => out.push({ designId: design.id, level, field, message });
  const product = productOf(catalog, design.productId);
  if (!product) {
    add('error', 'productId', 'Pick a product for this unit.');
    return out;
  }
  if (product.archived) add('warning', 'productId', `${product.name} is no longer sold.`);
  const l = product.limits;
  if (design.widthIn < l.minWidthIn) add('error', 'widthIn', `Too narrow for this product: ${fractionInches(l.minWidthIn)} in minimum.`);
  if (design.widthIn > l.maxWidthIn) add('error', 'widthIn', `Too wide for this product: ${fractionInches(l.maxWidthIn)} in maximum.`);
  if (design.heightIn < l.minHeightIn) add('error', 'heightIn', `Too short for this product: ${fractionInches(l.minHeightIn)} in minimum.`);
  if (design.heightIn > l.maxHeightIn) add('error', 'heightIn', `Too tall for this product: ${fractionInches(l.maxHeightIn)} in maximum.`);
  if (design.widthIn + design.heightIn > l.maxUnitedIn) add('error', 'size', `Over the ${l.maxUnitedIn} united inches this product allows.`);
  if (!product.shapes.includes(design.shape)) add('error', 'shape', 'This product cannot be made in that shape.');
  const sections = listSections(design.layout);
  if (sections.length > product.maxSections) add('error', 'layout', `At most ${product.maxSections} sections in this product.`);
  for (const s of sections) {
    if (!product.openings.includes(s.opening)) {
      add('error', 'layout', 'A section opens in a way this product cannot.');
      break;
    }
  }
  return out;
}

const emptyTotals = (): QuoteTotals => ({ subtotalCents: 0, markupCents: 0, discountCents: 0, totalCents: 0 });

/** Lines, totals and problems for a draft, for all three tiers. */
export function previewQuote(draft: Pick<QuoteDraft, 'designs' | 'accessories' | 'discountPercent'>, catalog: ProductCatalog): QuotePreview {
  const lines = { good: [], better: [], best: [] } as Record<Tier, BackofficeQuoteLine[]>;
  const totals = { good: emptyTotals(), better: emptyTotals(), best: emptyTotals() } as Record<Tier, QuoteTotals>;
  const issues = draft.designs.flatMap((d) => issuesFor(catalog, d));
  const units = draft.designs.reduce((n, d) => n + d.quantity, 0);
  const linearFt = draft.designs.reduce((n, d) => n + ((2 * (d.widthIn + d.heightIn)) / 12) * d.quantity, 0);
  const discount = Math.max(draft.discountPercent, 0);

  for (const tier of TIERS) {
    const tierLines: BackofficeQuoteLine[] = draft.designs.map((d) => {
      const unitCents = unitPriceCents(catalog, d, tier);
      const name = productOf(catalog, d.productId)?.name ?? '';
      return { designId: d.id, accessoryId: null, description: `${d.label}: ${name} ${sizeText(d)}`, quantity: d.quantity, unitCents, amountCents: unitCents * d.quantity };
    });
    for (const a of draft.accessories) {
      const acc = catalog.accessories.find((x) => x.id === a.accessoryId);
      if (!acc) continue;
      const basis = acc.per === 'job' ? 1 : acc.per === 'unit' ? units : Math.ceil(linearFt);
      tierLines.push({ designId: null, accessoryId: acc.id, description: acc.label, quantity: a.quantity, unitCents: acc.cents * basis, amountCents: acc.cents * basis * a.quantity });
    }
    const subtotalCents = tierLines.reduce((n, x) => n + x.amountCents, 0);
    const markupCents = Math.round((subtotalCents * catalog.markupPercent) / 100);
    const discountCents = Math.round(((subtotalCents + markupCents) * discount) / 100);
    lines[tier] = tierLines;
    totals[tier] = { subtotalCents, markupCents, discountCents, totalCents: subtotalCents + markupCents - discountCents };
  }
  return { lines, totals, issues, discountNeedsApproval: discount > catalog.maxRepDiscountPercent };
}

export const dollars = (cents: number): string => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
