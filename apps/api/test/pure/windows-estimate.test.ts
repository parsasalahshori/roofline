import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIZE_MIX,
  estimateAllSides,
  estimateSidesAndBack,
  floorsFromEave,
  houseWalls,
  splitByMix,
} from '../../src/estimator/windows-estimate.ts';

const FT = 0.3048;
const total = (e: { bySizeClass: Record<string, number> }) => Object.values(e.bySizeClass).reduce((t, v) => t + v, 0);

/** A rectangular single-storey house of `sqft` (2:1 plan), its perimeter in metres. */
function perimeterOf(sqft: number, floors = 1): number {
  const plan = sqft / floors;
  const w = Math.sqrt(plan / 2);
  return 2 * (w + 2 * w) * FT;
}

describe('walls', () => {
  it('assumes one 9 ft floor without heights, and says so', () => {
    const w = houseWalls(56.7, null, null);
    expect(w).toMatchObject({ perimeterFt: 186, wallHeightFt: 9, wallAreaSqFt: 1674, floors: 1, heightSource: 'assumed', frontWallFt: null });
    expect(estimateAllSides(w).basis).toBe('1 floor, 186 ft of wall, 9 ft high (assumed, no height data): about 13 windows');
  });

  it('takes the floors and height from Google eave heights', () => {
    expect(floorsFromEave(3.1)).toBe(1);
    expect(floorsFromEave(5.9)).toBe(2);
    expect(floorsFromEave(8.4)).toBe(3);
    const w = houseWalls(50, 12, 5.9);
    expect(w.floors).toBe(2);
    expect(w.heightSource).toBe('google');
    expect(w.wallHeightFt).toBeCloseTo(19.4, 1);
    expect(w.frontWallFt).toBe(39);
    // An implausible height is not trusted.
    expect(houseWalls(50, null, 40).heightSource).toBe('assumed');
  });
});

describe('estimate from the walls (all sides)', () => {
  it('a 1,800 sq ft single-storey house lands at 12-15 windows', () => {
    const e = estimateAllSides(houseWalls(perimeterOf(1800), null, 3.0));
    expect(e.covers).toBe('all-sides');
    expect(total(e)).toBeGreaterThanOrEqual(12);
    expect(total(e)).toBeLessThanOrEqual(15);
  });

  it('larger and two-storey houses get more windows', () => {
    const small = total(estimateAllSides(houseWalls(perimeterOf(1200), null, 3.0)));
    const big = total(estimateAllSides(houseWalls(perimeterOf(2600), null, 3.0)));
    const twoStorey = total(estimateAllSides(houseWalls(perimeterOf(2600, 2), null, 5.9)));
    expect(small).toBeLessThan(big);
    expect(twoStorey).toBeGreaterThan(big * 0.9);
  });

  it('the split adds up and follows the mix', () => {
    const s = splitByMix(13, DEFAULT_SIZE_MIX);
    expect(Object.values(s).reduce((t, v) => t + v, 0)).toBe(13);
    expect(s.standard).toBeGreaterThan(s.small);
    expect(splitByMix(0, DEFAULT_SIZE_MIX)).toEqual({ small: 0, standard: 0, large: 0, picture: 0 });
  });
});

describe('estimate for the sides and back', () => {
  it('leaves the front wall out and uses the marked mix from 3 windows', () => {
    const w = houseWalls(56.7, 18.3, null); // 60 ft front of 186
    const e = estimateSidesAndBack(w, [{ sizeClass: 'large' }, { sizeClass: 'large' }, { sizeClass: 'picture' }]);
    expect(e.covers).toBe('sides-and-back');
    expect(total(e)).toBe(Math.round((126 * 9 * 0.12) / 15));
    expect(e.bySizeClass.standard).toBe(0);
    expect(e.basis).toContain('126 ft of side and back wall');
    expect(e.basis).toContain('sizes like the front');
  });

  it('fewer than 3 marked: the typical mix', () => {
    const e = estimateSidesAndBack(houseWalls(56.7, 18.3, null), [{ sizeClass: 'picture' }]);
    expect(e.basis).toContain('typical sizes');
    expect(e.bySizeClass.standard).toBeGreaterThan(0);
  });
});
