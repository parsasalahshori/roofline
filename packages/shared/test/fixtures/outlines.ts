// Fixture roof outlines for the geometry and instant-estimate tests.
// Local feet (x east, y north) convert to [lng, lat] with 1 deg lat = 364,567 ft and
// 1 deg lng = 364,567 * cos(lat) ft, so tests read in feet while the code under test sees lng/lat.
import type { Ring } from '../../src/roof.ts';

export const OMAHA = { lng: -95.9345, lat: 41.2565 };

const FT_PER_DEG_LAT = 364567;

// Converts local feet to an open ring (no repeated closing point).
export function feetToRing(origin: { lng: number; lat: number }, ptsFt: [number, number][]): Ring {
  const ftPerDegLng = FT_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return ptsFt.map(([x, y]): [number, number] => [origin.lng + x / ftPerDegLng, origin.lat + y / FT_PER_DEG_LAT]);
}

// Axis-aligned rectangle of wFt by hFt, centred on origin.
export function rectRing(wFt: number, hFt: number, origin: { lng: number; lat: number } = OMAHA): Ring {
  const w = wFt / 2;
  const h = hFt / 2;
  return feetToRing(origin, [
    [-w, -h],
    [w, -h],
    [w, h],
    [-w, h],
  ]);
}

// Rotates local feet points about the origin by degrees (counter-clockwise).
export function rotate(ptsFt: [number, number][], degrees: number): [number, number][] {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return ptsFt.map(([x, y]): [number, number] => [x * c - y * s, x * s + y * c]);
}

export const rect40x30 = rectRing(40, 30);

// Area 60*25 + 30*25 = 2250 sq ft; perimeter 220 ft.
export const lShape: Ring = feetToRing(OMAHA, [
  [0, 0],
  [60, 0],
  [60, 25],
  [30, 25],
  [30, 50],
  [0, 50],
]);

export const secondHouse = rectRing(40, 30, { lng: -95.93, lat: 41.26 });

export const twoCornerRing: Ring = [
  [-95.9345, 41.2565],
  [-95.9344, 41.2566],
];

export const bowTie: Ring = feetToRing(OMAHA, [
  [0, 0],
  [40, 30],
  [40, 0],
  [0, 30],
]);

// 300,000 sq ft, over the 200,000 sq ft limit.
export const warehouse = rectRing(600, 500);
