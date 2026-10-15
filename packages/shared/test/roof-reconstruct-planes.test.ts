// The hidden-edge step 'planes' (outline-planes.ts): eaves a tree crown hides from the height map are put back where the
// face's plane comes down to the eave height its visible eaves show. Synthetic hip and gable roofs with a crown over an
// eave (the crown's pixels taken out of the mask, as Google's mask does), at 0.1 m (HIGH) and 0.25 m (MEDIUM) pixels,
// turned and not; the true outline is the shape's rectangle.
import { describe, expect, it } from 'vitest';
import { type LocalRoof, reconstructRoof, type RoofRaster } from '../src/roof-reconstruct/index.ts';
import { DEFAULT_OUTLINE_PLANES, inferHiddenEaves, type OutlinePlanesParams } from '../src/roof-reconstruct/outline-planes.ts';
import { gableShape, hipShape, L_CROSS, synthesize, type SyntheticRoof, type XY } from './fixtures/synthetic-roofs.ts';

/**
 * A crown of radius `rad` centred at `at` (house frame), its top `aboveM` over the eave. Google's mask leaves the whole
 * crown out. `gaps` is the share of the crown's pixels (a fixed pattern) where the leaves are sparse enough for the
 * photogrammetry to see what is under them (the roof, or the yard); 0 is a dense crown that hides everything.
 */
function withCrown(roof: SyntheticRoof, at: XY, rad: number, aboveM = 4, gaps = 0): RoofRaster {
  const { width: W, height: H, pixelSizeM: s } = roof.raster;
  const dsm = Float32Array.from(roof.raster.dsm);
  const mask = Uint8Array.from(roof.raster.mask);
  const green = new Uint8Array(W * H);
  const c = roof.toLocal(at);
  // A deterministic ripple instead of noise: foliage is rough (eave-support's crown test reads it).
  for (let r = 0; r < H; r++) {
    for (let col = 0; col < W; col++) {
      const x = (col + 0.5) * s;
      const y = -(r + 0.5) * s;
      const d = Math.hypot(x - c.x, y - c.y);
      if (d > rad) continue;
      const z = 3 + aboveM - (d * d) / (rad * 1.5) + 0.25 * Math.sin(x * 7.3) * Math.cos(y * 6.1);
      const i = r * W + col;
      // Google's mask leaves the crown out, gaps and all (its segmentation is coarser than the leaves).
      if (z > dsm[i]!) mask[i] = 0;
      if (cellHash(col, r) < gaps) continue;
      if (z > dsm[i]!) {
        dsm[i] = z;
        green[i] = 1;
      }
    }
  }
  return { width: W, height: H, pixelSizeM: s, dsm, mask, green };
}

/** A fixed pseudo-random number in [0, 1) per cell (no seeded generator needed; the same on every run). */
function cellHash(cx: number, cy: number): number {
  let h = (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Hypothesis mode: every plane line taken (minDeepSeenShare 0), as if the roof under a dense crown were known to be
 * there. It tests the eave-line geometry itself; the default refuses such moves ('unconfirmed', below).
 */
const HYPOTHESIS: Partial<OutlinePlanesParams> = { minDeepSeenShare: 0 };

const run = (raster: RoofRaster, roof: SyntheticRoof, on: boolean | Partial<OutlinePlanesParams>): LocalRoof => {
  const out = reconstructRoof(raster, roof.point, on === false ? {} : { hiddenEdge: { method: 'planes', ...(on === true ? {} : { planes: on }) } });
  expect(out).not.toBeNull();
  return out!;
};

function area(ring: readonly XY[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function distToRing(p: XY, ring: readonly XY[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
}

/** The true outline's points (house frame rectangle L x W) within `near` metres of the crown: the hidden stretch. */
function hiddenTruth(roof: SyntheticRoof, L: number, W: number, at: XY, near: number): XY[] {
  const pts: XY[] = [];
  const corners = [
    { x: -L / 2, y: -W / 2 },
    { x: L / 2, y: -W / 2 },
    { x: L / 2, y: W / 2 },
    { x: -L / 2, y: W / 2 },
  ];
  for (let k = 0; k < 4; k++) {
    const a = corners[k]!;
    const b = corners[(k + 1) % 4]!;
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.2);
    for (let i = 0; i <= n; i++) {
      const p = { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n };
      if (Math.hypot(p.x - at.x, p.y - at.y) <= near) pts.push(roof.toLocal(p));
    }
  }
  return pts;
}

const worst = (pts: XY[], ring: readonly XY[]) => Math.max(...pts.map((p) => distToRing(p, ring)));

describe('hidden eaves from the planes (synthetic crowns over eaves)', () => {
  // A hip 16 x 10 m at 6/12: a crown over the middle of a long eave, over a short (hip-end) eave, and over a corner
  // (the chamfer the owner saw at 305 Ridgeway Dr).
  const L = 16;
  const W = 10;
  const crowns: { name: string; at: XY; rad: number }[] = [
    { name: 'long eave', at: { x: 1, y: -W / 2 - 0.5 }, rad: 2.6 },
    { name: 'hip end', at: { x: L / 2 + 0.6, y: 0.5 }, rad: 2.4 },
    { name: 'corner', at: { x: L / 2 + 0.3, y: -W / 2 - 0.3 }, rad: 2.6 },
  ];
  for (const px of [0.1, 0.25]) {
    for (const turnDeg of [0, 23]) {
      for (const c of crowns) {
        it(`hip, dense crown over the ${c.name}, ${px} m pixels, turned ${turnDeg} deg: refused by default; as a hypothesis the eave line is right`, () => {
          const roof = synthesize(hipShape(L, W, 6), { pixelM: px, turnDeg, trees: 0, noiseM: 0.02, seed: 5 });
          const raster = withCrown(roof, c.at, c.rad);
          const off = run(raster, roof, false);
          // A dense crown hides whether roof or a notch is under it: by default the move is refused and said so.
          const safe = run(raster, roof, true);
          expect(safe.hiddenEdge?.declined.unconfirmed ?? 0).toBeGreaterThan(0);
          expect(safe.outline).toEqual(off.outline);
          const on = run(raster, roof, HYPOTHESIS);
          const truth = hiddenTruth(roof, L, W, c.at, c.rad - 0.3);
          // Reproduces the problem: without the step the outline stops short where the crown stands.
          expect(worst(truth, off.outline)).toBeGreaterThan(0.8);
          // With it, the hidden stretch is back within half a metre (a pixel more at MEDIUM).
          expect(on.hiddenEdge?.pieces ?? 0).toBeGreaterThan(0);
          expect(worst(truth, on.outline)).toBeLessThan(0.5 + px);
          // And the roof's area is the shape's within 3 % (it was short before).
          expect(Math.abs(area(on.outline) - L * W) / (L * W)).toBeLessThan(0.03);
          expect(Math.abs(area(on.outline) - L * W)).toBeLessThan(Math.abs(area(off.outline) - L * W));
        });
      }
    }
  }

  for (const turnDeg of [0, 23]) {
    it(`hip, sparse crown over the long eave (roof seen through 40 % of it), 0.1 m pixels, turned ${turnDeg} deg: put back by default`, () => {
      const roof = synthesize(hipShape(L, W, 6), { pixelM: 0.1, turnDeg, trees: 0, noiseM: 0.02, seed: 5 });
      const raster = withCrown(roof, crowns[0]!.at, crowns[0]!.rad, 4, 0.4);
      const off = run(raster, roof, false);
      const on = run(raster, roof, true);
      const truth = hiddenTruth(roof, L, W, crowns[0]!.at, crowns[0]!.rad - 0.3);
      expect(worst(truth, off.outline)).toBeGreaterThan(0.8);
      expect(on.hiddenEdge?.pieces ?? 0).toBeGreaterThan(0);
      expect(worst(truth, on.outline)).toBeLessThan(0.5);
      expect(Math.abs(area(on.outline) - L * W) / (L * W)).toBeLessThan(0.03);
    });
  }

  it('gable, crown over an eave: put back; the rake is not touched', () => {
    const roof = synthesize(gableShape(14, 9, 7), { pixelM: 0.1, turnDeg: 11, trees: 0, noiseM: 0.02, seed: 3 });
    const at = { x: -2, y: 9 / 2 + 0.4 };
    const raster = withCrown(roof, at, 2.5);
    const off = run(raster, roof, false);
    const on = run(raster, roof, HYPOTHESIS);
    const truth = hiddenTruth(roof, 14, 9, at, 2.2);
    expect(worst(truth, off.outline)).toBeGreaterThan(0.8);
    expect(worst(truth, on.outline)).toBeLessThan(0.5);
  });

  it('a gable rake under a crown is left alone (no eave height says where a rake ends)', () => {
    const roof = synthesize(gableShape(14, 9, 7), { pixelM: 0.1, turnDeg: 0, trees: 0, noiseM: 0.02, seed: 3 });
    const raster = withCrown(roof, { x: 7 + 0.5, y: 0 }, 2.4);
    const on = run(raster, roof, true);
    expect(on.hiddenEdge?.pieces).toBe(0);
    expect(on.hiddenEdge?.declined['not-eave'] ?? 0).toBeGreaterThan(0);
    expect(on.outline).toEqual(run(raster, roof, false).outline);
  });

  it('nothing hidden: the outline is exactly the one without the step (L-shaped house, no crowns)', () => {
    for (const px of [0.1, 0.25]) {
      const roof = synthesize(L_CROSS, { pixelM: px, trees: 0, noiseM: 0.02, seed: 9 });
      const off = reconstructRoof(roof.raster, roof.point, {})!;
      const on = reconstructRoof(roof.raster, roof.point, { hiddenEdge: { method: 'planes' } })!;
      expect(on.hiddenEdge?.pieces).toBe(0);
      expect(on.inferred).toEqual({ methods: ['planes'], edges: [], addedM2: 0, removedM2: 0 });
      expect(JSON.stringify({ ...on, hiddenEdge: undefined, inferred: undefined })).toBe(JSON.stringify(off));
    }
  });

  it('is deterministic: the same input gives byte-identical output', () => {
    const roof = synthesize(hipShape(L, W, 6), { pixelM: 0.1, turnDeg: 23, trees: 0, noiseM: 0.02, seed: 5 });
    const raster = withCrown(roof, crowns[2]!.at, 2.6);
    expect(JSON.stringify(run(raster, roof, HYPOTHESIS))).toBe(JSON.stringify(run(raster, roof, HYPOTHESIS)));
    expect(JSON.stringify(run(raster, roof, true))).toBe(JSON.stringify(run(raster, roof, true)));
  });

  it('metamorphic: turning the house or coarsening the pixel leaves the recovered area about the same', () => {
    const areas: number[] = [];
    for (const [px, turnDeg] of [
      [0.1, 0],
      [0.1, 37],
      [0.25, 0],
      [0.25, 37],
    ] as const) {
      const roof = synthesize(hipShape(L, W, 6), { pixelM: px, turnDeg, trees: 0, noiseM: 0.02, seed: 5 });
      areas.push(area(run(withCrown(roof, crowns[0]!.at, 2.6), roof, HYPOTHESIS).outline));
    }
    for (const a of areas) expect(Math.abs(a - areas[0]!) / areas[0]!).toBeLessThan(0.03);
  });

  it('visible yard in the swept strip stops the move (a real notch is not filled)', () => {
    // A roof whose mask really ends: the crown stands in the yard beside a notch, and the yard between shows ground.
    const roof = synthesize(hipShape(L, W, 6), { pixelM: 0.1, turnDeg: 0, trees: 0, noiseM: 0.02, seed: 5 });
    const raster = withCrown(roof, { x: 1, y: -W / 2 - 3.2 }, 1.6);
    const on = run(raster, roof, true);
    expect(on.outline).toEqual(run(raster, roof, false).outline);
  });
});

describe('inferHiddenEaves: typed refusals and guards', () => {
  const g = { w: 40, h: 40 };
  const s = 0.25;
  const flat = new Float32Array(g.w * g.h).fill(3);
  const labels = new Int32Array(g.w * g.h).fill(0);
  const square = [
    { x: 1, y: -9 },
    { x: 9, y: -9 },
    { x: 9, y: -1 },
    { x: 1, y: -1 },
  ];
  it('refuses bad input with a reason instead of throwing', () => {
    expect(inferHiddenEaves({ g, s, dsm: new Float32Array(3), labels, planes: [], other: null, crown: null, outline: square })).toEqual({ ok: false, reason: 'bad-input' });
    expect(inferHiddenEaves({ g, s: Number.NaN, dsm: flat, labels, planes: [], other: null, crown: null, outline: square })).toEqual({ ok: false, reason: 'bad-input' });
    expect(inferHiddenEaves({ g, s, dsm: flat, labels, planes: [{ a: Number.NaN, b: 0, c: 0 }], other: null, crown: null, outline: square })).toEqual({ ok: false, reason: 'bad-input' });
    expect(inferHiddenEaves({ g, s, dsm: flat, labels, planes: [{ a: 0, b: 0, c: 3 }], other: null, crown: null, outline: square.slice(0, 2) })).toEqual({ ok: false, reason: 'bad-input' });
  });
  it('a flat roof level with its surroundings: every edge hidden, every piece declined as low-pitch, outline unchanged', () => {
    const res = inferHiddenEaves({ g, s, dsm: flat, labels, planes: [{ a: 0, b: 0, c: 3 }], other: null, crown: null, outline: square });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changes).toEqual([]);
    expect(res.declined['low-pitch']).toBeGreaterThan(0);
    expect(res.outline).toEqual(square);
  });
  it('defaults are the documented constants', () => {
    expect(DEFAULT_OUTLINE_PLANES.minPitchX12).toBe(3);
    expect(DEFAULT_OUTLINE_PLANES.maxOffsetM).toBe(3);
    expect(DEFAULT_OUTLINE_PLANES.minOffsetM).toBe(-1);
  });
});

describe('hidden-edge combinations (photo+planes, planes+photo)', () => {
  it('with no photo the photo step declines and each combination is exactly planes alone, at 0.1 and 0.25 m', () => {
    for (const px of [0.1, 0.25]) {
      // The hip of the tests above (16 x 10 m at 6/12) with a crown over the middle of a long eave.
      const roof = synthesize(hipShape(16, 10, 6), { pixelM: px, trees: 0, noiseM: 0.02, seed: 5 });
      const raster = withCrown(roof, { x: 1, y: -5.5 }, 2.6);
      const planes = reconstructRoof(raster, roof.point, { hiddenEdge: { method: 'planes', planes: HYPOTHESIS } })!;
      for (const method of ['photo+planes', 'planes+photo'] as const) {
        const both = reconstructRoof(raster, roof.point, { hiddenEdge: { method, planes: HYPOTHESIS } })!;
        expect(both.hiddenEdges?.declined).toBe('no-photo');
        expect(planes.hiddenEdge?.pieces ?? 0).toBeGreaterThan(0);
        expect(both.outline).toEqual(planes.outline);
        expect(both.hiddenEdge).toEqual(planes.hiddenEdge);
      }
    }
  });
});
