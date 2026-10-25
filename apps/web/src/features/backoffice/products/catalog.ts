import { TIERS, type Accessory, type OptionChoice, type Product, type ProductCatalog, type Tier } from '@roofline/shared';
import { backoffice as copy } from '../../../copy/backoffice.ts';

const errors = copy.products.errors;

let counter = 0;
/** A new id for something the office adds. Unique within the price book and across sessions. */
export function newId(prefix: string): string {
  counter += 1;
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${random}${counter}`;
}

const tiers = (cents: number): Record<Tier, number> => ({ good: cents, better: cents, best: cents });

export function emptyProduct(): Product {
  return {
    id: newId('product'),
    kind: 'window',
    name: copy.products.newProductName,
    description: '',
    openings: ['fixed'],
    shapes: ['rect'],
    limits: { minWidthIn: 12, maxWidthIn: 72, minHeightIn: 12, maxHeightIn: 96, maxUnitedIn: 150 },
    maxSections: 1,
    price: { kind: 'united-inch', breaks: [{ maxUi: 100, cents: tiers(0) }] },
    perExtraSectionCents: tiers(0),
    archived: false,
  };
}

export function emptyOption(group: OptionChoice['group']): OptionChoice {
  return {
    id: newId('option'),
    group,
    label: copy.products.newOptionLabel,
    value: '',
    adder: { per: 'unit', cents: 0 },
    productIds: [],
    isDefault: false,
    archived: false,
  };
}

export function emptyAccessory(): Accessory {
  return { id: newId('accessory'), label: copy.products.newAccessoryLabel, per: 'job', cents: 0, autoAdd: false, archived: false };
}

/** A price rule of the other kind, seeded so the table is never empty. */
export function seedRule(kind: Product['price']['kind']): Product['price'] {
  return kind === 'united-inch'
    ? { kind, breaks: [{ maxUi: 100, cents: tiers(0) }] }
    : { kind, centsPerSqFt: tiers(0), minimumCents: tiers(0) };
}

export type CatalogErrors = Map<string, string>;

const bad = (value: number): string | null => (!Number.isFinite(value) ? errors.number : value < 0 ? errors.negative : null);

/** Everything wrong with the price book, by field key. Archived things are left alone: they are off the sheet. */
export function validateCatalog(catalog: ProductCatalog): CatalogErrors {
  const found: CatalogErrors = new Map();
  const put = (key: string, message: string | null) => {
    if (message) found.set(key, message);
  };

  for (const p of catalog.products) {
    if (p.archived) continue;
    const k = `p:${p.id}:`;
    put(k + 'name', p.name.trim() === '' ? errors.nameEmpty : null);
    put(k + 'openings', p.openings.length === 0 ? errors.noOpenings : null);
    put(k + 'shapes', p.shapes.length === 0 ? errors.noShapes : null);
    for (const key of ['minWidthIn', 'maxWidthIn', 'minHeightIn', 'maxHeightIn', 'maxUnitedIn'] as const) put(k + key, bad(p.limits[key]));
    if (!found.has(k + 'maxWidthIn') && p.limits.maxWidthIn < p.limits.minWidthIn) put(k + 'maxWidthIn', errors.limitOrder);
    if (!found.has(k + 'maxHeightIn') && p.limits.maxHeightIn < p.limits.minHeightIn) put(k + 'maxHeightIn', errors.limitOrder);
    put(k + 'maxSections', Number.isInteger(p.maxSections) && p.maxSections >= 1 ? null : errors.sections);
    if (p.price.kind === 'united-inch') {
      put(k + 'breaks', p.price.breaks.length === 0 ? errors.noBreaks : null);
      p.price.breaks.forEach((row, index) => {
        put(`${k}break:${index}:maxUi`, bad(row.maxUi));
        const above = p.price.kind === 'united-inch' ? p.price.breaks[index - 1] : undefined;
        if (!found.has(`${k}break:${index}:maxUi`) && above && Number.isFinite(above.maxUi) && row.maxUi <= above.maxUi) put(`${k}break:${index}:maxUi`, errors.breakOrder);
        for (const tier of TIERS) put(`${k}break:${index}:${tier}`, bad(row.cents[tier]));
      });
    } else {
      for (const tier of TIERS) {
        put(`${k}rate:${tier}`, bad(p.price.centsPerSqFt[tier]));
        put(`${k}min:${tier}`, bad(p.price.minimumCents[tier]));
      }
    }
    for (const tier of TIERS) put(`${k}extra:${tier}`, bad(p.perExtraSectionCents[tier]));
  }

  for (const o of catalog.options) {
    if (o.archived) continue;
    const k = `o:${o.id}:`;
    put(k + 'label', o.label.trim() === '' ? errors.labelEmpty : null);
    put(k + 'value', o.value.trim() === '' ? errors.valueEmpty : null);
    put(k + 'cents', Number.isFinite(o.adder.cents) ? null : errors.number);
  }
  for (const a of catalog.accessories) {
    if (a.archived) continue;
    const k = `a:${a.id}:`;
    put(k + 'label', a.label.trim() === '' ? errors.labelEmpty : null);
    put(k + 'cents', bad(a.cents));
  }
  for (const tier of TIERS) put(`t:${tier}`, catalog.tiers[tier].label.trim() === '' ? errors.tierName : null);
  const percent = (value: number) => (Number.isFinite(value) && value >= 0 && value <= 100 ? null : errors.percent);
  put('markup', percent(catalog.markupPercent));
  put('maxDiscount', percent(catalog.maxRepDiscountPercent));
  return found;
}

/** Which section of the editor a field key belongs to, to point a person at what needs fixing. */
export function sectionOf(key: string): 'products' | 'options' | 'accessories' | 'rules' {
  return key.startsWith('p:') ? 'products' : key.startsWith('o:') ? 'options' : key.startsWith('a:') ? 'accessories' : 'rules';
}

/** A short word for how a product is priced, for the table. */
export function ruleLabel(product: Product): string {
  return product.price.kind === 'united-inch' ? copy.products.ruleUnitedInch : copy.products.ruleSqFt;
}
