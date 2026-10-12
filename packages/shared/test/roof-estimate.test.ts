import { describe, expect, it } from 'vitest';
import { instantEstimate, type Outline, type Ring } from '../src/roof.ts';

// Omaha origin; 1 degree latitude = 364,567 ft; 1 degree longitude = 364,567 * cos(lat) ft.
const LNG0 = -95.9345;
const LAT0 = 41.2565;
const FT_PER_DEG_LAT = 364567;
const FT_PER_DEG_LNG = FT_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);

// Axis-aligned rectangle of w x h feet centred at (cx, cy), closed ring.
function rect(w: number, h: number, cx = LNG0, cy = LAT0): Ring {
  const dx = w / 2 / FT_PER_DEG_LNG;
  const dy = h / 2 / FT_PER_DEG_LAT;
  return [
    [cx - dx, cy - dy],
    [cx + dx, cy - dy],
    [cx + dx, cy + dy],
    [cx - dx, cy + dy],
    [cx - dx, cy - dy],
  ];
}

function within(actual: number, expected: number, pct: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual((Math.abs(expected) * pct) / 100);
}

describe('instantEstimate', () => {
  const base = { outline: [rect(40, 30)] as Outline, pitchX12: 6, overhangFt: 1 };

  it('gives footprint, plan, surface, squares, edges and ridge for a 40 x 30 ft rectangle at 6/12 with 1 ft overhang', () => {
    const e = instantEstimate(base);
    within(e.footprintSqFt, 1200, 0.5);
    within(e.planSqFt, 1340, 0.5);
    within(e.surfaceSqFt, 1498.1, 0.5);
    within(e.squares, 14.98, 0.5);
    within(e.edgeFt, 148, 0.5);
    within(e.ridgeFt, 40, 0.5);
    expect(e.valleyFt).toBe(0);
    expect(e.pitchX12).toBe(6);
  });

  it('rounds areas and lengths to one decimal', () => {
    const e = instantEstimate(base);
    for (const v of [e.footprintSqFt, e.planSqFt, e.surfaceSqFt, e.squares, e.edgeFt, e.ridgeFt]) {
      expect(Math.round(v * 10) / 10).toBeCloseTo(v, 9);
    }
  });

  it('gives plan equal to footprint when overhang is 0', () => {
    const e = instantEstimate({ ...base, overhangFt: 0 });
    expect(Math.abs(e.planSqFt - e.footprintSqFt)).toBeLessThanOrEqual(0.1);
    expect(e.edgeFt).toBeCloseTo(140, 0);
  });

  it('sums two identical rings at different places to double the footprint and ridge', () => {
    const one = instantEstimate(base);
    const two = instantEstimate({
      ...base,
      outline: [rect(40, 30, LNG0, LAT0), rect(40, 30, LNG0 + 0.01, LAT0 + 0.01)],
    });
    expect(Math.abs(two.footprintSqFt - 2 * one.footprintSqFt)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(two.ridgeFt - 2 * one.ridgeFt)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(two.edgeFt - 2 * one.edgeFt)).toBeLessThanOrEqual(0.1);
  });

  it('passes valleyFt through rounded to 0.1 ft', () => {
    const e = instantEstimate({ ...base, valleyFt: 12.34 });
    expect(e.valleyFt).toBe(12.3);
  });

  it('gives all zeros for an empty outline', () => {
    const e = instantEstimate({ outline: [], pitchX12: 6, overhangFt: 1 });
    expect(e).toEqual({
      footprintSqFt: 0,
      planSqFt: 0,
      surfaceSqFt: 0,
      squares: 0,
      edgeFt: 0,
      ridgeFt: 0,
      valleyFt: 0,
      pitchX12: 6,
    });
  });

  it('treats a negative or NaN overhang as 0', () => {
    const neg = instantEstimate({ ...base, overhangFt: -2 });
    const nan = instantEstimate({ ...base, overhangFt: Number.NaN });
    expect(neg.planSqFt).toBe(instantEstimate({ ...base, overhangFt: 0 }).planSqFt);
    expect(nan.planSqFt).toBe(neg.planSqFt);
  });

  it('treats a NaN pitch as 0 and does not throw', () => {
    const e = instantEstimate({ ...base, pitchX12: Number.NaN });
    expect(e.pitchX12).toBe(0);
    expect(e.surfaceSqFt).toBe(e.planSqFt);
  });
});
