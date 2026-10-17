import { describe, expect, it } from 'vitest';
import type { PublicProposalView } from '@roofline/shared';
import { homeowner } from '../src/copy/homeowner.ts';
import { addressText, defaultOption, financingOf, formatApr, plainDate, productLine, roofCard } from '../src/features/homeowner/facts.ts';

/*
 * What the proposal page may say, from what the proposal carries: the plain validity date, the financing line (monthly,
 * APR, number of payments and their total, only when the option has the terms), and the roof card (each fact only when
 * the company's data has it). Nothing is made up when a part is missing.
 */

type Option = PublicProposalView['options'][number];
const option = (over: Partial<Option> = {}): Option => ({
  id: 'o',
  tier: 'better',
  name: 'Better',
  highlights: [],
  inclusions: [],
  totalCents: 1_425_000,
  monthlyEstimateCents: 21_500,
  financingTerms: { aprBps: 899, months: 120 },
  ...over,
});

describe('plainDate', () => {
  const now = new Date('2026-10-16T12:00:00Z');

  it('is a month and a day, with the year only when it is not this one', () => {
    expect(plainDate('2026-11-11', now)).toBe('Nov 11');
    expect(plainDate('2026-11-11T00:00:00.000Z', now)).toBe('Nov 11');
    expect(plainDate('2027-01-05', now)).toBe('Jan 5, 2027');
  });

  it('a date-only value does not slide back a day for a viewer west of Greenwich (UTC is the reading)', () => {
    expect(plainDate('2026-12-01', now)).toBe('Dec 1');
  });

  it('what is not a date is returned as it came, not as "Invalid Date"', () => {
    expect(plainDate('soon', now)).toBe('soon');
  });
});

describe('financingOf', () => {
  it('says the monthly payment, the APR, the number of payments, and that they total monthly times the number', () => {
    expect(financingOf(option())).toEqual({ monthly: '$215', apr: '8.99', months: 120, total: '$25,800' });
    expect(financingOf(option({ monthlyEstimateCents: 18_300, financingTerms: { aprBps: 999, months: 84 } }))).toEqual({
      monthly: '$183',
      apr: '9.99',
      months: 84,
      total: '$15,372',
    });
  });

  it('is nothing when the option has no monthly estimate or no terms: no guess, no payoff month', () => {
    expect(financingOf(option({ monthlyEstimateCents: null }))).toBeNull();
    expect(financingOf(option({ financingTerms: null }))).toBeNull();
    expect(financingOf(option({ monthlyEstimateCents: null, financingTerms: null }))).toBeNull();
  });

  it('is nothing for terms that make no sense', () => {
    expect(financingOf(option({ monthlyEstimateCents: 0 }))).toBeNull();
    expect(financingOf(option({ monthlyEstimateCents: -5 }))).toBeNull();
    expect(financingOf(option({ financingTerms: { aprBps: 899, months: 0 } }))).toBeNull();
    expect(financingOf(option({ financingTerms: { aprBps: 899, months: 12.5 } }))).toBeNull();
    expect(financingOf(option({ financingTerms: { aprBps: -1, months: 12 } }))).toBeNull();
  });

  it('a rate of nothing is a real rate: 0% APR, still shown', () => {
    expect(financingOf(option({ financingTerms: { aprBps: 0, months: 12 }, monthlyEstimateCents: 10_000 }))).toEqual({ monthly: '$100', apr: '0', months: 12, total: '$1,200' });
  });
});

describe('formatApr', () => {
  it('turns basis points into a percentage and drops needless zeros', () => {
    expect(formatApr(899)).toBe('8.99');
    expect(formatApr(875)).toBe('8.75');
    expect(formatApr(900)).toBe('9');
    expect(formatApr(950)).toBe('9.5');
    expect(formatApr(0)).toBe('0');
  });
});

describe('roofCard', () => {
  it('shows each fact the company has, worded and in order', () => {
    expect(roofCard({ squares: 33.1, pitchX12: 6, hailInches: 1.25, photoCount: 18 })).toEqual({
      stats: [
        { key: 'roof', label: 'Roof', value: '33.1 sq' },
        { key: 'pitch', label: 'Pitch', value: '6/12' },
        { key: 'hail', label: 'Hail', value: '1.25 in' },
      ],
      photos: homeowner.photos(18),
    });
  });

  it('shows only the facts it has', () => {
    expect(roofCard({ squares: 28 })).toEqual({ stats: [{ key: 'roof', label: 'Roof', value: '28 sq' }], photos: null });
    expect(roofCard({ hailInches: 0.75 })?.stats).toEqual([{ key: 'hail', label: 'Hail', value: '0.75 in' }]);
    expect(roofCard({ photoCount: 1 })).toEqual({ stats: [], photos: '1 photo from your inspection' });
  });

  it('is nothing when there is no usable fact: no card, not an empty one', () => {
    expect(roofCard(undefined)).toBeNull();
    expect(roofCard(null)).toBeNull();
    expect(roofCard({})).toBeNull();
    expect(roofCard({ squares: 0, pitchX12: -1, hailInches: Number.NaN, photoCount: 0 })).toBeNull();
    expect(roofCard({ squares: null, pitchX12: null, hailInches: null, photoCount: null })).toBeNull();
    // A photo of the home alone is not a fact about the roof
    expect(roofCard({ outline: { center: [-96, 41.25], ring: [] } })).toBeNull();
  });

  it('a count of photos that is not a whole number is not shown', () => {
    expect(roofCard({ squares: 20, photoCount: 2.5 })?.photos).toBeNull();
  });
});

describe('defaultOption', () => {
  it('opens on Better, the one most people pick, else the middle one', () => {
    const good = option({ id: 'g', tier: 'good' });
    const better = option({ id: 'b', tier: 'better' });
    const best = option({ id: 'x', tier: 'best' });
    expect(defaultOption([good, better, best])?.id).toBe('b');
    expect(defaultOption([good, best])?.id).toBe('x');
    expect(defaultOption([good])?.id).toBe('g');
    expect(defaultOption([])).toBeUndefined();
  });
});

describe('productLine', () => {
  it("is the option's own name when it says more than the tier does", () => {
    expect(productLine(option({ name: 'Architectural + protection', highlights: ['Ice and water shield'] }))).toBe('Architectural + protection');
  });

  it('is the first thing the option promises when its name is only its tier, so the tier is never printed twice', () => {
    expect(productLine(option({ name: 'Better', highlights: ['', 'Architectural shingles, 50-year maker warranty', 'Ridge vent'] }))).toBe('Architectural shingles, 50-year maker warranty');
    // Case does not matter, and neither do spaces round the name
    expect(productLine(option({ name: '  better ', highlights: ['Upgraded underlayment'] }))).toBe('Upgraded underlayment');
  });

  it('falls back to the name, then the tier, when there is nothing to say', () => {
    expect(productLine(option({ name: 'Better', highlights: [] }))).toBe('Better');
    expect(productLine(option({ name: '', highlights: [] }))).toBe('Better');
  });
});

describe('addressText', () => {
  it('holds the ZIP to the state before it, so a narrow line never leaves it alone', () => {
    expect(addressText('193 Ames Ave, Omaha, NE 68111')).toBe('193 Ames Ave, Omaha, NE\u00a068111');
    expect(addressText('193 Ames Ave, Omaha, NE 68111-1234')).toBe('193 Ames Ave, Omaha, NE\u00a068111-1234');
  });

  it('leaves an address that does not end in a ZIP as it came', () => {
    expect(addressText('193 Ames Ave, Omaha')).toBe('193 Ames Ave, Omaha');
    expect(addressText('')).toBe('');
  });
});
