import { z } from 'zod';

const amount = z.number().finite().min(0).max(100000);
export const pricebookSchema = z.object({
  architecturalBundle: amount, premiumBundle: amount, metalPerSquare: amount,
  laborPerSquare: amount, metalLaborPerSquare: amount, tearoffPerSquare: amount,
  underlaymentPerSquare: amount, steepPerSquare: amount, heightPerSquare: amount,
  ridgePerFt: amount, edgePerFt: amount, valleyPerFt: amount, deckingPerSheet: amount,
  disposal: amount, permit: amount,
});
export type Pricebook = z.infer<typeof pricebookSchema>;
export const defaultPricebook: Pricebook = {
  architecturalBundle: 42, premiumBundle: 62, metalPerSquare: 310,
  laborPerSquare: 135, metalLaborPerSquare: 230, tearoffPerSquare: 55,
  underlaymentPerSquare: 24, steepPerSquare: 45, heightPerSquare: 25,
  ridgePerFt: 5.5, edgePerFt: 3.5, valleyPerFt: 8, deckingPerSheet: 95,
  disposal: 450, permit: 250,
};
/** The largest roof the pricing engine prices: surface area in sq ft, and each measured length in ft. */
export const PRICING_LIMITS = { maxAreaSqFt: 100000, maxLengthFt: 10000 } as const;
export const scopeSchema = z.object({
  areaSqFt: z.number().finite().positive().max(PRICING_LIMITS.maxAreaSqFt),
  areaType: z.enum(['surface', 'footprint']), pitch: z.number().finite().min(0).max(24),
  material: z.enum(['architectural', 'premium', 'metal']),
  wastePercent: z.number().finite().min(0).max(50),
  stories: z.number().int().min(1).max(4), layers: z.number().int().min(0).max(4),
  ridgeFt: z.number().finite().min(0).max(PRICING_LIMITS.maxLengthFt), edgeFt: z.number().finite().min(0).max(PRICING_LIMITS.maxLengthFt),
  valleyFt: z.number().finite().min(0).max(PRICING_LIMITS.maxLengthFt), deckingSheets: z.number().int().min(0).max(1000),
  markupPercent: z.number().finite().min(0).max(100), taxPercent: z.number().finite().min(0).max(15),
});
export type Scope = z.infer<typeof scopeSchema>;
export const defaultScope: Scope = {
  areaSqFt: 2480, areaType: 'surface', pitch: 6, material: 'architectural', wastePercent: 12,
  stories: 1, layers: 1, ridgeFt: 0, edgeFt: 0, valleyFt: 0, deckingSheets: 0,
  markupPercent: 25, taxPercent: 0,
};
export const materialNames = { architectural: 'Architectural shingles', premium: 'Designer shingles', metal: 'Standing seam metal' };
export type QuoteLine = { code: string; name: string; quantity: number; unit: string; unitCents: number; totalCents: number; taxable: boolean };
export function toSurfaceArea(area: number, type: Scope['areaType'], pitch: number) {
  return type === 'footprint' ? area * Math.sqrt(1 + (pitch / 12) ** 2) : area;
}
export function calculateQuote(input: Scope, prices: Pricebook) {
  const s = scopeSchema.parse(input), p = pricebookSchema.parse(prices);
  const surfaceAreaSqFt = toSurfaceArea(s.areaSqFt, s.areaType, s.pitch);
  const roofSquares = surfaceAreaSqFt / 100;
  const materialBundles = Math.ceil((roofSquares * (1 + s.wastePercent / 100) * 3) - 1e-9);
  const orderedSquares = s.material === 'metal' ? Math.ceil(roofSquares * (1 + s.wastePercent / 100) * 10) / 10 : materialBundles / 3;
  const lines: QuoteLine[] = [];
  const add = (code: string, name: string, quantity: number, unit: string, rate: number, taxable = false) => {
    if (quantity <= 0) return;
    const unitCents = Math.round(rate * 100);
    lines.push({ code, name, quantity: Math.round(quantity * 10000) / 10000, unit, unitCents, totalCents: Math.round(quantity * unitCents), taxable });
  };
  add('material', materialNames[s.material], s.material === 'metal' ? orderedSquares : materialBundles, s.material === 'metal' ? 'sq' : 'bundle', s.material === 'metal' ? p.metalPerSquare : s.material === 'premium' ? p.premiumBundle : p.architecturalBundle, true);
  add('underlayment', 'Synthetic underlayment', orderedSquares, 'sq', p.underlaymentPerSquare, true);
  add('labor', 'Roof installation', roofSquares, 'sq', s.material === 'metal' ? p.metalLaborPerSquare : p.laborPerSquare);
  add('tearoff', 'Tear-off & removal', roofSquares * s.layers, 'sq-layer', p.tearoffPerSquare);
  if (s.pitch >= 8) add('steep', 'Steep-slope labor (8/12+)', roofSquares, 'sq', p.steepPerSquare);
  if (s.stories > 1) add('height', 'Additional-story labor', roofSquares * (s.stories - 1), 'sq-story', p.heightPerSquare);
  add('ridge', 'Ridge & hip cap allowance', s.ridgeFt, 'ft', p.ridgePerFt, true);
  add('edge', 'Drip edge allowance', s.edgeFt, 'ft', p.edgePerFt, true);
  add('valley', 'Valley flashing allowance', s.valleyFt, 'ft', p.valleyPerFt, true);
  add('decking', 'Decking replacement allowance', s.deckingSheets, 'sheet', p.deckingPerSheet, true);
  add('disposal', 'Debris disposal & site cleanup', 1, 'job', p.disposal);
  add('permit', 'Permit allowance', 1, 'job', p.permit);
  const subtotalCents = lines.reduce((v, l) => v + l.totalCents, 0);
  const markupCents = Math.round(subtotalCents * s.markupPercent / 100);
  const taxable = lines.filter(l => l.taxable).reduce((v, l) => v + l.totalCents, 0);
  const taxCents = Math.round(Math.round(taxable * (1 + s.markupPercent / 100)) * s.taxPercent / 100);
  const totalCents = subtotalCents + markupCents + taxCents;
  return { surfaceAreaSqFt, roofSquares, materialBundles: s.material === 'metal' ? 0 : materialBundles, orderedSquares, lines, subtotalCents, markupCents, taxCents, totalCents };
}
export type Calculation = ReturnType<typeof calculateQuote>;
export const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(cents / 100);
