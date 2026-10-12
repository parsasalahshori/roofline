import { describe, expect, test } from 'vitest';
import { addOnQuantity, priceTier, withAddOns } from '../src/tiers-price.ts';
import { calculateQuote, defaultPricebook, defaultScope } from '../src/pricing.ts';
import type { TierTemplate, MeasuredQuantities } from '../src/tiers.ts';

// Local templates so these tests do not depend on DEFAULT_TIER_TEMPLATES.
const good: TierTemplate = {
  tier: 'good', name: 'Architectural shingles', material: 'architectural', wastePercent: 12,
  markupPercent: null, addOns: [], highlights: [], enabled: true,
};
const better: TierTemplate = {
  ...good, tier: 'better', name: 'Architectural + protection',
  addOns: [
    { name: 'Ice & water shield', unit: 'per_edge_ft', rateCents: 250, taxable: true },
    { name: 'Ridge vent', unit: 'per_ridge_ft', rateCents: 600, taxable: true },
  ],
};

const base = {
  areaSqFt: defaultScope.areaSqFt, areaType: defaultScope.areaType, pitch: defaultScope.pitch,
  stories: defaultScope.stories, layers: defaultScope.layers,
  ridgeFt: defaultScope.ridgeFt, edgeFt: defaultScope.edgeFt, valleyFt: defaultScope.valleyFt,
  deckingSheets: defaultScope.deckingSheets,
  markupPercent: defaultScope.markupPercent, taxPercent: defaultScope.taxPercent,
};
const q: MeasuredQuantities = { squares: 24.8, edgeFt: 180, ridgeFt: 60, valleyFt: 30 };

const taxFormula = (taxable: number, markup: number, tax: number) =>
  Math.round(Math.round(taxable * (1 + markup / 100)) * tax / 100);

describe('addOnQuantity', () => {
  test('maps each unit to its measured quantity; per_job is always 1', () => {
    expect(addOnQuantity('per_square', q)).toBe(24.8);
    expect(addOnQuantity('per_edge_ft', q)).toBe(180);
    expect(addOnQuantity('per_ridge_ft', q)).toBe(60);
    expect(addOnQuantity('per_valley_ft', q)).toBe(30);
    expect(addOnQuantity('per_job', q)).toBe(1);
  });
});

describe('priceTier', () => {
  test('Good equals calculateQuote exactly', () => {
    const price = priceTier(good, base, defaultPricebook, q);
    const expected = calculateQuote(defaultScope, defaultPricebook);
    expect(price.calculation).toEqual(expected);
    expect(price.totalCents).toBe(expected.totalCents);
    expect(price.addOnLines).toEqual([]);
  });

  test('withAddOns with no add-ons equals calculateQuote', () => {
    const scope = { ...defaultScope, taxPercent: 8.25, markupPercent: 20 };
    const calc = calculateQuote(scope, defaultPricebook);
    expect(withAddOns(calc, [], scope.markupPercent, scope.taxPercent)).toEqual(calc);
  });

  test('Better adds the two add-on lines with the expected quantities', () => {
    const price = priceTier(better, base, defaultPricebook, q);
    expect(price.addOnLines).toHaveLength(2);
    expect(price.addOnLines.map((l) => l.code)).toEqual(['addon:0', 'addon:1']);
    expect(price.addOnLines.map((l) => l.name)).toEqual(['Ice & water shield', 'Ridge vent']);
    expect(price.addOnLines.map((l) => l.unit)).toEqual(['per_edge_ft', 'per_ridge_ft']);
    expect(price.addOnLines.map((l) => l.quantity)).toEqual([180, 60]);
    expect(price.addOnLines.map((l) => l.unitCents)).toEqual([250, 600]);
    expect(price.addOnLines.map((l) => l.totalCents)).toEqual([45000, 36000]);
    expect(price.calculation.lines.slice(-2)).toEqual(price.addOnLines);
  });

  test('taxable add-ons are taxed, non-taxable add-ons are not', () => {
    const scope = { ...base, taxPercent: 8.25 };
    const goodTax = calculateQuote({ ...defaultScope, taxPercent: 8.25 }, defaultPricebook).taxCents;

    const taxablePrice = priceTier(better, scope, defaultPricebook, q);
    const taxableSum = taxablePrice.calculation.lines.filter((l) => l.taxable).reduce((v, l) => v + l.totalCents, 0);
    expect(taxablePrice.calculation.taxCents).toBe(taxFormula(taxableSum, 25, 8.25));
    expect(taxablePrice.calculation.taxCents).toBeGreaterThan(goodTax);

    const nonTaxable: TierTemplate = {
      ...better,
      addOns: better.addOns.map((a) => ({ ...a, taxable: false })),
    };
    const untaxedPrice = priceTier(nonTaxable, scope, defaultPricebook, q);
    expect(untaxedPrice.calculation.taxCents).toBe(goodTax);
    expect(untaxedPrice.calculation.taxCents).toBeLessThan(taxablePrice.calculation.taxCents);
  });

  test('totals reconcile', () => {
    const { calculation: c } = priceTier(better, { ...base, taxPercent: 8.25 }, defaultPricebook, q);
    expect(c.subtotalCents).toBe(c.lines.reduce((v, l) => v + l.totalCents, 0));
    expect(c.totalCents).toBe(c.subtotalCents + c.markupCents + c.taxCents);
  });

  test('markupPercent null uses the base markup, a number overrides it', () => {
    const inherited = priceTier(good, base, defaultPricebook, q);
    expect(inherited.scope.markupPercent).toBe(25);

    const overridden = priceTier({ ...good, markupPercent: 10 }, base, defaultPricebook, q);
    expect(overridden.scope.markupPercent).toBe(10);
    expect(overridden.calculation.markupCents).toBe(Math.round(overridden.calculation.subtotalCents * 10 / 100));
  });

  test('per_square add-ons are priced with waste', () => {
    const squareTier: TierTemplate = {
      ...good,
      wastePercent: 12,
      addOns: [{ name: 'Starter strip', unit: 'per_square', rateCents: 1000, taxable: false }],
    };
    const price = priceTier(squareTier, base, defaultPricebook, { ...q, squares: 20 });
    expect(price.addOnLines).toHaveLength(1);
    expect(price.addOnLines[0].quantity).toBe(22.4);
    expect(price.addOnLines[0].totalCents).toBe(Math.round(20 * 1.12 * 1000));
  });

  test('a zero-quantity add-on is skipped but later add-ons keep their original index', () => {
    const price = priceTier(better, base, defaultPricebook, { ...q, edgeFt: 0 });
    expect(price.addOnLines.map((l) => l.code)).toEqual(['addon:1']);
    expect(price.addOnLines[0].name).toBe('Ridge vent');
  });
});
