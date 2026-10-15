// A measurement must not change because a random seed did: the plane search is deterministic in outcome.
//
// These are DETERMINISM properties, not robustness: the lattice search never reads the random stream, so "the same
// roof for seeds 7, 8, 9" holds by construction and says nothing about how stable a roof is. That signal now comes from
// roof-reconstruct-perturb.test.ts (mask jitter, height noise, turns, MEDIUM-like resampling) and the golden roofs at
// 0.1, 0.25 and 0.3 m in roof-reconstruct-resolution.test.ts, which caught a plane lost to tied candidates that these
// tests could not see.
import { describe, expect, it } from 'vitest';
import { reconstructRoof } from '../src/roof-reconstruct/index.ts';
import { DEFAULT_PLANE_PARAMS, findPlanes, latticeSeeds } from '../src/roof-reconstruct/planes.ts';
import { seededRandom } from '../src/roof-reconstruct/raster.ts';
import { GABLE, HIP, L_CROSS, PORCH, SHAPES, synthesize } from './fixtures/synthetic-roofs.ts';

describe('plane search: the same roof whatever the seed', () => {
  for (const shape of [...SHAPES, PORCH]) {
    it(`${shape.name}: seeds 7, 8, 9 and 12345 give byte-identical roofs`, () => {
      const syn = synthesize(shape, { turnDeg: 23, seed: 11 });
      const out = [7, 8, 9, 12345].map((seed) => JSON.stringify(reconstructRoof(syn.raster, syn.point, { seed })));
      expect(out[0]).not.toBe('null');
      for (const o of out.slice(1)) expect(o).toBe(out[0]);
    });
  }

  it('findPlanes ignores the random stream entirely (property: any rng gives the same planes)', () => {
    const syn = synthesize(L_CROSS, { turnDeg: 31, seed: 4, trees: 2 });
    const { width: w, height: h, pixelSizeM: s, dsm, mask } = syn.raster;
    const roof = Uint8Array.from(mask, (v) => (v !== 0 ? 1 : 0));
    const ref = JSON.stringify(findPlanes({ w, h }, s, dsm, roof, seededRandom(1), DEFAULT_PLANE_PARAMS).map((f) => f.plane));
    for (const rng of [seededRandom(2), seededRandom(99), () => 0, () => 0.999999]) {
      expect(JSON.stringify(findPlanes({ w, h }, s, dsm, roof, rng, DEFAULT_PLANE_PARAMS).map((f) => f.plane))).toBe(ref);
    }
  });

  it('the random search (lattice off) is still available, and is what varies with the seed', () => {
    const syn = synthesize(HIP, { turnDeg: 17, seed: 11 });
    const a = JSON.stringify(reconstructRoof(syn.raster, syn.point, { seed: 7, planes: { lattice: false } }));
    const b = JSON.stringify(reconstructRoof(syn.raster, syn.point, { seed: 8, planes: { lattice: false } }));
    expect(a).not.toBe(b);
  });

  it('latticeSeeds: about the number asked for, evenly spread, a subset of the free pixels', () => {
    const g = { w: 200, h: 150 };
    const list = Int32Array.from({ length: g.w * g.h }, (_, i) => i).filter((i) => (i % g.w) > 20 && (i % g.w) < 180);
    for (const want of [1, 50, 320, 5000]) {
      const seeds = latticeSeeds(g, list, want);
      const set = new Set(list);
      expect(seeds.length).toBeGreaterThanOrEqual(Math.min(want, list.length) * 0.9);
      expect(seeds.length).toBeLessThanOrEqual(Math.max(4 * want, 1));
      for (const i of seeds) expect(set.has(i)).toBe(true);
    }
    expect(latticeSeeds(g, new Int32Array(0), 320).length).toBe(0);
  });

  it('a gable at another turn is still read exactly', () => {
    const syn = synthesize(GABLE, { turnDeg: 41, seed: 3, trees: 0 });
    const r = reconstructRoof(syn.raster, syn.point, { seed: 9 });
    expect(r?.faces.length).toBe(2);
  });
});
