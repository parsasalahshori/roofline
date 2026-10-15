import { describe, expect, it } from 'vitest';
import { crownFromGreen, EAVE_SUPPORT, eaveSupport, type EaveRaster, type EaveXY, supportOf } from '../src/roof-reconstruct/eave-support.ts';

// Synthetic eaves on a 0.1 m grid, 300 x 300 (30 m): ground at 0, a flat-topped box roof 10 m x 8 m at EAVE_Z.
const S = 0.1;
const W = 300;
const H = 300;
const EAVE_Z = 5;
// The roof's box in local metres (x east, y north from the top edge, so y <= 0).
const X0 = 10;
const X1 = 20;
const Y0 = -19; // south edge
const Y1 = -11; // north edge
const RECT: EaveXY[] = [
  { x: X0, y: Y0 },
  { x: X1, y: Y0 },
  { x: X1, y: Y1 },
  { x: X0, y: Y1 },
];

function raster(fill: (x: number, y: number) => number): EaveRaster {
  const dsm = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) dsm[r * W + c] = fill((c + 0.5) * S, -(r + 0.5) * S);
  return { width: W, height: H, pixelSizeM: S, dsm };
}
const inRoof = (x: number, y: number) => x >= X0 && x < X1 && y >= Y0 && y < Y1;
const clean = raster((x, y) => (inRoof(x, y) ? EAVE_Z : 0));

/** The edge of RECT along x = X1 (east side) is edge 1. */
const EAST = 1;

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  expect(r.ok).toBe(true);
  return r as Extract<T, { ok: true }>;
}

describe('eave support', () => {
  it('classifies a drop', () => {
    expect(supportOf(2)).toBe('strong');
    expect(supportOf(1)).toBe('strong');
    expect(supportOf(0.7)).toBe('weak');
    expect(supportOf(0.49)).toBe('none');
    expect(supportOf(-3)).toBe('none');
    expect(supportOf(null)).toBe('none');
  });

  it('a clean eave is strongly supported all round', () => {
    const r = ok(eaveSupport(RECT, clean));
    expect(r.strongShare).toBeCloseTo(1, 6);
    expect(r.unverifiedShare).toBe(0);
    expect(r.lengthM).toBeCloseTo(36, 6);
    // Samples every 0.2 m: 10 m edges hold 50, 8 m edges 40.
    expect(r.samples.length).toBe(180);
    expect(r.edges.map((e) => e.support)).toEqual(['strong', 'strong', 'strong', 'strong']);
    for (const e of r.edges) expect(e.medianDropM).toBeCloseTo(EAVE_Z, 3);
    expect(r.canopyExposure).toBe(0);
  });

  it('winding does not matter', () => {
    const a = ok(eaveSupport(RECT, clean));
    const b = ok(eaveSupport([...RECT].reverse(), clean));
    expect(b.strongShare).toBeCloseTo(a.strongShare, 9);
    expect(b.unverifiedShare).toBeCloseTo(a.unverifiedShare, 9);
  });

  it('a crown beside the east eave, as high as the roof, leaves that edge unverified for the crown', () => {
    // A 4 m wide crown, 6 m high, hugging the east edge (from 0.0 to 4 m outside it) along its whole length.
    const crownAt = (x: number, y: number) => x >= X1 && x < X1 + 4 && y >= Y0 - 1 && y < Y1 + 1;
    const r0 = raster((x, y) => (inRoof(x, y) ? EAVE_Z : crownAt(x, y) ? 6 : 0));
    const crown = new Uint8Array(W * H);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (crownAt((c + 0.5) * S, -(r + 0.5) * S)) crown[r * W + c] = 1;
    const res = ok(eaveSupport(RECT, r0, crown));
    const east = res.edges[EAST]!;
    expect(east.support).toBe('none');
    expect(east.reason).toBe('crown');
    expect(east.canopyShare).toBeGreaterThan(0.9);
    for (const k of [0, 2, 3]) expect(res.edges[k]!.support).toBe('strong');
    expect(res.unverifiedShare).toBeCloseTo(8 / 36, 2);
    expect(res.unverifiedByReasonM.crown).toBeCloseTo(8, 0);
    // Without a crown map the same edge is still unverified; the reason is the heights' own.
    const blind = ok(eaveSupport(RECT, r0));
    expect(blind.edges[EAST]!.support).toBe('none');
    expect(blind.edges[EAST]!.reason).toBe('taller-neighbour');
    expect(blind.canopyExposure).toBe(0);
  });

  it("a taller neighbour's wall against the east eave is unverified: taller neighbour", () => {
    const r0 = raster((x, y) => (inRoof(x, y) ? EAVE_Z : x >= X1 && x < X1 + 6 ? 8 : 0));
    const res = ok(eaveSupport(RECT, r0));
    expect(res.edges[EAST]!.support).toBe('none');
    expect(res.edges[EAST]!.reason).toBe('taller-neighbour');
    expect(res.edges[EAST]!.medianDropM).toBeCloseTo(-3, 3);
  });

  it('a deck at eave height is unverified: level', () => {
    const r0 = raster((x, y) => (inRoof(x, y) ? EAVE_Z : x >= X1 && x < X1 + 3 && y >= Y0 && y < Y1 ? EAVE_Z - 0.2 : 0));
    const res = ok(eaveSupport(RECT, r0));
    expect(res.edges[EAST]!.support).toBe('none');
    expect(res.edges[EAST]!.reason).toBe('level');
  });

  it('a low step (0.7 m) is weak support', () => {
    const r0 = raster((x, y) => (inRoof(x, y) ? EAVE_Z : x >= X1 && x < X1 + 3 && y >= Y0 && y < Y1 ? EAVE_Z - 0.7 : 0));
    const res = ok(eaveSupport(RECT, r0));
    expect(res.edges[EAST]!.support).toBe('weak');
    expect(res.weakShare).toBeCloseTo(8 / 36, 2);
  });

  it('no height data outside is a data gap', () => {
    const r0 = raster((x, y) => (inRoof(x, y) ? EAVE_Z : x >= X1 ? Number.NaN : 0));
    const res = ok(eaveSupport(RECT, r0));
    expect(res.edges[EAST]!.reason).toBe('data-gap');
    expect(res.edges[EAST]!.medianDropM).toBeNull();
    expect(res.edges[EAST]!.support).toBe('none');
  });

  it('an outline off the raster is a data gap, not a throw', () => {
    const res = ok(eaveSupport(RECT.map((p) => ({ x: p.x + 100, y: p.y })), clean));
    expect(res.unverifiedShare).toBeCloseTo(1, 6);
    expect(res.unverifiedByReasonM['data-gap']).toBeCloseTo(36, 6);
  });

  it('returns a typed failure on bad input', () => {
    expect(eaveSupport([], clean)).toEqual({ ok: false, reason: 'bad-outline' });
    expect(eaveSupport(RECT.slice(0, 2), clean)).toEqual({ ok: false, reason: 'bad-outline' });
    expect(eaveSupport([RECT[0]!, RECT[1]!, { x: 30, y: Y0 }], clean)).toEqual({ ok: false, reason: 'bad-outline' });
    expect(eaveSupport([...RECT.slice(0, 3), { x: Number.NaN, y: 0 }], clean)).toEqual({ ok: false, reason: 'bad-outline' });
    expect(eaveSupport(RECT, { ...clean, width: 10 })).toEqual({ ok: false, reason: 'bad-raster' });
    expect(eaveSupport(RECT, clean, new Uint8Array(3))).toEqual({ ok: false, reason: 'bad-crown' });
  });

  it('a closed ring (last = first) is read as open', () => {
    const a = ok(eaveSupport(RECT, clean));
    const b = ok(eaveSupport([...RECT, RECT[0]!], clean));
    expect(b.samples.length).toBe(a.samples.length);
  });

  it('grows the step on huge outlines (size limit)', () => {
    const res = ok(eaveSupport(RECT, clean, null, { maxSamples: 36 }));
    expect(res.stepM).toBeCloseTo(1, 6);
    expect(res.samples.length).toBeLessThanOrEqual(40);
  });

  // Property: on random rectangles over random terrain the shares add to one, edges cover every sample, it is
  // deterministic, and lifting the whole height map does not change a thing.
  it('invariants on random roofs (seeded)', () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let trial = 0; trial < 25; trial++) {
      const x0 = 3 + rand() * 10;
      const y0 = -(3 + rand() * 10);
      const ring: EaveXY[] = [
        { x: x0, y: y0 - 4 - rand() * 8 },
        { x: x0 + 4 + rand() * 8, y: y0 - 4 - rand() * 8 },
        { x: x0 + 4 + rand() * 8, y: y0 },
        { x: x0 + rand() * 2, y: y0 + rand() },
      ];
      const z = new Float32Array(W * H);
      for (let i = 0; i < z.length; i++) z[i] = rand() * 6;
      const r0: EaveRaster = { width: W, height: H, pixelSizeM: S, dsm: z };
      const a = ok(eaveSupport(ring, r0));
      expect(a.strongShare + a.weakShare + a.unverifiedShare).toBeCloseTo(1, 9);
      expect(a.edges.reduce((t, e) => t + e.samples, 0)).toBe(a.samples.length);
      const b = ok(eaveSupport(ring, r0));
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      const lifted = ok(eaveSupport(ring, { ...r0, dsm: z.map((v) => v + 100) }));
      expect(lifted.samples.map((q) => q.support)).toEqual(a.samples.map((q) => q.support));
    }
  });
});

describe('crownFromGreen', () => {
  it('marks green rough pixels and their surroundings, not a green smooth roof', () => {
    const z = new Float32Array(W * H);
    const green = new Uint8Array(W * H);
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const i = r * W + c;
        // Rough green foliage on the left third, a smooth green roof on the right third.
        if (c < 100) {
          green[i] = 1;
          z[i] = 5 + ((r * 7 + c * 13) % 5) * 0.1;
        } else if (c >= 200) {
          green[i] = 1;
          z[i] = 4;
        }
      }
    }
    const crown = crownFromGreen({ width: W, height: H, pixelSizeM: S, dsm: z }, green)!;
    expect(crown[150 * W + 50]).toBe(1);
    expect(crown[150 * W + 250]).toBe(0);
    expect(crownFromGreen({ width: W, height: H, pixelSizeM: S, dsm: z }, null)).toBeNull();
  });

  it('constants are the documented reference', () => {
    expect(EAVE_SUPPORT.strongM).toBe(1);
    expect(EAVE_SUPPORT.weakM).toBe(0.5);
  });
});
