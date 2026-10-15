import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import type { LngLat, Roof3d, Roof3dFace } from '@roofline/shared';
import { utmToLngLat } from '@roofline/shared/roof-reconstruct';
import { countyAgg } from '../../src/bench/roof3d/aggregate.ts';
import { type CountyTruth, CountyTruthSchema, countyIndexHash, countyMetrics, readCountyIndex, readCountyTruth } from '../../src/bench/roof3d/county.ts';
import { cohortsOf, withCounty, type Manifest } from '../../src/bench/roof3d/manifest.ts';
import { emptyMetrics, type HouseMetrics } from '../../src/bench/roof3d/metrics.ts';
import { house } from './helpers.ts';

/*
 * The county truth grade (county.ts): a footprint in its publisher's frame, scored raw and after EagleView's best
 * translation. Synthetic houses in UTM so the expected numbers are exact.
 */

const ZONE = { zone: 15, south: false };
const E0 = 563_000;
const N0 = 3_845_800;
const ll = (e: number, n: number): LngLat => utmToLngLat(ZONE, E0 + e, N0 + n) as LngLat;
const rect = (x0: number, y0: number, x1: number, y1: number): LngLat[] => [ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1)];
const closed = (r: LngLat[]): [number, number][] => [...r, r[0]!].map((p) => [p[0], p[1]]);

function roof(x1: number): Roof3d {
  const sqft = 10.7639104167;
  const plan = (x1 - 9) * 8 * sqft;
  const f: Roof3dFace = { ring: rect(9, 11, x1, 19), pitchX12: 6, azimuthDeg: 180, planAreaSqFt: plan, slopedAreaSqFt: plan * Math.sqrt(1.25), flat: false, labelAt: ll((9 + x1) / 2, 15) };
  return { version: 1, outline: rect(9, 11, x1, 19), faces: [f], lines: [], pixelSizeM: 0.1, imageryQuality: 'HIGH', imageryDate: null };
}

function truth(dx = 0, x1 = 21, lidarDerived = false): CountyTruth {
  return CountyTruthSchema.parse({
    slug: 'tr-test',
    ok: true,
    version: 1,
    grade: 'county',
    source: { name: 'pagis', method: 'photogrammetric', lidarDerived, credit: 'test', featureIds: ['pagis/1'], dates: ['20040401'] },
    outline: [{ outer: closed(rect(9 + dx, 11, x1 + dx, 19)), holes: [] }],
    planAreaM2: (x1 - 9) * 8,
  });
}

describe('county truth metrics', () => {
  test('the same outline scores 1 raw and aligned; plan error 0', () => {
    const m = countyMetrics(roof(21), truth());
    expect(m.iou).toBeCloseTo(1, 3);
    expect(m.aligned.iou).toBeCloseTo(1, 3);
    expect(m.planErrPct).toBeCloseTo(0, 1);
    expect(m.comparable).toBe(true);
  });

  test('a 1 m frame offset costs raw IoU but not aligned IoU (EagleView rule)', () => {
    const m = countyMetrics(roof(21), truth(1));
    expect(m.iou).toBeLessThan(0.9);
    expect(m.aligned.iou).toBeGreaterThan(0.98);
    expect(Math.abs(m.aligned.shiftM[0] + 1)).toBeLessThan(0.15);
  });

  test('a reconstruction that misses a 4 m wing is 25% small in plan', () => {
    const m = countyMetrics(roof(18), truth(0, 21));
    expect(m.planErrPct).toBeCloseTo(-25, 0);
    expect(m.lidarDerived).toBe(false);
    expect(countyMetrics(roof(18), truth(0, 21, true)).lidarDerived).toBe(true);
  });

  test('deterministic', () => {
    expect(JSON.stringify(countyMetrics(roof(20), truth(0.4)))).toBe(JSON.stringify(countyMetrics(roof(20), truth(0.4))));
  });

  test('another building (IoU under 0.5) is not comparable and stays out of the medians', () => {
    const far = CountyTruthSchema.parse({ ...truth(), outline: [{ outer: closed(rect(40, 40, 50, 50)), holes: [] }] });
    const m = countyMetrics(roof(21), far);
    expect(m.comparable).toBe(false);
    const a = countyAgg([{ ...emptyMetrics('ok'), county: m } as HouseMetrics, { ...emptyMetrics('ok'), county: countyMetrics(roof(21), truth()) } as HouseMetrics]);
    expect(a.houses).toBe(2);
    expect(a.comparable).toBe(1);
    expect(a.medianAlignedIoU).toBeCloseTo(1, 3);
  });
});

describe('county index and files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'county-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('no index: no county truth', () => {
    expect(readCountyIndex(dir)).toBeNull();
    expect(countyIndexHash(null)).toBeNull();
  });

  test('reads the index and truth; a truth naming another house is refused', () => {
    const c = path.join(dir, 'free', 'county');
    mkdirSync(path.join(c, 'tr-test'), { recursive: true });
    writeFileSync(path.join(c, 'index.json'), JSON.stringify({ version: 1, credit: 't', rules: {}, houses: { 'tr-test': { grade: 'county', reasons: [], source: 'pagis', lidarDerived: false } } }));
    writeFileSync(path.join(c, 'tr-test', 'truth.json'), JSON.stringify(truth()));
    const idx = readCountyIndex(dir)!;
    expect(idx.houses['tr-test']!.grade).toBe('county');
    expect(readCountyTruth(dir, 'tr-test')!.truth.planAreaM2).toBe(96);
    expect(countyIndexHash(idx)).toMatch(/^[0-9a-f]{12}$/);
    mkdirSync(path.join(c, 'tr-other'), { recursive: true });
    writeFileSync(path.join(c, 'tr-other', 'truth.json'), JSON.stringify(truth()));
    expect(() => readCountyTruth(dir, 'tr-other')).toThrow(/names tr-test/);
  });

  test('an ML footprint is not a county grade: the schema refuses an unknown grade', () => {
    expect(() => CountyTruthSchema.parse({ ...truth(), grade: 'ms' })).toThrow();
  });

  test('withCounty merges grades and adds the truth-county cohort', () => {
    const m = { version: 1, generatedAt: '', splitRule: '', thresholds: {}, houses: [house('tr-test'), house('tr-none')] } as unknown as Manifest;
    const merged = withCounty(m, { houses: { 'tr-test': { grade: 'county', lidarDerived: false } } });
    expect(merged.houses[0]!.county).toEqual({ grade: 'county', lidarDerived: false });
    expect(merged.houses[1]!.county).toEqual({ grade: 'none', lidarDerived: false });
    expect(cohortsOf(merged.houses[0]!)).toContain('truth-county');
    expect(cohortsOf(merged.houses[1]!)).not.toContain('truth-county');
  });
});
