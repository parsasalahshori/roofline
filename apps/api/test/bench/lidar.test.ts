import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import type { LngLat, Roof3d, Roof3dFace } from '@roofline/shared';
import { lngLatToUtm, utmToLngLat } from '@roofline/shared/roof-reconstruct';
import { lidarAgg } from '../../src/bench/roof3d/aggregate.ts';
import { DEFAULT_LIDAR, type LidarTruth, LidarTruthSchema, lidarIndexHash, lidarMetrics, readLidarIndex, readLidarTruth } from '../../src/bench/roof3d/lidar.ts';
import { cohortsOf, withLidar, type Manifest } from '../../src/bench/roof3d/manifest.ts';
import { emptyMetrics, type HouseMetrics } from '../../src/bench/roof3d/metrics.ts';
import type { RoofLayers } from '../../src/providers/solar-layers.ts';
import { house } from './helpers.ts';

/*
 * The lidar truth grade and the hidden-edge metrics, on synthetic houses built in UTM so the expected distances are
 * exact: a 12 m x 8 m roof at 5 m with a 7 m tree crown standing against its east eave (the heights show no drop
 * there, eave support 'none'), a reconstruction that stops 1 m short on that side, and lidar truth that has the whole
 * roof. Both Google resolutions (0.1 m HIGH, 0.25 m MEDIUM).
 */

const ZONE = { zone: 15, south: false };
const E0 = 563_000;
const N0 = 3_845_800;
const ll = (e: number, n: number): LngLat => utmToLngLat(ZONE, E0 + e, N0 + n) as LngLat;
const rect = (x0: number, y0: number, x1: number, y1: number): LngLat[] => [ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1)];
const closed = (r: LngLat[]): [number, number][] => [...r, r[0]!].map((p) => [p[0], p[1]]);

/** Google-like layers: 30 m square, ground 0, roof 5 m over x 9..21, y 11..19, a 7 m crown over x 21..25, y 9..21. */
function layers(s: number, crown = true): RoofLayers {
  const W = Math.round(30 / s);
  const dsm = new Float32Array(W * W);
  const mask = new Uint8Array(W * W);
  for (let r = 0; r < W; r++) {
    for (let c = 0; c < W; c++) {
      const x = (c + 0.5) * s;
      const y = 30 - (r + 0.5) * s;
      let z = 0;
      if (x >= 9 && x <= 21 && y >= 11 && y <= 19) {
        z = 5;
        mask[r * W + c] = 1;
      }
      if (crown && x > 21 && x <= 25 && y >= 9 && y <= 21) z = 7;
      dsm[r * W + c] = z;
    }
  }
  return { raster: { width: W, height: W, pixelSizeM: s, dsm, mask }, epsg: 32615, originX: E0, originY: N0 + 30, imageryQuality: s > 0.1 ? 'MEDIUM' : 'HIGH', imageryDate: null };
}

function roof(x1: number): Roof3d {
  const sqft = 10.7639104167;
  const plan = (x1 - 9) * 8 * sqft;
  const f: Roof3dFace = { ring: rect(9, 11, x1, 19), pitchX12: 6, azimuthDeg: 180, planAreaSqFt: plan, slopedAreaSqFt: plan * Math.sqrt(1 + 0.25), flat: false, labelAt: ll((9 + x1) / 2, 15) };
  return { version: 1, outline: rect(9, 11, x1, 19), faces: [f], lines: [], pixelSizeM: 0.1, imageryQuality: 'HIGH', imageryDate: null };
}

function truth(over: Partial<LidarTruth> = {}): LidarTruth {
  return LidarTruthSchema.parse({
    slug: 'tr-test',
    ok: true,
    version: 1,
    source: { project: 'AR_Test_B24', workunit: 'AR_Test_4_B24', ql: 'QL 1', pointDates: ['2025-01-08', '2025-01-08', '2025-01-08'], credit: 'USGS 3DEP' },
    frame: { dxM: -0.8, dyM: 0.6, dzM: 2.1, madM: 0.05 },
    method: { expectedEdgeErrorM: 0.2, spacingM: 0.25, cellM: 0.25 },
    outline: [{ outer: closed(rect(9, 11, 21, 19)), holes: [] }],
    planAreaM2: 96,
    slopedAreaM2: 96 * Math.sqrt(1.25),
    mainPitchX12: 6,
    planes: [{ pitchX12: 6, azimuthDeg: 180, planM2: 96, slopedM2: 96 * Math.sqrt(1.25), rings: [closed(rect(9, 11, 21, 19))] }],
    checks: { roofPointsPerM2: 16 },
    ...over,
  });
}

describe('lidar truth: outline and hidden-edge metrics', () => {
  for (const s of [0.1, 0.25]) {
    test(`a reconstruction 1 m short on the canopy side is scored there, and only there (${s} m pixels)`, () => {
      const m = lidarMetrics(roof(20), truth(), layers(s));
      expect(m.comparable).toBe(true);
      expect(m.iou).toBeCloseTo(88 / 96, 3);
      expect(m.planErrPct!).toBeCloseTo((100 * (88 - 96)) / 96, 1);
      expect(m.mainPitchErr).toBe(0);
      expect(m.edgeError).toBeNull();
      // Our east edge (8 m) has a roof outside it (no drop): every hidden sample is 1 m from the lidar outline.
      expect(m.hidden.samples).toBeGreaterThanOrEqual(30);
      expect(m.hidden.sumM / m.hidden.samples).toBeGreaterThan(0.85);
      // Since algorithm 6 the edge is read end to end: the last half metre at each end is within 0.5 m of the lidar
      // outline's north and south edges (2 x 0.5 of 8 m, 12.5%, plus a sample of blur).
      expect(m.hidden.within / m.hidden.samples).toBeLessThan(0.2);
      // The other three edges are on the lidar outline.
      expect(m.visible.samples).toBeGreaterThan(100);
      expect(m.visible.within / m.visible.samples).toBeGreaterThan(0.95);
      // The lidar outline's east edge is under the crown (no drop on Google's heights): 1 m from ours.
      expect(m.truthHidden.samples).toBeGreaterThanOrEqual(30);
      expect(m.truthHidden.sumM / m.truthHidden.samples).toBeGreaterThan(0.85);
    });

    test(`the right outline scores within 0.5 m on its hidden edge too (${s} m pixels)`, () => {
      const m = lidarMetrics(roof(21), truth(), layers(s));
      expect(m.iou).toBeCloseTo(1, 3);
      expect(m.hidden.samples).toBeGreaterThan(0);
      expect(m.hidden.within / m.hidden.samples).toBeGreaterThan(0.95);
      expect(m.truthHidden.within / m.truthHidden.samples).toBeGreaterThan(0.95);
    });
  }

  test('without the crown nothing is hidden: the measure follows the heights, not the canopy tag', () => {
    const m = lidarMetrics(roof(21), truth(), layers(0.1, false));
    expect(m.hidden.samples).toBe(0);
    expect(m.truthHidden.samples).toBe(0);
  });

  test('metamorphic: moving the reconstruction 0.3 m west raises every boundary number and keeps the hidden set', () => {
    const a = lidarMetrics(roof(20), truth(), layers(0.1));
    const shifted = roof(20);
    const moved: Roof3d = { ...shifted, outline: shifted.outline.map((p) => {
      const u = lngLatToUtm(ZONE, p[0], p[1]);
      return utmToLngLat(ZONE, u.easting - 0.3, u.northing) as LngLat;
    }) };
    const b = lidarMetrics(moved, truth(), layers(0.1));
    expect(b.iou).toBeLessThan(a.iou);
    expect(b.meanBoundaryM).toBeGreaterThan(a.meanBoundaryM);
    // aligned removes a pure translation
    expect(b.aligned.iou).toBeGreaterThan(b.iou);
  });

  test('deterministic: the same input gives the same numbers, byte for byte', () => {
    const a = JSON.stringify(lidarMetrics(roof(20), truth(), layers(0.25)));
    const b = JSON.stringify(lidarMetrics(roof(20), truth(), layers(0.25)));
    expect(a).toBe(b);
  });

  /** The layers with the crown only over the north end of the east eave (y 16..21): the eave is hidden on its last 3 m. */
  function northCrown(s: number): RoofLayers {
    const L = layers(s, false);
    const W = L.raster.width;
    for (let r = 0; r < W; r++) {
      for (let c = 0; c < W; c++) {
        const x = (c + 0.5) * s;
        const y = 30 - (r + 0.5) * s;
        if (x > 21 && x <= 25 && y >= 16 && y <= 21) L.raster.dsm[r * W + c] = 7;
      }
    }
    return L;
  }

  for (const s of [0.1, 0.25]) {
    test(`both scorers see a hidden stretch on the second half of an edge (${s} m pixels)`, () => {
      // The east edge runs south to north (y 11 -> 19) with a crown over y 16-19. Before algorithm 6 eaveSupport clamped
      // every sample past the midpoint (y 15) to it, so the 'midpoint' scorer (the product's sampling) never read the
      // crown there; it now reads the whole edge, like the dense scorer.
      const mid = lidarMetrics(roof(21), truth(), northCrown(s), { ...DEFAULT_LIDAR, supportScorer: 'midpoint' });
      const dense = lidarMetrics(roof(21), truth(), northCrown(s), { ...DEFAULT_LIDAR, supportScorer: 'dense' });
      expect(mid.hidden.samples).toBeGreaterThanOrEqual(12);
      expect(mid.hidden.samples).toBeLessThanOrEqual(20);
      // About 3 m of hidden eave at 0.2 m a sample (the crown's edge blurs a sample or two either way).
      expect(dense.hidden.samples).toBeGreaterThanOrEqual(12);
      expect(dense.hidden.samples).toBeLessThanOrEqual(20);
      expect(dense.truthHidden.samples).toBeGreaterThanOrEqual(12);
      // Outline geometry numbers do not depend on the scorer.
      expect(dense.iou).toBe(mid.iou);
      expect(dense.meanBoundaryM).toBe(mid.meanBoundaryM);
    });
  }

  test('a layer grid with no UTM zone is a typed edge error, not a throw', () => {
    const m = lidarMetrics(roof(20), truth(), { ...layers(0.1), epsg: 4326 });
    expect(m.edgeError).toMatch(/no-zone/);
    expect(m.hidden.samples).toBe(0);
    expect(m.iou).toBeGreaterThan(0.9);
  });
});

describe('aggregation pools edge samples over houses', () => {
  test('pooled share and mean are sample-weighted; houses without lidar are left out', () => {
    const base = emptyMetrics('failed');
    const mk = (samples: number, sumM: number, within: number): HouseMetrics => ({
      ...base,
      status: 'ok',
      lidar: { ...lidarMetrics(roof(21), truth(), layers(0.25)), hidden: { samples, sumM, within } },
    });
    const a = lidarAgg([mk(100, 50, 80), mk(300, 450, 60), { ...base, status: 'ok' }]);
    expect(a.houses).toBe(2);
    expect(a.hidden.samples).toBe(400);
    expect(a.hidden.meanM).toBeCloseTo(500 / 400, 9);
    expect(a.hidden.withinShare).toBeCloseTo(140 / 400, 9);
    expect(a.hidden.houses).toBe(2);
  });
});

describe('the lidar index and the truth files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lidar-bench-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'lidar', 'tr-a'), { recursive: true });
  writeFileSync(
    path.join(dir, 'lidar', 'index.json'),
    JSON.stringify({ version: 1, credit: 'USGS 3DEP', rules: {}, houses: { 'tr-a': { grade: 'lidar', reasons: [], leafOff: true }, 'tr-b': { grade: 'rejected', reasons: ['A3-edges-unobserved'] } } }),
  );
  writeFileSync(path.join(dir, 'lidar', 'tr-a', 'truth.json'), JSON.stringify(truth({ slug: 'tr-a' })));

  test('grades merge into the manifest without touching its hash fields, and make the truth-lidar cohort', () => {
    const index = readLidarIndex(dir);
    expect(index).not.toBeNull();
    const m: Manifest = { version: 1, generatedAt: 'x', splitRule: 'x', thresholds: {} as Manifest['thresholds'], houses: [house('tr-a'), house('tr-b'), house('tr-c')] };
    const merged = withLidar(m, index);
    expect(merged.houses.map((h) => h.lidar?.grade)).toEqual(['lidar', 'rejected', 'none']);
    expect(cohortsOf(merged.houses[0]!)).toContain('truth-lidar');
    expect(cohortsOf(merged.houses[1]!)).not.toContain('truth-lidar');
    expect(withLidar(m, null)).toBe(m);
  });

  test('the truth file is read with its fingerprint; the index hash changes with a grade or a truth', () => {
    const t = readLidarTruth(dir, 'tr-a');
    expect(t?.truth.slug).toBe('tr-a');
    expect(t?.sha1).toMatch(/^[0-9a-f]{12}$/);
    expect(readLidarTruth(dir, 'tr-b')).toBeNull();
    const index = readLidarIndex(dir)!;
    const h1 = lidarIndexHash(index, new Map([['tr-a', t!.sha1]]));
    const h2 = lidarIndexHash(index, new Map([['tr-a', 'ffffffffffff']]));
    const h3 = lidarIndexHash({ ...index, houses: { ...index.houses, 'tr-a': { grade: 'rejected', reasons: [] } } }, new Map([['tr-a', t!.sha1]]));
    expect(new Set([h1, h2, h3]).size).toBe(3);
    expect(lidarIndexHash(null)).toBeNull();
  });

  test('a malformed truth file is refused (it would otherwise score against nonsense)', () => {
    mkdirSync(path.join(dir, 'lidar', 'tr-bad'), { recursive: true });
    writeFileSync(path.join(dir, 'lidar', 'tr-bad', 'truth.json'), JSON.stringify({ slug: 'tr-bad', ok: true, outline: [] }));
    expect(() => readLidarTruth(dir, 'tr-bad')).toThrow();
  });
});
