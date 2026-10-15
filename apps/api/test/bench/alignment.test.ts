import { describe, expect, it } from 'vitest';
import { bestTranslation, iou, type MultiPoly, translate } from '../../src/bench/roof3d/geometry.ts';
import { alignedOutline } from '../../src/bench/roof3d/truth.ts';

/*
 * FM13: EagleView's outlines sit about 1 m east and 0.5 m south of Google's frame. The aligned score must recover a
 * pure frame shift exactly (the shape is then perfect) and never make a different shape look the same.
 */

const rect = (x0: number, y0: number, w: number, h: number): MultiPoly => [[[[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h], [x0, y0]]]];
const L: MultiPoly = [[[[0, 0], [20, 0], [20, 8], [8, 8], [8, 16], [0, 16], [0, 0]]]];

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

describe('bestTranslation', () => {
  it('property: a shape moved by a random shift within 2.5 m is recovered to 0.1 m with IoU near 1', () => {
    const next = rng(13);
    for (let k = 0; k < 12; k++) {
      const shape = k % 2 === 0 ? rect(0, 0, 10 + next() * 10, 8 + next() * 8) : L;
      const dx = Math.round((next() * 5 - 2.5) * 10) / 10;
      const dy = Math.round((next() * 5 - 2.5) * 10) / 10;
      const moved = translate(shape, dx, dy);
      const t = bestTranslation(shape, moved, 3);
      expect(Math.abs(t.dx + dx), `case ${k}`).toBeLessThanOrEqual(0.1 + 1e-9);
      expect(Math.abs(t.dy + dy), `case ${k}`).toBeLessThanOrEqual(0.1 + 1e-9);
      expect(t.iou).toBeGreaterThan(0.98);
    }
  });

  it('never worse than raw, never past the limit, and a different shape stays different', () => {
    const a = rect(0, 0, 20, 10);
    const b = rect(0, 0, 14, 10);
    const t = bestTranslation(a, b, 3);
    expect(t.iou).toBeGreaterThanOrEqual(iou(a, b)!);
    expect(t.iou).toBeCloseTo(0.7, 5);
    const far = bestTranslation(a, translate(a, 10, 0), 3);
    expect(Math.abs(far.dx)).toBeLessThanOrEqual(3);
  });

  it('alignedOutline reports the shift and the boundary distance after it', () => {
    const ours = rect(0, 0, 12, 9);
    const key = translate(ours, 1, -0.5);
    const a = alignedOutline(ours, key, 0.2);
    expect(a.shiftM).toEqual([-1, 0.5]);
    expect(a.iou).toBeGreaterThan(0.99);
    expect(a.meanBoundaryM).toBeLessThan(0.01);
  });

  it('is deterministic', () => {
    const t1 = bestTranslation(L, translate(L, 1.3, -0.7));
    const t2 = bestTranslation(L, translate(L, 1.3, -0.7));
    expect(t1).toEqual(t2);
  });
});
