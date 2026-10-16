import { describe, expect, it } from 'vitest';
import { priceRange } from '../src/instant-quote.ts';

describe('priceRange', () => {
  it('centres on the middle option, not the cheapest-to-dearest span', () => {
    // Good $10,400 / Better $13,870 / Best $20,800 at 12%: $12,206-$15,534, rounded out to hundreds.
    expect(priceRange([1_040_000, 1_387_000, 2_080_000], 12)).toEqual({ lowCents: 1_220_000, highCents: 1_560_000 });
  });

  it('uses the median for an even count and ignores order and non-positive totals', () => {
    expect(priceRange([2_000_000, 0, 1_000_000], 10)).toEqual({ lowCents: 1_350_000, highCents: 1_650_000 });
  });

  it('is null with nothing to price, and never below $100 or zero-width', () => {
    expect(priceRange([], 12)).toBeNull();
    expect(priceRange([5_000], 12)).toEqual({ lowCents: 10_000, highCents: 20_000 });
  });
});
