import { describe, expect, it } from 'vitest';
import { buildRoofModel, measureRoof, seededPitchX12, type RoofLineKind, type RoofModel } from '../src/roof-model.ts';
import { instantEstimate, polygonAreaSqFt, type Ring } from '../src/roof.ts';

// Omaha origin; metres to degrees with the same sphere the engine uses.
const LNG0 = -95.9345;
const LAT0 = 41.2565;
const K = (Math.PI / 180) * 6371008.8;
const COS = Math.cos((LAT0 * Math.PI) / 180);

/** A ring from local metres, turned by `rot` radians (open ring). */
function ring(pts: [number, number][], rot = 0): Ring {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return pts.map(([x, y]) => [LNG0 + (x * c - y * s) / (K * COS), LAT0 + (x * s + y * c) / K]);
}

function count(m: RoofModel, kind: RoofLineKind): number {
  return m.lines.filter((l) => l.kind === kind).length;
}

/** Facet plan areas (from the rings, no overhang) summed, in sq ft. */
function facetRingArea(m: RoofModel): number {
  return m.facets.reduce((s, f) => s + polygonAreaSqFt(f.ring), 0);
}

const RECT: [number, number][] = [
  [0, 0],
  [20, 0],
  [20, 10],
  [0, 10],
];
const L_SHAPE: [number, number][] = [
  [0, 0],
  [20, 0],
  [20, 8],
  [8, 8],
  [8, 20],
  [0, 20],
];
const T_SHAPE: [number, number][] = [
  [0, 0],
  [30, 0],
  [30, 10],
  [19, 10],
  [19, 20],
  [11, 20],
  [11, 10],
  [0, 10],
];

describe('buildRoofModel', () => {
  it('makes a long rectangle a gable: 2 facets, 1 ridge, 2 eaves, 4 rakes', () => {
    const m = buildRoofModel(ring(RECT, 0.4), { pitchX12: 6 })!;
    expect(m).not.toBeNull();
    expect(m.facets.map((f) => f.id)).toEqual(['A', 'B']);
    expect(count(m, 'ridge')).toBe(1);
    expect(count(m, 'eave')).toBe(2);
    expect(count(m, 'rake')).toBe(4);
    expect(count(m, 'hip')).toBe(0);
    expect(count(m, 'valley')).toBe(0);
    const ftPerM = 3.280839895;
    expect(m.totals.ridgeFt).toBeCloseTo(20 * ftPerM, 0);
    expect(m.totals.eaveFt).toBeCloseTo(40 * ftPerM, 0);
    // Rakes climb: 4 x 5 m at 6/12.
    expect(m.totals.rakeFt).toBeCloseTo(20 * ftPerM * Math.sqrt(1 + 0.25), 0);
    expect(m.pitch).toBe('6/12');
    for (const f of m.facets) {
      expect(f.pitch).toBe('6/12');
      expect(f.ring[0]).toEqual(f.ring[f.ring.length - 1]);
      expect(f.areaSqFt).toBeCloseTo(f.planSqFt * Math.sqrt(1.25), 0);
    }
    expect(m.totals.facetCount).toBe(2);
    expect(m.totals.wastePct).toBe(10);
    expect(m.totals.squares).toBeCloseTo(m.totals.slopedSqFt / 100, 1);
    expect(m.outline[0]).toEqual(m.outline[m.outline.length - 1]);
  });

  it('gives an L-shape valleys, ridges on both wings and gable ends', () => {
    const m = buildRoofModel(ring(L_SHAPE, 1.1), { pitchX12: 5 })!;
    expect(m.facets).toHaveLength(4);
    expect(count(m, 'valley')).toBe(1);
    expect(count(m, 'hip')).toBe(1);
    expect(count(m, 'ridge')).toBe(2);
    expect(count(m, 'rake')).toBe(4);
    expect(m.totals.valleyFt).toBeGreaterThan(0);
  });

  it('gives a T-shape a cross gable with two valleys, like the reference drawing', () => {
    const m = buildRoofModel(ring(T_SHAPE), { pitchX12: 5 })!;
    expect(m.facets).toHaveLength(4);
    expect(count(m, 'valley')).toBe(2);
    expect(count(m, 'ridge')).toBe(2);
    expect(count(m, 'hip')).toBe(0);
    expect(count(m, 'rake')).toBe(6);
  });

  it('hips a near-square roof (4 facets, 4 hips)', () => {
    const m = buildRoofModel(ring([[0, 0], [12, 0], [12, 11], [0, 11]]), { pitchX12: 5 })!;
    expect(m.facets).toHaveLength(4);
    expect(count(m, 'hip')).toBe(4);
    expect(m.totals.wastePct).toBeGreaterThanOrEqual(12);
    expect(m.totals.wastePct).toBeLessThanOrEqual(15);
  });

  it('labels facets A, B, C... largest first, each label point inside its facet', () => {
    const m = buildRoofModel(ring(T_SHAPE), { pitchX12: 5 })!;
    expect(m.facets.map((f) => f.id)).toEqual(['A', 'B', 'C', 'D']);
    for (let i = 1; i < m.facets.length; i++) expect(m.facets[i - 1]!.planSqFt).toBeGreaterThanOrEqual(m.facets[i]!.planSqFt);
    for (const f of m.facets) {
      const [x, y] = f.labelAt;
      let inside = false;
      for (let i = 0, j = f.ring.length - 1; i < f.ring.length; j = i++) {
        const a = f.ring[i]!;
        const b = f.ring[j]!;
        if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
      }
      expect(inside).toBe(true);
    }
  });

  it('survives a noisy real-ish footprint and covers it within 3%', () => {
    // An L with jittered corners, extra points along the sides and a tiny notch, turned 23 degrees.
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648 - 0.5;
    };
    const base: [number, number][] = [
      [0, 0],
      [9, 0],
      [18, 0],
      [18.3, 0.4],
      [18, 9.5],
      [10.2, 9.5],
      [10.2, 10.1],
      [9.6, 10.1],
      [9.6, 17],
      [5, 17.2],
      [0, 17],
      [0, 8],
    ];
    const noisy = base.map(([x, y]) => [x + rnd() * 0.5, y + rnd() * 0.5] as [number, number]);
    const r = ring(noisy, (23 * Math.PI) / 180);
    let m: RoofModel | null = null;
    expect(() => {
      m = buildRoofModel(r, { pitchX12: 5 });
    }).not.toThrow();
    expect(m).not.toBeNull();
    const area = polygonAreaSqFt(r);
    expect(Math.abs(facetRingArea(m!) - area) / area).toBeLessThan(0.03);
    expect(count(m!, 'valley')).toBeGreaterThanOrEqual(1);
  });

  it('falls back to one gable for a shape that is not rectilinear', () => {
    const oct = ring([[0, 0], [10, -4], [20, 0], [24, 10], [20, 20], [10, 24], [0, 20], [-4, 10]]);
    const m = buildRoofModel(oct, { pitchX12: 5 })!;
    expect(m.facets).toHaveLength(2);
    expect(count(m, 'ridge')).toBe(1);
    const area = polygonAreaSqFt(oct);
    expect(Math.abs(facetRingArea(m) - area) / area).toBeLessThan(0.03);
  });

  it('never throws on bad input', () => {
    const bad: unknown[] = [
      [],
      [[[0, 0]]],
      [[Number.NaN, 1], [2, 3], [4, 5]],
      ring([[0, 0], [10, 0], [0, 10], [10, 10]]), // bow tie
      ring([[0, 0], [10, 0], [20, 0]]), // a line
    ];
    for (const b of bad) {
      expect(() => buildRoofModel(b as Ring, { pitchX12: 5 })).not.toThrow();
    }
    expect(buildRoofModel([], { pitchX12: 5 })).toBeNull();
  });

  it('is deterministic', () => {
    const a = buildRoofModel(ring(L_SHAPE, 0.2), { pitchX12: 7 });
    const b = buildRoofModel(ring(L_SHAPE, 0.2), { pitchX12: 7 });
    expect(a).toEqual(b);
  });
});

describe('seededPitchX12', () => {
  it('is 4 to 7 and the same for the same id; 5 without one', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', '0b5d3c3e-4b1f-4e47-9a3a-2f7c5b1e6d10'];
    for (const id of ids) {
      expect([4, 5, 6, 7]).toContain(seededPitchX12(id));
      expect(seededPitchX12(id)).toBe(seededPitchX12(id));
    }
    expect(new Set(ids.map(seededPitchX12)).size).toBeGreaterThan(1);
    expect(seededPitchX12(null)).toBe(5);
  });
});

describe('measureRoof', () => {
  it('keeps the instant estimate areas and takes ridge, valley and edges from the roof', () => {
    const input = { outline: [ring(L_SHAPE)], pitchX12: 5, overhangFt: 1 };
    const base = instantEstimate(input);
    const { estimate, roof } = measureRoof(input);
    expect(roof).not.toBeNull();
    expect(estimate.surfaceSqFt).toBe(base.surfaceSqFt);
    expect(estimate.planSqFt).toBe(base.planSqFt);
    expect(roof!.totals.slopedSqFt).toBe(base.surfaceSqFt);
    expect(roof!.totals.squares).toBe(base.squares);
    expect(estimate.ridgeFt).toBe(roof!.totals.ridgeFt);
    expect(estimate.valleyFt).toBe(roof!.totals.valleyFt);
    expect(estimate.edgeFt).toBeCloseTo(roof!.totals.eaveFt + roof!.totals.rakeFt, 1);
    const facetSum = roof!.facets.reduce((s, f) => s + f.areaSqFt, 0);
    expect(Math.abs(facetSum - base.surfaceSqFt)).toBeLessThan(1);
  });

  it('keeps a valley length that was entered', () => {
    const { estimate } = measureRoof({ outline: [ring(L_SHAPE)], pitchX12: 5, overhangFt: 1, valleyFt: 42 });
    expect(estimate.valleyFt).toBe(42);
  });

  it('is the plain estimate with no roof for an empty outline', () => {
    const { estimate, roof } = measureRoof({ outline: [], pitchX12: 6, overhangFt: 1 });
    expect(roof).toBeNull();
    expect(estimate).toEqual(instantEstimate({ outline: [], pitchX12: 6, overhangFt: 1 }));
  });
});
