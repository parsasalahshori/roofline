import { describe, expect, it } from 'vitest';
import { spreadLabels } from '../src/features/measure/lift/labelSpread.ts';

/** Where each label ends up: its point moved by the offset the function returns. */
const settle = (at: { x: number; y: number }[], min: number) => spreadLabels(at, min).map(([dx, dy], i) => ({ x: at[i]!.x + dx, y: at[i]!.y + dy }));
const apart = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe('spreadLabels: facet letters that would sit on each other', () => {
  it('moves nothing that is already clear', () => {
    expect(spreadLabels([{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 0, y: 90 }], 30)).toEqual([[0, 0], [0, 0], [0, 0]]);
    expect(spreadLabels([], 30)).toEqual([]);
  });

  it('pushes two close letters apart until each is whole (the E and F of one roof)', () => {
    const out = settle([{ x: 100, y: 100 }, { x: 110, y: 120 }], 30);
    expect(apart(out[0]!, out[1]!)).toBeGreaterThanOrEqual(30 - 1);
    // Each gives way by about half, so neither jumps far from its facet
    expect(apart(out[0]!, { x: 100, y: 100 })).toBeLessThan(20);
    expect(apart(out[1]!, { x: 110, y: 120 })).toBeLessThan(20);
  });

  it('splits letters on the very same spot sideways, in order', () => {
    const out = settle([{ x: 50, y: 50 }, { x: 50, y: 50 }], 30);
    expect(out[0]!.x).toBeLessThan(out[1]!.x);
    expect(apart(out[0]!, out[1]!)).toBeGreaterThanOrEqual(30 - 1);
  });

  it('settles a crowd of letters so that none touches another', () => {
    const out = settle(
      [
        { x: 100, y: 100 },
        { x: 112, y: 104 },
        { x: 104, y: 118 },
        { x: 118, y: 120 },
        { x: 95, y: 112 },
      ],
      30,
    );
    for (let i = 0; i < out.length; i += 1) for (let j = i + 1; j < out.length; j += 1) expect(apart(out[i]!, out[j]!)).toBeGreaterThanOrEqual(30 - 2);
  });

  it('returns whole pixels', () => {
    for (const [dx, dy] of spreadLabels([{ x: 0, y: 0 }, { x: 7, y: 3 }], 30)) {
      expect(Number.isInteger(dx)).toBe(true);
      expect(Number.isInteger(dy)).toBe(true);
    }
  });
});
