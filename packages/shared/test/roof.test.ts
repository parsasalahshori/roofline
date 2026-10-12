import { expect, test } from 'vitest';
import type { Ring } from '../src/roof.ts';
import {
  instantEstimate,
  minRotatedRectangle,
  outlineProblem,
  perimeterFt,
  pitchFactor,
  polygonAreaSqFt,
} from '../src/roof.ts';
import {
  OMAHA,
  bowTie,
  feetToRing,
  lShape,
  rect40x30,
  rotate,
  secondHouse,
  twoCornerRing,
  warehouse,
} from './fixtures/outlines.ts';

// pct is a percentage: within(x, 1200, 0.5) accepts 1194..1206.
function within(actual: number, expected: number, pct: number): void {
  const tol = Math.abs(expected) * (pct / 100);
  expect(Math.abs(actual - expected), `actual ${actual} vs expected ${expected} (+-${pct}%)`).toBeLessThanOrEqual(tol);
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

test('40 x 30 rectangle: area, perimeter and pitch factor', () => {
  within(polygonAreaSqFt(rect40x30), 1200, 0.5);
  within(perimeterFt(rect40x30), 140, 0.5);
  expect(pitchFactor(6)).toBeCloseTo(1.118, 4);
});

test('40 x 30 rectangle instant estimate at 6/12 with 1 ft overhang', () => {
  const e = instantEstimate({ outline: [rect40x30], pitchX12: 6, overhangFt: 1 });
  within(e.footprintSqFt, 1200, 0.5);
  within(e.planSqFt, 1340, 0.5);
  within(e.surfaceSqFt, 1498.1, 0.5);
  within(e.edgeFt, 148, 0.5);
  within(e.ridgeFt, 40, 0.5);
  within(e.squares, 14.98, 0.5);
  expect(e.valleyFt).toBe(0);
  expect(e.pitchX12).toBe(6);
});

test('L-shape: area, perimeter and bounding dimensions', () => {
  within(polygonAreaSqFt(lShape), 2250, 0.5);
  within(perimeterFt(lShape), 220, 0.5);
  const r = minRotatedRectangle(lShape);
  expect(r.longFt).toBeGreaterThanOrEqual(55);
  expect(r.longFt).toBeLessThanOrEqual(70);
  expect(r.shortFt).toBeGreaterThanOrEqual(40);
  expect(r.shortFt).toBeLessThanOrEqual(55);
});

test('L-shape instant estimate ridge equals the min rotated rectangle long side, rounded to 0.1 ft', () => {
  const e = instantEstimate({ outline: [lShape], pitchX12: 6, overhangFt: 1 });
  expect(e.ridgeFt).toBeCloseTo(round1(minRotatedRectangle(lShape).longFt), 6);
  within(e.footprintSqFt, 2250, 0.5);
});

test('two rings sum footprint and surface', () => {
  const e = instantEstimate({ outline: [rect40x30, secondHouse], pitchX12: 6, overhangFt: 1 });
  within(e.footprintSqFt, 2400, 0.5);
  within(e.surfaceSqFt, 2 * 1498.1, 0.5);
});

test('closed ring (first point repeated) has the same area as the open ring', () => {
  const closed: Ring = [...rect40x30, rect40x30[0]!];
  expect(polygonAreaSqFt(closed)).toBeCloseTo(polygonAreaSqFt(rect40x30), 6);
  expect(perimeterFt(closed)).toBeCloseTo(perimeterFt(rect40x30), 6);
});

test('rotated 40 x 30 rectangle keeps its area and min rectangle dimensions', () => {
  const rotated = feetToRing(OMAHA, rotate([[-20, -15], [20, -15], [20, 15], [-20, 15]], 33));
  within(polygonAreaSqFt(rotated), 1200, 0.5);
  const r = minRotatedRectangle(rotated);
  within(r.longFt, 40, 0.5);
  within(r.shortFt, 30, 0.5);
});

test('outline problems', () => {
  expect(outlineProblem(twoCornerRing)).toBe('too_few_corners');
  expect(outlineProblem(bowTie)).toBe('self_intersecting');
  expect(outlineProblem(warehouse)).toBe('too_large');
  expect(outlineProblem(rect40x30)).toBeNull();
  expect(outlineProblem(lShape)).toBeNull();
});
