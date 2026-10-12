import { expect, test } from 'vitest';
import type { LngLat, Ring } from '../src/roof.ts';
import { instantEstimate, minRotatedRectangle, outlineProblem, perimeterFt, pitchFactor, polygonAreaSqFt, TOO_LARGE_SQFT } from '../src/roof.ts';
import { PRICING_LIMITS } from '../src/pricing.ts';

// Omaha origin used across the estimator tests.
const LNG0 = -95.9345;
const LAT0 = 41.2565;
const FT_PER_DEG_LAT = 364567;

// Convert local feet offsets (x east, y north) to lng/lat around the Omaha origin.
function ftToLngLat(x: number, y: number): LngLat {
  const lat = LAT0 + y / FT_PER_DEG_LAT;
  const lng = LNG0 + x / (FT_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180));
  return [lng, lat];
}

// Axis-aligned w x h ft rectangle centred on the origin, optionally rotated by degrees.
function rectRing(w: number, h: number, rotateDeg = 0, closed = false): Ring {
  const t = (rotateDeg * Math.PI) / 180;
  const corners: [number, number][] = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
  const ring: Ring = corners.map(([x, y]) => {
    const rx = x * Math.cos(t) - y * Math.sin(t);
    const ry = x * Math.sin(t) + y * Math.cos(t);
    return ftToLngLat(rx, ry);
  });
  if (closed) ring.push(ring[0]!);
  return ring;
}

test('40 x 30 ft rectangle has area 1200 and perimeter 140 within 0.5%', () => {
  const ring = rectRing(40, 30);
  expect(Math.abs(polygonAreaSqFt(ring) - 1200) / 1200).toBeLessThan(0.005);
  expect(Math.abs(perimeterFt(ring) - 140) / 140).toBeLessThan(0.005);
});

test('pitch factor is sqrt(1 + (p/12)^2)', () => {
  expect(pitchFactor(6)).toBeCloseTo(1.118, 3);
  expect(pitchFactor(0)).toBe(1);
  expect(pitchFactor(12)).toBeCloseTo(Math.SQRT2, 10);
});

test('minimum rotated rectangle of 40 x 30 ft is 40 by 30', () => {
  const r = minRotatedRectangle(rectRing(40, 30));
  expect(Math.abs(r.longFt - 40) / 40).toBeLessThan(0.005);
  expect(Math.abs(r.shortFt - 30) / 30).toBeLessThan(0.005);
});

test('minimum rotated rectangle is independent of rotation', () => {
  const r = minRotatedRectangle(rectRing(40, 30, 30));
  expect(Math.abs(r.longFt - 40) / 40).toBeLessThan(0.01);
  expect(Math.abs(r.shortFt - 30) / 30).toBeLessThan(0.01);
});

test('open and closed rings give the same area and perimeter', () => {
  const open = rectRing(40, 30);
  const closed = rectRing(40, 30, 0, true);
  expect(polygonAreaSqFt(closed)).toBeCloseTo(polygonAreaSqFt(open), 6);
  expect(perimeterFt(closed)).toBeCloseTo(perimeterFt(open), 6);
});

test('L-shaped outline area is the rectangle minus the notch', () => {
  // 40 x 30 ft with a 20 x 15 ft notch removed from one corner: 1200 - 300 = 900 sq ft.
  const pts: [number, number][] = [
    [0, 0],
    [40, 0],
    [40, 15],
    [20, 15],
    [20, 30],
    [0, 30],
  ];
  const ring: Ring = pts.map(([x, y]) => ftToLngLat(x, y));
  expect(Math.abs(polygonAreaSqFt(ring) - 900) / 900).toBeLessThan(0.005);
  expect(outlineProblem(ring)).toBeNull();
});

test('degenerate rings return zero measurements instead of throwing', () => {
  expect(polygonAreaSqFt([])).toBe(0);
  expect(perimeterFt([])).toBe(0);
  expect(polygonAreaSqFt([ftToLngLat(0, 0), ftToLngLat(10, 0)])).toBe(0);
  expect(minRotatedRectangle([])).toEqual({ longFt: 0, shortFt: 0 });
});

test('outlineProblem: fewer than three corners', () => {
  expect(outlineProblem([])).toBe('too_few_corners');
  expect(outlineProblem([ftToLngLat(0, 0), ftToLngLat(40, 30)])).toBe('too_few_corners');
});

test('outlineProblem: a bow-tie at house size is self-intersecting', () => {
  const bowTie: Ring = [
    ftToLngLat(0, 0),
    ftToLngLat(40, 30),
    ftToLngLat(40, 0),
    ftToLngLat(0, 30),
  ];
  expect(outlineProblem(bowTie)).toBe('self_intersecting');
});

test('outlineProblem: a 600 x 500 ft rectangle is too large', () => {
  expect(outlineProblem(rectRing(600, 500))).toBe('too_large');
});

test('outlineProblem: a normal rectangle has no problem', () => {
  expect(outlineProblem(rectRing(40, 30))).toBeNull();
  expect(outlineProblem(rectRing(40, 30, 0, true))).toBeNull();
});

test('outlineProblem: three corners in a line enclose nothing, so they count as too few corners', () => {
  expect(outlineProblem([ftToLngLat(0, 0), ftToLngLat(20, 0), ftToLngLat(40, 0)])).toBe('too_few_corners');
});

test('outlineProblem: the size limit keeps every accepted outline within the pricing limit (B8)', () => {
  // The largest accepted square, at the steepest pitch with the most overhang, still prices.
  const side = Math.sqrt(TOO_LARGE_SQFT) - 2;
  const square = rectRing(side, side);
  expect(outlineProblem(square)).toBeNull();
  const steepest = instantEstimate({ outline: [square], pitchX12: 24, overhangFt: 3 });
  expect(steepest.surfaceSqFt).toBeLessThanOrEqual(PRICING_LIMITS.maxAreaSqFt);
  expect(steepest.edgeFt).toBeLessThanOrEqual(PRICING_LIMITS.maxLengthFt);
  // Just over the limit is too large.
  const over = Math.sqrt(TOO_LARGE_SQFT) + 2;
  expect(outlineProblem(rectRing(over, over))).toBe('too_large');
  // A long, narrow outline at the limit also stays within the pricing limit.
  const long = rectRing(TOO_LARGE_SQFT / 40 - 10, 40);
  expect(outlineProblem(long)).toBeNull();
  expect(instantEstimate({ outline: [long], pitchX12: 24, overhangFt: 3 }).surfaceSqFt).toBeLessThanOrEqual(PRICING_LIMITS.maxAreaSqFt);
});
