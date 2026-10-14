import { describe, expect, it } from 'vitest';
import { buildRoofModel, measureRoof, type RoofPlane } from '../src/roof-model.ts';
import { pitchFactor, polygonAreaSqFt, type LngLat, type Ring } from '../src/roof.ts';
import {
  dominantPitchX12,
  metresToBuilding,
  outlineFromSolar,
  pitchX12FromDegrees,
  planesOverRing,
  roofPlanesOf,
  solarSnapshotFresh,
  type SolarBuilding,
  type SolarSegment,
} from '../src/solar.ts';

// Omaha origin; metres to degrees with the same sphere the engine uses.
const LNG0 = -95.9345;
const LAT0 = 41.2565;
const K = (Math.PI / 180) * 6371008.8;
const COS = Math.cos((LAT0 * Math.PI) / 180);

/** A [lng, lat] point from local metres (x east, y north), turned by `rot` radians counter-clockwise. */
function at(x: number, y: number, rot = 0): LngLat {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return [LNG0 + (x * c - y * s) / (K * COS), LAT0 + (x * s + y * c) / K];
}
const ring = (pts: [number, number][], rot = 0): Ring => pts.map(([x, y]) => at(x, y, rot));

/** A segment over the local box [x0, x1] x [y0, y1] (axis-aligned), facing `azimuthDeg`. */
function segment(x0: number, y0: number, x1: number, y1: number, pitchDeg: number, azimuthDeg: number): SolarSegment {
  const ground = (x1 - x0) * (y1 - y0);
  return {
    pitchDeg,
    azimuthDeg,
    groundAreaM2: ground,
    areaM2: ground / Math.cos((pitchDeg * Math.PI) / 180),
    center: at((x0 + x1) / 2, (y0 + y1) / 2),
    box: { sw: at(x0, y0), ne: at(x1, y1) },
  };
}

function building(segments: SolarSegment[]): SolarBuilding {
  return { center: at(10, 5), box: { sw: at(0, 0), ne: at(20, 10) }, imageryQuality: 'HIGH', imageryDate: '2024-05-01', segments };
}

/** A 20 m by 10 m gable house, ridge east-west: a south half at 9/12 (36.9 deg) and a north half at 4/12 (18.4 deg). */
const GABLE = building([segment(0, 0, 20, 5, 36.87, 180), segment(0, 5, 20, 10, 18.43, 0)]);
const HOUSE: [number, number][] = [
  [0, 0],
  [20, 0],
  [20, 10],
  [0, 10],
];

describe('pitchX12FromDegrees', () => {
  it('rounds to the nearest whole x/12', () => {
    expect(pitchX12FromDegrees(33.7)).toBe(8);
    expect(pitchX12FromDegrees(26.57)).toBe(6);
    expect(pitchX12FromDegrees(45)).toBe(12);
    expect(pitchX12FromDegrees(18.43)).toBe(4);
    expect(pitchX12FromDegrees(2)).toBe(0);
  });
  it('is 0 for nothing sensible, and never over 24/12', () => {
    expect(pitchX12FromDegrees(Number.NaN)).toBe(0);
    expect(pitchX12FromDegrees(-5)).toBe(0);
    expect(pitchX12FromDegrees(80)).toBe(24);
  });
});

describe('roofPlanesOf and dominantPitchX12', () => {
  it('turns segments into planes in x/12 and sq ft, leaving out tiny and wall-steep ones', () => {
    const planes = roofPlanesOf(
      building([
        segment(0, 0, 20, 5, 36.87, 180),
        segment(0, 0, 1, 1, 30, 90), // 1 m2: a chimney
        segment(0, 0, 2, 4, 68, 270), // a wall
      ]),
    );
    expect(planes).toHaveLength(1);
    expect(planes[0]).toMatchObject({ pitchX12: 9, azimuthDeg: 180 });
    expect(planes[0]!.areaSqFt).toBeCloseTo(100 * 10.7639, 0);
  });

  it('the dominant pitch is the area-weighted median', () => {
    const p = (pitchX12: number, areaSqFt: number): RoofPlane => ({ pitchX12, areaSqFt, azimuthDeg: 0, center: at(0, 0) });
    expect(dominantPitchX12([p(10, 400), p(9, 350), p(7, 200), p(3, 120)])).toBe(9);
    expect(dominantPitchX12([p(6, 1000), p(12, 100)])).toBe(6);
    expect(dominantPitchX12([])).toBeNull();
  });

  it('flat bits are ignored unless the roof is mostly flat', () => {
    const p = (pitchX12: number, areaSqFt: number): RoofPlane => ({ pitchX12, areaSqFt, azimuthDeg: 0, center: at(0, 0) });
    expect(dominantPitchX12([p(8, 500), p(0, 300)])).toBe(8);
    expect(dominantPitchX12([p(1, 900), p(0, 800), p(6, 200)])).toBe(1);
  });
});

describe('per-facet pitch from roof planes', () => {
  it('each facet takes the pitch of the plane facing its way over it; the sloped area follows', () => {
    const planes = roofPlanesOf(GABLE);
    const model = buildRoofModel(ring(HOUSE), { pitchX12: 9, planes })!;
    expect(model.facets).toHaveLength(2);
    const south = model.facets.find((f) => Math.abs((f.azimuthDeg ?? -1) - 180) < 5)!;
    const north = model.facets.find((f) => (f.azimuthDeg ?? 99) < 5 || (f.azimuthDeg ?? 0) > 355)!;
    expect(south.pitch).toBe('9/12');
    expect(north.pitch).toBe('4/12');
    expect(south.areaSqFt).toBeCloseTo(south.planSqFt * pitchFactor(9), 0);
    expect(north.areaSqFt).toBeCloseTo(north.planSqFt * pitchFactor(4), 0);

    const { estimate } = measureRoof({ outline: [ring(HOUSE)], pitchX12: 9, overhangFt: 0, planes });
    const plan = polygonAreaSqFt(ring(HOUSE));
    expect(estimate.pitchX12).toBe(9);
    expect(estimate.surfaceSqFt).toBeCloseTo(plan * ((pitchFactor(9) + pitchFactor(4)) / 2), -1);
    const uniform = measureRoof({ outline: [ring(HOUSE)], pitchX12: 9, overhangFt: 0 }).estimate;
    expect(estimate.surfaceSqFt).toBeLessThan(uniform.surfaceSqFt);
  });

  it('a facet with no plane facing its way keeps the roof pitch', () => {
    const southOnly = roofPlanesOf(building([segment(0, 0, 20, 5, 45, 180)]));
    const model = buildRoofModel(ring(HOUSE), { pitchX12: 6, planes: southOnly })!;
    expect(model.facets.map((f) => f.pitch).sort()).toEqual(['12/12', '6/12']);
  });

  it('a facet its planes barely cover (the roof drawn differs from the real one there) keeps the roof pitch', () => {
    // A small south dormer at 3/12 is the only south-facing plane: a tenth of the south half.
    const dormer: RoofPlane[] = [{ pitchX12: 3, azimuthDeg: 180, center: at(10, 2.5), areaSqFt: 10 * 10.7639 }];
    const model = buildRoofModel(ring(HOUSE), { pitchX12: 8, planes: dormer })!;
    expect(model.facets.every((f) => f.pitch === '8/12')).toBe(true);
  });

  it('a facet over several planes takes the pitch that keeps their sloped area', () => {
    // The south half: 60 m2 at 12/12 and 40 m2 at 4/12 (factors 1.414 and 1.054): together about 9/12.
    const planes: RoofPlane[] = [
      { pitchX12: 12, azimuthDeg: 180, center: at(6, 2.5), areaSqFt: 60 * 10.7639 },
      { pitchX12: 4, azimuthDeg: 180, center: at(16, 2.5), areaSqFt: 40 * 10.7639 },
    ];
    const model = buildRoofModel(ring(HOUSE), { pitchX12: 6, planes })!;
    const south = model.facets.find((f) => Math.abs((f.azimuthDeg ?? 0) - 180) < 5)!;
    expect(south.pitch).toBe('9/12');
  });

  it('planes far from the roof (a neighbour) change nothing', () => {
    const far: RoofPlane[] = [{ pitchX12: 12, azimuthDeg: 180, center: at(200, 200), areaSqFt: 500 }];
    const model = buildRoofModel(ring(HOUSE), { pitchX12: 6, planes: far })!;
    expect(model.facets.every((f) => f.pitch === '6/12')).toBe(true);
    expect(measureRoof({ outline: [ring(HOUSE)], pitchX12: 6, overhangFt: 1, planes: far }).estimate).toEqual(
      measureRoof({ outline: [ring(HOUSE)], pitchX12: 6, overhangFt: 1 }).estimate,
    );
  });

  it('facets on a turned house still face the right way', () => {
    const rot = 0.5;
    const planes: RoofPlane[] = [
      // The south half of the house turned by 0.5 rad faces 180 - 28.6 degrees.
      { pitchX12: 10, azimuthDeg: 180 - (rot * 180) / Math.PI, center: at(10, 2.5, rot), areaSqFt: 1000 },
    ];
    const model = buildRoofModel(ring(HOUSE, rot), { pitchX12: 5, planes })!;
    expect(model.facets.map((f) => f.pitch).sort()).toEqual(['10/12', '5/12']);
  });

  it('planesOverRing keeps only the planes over the outline', () => {
    const planes: RoofPlane[] = [
      { pitchX12: 8, azimuthDeg: 0, center: at(10, 5), areaSqFt: 100 },
      { pitchX12: 8, azimuthDeg: 0, center: at(21, 5), areaSqFt: 100 },
      { pitchX12: 8, azimuthDeg: 0, center: at(40, 5), areaSqFt: 100 },
    ];
    expect(planesOverRing(planes, ring(HOUSE)).map((p) => p.center)).toEqual([at(10, 5), at(21, 5)]);
  });
});

describe('outlineFromSolar', () => {
  it('merges the segments of a gable house into its rectangle', () => {
    const outline = outlineFromSolar(GABLE)!;
    expect(outline).not.toBeNull();
    const area = polygonAreaSqFt(outline);
    expect(area).toBeGreaterThan(200 * 10.7639 * 0.95);
    expect(area).toBeLessThan(200 * 10.7639 * 1.05);
    expect(outline.length).toBeLessThanOrEqual(6);
  });

  it('keeps an L-shaped house L-shaped (not its convex hull)', () => {
    const l = building([
      segment(0, 0, 20, 4, 30, 180),
      segment(0, 4, 20, 8, 30, 0),
      segment(0, 8, 4, 20, 30, 270),
      segment(4, 8, 8, 20, 30, 90),
    ]);
    const area = polygonAreaSqFt(outlineFromSolar(l)!);
    const lArea = (20 * 8 + 8 * 12) * 10.7639;
    expect(area).toBeGreaterThan(lArea * 0.93);
    expect(area).toBeLessThan(lArea * 1.07);
  });

  it('a house turned 30 degrees: rectangles follow the segments, not their boxes', () => {
    const rot = (30 * Math.PI) / 180;
    // Two halves of a 20 m by 10 m house turned 30 degrees; each segment's box is axis-aligned around it.
    const half = (y0: number, y1: number, az: number): SolarSegment => {
      const corners = [at(0, y0, rot), at(20, y0, rot), at(20, y1, rot), at(0, y1, rot)];
      const lngs = corners.map((c) => c[0]);
      const lats = corners.map((c) => c[1]);
      return {
        pitchDeg: 30,
        azimuthDeg: az,
        groundAreaM2: 100,
        areaM2: 115,
        center: at(10, (y0 + y1) / 2, rot),
        box: { sw: [Math.min(...lngs), Math.min(...lats)], ne: [Math.max(...lngs), Math.max(...lats)] },
      };
    };
    // Turned counter-clockwise by 30 degrees, the south half faces east of south (compass 150), the north half 330.
    const outline = outlineFromSolar(building([half(0, 5, 150), half(5, 10, 330)]))!;
    const area = polygonAreaSqFt(outline);
    expect(area).toBeGreaterThan(200 * 10.7639 * 0.92);
    expect(area).toBeLessThan(200 * 10.7639 * 1.08);
  });

  it('is null without segment boxes or with nothing usable', () => {
    expect(outlineFromSolar(null)).toBeNull();
    expect(outlineFromSolar(building([]))).toBeNull();
    expect(outlineFromSolar(building([{ ...segment(0, 0, 20, 5, 30, 180), box: null }]))).toBeNull();
  });
});

describe('metresToBuilding and solarSnapshotFresh', () => {
  it('measures from the point to the building box', () => {
    expect(metresToBuilding(GABLE, at(10, 5))).toBe(0);
    expect(metresToBuilding(GABLE, at(10, 25))).toBeCloseTo(15, 0);
  });

  it('a snapshot is fresh for 30 days, for a point within 3 m', () => {
    const now = new Date('2026-10-13T00:00:00Z');
    const snap = { fetchedAt: '2026-10-01T00:00:00Z', at: at(0, 0), building: null };
    expect(solarSnapshotFresh(snap, at(1, 1), now)).toBe(true);
    expect(solarSnapshotFresh(snap, at(10, 0), now)).toBe(false);
    expect(solarSnapshotFresh(snap, at(0, 0), new Date('2026-11-05T00:00:00Z'))).toBe(false);
    expect(solarSnapshotFresh(null, at(0, 0), now)).toBe(false);
  });
});
