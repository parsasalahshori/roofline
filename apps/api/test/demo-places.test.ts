import { statSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { OMAHA_CONTOURS } from '@roofline/db/testing';
import { DEMO_BUILDINGS, DEMO_FOOTPRINT_ATTRIBUTION, DEMO_LOT_COUNT, DemoPlacer, hailOver, type DemoLngLat } from '../src/demo/places.ts';
import { DEMO_LOOKUP_LOTS } from '../src/providers/fakes/geocoder.ts';

const M_LNG = 111_320 * Math.cos((41.26 * Math.PI) / 180);
const M_LAT = 111_320;

function inside(p: DemoLngLat, ring: readonly DemoLngLat[]): boolean {
  let c = false;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[i + 1]!;
    if (y1 > p[1] !== y2 > p[1] && p[0] < ((x2 - x1) * (p[1] - y1)) / (y2 - y1) + x1) c = !c;
  }
  return c;
}

function areaSqM(ring: readonly DemoLngLat[]): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    a += ring[i]![0] * M_LNG * ring[i + 1]![1] * M_LAT - ring[i + 1]![0] * M_LNG * ring[i]![1] * M_LAT;
  }
  return Math.abs(a) / 2;
}

describe('the demo footprint asset', () => {
  test('is a small, attributed set of house-sized Omaha buildings', () => {
    expect(DEMO_FOOTPRINT_ATTRIBUTION).toMatch(/Microsoft/);
    expect(DEMO_FOOTPRINT_ATTRIBUTION).toMatch(/ODbL/);
    expect(DEMO_BUILDINGS.length).toBeGreaterThanOrEqual(150);
    expect(DEMO_BUILDINGS.length).toBeLessThanOrEqual(300);
    expect(statSync(new URL('../src/demo/data/omaha-footprints.json', import.meta.url)).size).toBeLessThan(300_000);
    expect(new Set(DEMO_BUILDINGS.map((b) => b.id)).size).toBe(DEMO_BUILDINGS.length);
    for (const b of DEMO_BUILDINGS) {
      expect(b.ring[0], b.id).toEqual(b.ring[b.ring.length - 1]);
      expect(b.ring.length - 1, b.id).toBeGreaterThanOrEqual(4);
      const sqM = areaSqM(b.ring);
      expect(sqM, b.id).toBeGreaterThan(75);
      expect(sqM, b.id).toBeLessThan(410);
      expect(b.pt[0], b.id).toBeGreaterThan(-96.2);
      expect(b.pt[0], b.id).toBeLessThan(-95.9);
      expect(b.pt[1], b.id).toBeGreaterThan(41.15);
      expect(b.pt[1], b.id).toBeLessThan(41.35);
      // The point is on the building (a point-on-surface, which an L-shape's raw centroid may not be).
      expect(inside(b.pt, b.ring), b.id).toBe(true);
      expect(b.hail, b.id).toBe(hailOver(b.pt, OMAHA_CONTOURS));
    }
    // Real shapes: most outlines are not four-cornered rectangles.
    expect(DEMO_BUILDINGS.filter((b) => b.ring.length - 1 > 4).length).toBeGreaterThan(DEMO_BUILDINGS.length / 2);
  });

  test('has 48 lookup lots, each a point on its own real building', () => {
    expect(DEMO_LOOKUP_LOTS).toHaveLength(DEMO_LOT_COUNT);
    expect(new Set(DEMO_LOOKUP_LOTS.map((l) => l.join(','))).size).toBe(DEMO_LOT_COUNT);
    for (const lot of DEMO_LOOKUP_LOTS) expect(DEMO_BUILDINGS.some((b) => inside(lot, b.ring))).toBe(true);
  });
});

describe('the demo placer', () => {
  test('hands out the same buildings every run, never a lot, each under the hail it was asked for', () => {
    const wants = [0, 0.75, 0.75, 1, 1.5, 0, 0.75];
    const a = new DemoPlacer();
    const b = new DemoPlacer();
    const first = wants.map((w) => a.take(w));
    expect(wants.map((w) => b.take(w).id)).toEqual(first.map((x) => x.id));
    expect(new Set(first.map((x) => x.id)).size).toBe(first.length);
    first.forEach((x, i) => expect(x.hail).toBe(wants[i]));
    const lots = new Set(DEMO_LOOKUP_LOTS.map((l) => l.join(',')));
    for (const x of first) expect(lots.has(x.pt.join(','))).toBe(false);
  });

  test('keeps the storm edge when a size runs out, and loads every building once under demo-home, demo-lot or demo-next', () => {
    const p = new DemoPlacer();
    const taken = Array.from({ length: 70 }, () => p.take(1));
    expect(taken.every((x) => x.hail > 0)).toBe(true);
    const refs = p.footprints();
    expect(refs).toHaveLength(DEMO_BUILDINGS.length);
    expect(new Set(refs.map((r) => r.sourceRef)).size).toBe(refs.length);
    expect(refs.filter((r) => r.sourceRef.startsWith('demo-home-'))).toHaveLength(70);
    expect(refs.filter((r) => r.sourceRef.startsWith('demo-lot-'))).toHaveLength(DEMO_LOT_COUNT);
  });
});
