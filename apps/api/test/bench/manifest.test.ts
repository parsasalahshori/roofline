import { describe, expect, test } from 'vitest';
import {
  HELDOUT_BELOW,
  type Manifest,
  cohortsOf,
  expiredHouses,
  manifestHash,
  manifestProblems,
  parseManifest,
  regionOf,
  splitOf,
} from '../../src/bench/roof3d/manifest.ts';
import { DEFAULT_THRESHOLDS, canopyClass } from '../../src/bench/roof3d/tags.ts';
import { cohortCounts } from '../../src/bench/roof3d/bench.ts';
import { house } from './helpers.ts';

describe('the frozen split', () => {
  test('sha1(slug) mod 10 < 3 is held out (values computed independently with Python hashlib)', () => {
    // int(hashlib.sha1(s.encode()).hexdigest(), 16) % 10: a 2, lr-305-ridgeway 3, ev-47737198 8, omaha-roland 6, house-0 9.
    expect(HELDOUT_BELOW).toBe(3);
    expect(splitOf('a')).toBe('heldout');
    expect(splitOf('lr-305-ridgeway')).toBe('dev');
    expect(splitOf('ev-47737198')).toBe('dev');
    expect(splitOf('omaha-roland')).toBe('dev');
    expect(splitOf('house-0')).toBe('dev');
  });

  test('about 30 percent of names are held out, and a name never moves', () => {
    const names = Array.from({ length: 2000 }, (_, k) => `house-${k}`);
    const share = names.filter((n) => splitOf(n) === 'heldout').length / names.length;
    expect(share).toBeGreaterThan(0.26);
    expect(share).toBeLessThan(0.34);
    expect(names.map(splitOf)).toEqual(names.map(splitOf));
  });

  test('a manifest whose split breaks the rule is refused', () => {
    const ok: Manifest = { version: 1, generatedAt: 'x', splitRule: 'r', thresholds: DEFAULT_THRESHOLDS, houses: [house('a'), house('lr-305-ridgeway')] };
    expect(manifestProblems(ok)).toEqual([]);
    const moved: Manifest = { ...ok, houses: [{ ...house('a'), split: 'dev' }] };
    expect(manifestProblems(moved)[0]).toMatch(/breaks the frozen rule/);
    const dup: Manifest = { ...ok, houses: [house('a'), house('a')] };
    expect(manifestProblems(dup).some((p) => /duplicate/.test(p))).toBe(true);
    const wrongDir: Manifest = { ...ok, houses: [house('a', { dir: 'elsewhere/a' })] };
    expect(manifestProblems(wrongDir).some((p) => /dir/.test(p))).toBe(true);
  });

  test('the schema rejects a malformed manifest', () => {
    expect(() => parseManifest({ version: 2 })).toThrow();
    expect(() => parseManifest({ version: 1, generatedAt: 'x', splitRule: 'r', thresholds: DEFAULT_THRESHOLDS, houses: [{ slug: 'Bad Slug' }] })).toThrow();
  });
});

describe('Google data dates', () => {
  test('a house is expired the day after its delete-by date', () => {
    const m: Manifest = { version: 1, generatedAt: 'x', splitRule: 'r', thresholds: DEFAULT_THRESHOLDS, houses: [house('a'), house('b', { data: { downloadedAt: null, deleteBy: '2026-10-01', imageryQuality: null, imageryDate: null } })] };
    expect(expiredHouses(m, '2026-11-13').map((h) => h.slug)).toEqual(['b']);
    expect(expiredHouses(m, '2026-11-14').map((h) => h.slug)).toEqual(['a', 'b']);
  });
});

describe('cohorts', () => {
  test('a house is in the cohorts its tags name', () => {
    const tagged = house('x', { truth: 'eagleview', tags: { ...house('x').tags, steep: true, lowSlope: true } });
    expect(cohortsOf(tagged)).toEqual(expect.arrayContaining(['all', 'canopy-heavy', 'canopy-any', 'simple', 'steep', 'lowslope', 'truth-eagleview', 'has-truth', 'state-AR', 'set-testset']));
    const bare = house('y', { tags: { ...house('y').tags, canopy: { roofShare: 0, rimShare: 0, biteShare: 0, class: 'none' } } });
    expect(cohortsOf(bare)).toContain('canopy-none');
    expect(cohortsOf(bare)).not.toContain('canopy-any');
    expect(cohortsOf(bare)).not.toContain('has-truth');
  });

  test('counts by split add up', () => {
    const m: Manifest = { version: 1, generatedAt: 'x', splitRule: 'r', thresholds: DEFAULT_THRESHOLDS, houses: ['a', 'b', 'c', 'lr-305-ridgeway', 'house-0'].map((s) => house(s)) };
    const c = cohortCounts(m);
    expect(c.all).toEqual({ dev: 3, heldout: 2, total: 5 });
    expect(c['canopy-heavy']!.total).toBe(5);
  });

  test('canopy classes follow the thresholds, and each limit is inclusive', () => {
    const t = DEFAULT_THRESHOLDS;
    expect(canopyClass(0, 0, 0, t)).toBe('none');
    expect(canopyClass(0, t.lightRim - 1e-9, 0, t)).toBe('none');
    expect(canopyClass(0, t.lightRim, 0, t)).toBe('light');
    expect(canopyClass(0, t.heavyRim, 0, t)).toBe('heavy');
    expect(canopyClass(t.heavyRoof, 0, 0, t)).toBe('heavy');
    expect(canopyClass(0, 0, t.lightBite, t)).toBe('light');
    expect(canopyClass(0, 0, t.heavyBite, t)).toBe('heavy');
  });

  test('the manifest hash changes with a tag and not with the date it was made', () => {
    const a: Manifest = { version: 1, generatedAt: '1', splitRule: 'r', thresholds: DEFAULT_THRESHOLDS, houses: [house('a')] };
    expect(manifestHash(a)).toBe(manifestHash({ ...a, generatedAt: '2' }));
    expect(manifestHash(a)).not.toBe(manifestHash({ ...a, houses: [house('a', { truth: 'eagleview' })] }));
  });

  test('region comes from the address', () => {
    expect(regionOf('305 Ridgeway Dr, Little Rock, AR 72205')).toEqual({ state: 'AR', metro: 'Little Rock' });
    expect(regionOf('(no address)')).toEqual({ state: '??', metro: '??' });
  });
});
