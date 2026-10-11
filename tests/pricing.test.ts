import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateQuote, defaultPricebook, defaultScope, toSurfaceArea } from '../shared/pricing.ts';

test('surface measurements are not pitched twice', () => {
  assert.equal(toSurfaceArea(2000, 'surface', 12), 2000);
  assert.equal(toSurfaceArea(2000, 'footprint', 0), 2000);
  assert.ok(Math.abs(toSurfaceArea(2000, 'footprint', 12) - 2828.427) < 0.01);
});
test('orders complete bundles and calculates labor on actual area', () => {
  const q = calculateQuote({ ...defaultScope, areaSqFt: 2000, wastePercent: 10 }, defaultPricebook);
  assert.equal(q.materialBundles, 66);
  assert.equal(q.roofSquares, 20);
  assert.equal(q.lines.find(x => x.code === 'labor')?.quantity, 20);
  assert.equal(q.lines.find(x => x.code === 'material')?.quantity, 66);
  assert.equal(q.totalCents, q.subtotalCents + q.markupCents + q.taxCents);
});
test('tax applies to marked-up materials only, money reconciles', () => {
  const q = calculateQuote({ ...defaultScope, areaSqFt: 2101, taxPercent: 8.25, markupPercent: 20 }, defaultPricebook);
  const taxable = q.lines.filter(x => x.taxable).reduce((sum, x) => sum + x.totalCents, 0);
  assert.equal(q.taxCents, Math.round(Math.round(taxable * 1.2) * 0.0825));
  assert.equal(q.subtotalCents, q.lines.reduce((sum, x) => sum + x.totalCents, 0));
});
test('invalid areas and dangerous pricing values fail closed', () => {
  for (const areaSqFt of [0, -20, NaN, Infinity, 100001]) assert.throws(() => calculateQuote({ ...defaultScope, areaSqFt }, defaultPricebook));
  assert.throws(() => calculateQuote({ ...defaultScope, wastePercent: -1 }, defaultPricebook));
  assert.throws(() => calculateQuote(defaultScope, { ...defaultPricebook, laborPerSquare: -1 }));
});
test('additional layers, slope and height increase the correct labor costs', () => {
  const basic = calculateQuote({ ...defaultScope, areaSqFt: 2000, pitch: 4, stories: 1, layers: 1 }, defaultPricebook);
  const difficult = calculateQuote({ ...defaultScope, areaSqFt: 2000, pitch: 10, stories: 2, layers: 2 }, defaultPricebook);
  assert.ok(difficult.totalCents > basic.totalCents);
  assert.equal(difficult.lines.find(x => x.code === 'tearoff')?.quantity, 40);
  assert.ok(difficult.lines.some(x => x.code === 'steep'));
});
