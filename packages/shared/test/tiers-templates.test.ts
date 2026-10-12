import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { DEFAULT_TIER_TEMPLATES, TierTemplateSchema } from '../src/tiers.ts';

const base = () => structuredClone(DEFAULT_TIER_TEMPLATES[1]);

test('the three defaults parse', () => {
  for (const t of DEFAULT_TIER_TEMPLATES) {
    expect(TierTemplateSchema.safeParse(t).success).toBe(true);
  }
  expect(DEFAULT_TIER_TEMPLATES.map((t) => t.tier)).toEqual(['good', 'better', 'best']);
  expect(DEFAULT_TIER_TEMPLATES.map((t) => t.name)).toEqual([
    'Architectural shingles',
    'Architectural + protection',
    'Designer shingles',
  ]);
  expect(DEFAULT_TIER_TEMPLATES.map((t) => t.material)).toEqual(['architectural', 'architectural', 'premium']);
  expect(DEFAULT_TIER_TEMPLATES.every((t) => t.enabled && t.markupPercent === null && t.wastePercent === 12)).toBe(true);

  const [good, better, best] = DEFAULT_TIER_TEMPLATES;
  expect(good.addOns).toEqual([]);
  expect(good.highlights).toEqual(['Architectural shingles', 'Synthetic underlayment', 'Tear-off and cleanup']);

  const expectedAddOns = [
    { name: 'Ice & water shield', unit: 'per_edge_ft', rateCents: 250, taxable: true },
    { name: 'Ridge vent', unit: 'per_ridge_ft', rateCents: 600, taxable: true },
  ];
  expect(better.addOns).toEqual(expectedAddOns);
  expect(better.highlights).toEqual([
    'Architectural shingles',
    'Synthetic underlayment',
    'Ice & water shield at the edges',
    'Ridge ventilation',
  ]);

  expect(best.addOns).toEqual([
    ...expectedAddOns,
    { name: 'Extended workmanship warranty', unit: 'per_job', rateCents: 45000, taxable: false },
  ]);
  expect(best.highlights).toEqual([
    'Designer shingles',
    'Ice & water shield at the edges',
    'Ridge ventilation',
    'Extended warranty',
  ]);
});

test('invalid templates are refused with paths', () => {
  const cases: Array<[string, (t: ReturnType<typeof base>) => void, PropertyKey[]]> = [
    ['empty name', (t) => { t.name = ''; }, ['name']],
    ['61-char name', (t) => { t.name = 'x'.repeat(61); }, ['name']],
    [
      '9 add-ons',
      (t) => {
        t.addOns = Array.from({ length: 9 }, () => ({ name: 'Extra', unit: 'per_job', rateCents: 1, taxable: false }));
      },
      ['addOns'],
    ],
    ['rateCents above 1,000,000', (t) => { t.addOns[0].rateCents = 1_000_001; }, ['addOns', 0, 'rateCents']],
    ['negative rateCents', (t) => { t.addOns[0].rateCents = -1; }, ['addOns', 0, 'rateCents']],
    ['fractional rateCents', (t) => { t.addOns[0].rateCents = 1.5; }, ['addOns', 0, 'rateCents']],
    [
      '5 highlights',
      (t) => { t.highlights = ['a', 'b', 'c', 'd', 'e']; },
      ['highlights'],
    ],
    ['61-char highlight', (t) => { t.highlights[0] = 'x'.repeat(61); }, ['highlights', 0]],
    ['unit per_mile', (t) => { (t.addOns[0] as { unit: string }).unit = 'per_mile'; }, ['addOns', 0, 'unit']],
    ['tier gold', (t) => { (t as { tier: string }).tier = 'gold'; }, ['tier']],
  ];
  for (const [label, mutate, path] of cases) {
    const t = base();
    mutate(t);
    const result = TierTemplateSchema.safeParse(t);
    expect(result.success, label).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path, label).toEqual(path);
    }
  }
});

test('boundary values are accepted', () => {
  const longName = base();
  longName.name = 'x'.repeat(60);
  expect(TierTemplateSchema.safeParse(longName).success).toBe(true);

  const manyAddOns = base();
  manyAddOns.addOns = Array.from({ length: 8 }, () => ({ name: 'Extra', unit: 'per_job', rateCents: 0, taxable: false }));
  expect(TierTemplateSchema.safeParse(manyAddOns).success).toBe(true);

  const rates = base();
  rates.addOns = [
    { name: 'Low', unit: 'per_job', rateCents: 0, taxable: false },
    { name: 'High', unit: 'per_job', rateCents: 1_000_000, taxable: false },
  ];
  expect(TierTemplateSchema.safeParse(rates).success).toBe(true);

  const highlights = base();
  highlights.highlights = Array.from({ length: 4 }, () => 'y'.repeat(60));
  expect(TierTemplateSchema.safeParse(highlights).success).toBe(true);
});

test('source scan: no default rate uses the 19900 or 39900 literals', () => {
  const src = readFileSync(new URL('../src/tiers.ts', import.meta.url), 'utf8');
  expect(src).not.toContain('19900');
  expect(src).not.toContain('39900');
});
