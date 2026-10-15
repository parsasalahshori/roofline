import { describe, expect, test } from 'vitest';
import type { LngLat, Roof3d } from '@roofline/shared';
import { type EagleViewTruth, dominantPitch, eagleViewMetrics, isBad, visualMetrics } from '../../src/bench/roof3d/truth.ts';
import { rectRoof, toLngLat } from './helpers.ts';

const ORIGIN: LngLat = [-92.311, 34.7532];

function truthFrom(roof: Roof3d, over: Partial<EagleViewTruth> = {}): EagleViewTruth {
  return {
    report: '1',
    address: 'test',
    faces: roof.faces.map((f, k) => ({ label: String(k), pitch_x12: f.pitchX12, sloped_sqft: f.slopedAreaSqFt, ring: [...f.ring, f.ring[0]!] })),
    outline: { type: 'Polygon', coordinates: [[...roof.outline, roof.outline[0]!]] },
    total_sloped_sqft: roof.faces.reduce((t, f) => t + f.slopedAreaSqFt, 0),
    lines_ft: { ridge: 40, hip: 0, valley: 0, rake: 20, eave: 80 },
    structures: 1,
    ...over,
  };
}

describe('scoring against an EagleView report', () => {
  const roof = rectRoof(ORIGIN, 14, 9, 6);

  test('the same roof scores perfectly', () => {
    const m = eagleViewMetrics(roof, truthFrom(roof));
    expect(m.comparable).toBe(true);
    expect(m.iou).toBeCloseTo(1, 6);
    expect(m.meanBoundaryM).toBeLessThan(0.01);
    expect(m.areaErrPct).toBeCloseTo(0, 1);
    expect(m.mainPitchErr).toBe(0);
    expect(m.facePitchMAE).toBeCloseTo(0, 9);
    expect(m.within1Pct).toBeCloseTo(100, 9);
    expect(m.unmatchedPct).toBe(0);
    expect(isBad(m)).toBe(false);
  });

  test('area and pitch errors are signed and measured against the report', () => {
    const t = truthFrom(roof);
    const big: EagleViewTruth = { ...t, total_sloped_sqft: t.total_sloped_sqft / 1.12 };
    expect(eagleViewMetrics(roof, big).areaErrPct).toBeCloseTo(12, 0);
    const steeper = rectRoof(ORIGIN, 14, 9, 8);
    const m = eagleViewMetrics(steeper, t);
    expect(m.mainPitchOurs).toBe(8);
    expect(m.mainPitchTruth).toBe(6);
    expect(m.mainPitchErr).toBe(2);
    expect(m.facePitchMAE).toBeCloseTo(2, 9);
    expect(m.within1Pct).toBe(0);
    expect(isBad(m)).toBe(true);
  });

  test('bad means area off over 10 percent or pitch off over 1/12, nothing less', () => {
    const base = eagleViewMetrics(roof, truthFrom(roof));
    expect(isBad({ ...base, areaErrPct: 10, mainPitchErr: 1 })).toBe(false);
    expect(isBad({ ...base, areaErrPct: -10.1, mainPitchErr: 0 })).toBe(true);
    expect(isBad({ ...base, areaErrPct: 0, mainPitchErr: 1.01 })).toBe(true);
  });

  test('a report measuring two structures, or a different building, is not comparable', () => {
    expect(eagleViewMetrics(roof, truthFrom(roof, { structures: 2 })).comparable).toBe(false);
    const elsewhere = rectRoof(toLngLat(ORIGIN, 200, 0), 14, 9, 6);
    const m = eagleViewMetrics(roof, truthFrom(elsewhere));
    expect(m.iou).toBe(0);
    expect(m.comparable).toBe(false);
    expect(m.unmatchedPct).toBeCloseTo(100, 9);
    expect(m.facePitchMAE).toBeNull();
  });

  test('line totals pair ours with the report for the five kinds', () => {
    const withLines: Roof3d = {
      ...roof,
      lines: [
        { kind: 'ridge', coords: [ORIGIN, ORIGIN], lengthFt: 30, riseFt: 0, faces: [0, 1] },
        { kind: 'ridge', coords: [ORIGIN, ORIGIN], lengthFt: 10, riseFt: 0, faces: [0, 1] },
        { kind: 'eave', coords: [ORIGIN, ORIGIN], lengthFt: 70, riseFt: 0, faces: [0] },
        { kind: 'step-flashing', coords: [ORIGIN, ORIGIN], lengthFt: 99, riseFt: 0, faces: [0] },
      ],
    };
    const m = eagleViewMetrics(withLines, truthFrom(withLines));
    expect(m.lines).toEqual({ ridge: [40, 40], hip: [0, 0], valley: [0, 0], eave: [70, 80], rake: [0, 20] });
  });

  test('only report faces of 100 sq ft or more are matched', () => {
    const t = truthFrom(roof);
    const withTiny: EagleViewTruth = { ...t, faces: [...t.faces, { label: 'x', pitch_x12: 12, sloped_sqft: 60, ring: t.faces[0]!.ring }] };
    expect(eagleViewMetrics(roof, withTiny).facePitchMAE).toBeCloseTo(0, 9);
  });
});

describe('main pitch', () => {
  test('the pitch with the most area, whole x/12, ties to the first met, halves to even', () => {
    expect(dominantPitch([{ pitch: 6.2, area: 100 }, { pitch: 8, area: 90 }, { pitch: 5.9, area: 20 }])).toBe(6);
    expect(dominantPitch([{ pitch: 7, area: 50 }, { pitch: 5, area: 50 }])).toBe(7);
    expect(dominantPitch([{ pitch: 6.5, area: 10 }])).toBe(6);
    expect(dominantPitch([{ pitch: 7.5, area: 10 }])).toBe(8);
    expect(dominantPitch([])).toBeNull();
  });
});

describe('scoring against a hand-drawn outline', () => {
  test('outline only: overlap and boundary distance, no area or pitch', () => {
    const roof = rectRoof(ORIGIN, 14, 9, 6);
    const drawn = { outline: [...rectRoof(ORIGIN, 14.5, 9.5, 6).outline], toleranceM: 0.6, source: 'test' };
    const m = visualMetrics(roof, drawn);
    expect(m.grade).toBe('visual');
    expect(m.iou).toBeGreaterThan(0.9);
    expect(m.areaErrPct).toBeNull();
    expect(m.mainPitchErr).toBeNull();
    expect(isBad(m)).toBe(false);
  });
});
