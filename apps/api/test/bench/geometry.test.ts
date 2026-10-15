import { describe, expect, test } from 'vitest';
import {
  boundaryDistance,
  boundaryDistances,
  convexHull,
  iou,
  iouGrid,
  mean,
  median,
  type MultiPoly,
  overlapArea,
  percentile,
  rasterize,
  rectilinearity,
  ringArea,
  roundHalfEven,
  sampleRings,
} from '../../src/bench/roof3d/geometry.ts';
import { closed, randomStar, rng } from './helpers.ts';

const square = (x: number, y: number, s: number): MultiPoly => [[closed([[x, y], [x + s, y], [x + s, y + s], [x, y + s]])]];

describe('overlap', () => {
  test('known squares', () => {
    expect(iou(square(0, 0, 10), square(0, 0, 10))).toBeCloseTo(1, 12);
    expect(iou(square(0, 0, 10), square(5, 0, 10))).toBeCloseTo(50 / 150, 12);
    expect(iou(square(0, 0, 10), square(20, 20, 5))).toBe(0);
    // One inside the other: the small one's area over the big one's.
    expect(iou(square(0, 0, 10), square(2, 2, 4))).toBeCloseTo(16 / 100, 12);
  });

  test('a hole counts against the area', () => {
    const ring = square(0, 0, 10)[0]![0]!;
    const donut: MultiPoly = [[ring, closed([[3, 3], [3, 7], [7, 7], [7, 3]])]];
    expect(iou(donut, square(0, 0, 10))).toBeCloseTo(84 / 100, 12);
  });

  test('both empty is no answer, not a perfect one', () => {
    expect(iou([], [])).toBeNull();
  });

  test('properties on random polygons: symmetric, in [0,1], 1 on itself, invariant to moving and turning both', () => {
    const r = rng(11);
    for (let k = 0; k < 60; k++) {
      const a: MultiPoly = [[closed(randomStar(r, 8))]];
      const b: MultiPoly = [[closed(randomStar(r, 8, r() * 6 - 3, r() * 6 - 3))]];
      const ab = iou(a, b)!;
      expect(ab).toBeGreaterThanOrEqual(0);
      expect(ab).toBeLessThanOrEqual(1);
      expect(iou(b, a)!).toBeCloseTo(ab, 9);
      expect(iou(a, a)!).toBeCloseTo(1, 9);
      const dx = 1000 * r();
      const dy = 1000 * r();
      const move = (m: MultiPoly): MultiPoly => m.map((p) => p.map((ring) => ring.map(([x, y]): [number, number] => [x + dx, y + dy])));
      expect(iou(move(a), move(b))!).toBeCloseTo(ab, 6);
      const th = r() * Math.PI;
      const turn = (m: MultiPoly): MultiPoly => m.map((p) => p.map((ring) => ring.map(([x, y]): [number, number] => [x * Math.cos(th) - y * Math.sin(th), x * Math.sin(th) + y * Math.cos(th)])));
      expect(iou(turn(a), turn(b))!).toBeCloseTo(ab, 6);
    }
  });

  test('the exact overlap agrees with the independent grid estimate', () => {
    const r = rng(5);
    for (let k = 0; k < 12; k++) {
      const a: MultiPoly = [[closed(randomStar(r, 7))]];
      const b: MultiPoly = [[closed(randomStar(r, 7, r() * 4 - 2, r() * 4 - 2))]];
      expect(Math.abs(iou(a, b)! - iouGrid(a, b, 0.05)!)).toBeLessThan(0.01);
    }
  });

  test('overlapArea is the intersection area', () => {
    expect(overlapArea(square(0, 0, 10), square(5, 5, 10))).toBeCloseTo(25, 9);
  });
});

describe('boundary distance', () => {
  test('a polygon is no distance from itself', () => {
    const r = rng(3);
    const a: MultiPoly = [[closed(randomStar(r))]];
    const d = boundaryDistance(a, a);
    expect(d.mean).toBeCloseTo(0, 9);
    expect(d.hd95).toBeCloseTo(0, 9);
  });

  test('a square grown by one metre is about one metre away (a corner of the outer one is 1.41 m from the inner)', () => {
    const d = boundaryDistance(square(0, 0, 10), square(-1, -1, 12));
    expect(d.mean).toBeGreaterThan(1);
    expect(d.mean).toBeLessThan(1.1);
    expect(d.hd95).toBeLessThanOrEqual(Math.SQRT2 + 1e-9);
    // Directed: every point of the inner square is exactly 1 m from the outer one.
    const inner = boundaryDistances(square(0, 0, 10), square(-1, -1, 12));
    expect(Math.min(...inner)).toBeCloseTo(1, 9);
    expect(Math.max(...inner)).toBeCloseTo(1, 9);
  });

  test('properties: symmetric; a copy moved by d is at most d away', () => {
    const r = rng(21);
    for (let k = 0; k < 25; k++) {
      const a: MultiPoly = [[closed(randomStar(r, 8))]];
      const d = 0.3 + r() * 2;
      const shifted: MultiPoly = a.map((p) => p.map((ring) => ring.map(([x, y]): [number, number] => [x + d, y])));
      const s = boundaryDistance(a, shifted);
      const t = boundaryDistance(shifted, a);
      expect(s.mean).toBeCloseTo(t.mean, 9);
      expect(s.mean).toBeLessThanOrEqual(d + 1e-9);
      expect(s.hd95).toBeLessThanOrEqual(d + 1e-9);
    }
  });

  test('a one-sided notch shows in the Hausdorff percentile, not the mean', () => {
    const a = square(0, 0, 20);
    // The same square with a 6 m deep notch cut into one side (the outline a tree bite leaves).
    const notched: MultiPoly = [[closed([[0, 0], [8, 0], [8, 6], [12, 6], [12, 0], [20, 0], [20, 20], [0, 20]])]];
    const d = boundaryDistance(a, notched);
    expect(d.hd95).toBeGreaterThan(d.mean);
    expect(d.mean).toBeLessThan(1.5);
  });

  test('directed distances and sampling', () => {
    const ds = boundaryDistances(square(0, 0, 10), square(0, 0, 10), 0.5);
    expect(ds.length).toBe(80);
    expect(Math.max(...ds)).toBeLessThan(1e-9);
    expect(sampleRings(square(0, 0, 10)[0]!, 0.2).length).toBe(200);
  });
});

describe('rectilinearity', () => {
  const rect = (w: number, h: number, deg: number) => {
    const t = (deg * Math.PI) / 180;
    return [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]): [number, number] => [x! * Math.cos(t) - y! * Math.sin(t), x! * Math.sin(t) + y! * Math.cos(t)]);
  };
  test('a rectangle is 1 at any angle', () => {
    for (const deg of [0, 7, 23.5, 45, 62, 89]) expect(rectilinearity(rect(14, 9, deg)).share).toBeCloseTo(1, 9);
  });
  test('an L shape is 1', () => {
    expect(rectilinearity([[0, 0], [12, 0], [12, 5], [5, 5], [5, 10], [0, 10]]).share).toBe(1);
  });
  test('a chamfered corner loses its share of the length', () => {
    // 10 x 10 square with one 2 m x 2 m corner cut by a diagonal: perimeter 40 - 4 + 2.83.
    const pts: [number, number][] = [[0, 0], [10, 0], [10, 8], [8, 10], [0, 10]];
    const total = 10 + 8 + Math.hypot(2, 2) + 8 + 10;
    expect(rectilinearity(pts).share).toBeCloseTo((total - Math.hypot(2, 2)) / total, 9);
  });
  test('a circle is not rectilinear', () => {
    const circle: [number, number][] = Array.from({ length: 72 }, (_, k): [number, number] => [10 * Math.cos((k / 72) * 2 * Math.PI), 10 * Math.sin((k / 72) * 2 * Math.PI)]);
    expect(rectilinearity(circle).share).toBeLessThan(0.3);
  });
  test('the share is the same whichever vertex the ring starts at', () => {
    const r = rng(9);
    const pts = randomStar(r, 10);
    const a = rectilinearity(pts).share;
    for (let k = 1; k < pts.length; k++) expect(rectilinearity([...pts.slice(k), ...pts.slice(0, k)]).share).toBeCloseTo(a, 9);
  });
});

describe('small helpers', () => {
  test('round half to even, like Python', () => {
    expect([0.5, 1.5, 2.5, 3.5, 6.4, 6.5, 6.6, -1.5].map(roundHalfEven)).toEqual([0, 2, 2, 4, 6, 6, 7, -2]);
  });
  test('percentiles interpolate', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([5], 0.95)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBeCloseTo(4.8, 12);
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
    expect(median([3, 1, 2])).toBe(2);
    expect(mean([1, 2, 3])).toBe(2);
  });
  test('convex hull and area', () => {
    const hull = convexHull([[0, 0], [4, 0], [4, 4], [0, 4], [2, 2], [1, 3]]);
    expect(hull.length).toBe(4);
    expect(Math.abs(ringArea(closed(hull)))).toBe(16);
  });
  test('rasterize fills the pixels whose centres are inside', () => {
    const grid = rasterize([[2, 2], [8, 2], [8, 6], [2, 6]], 10, 10);
    expect(grid.reduce((t, v) => t + v, 0)).toBe(24);
  });
});
