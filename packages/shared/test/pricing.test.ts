import { expect, test } from 'vitest';
import { calculateQuote, defaultPricebook, defaultScope, toSurfaceArea } from '../src/pricing.ts';

test('surface measurements are not pitched twice', () => {
  expect(toSurfaceArea(2000, 'surface', 12)).toBe(2000);
  expect(toSurfaceArea(2000, 'footprint', 0)).toBe(2000);
  expect(Math.abs(toSurfaceArea(2000, 'footprint', 12) - 2828.427)).toBeLessThan(0.01);
});
test('orders complete bundles and calculates labor on actual area', () => {
  const q = calculateQuote({ ...defaultScope, areaSqFt: 2000, wastePercent: 10 }, defaultPricebook);
  expect(q.materialBundles).toBe(66);
  expect(q.roofSquares).toBe(20);
  expect(q.lines.find(x => x.code === 'labor')?.quantity).toBe(20);
  expect(q.lines.find(x => x.code === 'material')?.quantity).toBe(66);
  expect(q.totalCents).toBe(q.subtotalCents + q.markupCents + q.taxCents);
});
test('tax applies to marked-up materials only, money reconciles', () => {
  const q = calculateQuote({ ...defaultScope, areaSqFt: 2101, taxPercent: 8.25, markupPercent: 20 }, defaultPricebook);
  const taxable = q.lines.filter(x => x.taxable).reduce((sum, x) => sum + x.totalCents, 0);
  expect(q.taxCents).toBe(Math.round(Math.round(taxable * 1.2) * 0.0825));
  expect(q.subtotalCents).toBe(q.lines.reduce((sum, x) => sum + x.totalCents, 0));
});
test('invalid areas and dangerous pricing values fail closed', () => {
  for (const areaSqFt of [0, -20, NaN, Infinity, 100001]) expect(() => calculateQuote({ ...defaultScope, areaSqFt }, defaultPricebook)).toThrow();
  expect(() => calculateQuote({ ...defaultScope, wastePercent: -1 }, defaultPricebook)).toThrow();
  expect(() => calculateQuote(defaultScope, { ...defaultPricebook, laborPerSquare: -1 })).toThrow();
});
test('additional layers, slope and height increase the correct labor costs', () => {
  const basic = calculateQuote({ ...defaultScope, areaSqFt: 2000, pitch: 4, stories: 1, layers: 1 }, defaultPricebook);
  const difficult = calculateQuote({ ...defaultScope, areaSqFt: 2000, pitch: 10, stories: 2, layers: 2 }, defaultPricebook);
  expect(difficult.totalCents).toBeGreaterThan(basic.totalCents);
  expect(difficult.lines.find(x => x.code === 'tearoff')?.quantity).toBe(40);
  expect(difficult.lines.some(x => x.code === 'steep')).toBe(true);
});
