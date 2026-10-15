// Failure behaviour and limits of the hidden-edge steps taken together (review of the outline round):
// - the photo step, like the planes step, never throws into a reconstruction: an exception keeps the outline;
// - photo then planes cannot compound past one combined limit (HIDDEN_EDGE_LIMITS);
// - what the steps inferred is recorded edge by edge with its area (LocalRoof.inferred -> Roof3d.inferredEdges).
import { describe, expect, it } from 'vitest';
import { combinedChangeOk, HIDDEN_EDGE_LIMITS, inferredOf, reconstructRoof, type RoofRaster, toRoof3d } from '../src/roof-reconstruct/index.ts';
import { hipShape, synthesize, type SyntheticRoof, type XY } from './fixtures/synthetic-roofs.ts';

/** The planes tests' dense crown (radius `rad`, centred at `at` in the house frame), its pixels out of the mask. */
function withCrown(roof: SyntheticRoof, at: XY, rad: number): RoofRaster {
  const { width: w, height: h, pixelSizeM: s } = roof.raster;
  const dsm = Float32Array.from(roof.raster.dsm);
  const mask = Uint8Array.from(roof.raster.mask);
  const green = new Uint8Array(w * h);
  const c = roof.toLocal(at);
  for (let r = 0; r < h; r++) {
    for (let col = 0; col < w; col++) {
      const x = (col + 0.5) * s;
      const y = -(r + 0.5) * s;
      const d = Math.hypot(x - c.x, y - c.y);
      if (d > rad) continue;
      const z = 7 - (d * d) / (rad * 1.5) + 0.25 * Math.sin(x * 7.3) * Math.cos(y * 6.1);
      const i = r * w + col;
      if (z > dsm[i]!) {
        dsm[i] = z;
        green[i] = 1;
        mask[i] = 0;
      }
    }
  }
  return { width: w, height: h, pixelSizeM: s, dsm, mask, green };
}

function area(ring: readonly XY[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) a += ring[i]!.x * ring[(i + 1) % ring.length]!.y - ring[(i + 1) % ring.length]!.x * ring[i]!.y;
  return Math.abs(a) / 2;
}

const rect = (x0: number, y0: number, x1: number, y1: number): XY[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

describe('the photo step never throws into a reconstruction', () => {
  for (const px of [0.1, 0.25]) {
    it(`a photo raster that throws when read (${px} m pixels): the outline is the one without the step, declined 'error'`, () => {
      const roof = synthesize(hipShape(16, 10, 6), { pixelM: px, trees: 0, noiseM: 0.02, seed: 5 });
      const n = roof.raster.width * roof.raster.height;
      const rgb = new Proxy(new Uint8Array(3 * n).fill(128), {
        get(target, key) {
          if (key === 'subarray') throw new Error('unreadable photo');
          const v = Reflect.get(target, key) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      const raster: RoofRaster = { ...roof.raster, rgb };
      const off = reconstructRoof(roof.raster, roof.point, {})!;
      for (const method of ['photo', 'photo+planes', 'planes+photo'] as const) {
        const on = reconstructRoof(raster, roof.point, { hiddenEdge: { method } });
        expect(on).not.toBeNull();
        expect(on!.hiddenEdges?.declined).toBe('error');
        expect(on!.outline).toEqual(off.outline);
      }
    });
  }
});

describe('a reconstruction with the step on: inferred roof is recorded and reviewed, and capped', () => {
  for (const px of [0.1, 0.25]) {
    // The planes tests' hip (16 x 10 m at 6/12) with a dense crown over the middle of its long eave, in hypothesis mode.
    const roof = synthesize(hipShape(16, 10, 6), { pixelM: px, trees: 0, noiseM: 0.02, seed: 5 });
    const raster = withCrown(roof, { x: 0.3, y: -5.5 }, 2.6);
    const off = reconstructRoof(raster, roof.point, {})!;
    it(`${px} m pixels: the bite filled (about 8 m2) is recorded edge by edge and sent for review ('roof-inferred')`, () => {
      const on = reconstructRoof(raster, roof.point, { hiddenEdge: { method: 'planes', planes: { minDeepSeenShare: 0 } } })!;
      const added = area(on.outline) - area(off.outline);
      expect(added).toBeGreaterThan(3);
      expect(on.inferred!.edges.length).toBeGreaterThan(0);
      expect(on.inferred!.edges.every((e) => e.method === 'planes')).toBe(true);
      expect(Math.abs(on.inferred!.addedM2 - added)).toBeLessThan(0.05 * added + 4 * px * px);
      expect(on.quality.reasons).toContain('roof-inferred');
      expect(off.quality.reasons).not.toContain('roof-inferred');
    });
    it(`${px} m pixels: past the combined limit (here 3 % of the area) the outline is put back and says so`, () => {
      const capped = reconstructRoof(raster, roof.point, { hiddenEdge: { method: 'planes', planes: { minDeepSeenShare: 0 }, limits: { maxAreaChange: 0.03 } } })!;
      expect(capped.outline).toEqual(off.outline);
      expect(capped.inferred).toEqual({ methods: ['planes'], edges: [], addedM2: 0, removedM2: 0, undone: 'large-change' });
      expect(capped.quality.reasons).not.toContain('roof-inferred');
    });
  }
});

describe('the steps together stay within one combined limit', () => {
  const pre = rect(0, -10, 16, 0);
  it('the documented limits', () => {
    expect(HIDDEN_EDGE_LIMITS).toEqual({ maxAreaChange: 0.15, maxCornerMoveM: 4.5 });
  });
  it('accepts a change inside both limits', () => {
    expect(combinedChangeOk(pre, rect(0, -11, 16, 0), HIDDEN_EDGE_LIMITS)).toBe(true);
  });
  it('refuses an area change past 15 % even when each step alone kept under its own 25 %', () => {
    // 16 x 10 grown by 1.3 m (+13 %), then by 1.2 m more: +25 % in all, every corner within 2.5 m.
    const one = rect(0, -11.3, 16, 0);
    const two = rect(0, -12.5, 16, 0);
    expect(combinedChangeOk(pre, one, HIDDEN_EDGE_LIMITS)).toBe(true);
    expect(combinedChangeOk(one, two, HIDDEN_EDGE_LIMITS)).toBe(true);
    expect(combinedChangeOk(pre, two, HIDDEN_EDGE_LIMITS)).toBe(false);
  });
  it('refuses a corner more than 4.5 m from every old corner', () => {
    // A spike 4.6 m north of the roof's north eave, its tip 4.6 m or more from every old corner (area check off).
    const spike = [{ x: 0, y: -10 }, { x: 16, y: -10 }, { x: 16, y: 0 }, { x: 10, y: 0 }, { x: 8, y: 4.6 }, { x: 6, y: 0 }, { x: 0, y: 0 }];
    expect(combinedChangeOk(pre, spike, { maxAreaChange: 1, maxCornerMoveM: 4.5 })).toBe(false);
    expect(combinedChangeOk(pre, spike, { maxAreaChange: 1, maxCornerMoveM: 10 })).toBe(true);
  });
  it('refuses a degenerate result', () => {
    expect(combinedChangeOk(pre, pre.slice(0, 2), HIDDEN_EDGE_LIMITS)).toBe(false);
  });
});

describe('the record of what was inferred', () => {
  const pre = rect(0, -10, 16, 0);
  it('nothing moved: no edges, no area', () => {
    expect(inferredOf([pre, pre, pre], ['photo', 'planes'], 0.1)).toEqual({ methods: ['photo', 'planes'], edges: [], addedM2: 0, removedM2: 0 });
  });
  it('one eave moved out 1.5 m by the planes step: that edge, its offset and the 24 m2 it adds', () => {
    const moved = rect(0, -11.5, 16, 0);
    const r = inferredOf([pre, pre, moved], ['photo', 'planes'], 0.1);
    // The moved eave (edge 0) and the stretches of the two side edges beyond the old corners.
    const eave = r.edges.find((e) => e.from === 0)!;
    expect(eave).toMatchObject({ method: 'planes', lengthM: 16, offsetM: 1.5 });
    expect(r.edges.filter((e) => e.from !== 0).every((e) => e.lengthM <= 1.6 && e.method === 'planes')).toBe(true);
    expect(r.addedM2).toBeCloseTo(24, 0);
    expect(r.removedM2).toBe(0);
  });
  it('counts a thin strip right at MEDIUM pixels (0.4 m over 16 m is 6.4 m2, not a whole number of 0.25 m rows)', () => {
    const r = inferredOf([pre, rect(0, -10.4, 16, 0)], ['planes'], 0.25);
    expect(r.addedM2).toBeCloseTo(6.4, 1);
  });
  it('each stretch is put down to the step that moved it', () => {
    const afterPhoto = rect(0, -10.5, 16, 0);
    const afterPlanes = [{ x: 0, y: -10.5 }, { x: 16, y: -10.5 }, { x: 17, y: 0 }, { x: 0, y: 0 }];
    const r = inferredOf([pre, afterPhoto, afterPlanes], ['photo', 'planes'], 0.1);
    expect(r.edges.find((e) => e.from === 0)!.method).toBe('photo');
    expect(r.edges.find((e) => e.from === 1)!.method).toBe('planes');
  });
  it('an undone change says so and has nothing inferred', () => {
    expect(inferredOf([pre, rect(0, -14, 16, 0), pre], ['photo', 'planes'], 0.1, 'large-change')).toEqual({ methods: ['photo', 'planes'], edges: [], addedM2: 0, removedM2: 0, undone: 'large-change' });
  });
  it('is carried onto the stored roof in feet', () => {
    const roof = synthesize(hipShape(16, 10, 6), { pixelM: 0.1, trees: 0, noiseM: 0.02, seed: 5 });
    const local = reconstructRoof(roof.raster, roof.point, { hiddenEdge: { method: 'planes' } })!;
    const stored = toRoof3d({ ...local, inferred: { methods: ['planes'], edges: [{ from: 1, method: 'planes', lengthM: 10, offsetM: 1 }], addedM2: 10, removedM2: 0 } }, (x, y) => [x, y], { imageryQuality: 'HIGH', imageryDate: null });
    expect(stored.inferredEdges).toEqual({ methods: ['planes'], edges: [{ from: 1, method: 'planes', lengthFt: 32.8, offsetFt: 3.3 }], addedSqFt: 107.6, removedSqFt: 0 });
    const without = toRoof3d({ ...local, inferred: undefined }, (x, y) => [x, y], { imageryQuality: 'HIGH', imageryDate: null });
    expect('inferredEdges' in without).toBe(false);
  });
});
