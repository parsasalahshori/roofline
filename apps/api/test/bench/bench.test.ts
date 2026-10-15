import { describe, expect, test } from 'vitest';
import type { LngLat, SolarBuilding } from '@roofline/shared';
import { BenchDataError, runBench } from '../../src/bench/roof3d/bench.ts';
import type { LoadedHouse } from '../../src/bench/roof3d/data.ts';
import { type HouseEntry, type Manifest, splitOf } from '../../src/bench/roof3d/manifest.ts';
import { formatHouses, formatSplit } from '../../src/bench/roof3d/report.ts';
import { DEFAULT_THRESHOLDS } from '../../src/bench/roof3d/tags.ts';
import type { EagleViewTruth } from '../../src/bench/roof3d/truth.ts';
import { hipLayers } from '../roof-3d-fixture.ts';
import { house, toLngLat } from './helpers.ts';

/*
 * The harness end to end on a tiny synthetic house: a hip roof with an exact answer key (16 x 10 m at 5/12). The
 * layers are the ones the estimator's own tests use; the houses all share them, so only the harness is under test.
 */

const ORIGIN: LngLat = [-92.311, 34.7532];
const HX = 8;
const HY = 5;
const PITCH = 5;
const at = (x: number, y: number): LngLat => toLngLat(ORIGIN, x, y);
const ring = [at(-HX, -HY), at(HX, -HY), at(HX, HY), at(-HX, HY)];
const point = at(0, 0);
const slope = Math.sqrt(1 + (PITCH / 12) ** 2);
const SQFT = 10.7639104167;

const face = (label: string, pts: [number, number][], planM2: number) => ({ label, pitch_x12: PITCH, sloped_sqft: planM2 * SQFT * slope, ring: [...pts.map(([x, y]) => at(x, y)), at(pts[0]![0], pts[0]![1])] });
const truth: EagleViewTruth = {
  report: 'syn',
  address: 'synthetic hip',
  faces: [
    face('N', [[-HX, HY], [HX, HY], [HX - HY, 0], [-HX + HY, 0]], (2 * HX - HY) * HY),
    face('S', [[-HX, -HY], [-HX + HY, 0], [HX - HY, 0], [HX, -HY]], (2 * HX - HY) * HY),
    face('E', [[HX, -HY], [HX - HY, 0], [HX, HY]], HY * HY),
    face('W', [[-HX, -HY], [-HX, HY], [-HX + HY, 0]], HY * HY),
  ],
  outline: { type: 'Polygon', coordinates: [[...ring, ring[0]!]] },
  total_sloped_sqft: 4 * 0 + (2 * (2 * HX - HY) * HY + 2 * HY * HY) * SQFT * slope,
  lines_ft: { ridge: 6 * 3.28084, hip: 4 * Math.sqrt(50 + (HY * (PITCH / 12)) ** 2) * 3.28084, valley: 0, rake: 0, eave: 52 * 3.28084 },
  structures: 1,
};

const building: SolarBuilding = { center: point, box: { sw: at(-HX, -HY), ne: at(HX, HY) }, imageryQuality: 'HIGH', imageryDate: '2024-05-01', segments: [] };

/** Houses named so that some are held out: names are searched until there are enough of each split. */
function names(dev: number, held: number): string[] {
  const out: string[] = [];
  let d = 0;
  let h = 0;
  for (let k = 0; d < dev || h < held; k++) {
    const slug = `syn-${k}`;
    if (splitOf(slug) === 'dev' && d < dev) {
      out.push(slug);
      d++;
    } else if (splitOf(slug) === 'heldout' && h < held) {
      out.push(slug);
      h++;
    }
  }
  return out;
}

const layers = hipLayers(ring, { pitchX12: PITCH });
function entries(slugs: string[], heavy: Set<string> = new Set()): HouseEntry[] {
  return slugs.map((slug) =>
    house(slug, {
      point,
      truth: 'eagleview',
      tags: { ...house(slug).tags, canopy: { roofShare: 0, rimShare: heavy.has(slug) ? 0.5 : 0, biteShare: 0, class: heavy.has(slug) ? 'heavy' : 'none' } },
    }),
  );
}
const manifest = (houses: HouseEntry[]): Manifest => ({ version: 1, generatedAt: 'now', splitRule: 'r', thresholds: DEFAULT_THRESHOLDS, houses });
const loader = async (entry: HouseEntry): Promise<LoadedHouse> => ({
  entry,
  dir: '(memory)',
  layers,
  building,
  google: { groundM2: 2 * HX * 2 * HY, slopedM2: 2 * HX * 2 * HY * slope, segments: 4, box: building.box },
  eagleview: truth,
  visual: null,
  osm: null,
});

const slugs = names(3, 6);
const heavy = new Set(slugs.filter((s) => splitOf(s) === 'heldout').slice(0, 2));
const base = { today: '2026-10-20', commit: { sha: 'abc', dirty: false }, loader, seeds: [7, 8] } as const;

describe('the harness on a synthetic hip roof', () => {
  test('scores the reconstruction against its exact key', async () => {
    const report = await runBench({ ...base, manifest: manifest(entries(slugs, heavy)), split: 'dev' });
    const dev = report.splits.dev!;
    const all = dev.cohorts.all!;
    expect(dev.houses).toBe(3);
    expect(all.stats.comparable!.mean).toBe(3);
    // The reconstruction of an exact hip is close to its key.
    expect(all.stats.truth.medianIoU!.mean).toBeGreaterThan(0.93);
    expect(all.stats.truth.medianBoundaryM!.mean).toBeLessThan(0.5);
    expect(all.stats.truth.medianAreaErrAbsPct!.mean).toBeLessThan(8);
    expect(all.stats.truth.mainPitchWithin1!.mean).toBe(3);
    expect(all.stats.slivers!.mean).toBe(0);
    expect(all.stats.steepJunk!.mean).toBe(0);
    expect(all.stats.failures!.mean).toBe(0);
    expect(all.nondeterministic).toBe(0);
    expect(all.runtime.p95Ms).toBeGreaterThan(0);
    expect(report.seeds).toEqual([7, 8]);
    expect(report.splits.heldout).toBeUndefined();
  }, 60_000);

  test('the held-out split is sealed: aggregates only, small cohorts withheld, no house named', async () => {
    const report = await runBench({ ...base, manifest: manifest(entries(slugs, heavy)), split: 'heldout' });
    const held = report.splits.heldout!;
    expect(held.houses).toBe(6);
    expect(held.perHouse).toBeUndefined();
    expect(Object.keys(held.cohorts)).toContain('all');
    // Two houses are canopy-heavy: a cohort of two is two houses' numbers in disguise.
    expect(Object.keys(held.cohorts)).not.toContain('canopy-heavy');
    expect(held.suppressed).toContain('canopy-heavy');
    const text = formatSplit('heldout', held);
    for (const s of slugs) expect(text).not.toContain(s);
    expect(JSON.stringify(report)).not.toContain('syn-');
  }, 60_000);

  test('--reveal shows held-out houses one by one', async () => {
    const report = await runBench({ ...base, manifest: manifest(entries(slugs, heavy)), split: 'heldout', reveal: true });
    const held = report.splits.heldout!;
    expect(held.perHouse!.length).toBe(6);
    expect(Object.keys(held.cohorts)).toContain('canopy-heavy');
    expect(formatHouses(held.perHouse!)).toContain('syn-');
  }, 60_000);

  test('one cohort only', async () => {
    const report = await runBench({ ...base, manifest: manifest(entries(slugs, heavy)), split: 'all', cohort: 'canopy-heavy', reveal: true });
    expect(report.cohortFilter).toBe('canopy-heavy');
    expect(Object.keys(report.splits.heldout!.cohorts)).toEqual(['canopy-heavy']);
    expect(report.splits.dev).toBeUndefined();
    await expect(runBench({ ...base, manifest: manifest(entries(slugs)), split: 'dev', cohort: 'no-such-cohort' })).rejects.toBeInstanceOf(BenchDataError);
  }, 60_000);

  test('--house runs just those houses; a held-out house is refused without --reveal', async () => {
    const m = manifest(entries(slugs, heavy));
    const dev = slugs.find((s) => splitOf(s) === 'dev')!;
    const held = slugs.find((s) => splitOf(s) === 'heldout')!;
    const one = await runBench({ ...base, manifest: m, split: 'dev', houses: [dev] });
    expect(one.splits.dev!.houses).toBe(1);
    expect(one.splits.dev!.perHouse!.map((r) => r.slug)).toEqual([dev]);
    await expect(runBench({ ...base, manifest: m, split: 'dev', houses: [held] })).rejects.toThrow(/held out/);
    await expect(runBench({ ...base, manifest: m, split: 'dev', houses: ['nope'] })).rejects.toThrow(/no such house/);
    const shown = await runBench({ ...base, manifest: m, split: 'all', houses: [held], reveal: true });
    expect(shown.splits.heldout!.perHouse!.map((r) => r.slug)).toEqual([held]);
  }, 60_000);

  test('refuses Google data past its 30 days, and runs when told to', async () => {
    const stale = entries(slugs.slice(0, 1)).map((h) => ({ ...h, data: { ...h.data, deleteBy: '2026-10-01' } }));
    const m = manifest(stale);
    await expect(runBench({ ...base, manifest: m, split: 'all' })).rejects.toThrow(/past its 30-day date/);
    const report = await runBench({ ...base, manifest: m, split: 'all', allowExpired: true });
    expect(report.expired).toEqual(stale.map((h) => h.slug));
  }, 60_000);

  test('a house whose data cannot be read stops the run with a data error, not a silent skip', async () => {
    const m = manifest(entries(slugs.slice(0, 1)));
    await expect(runBench({ ...base, manifest: m, split: 'all', loader: () => Promise.reject(new Error('missing dsm.tif')) })).rejects.toThrow(/cannot read/);
  });

  test('a house with no roof under the point is counted as no-roof, not skipped', async () => {
    const m = manifest(entries(slugs.slice(0, 1)));
    const bare = async (entry: HouseEntry): Promise<LoadedHouse> => {
      const h = await loader(entry);
      return { ...h, layers: { ...h.layers, raster: { ...h.layers.raster, mask: new Uint8Array(h.layers.raster.mask.length) } } };
    };
    const report = await runBench({ ...base, manifest: m, split: 'all', loader: bare, reveal: true });
    const all = [...(report.splits.dev ? [report.splits.dev] : []), ...(report.splits.heldout ? [report.splits.heldout] : [])][0]!.cohorts.all!;
    expect(all.stats.noRoof!.mean).toBe(1);
    expect(all.stats.failures!.mean).toBe(0);
  }, 60_000);

  test('a reconstruction that throws is counted as a failure and the run goes on', async () => {
    const m = manifest(entries(slugs.slice(0, 2)));
    let n = 0;
    const flaky = async (entry: HouseEntry): Promise<LoadedHouse> => {
      const h = await loader(entry);
      // The second house has a corrupt height map (the wrong length): the reconstruction refuses it.
      return n++ === 1 ? { ...h, layers: { ...h.layers, raster: { ...h.layers.raster, dsm: new Float32Array(3) } } } : h;
    };
    const report = await runBench({ ...base, manifest: m, split: 'all', loader: flaky, reveal: true });
    const rows = [...(report.splits.dev?.perHouse ?? []), ...(report.splits.heldout?.perHouse ?? [])];
    expect(rows.filter((r) => r.metrics.status !== 'ok').length).toBe(1);
    expect(rows.filter((r) => r.metrics.status === 'ok').length).toBe(1);
  }, 60_000);
});
