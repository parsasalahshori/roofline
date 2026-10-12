// Pricing of one tier plus add-ons. Rounding follows calculateQuote in pricing.ts.
import type { AddOnUnit } from './proposals.ts';
import { calculateQuote, type Scope, type Pricebook, type Calculation, type QuoteLine } from './pricing.ts';
import type { TierTemplate, MeasuredQuantities } from './tiers.ts';

export function addOnQuantity(unit: AddOnUnit, q: MeasuredQuantities): number {
  switch (unit) {
    case 'per_square': return q.squares;
    case 'per_edge_ft': return q.edgeFt;
    case 'per_ridge_ft': return q.ridgeFt;
    case 'per_valley_ft': return q.valleyFt;
    case 'per_job': return 1;
  }
}

// Recomputes subtotal, markup and tax over ALL lines, with the same rules as calculateQuote.
export function withAddOns(calc: Calculation, addOnLines: QuoteLine[], markupPercent: number, taxPercent: number): Calculation {
  const lines = [...calc.lines, ...addOnLines];
  const subtotalCents = lines.reduce((v, l) => v + l.totalCents, 0);
  const markupCents = Math.round(subtotalCents * markupPercent / 100);
  const taxable = lines.filter(l => l.taxable).reduce((v, l) => v + l.totalCents, 0);
  const taxCents = Math.round(Math.round(taxable * (1 + markupPercent / 100)) * taxPercent / 100);
  const totalCents = subtotalCents + markupCents + taxCents;
  return { ...calc, lines, subtotalCents, markupCents, taxCents, totalCents };
}

export type TierPrice = { scope: Scope; calculation: Calculation; addOnLines: QuoteLine[]; totalCents: number };

export function priceTier(t: TierTemplate, base: Omit<Scope, 'material' | 'wastePercent' | 'markupPercent'> & { markupPercent: number }, prices: Pricebook, q: MeasuredQuantities): TierPrice {
  const scope: Scope = {
    ...base,
    material: t.material,
    wastePercent: t.wastePercent,
    markupPercent: t.markupPercent ?? base.markupPercent,
  };
  const calc = calculateQuote(scope, prices);
  const addOnLines: QuoteLine[] = [];
  t.addOns.forEach((a, index) => {
    let quantity = addOnQuantity(a.unit, q);
    if (a.unit === 'per_square') quantity *= 1 + t.wastePercent / 100;
    if (quantity <= 0) return;
    addOnLines.push({
      code: `addon:${index}`,
      name: a.name,
      quantity: Math.round(quantity * 10000) / 10000,
      unit: a.unit,
      unitCents: a.rateCents,
      totalCents: Math.round(quantity * a.rateCents),
      taxable: a.taxable,
    });
  });
  const calculation = withAddOns(calc, addOnLines, scope.markupPercent, scope.taxPercent);
  return { scope, calculation, addOnLines, totalCents: calculation.totalCents };
}
