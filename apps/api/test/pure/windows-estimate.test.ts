import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIZE_MIX,
  estimateAllSides,
  estimateSidesAndBack,
  floorsFromEave,
  houseWalls,
  rangeOf,
  splitByMix,
  WINDOW_TO_WALL_RATIO,
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
    expect(w).toMatchObject({ perimeterFt: 186, wallHeightFt: 9, wallAreaSqFt: 1674, windowWallSqFt: 1674, floors: 1, heightSource: 'assumed', frontWallFt: null });
    // One floor is assumed, so the count comes with a range up to two floors' worth.
    const e = estimateAllSides(w);
    expect(total(e)).toBe(13);
    expect(e.range).toEqual({ low: 13, high: 26 });
    expect(e.basis).toBe('1,674 sq ft of wall: about 13 windows (13-26)');
  });

  it('takes the floors and height from Google eave heights', () => {
    expect(floorsFromEave(3.1)).toBe(1);
    expect(floorsFromEave(5.9)).toBe(2);
    expect(floorsFromEave(7.4)).toBe(2);
    expect(floorsFromEave(8.4)).toBe(3);
    expect(floorsFromEave(9.4, 12)).toBe(3);
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

describe('floors, wings and ranges', () => {
  it('a storey and a half: an eave between one and two storeys under a roof with room in it', () => {
    expect(floorsFromEave(4.8, 8.3)).toBe(1.5);
    // The same eave under a two-storey house's tall roof is two floors; with no room under the roof it is one.
    expect(floorsFromEave(4.8, 11)).toBe(2);
    expect(floorsFromEave(4.6, 6.2)).toBe(1);
    // Older measurements without the ridge keep the old split.
    expect(floorsFromEave(4.6)).toBe(2);
    expect(floorsFromEave(4.3)).toBe(1);
    const w = houseWalls(50, null, 4.8, { ridgeM: 8.3 });
    expect(w.floors).toBe(1.5);
    expect(estimateAllSides(w).range).not.toBeNull();
  });

  it('counts a row of windows a floor, not the eave’s height', () => {
    // A one-storey house on a raised floor (4.2 m eave) has as many windows as one with a 3 m eave.
    expect(total(estimateAllSides(houseWalls(56.7, null, 4.2, { ridgeM: 6.2 })))).toBe(total(estimateAllSides(houseWalls(56.7, null, 3.0, { ridgeM: 5.5 }))));
    // Two floors: twice the window wall.
    expect(houseWalls(56.7, null, 6, { ridgeM: 9 }).windowWallSqFt).toBe(2 * 186 * 9);
  });

  it('leaves a low one-storey wing of a two-storey house out of the window wall, and the range puts it back', () => {
    // 4 walls of the block (2 x 12 m and 2 x 10 m at 6 m), the garage's 3 outer walls (6 + 7 + 6 m at 3 m).
    const walls = [
      { lengthM: 12, eaveM: 6 },
      { lengthM: 10, eaveM: 6 },
      { lengthM: 12, eaveM: 6.2 },
      { lengthM: 4, eaveM: 6 },
      { lengthM: 6, eaveM: 3 },
      { lengthM: 7, eaveM: 3.1 },
      { lengthM: 6, eaveM: 2.9 },
    ];
    const perimeterM = walls.reduce((t, w) => t + w.lengthM, 0);
    const w = houseWalls(perimeterM, null, 6, { walls, ridgeM: 9 });
    expect(w.floors).toBe(2);
    expect(w.lowWingFt).toBe(Math.round(19 * 3.28084));
    // The block's 38 m at two floors of 9 ft.
    expect(w.windowWallSqFt).toBeCloseTo(38 * 3.28084 * 2 * 9, -1);
    const e = estimateAllSides(w);
    const n = total(e);
    expect(n).toBe(Math.round((w.windowWallSqFt * WINDOW_TO_WALL_RATIO) / 15));
    expect(e.range!.low).toBe(n);
    expect(e.range!.high).toBeGreaterThan(n + 1);
    // An unread wall is taken at the main height; a wall read above the main eave (a tree on it) is capped.
    const treed = houseWalls(perimeterM, null, 6, { walls: walls.map((x, i) => (i === 0 ? { ...x, eaveM: 11 } : i === 1 ? { ...x, eaveM: null } : x)), ridgeM: 9 });
    expect(treed.windowWallSqFt).toBe(w.windowWallSqFt);
  });

  it('one storey under a very tall roof: still one floor, but the range allows for rooms in the roof', () => {
    const w = houseWalls(70, null, 3.6, { ridgeM: 9.5 });
    expect(w.floors).toBe(1);
    expect(w.roofRiseM).toBeCloseTo(5.9, 5);
    const e = estimateAllSides(w);
    expect(e.range!.high).toBe(Math.round(total(e) * 1.3));
    expect(estimateAllSides(houseWalls(70, null, 3.6, { ridgeM: 7 })).range).toBeNull();
  });

  it('a one-storey house has no low wings, and a confident estimate has no range', () => {
    const walls = [
      { lengthM: 15, eaveM: 3 },
      { lengthM: 10, eaveM: 2.6 },
      { lengthM: 15, eaveM: 3.1 },
      { lengthM: 10, eaveM: 3 },
    ];
    const w = houseWalls(50, null, 3, { walls, ridgeM: 5.5 });
    expect(w.lowWingFt).toBe(0);
    expect(estimateAllSides(w).range).toBeNull();
    // From Google's roof instead of a footprint: plus or minus 15%.
    expect(rangeOf(houseWalls(50, null, 3, { walls, ridgeM: 5.5, outlineSource: 'solar-mask' }), 20)).toEqual({ low: 17, high: 23 });
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
