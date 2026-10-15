import type { LngLat, Roof3d, Roof3dFace } from '@roofline/shared';
import type { Pt } from '../../src/bench/roof3d/geometry.ts';
import { type HouseEntry, splitOf } from '../../src/bench/roof3d/manifest.ts';

/** A small seeded generator (mulberry32) so the property tests are the same every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random simple polygon: points at random radii round a centre, in angular order (star-shaped, so never self-crossing). */
export function randomStar(r: () => number, n = 9, cx = 0, cy = 0, minR = 4, maxR = 12): Pt[] {
  const pts: Pt[] = [];
  for (let k = 0; k < n; k++) {
    const a = ((k + r() * 0.6) / n) * 2 * Math.PI;
    const rad = minR + r() * (maxR - minR);
    pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
  }
  return pts;
}

export const closed = (pts: Pt[]): Pt[] => [...pts, [pts[0]![0], pts[0]![1]]];

const K = (Math.PI / 180) * 6371008.8;

/** Metres east/north of an origin to [lng, lat]. */
export function toLngLat(origin: LngLat, x: number, y: number): LngLat {
  return [origin[0] + x / (K * Math.cos((origin[1] * Math.PI) / 180)), origin[1] + y / K];
}

/** A rectangle roof (one flat-pitched face and a gable-like outline) in lng/lat, for scoring tests. */
export function rectRoof(origin: LngLat, w: number, d: number, pitchX12: number, o: { faces?: number } = {}): Roof3d {
  const ring = (x0: number, y0: number, x1: number, y1: number): LngLat[] => [toLngLat(origin, x0, y0), toLngLat(origin, x1, y0), toLngLat(origin, x1, y1), toLngLat(origin, x0, y1)];
  const sqft = 10.7639104167;
  const slope = Math.sqrt(1 + (pitchX12 / 12) ** 2);
  const mk = (x0: number, y0: number, x1: number, y1: number, down: number): Roof3dFace => {
    const plan = (x1 - x0) * (y1 - y0) * sqft;
    return { ring: ring(x0, y0, x1, y1), pitchX12, azimuthDeg: down, planAreaSqFt: plan, slopedAreaSqFt: plan * slope, flat: pitchX12 < 2, labelAt: toLngLat(origin, (x0 + x1) / 2, (y0 + y1) / 2) };
  };
  const faces = o.faces === 1 ? [mk(0, 0, w, d, 180)] : [mk(0, 0, w, d / 2, 180), mk(0, d / 2, w, d, 0)];
  return { version: 1, outline: ring(0, 0, w, d), faces, lines: [], pixelSizeM: 0.1, imageryQuality: 'HIGH', imageryDate: null };
}

export function house(slug: string, over: Partial<HouseEntry> = {}): HouseEntry {
  return {
    slug,
    set: 'testset',
    dir: `testset/${slug}`,
    point: [-92.3, 34.75],
    address: '1 Test St, Little Rock, AR 72205',
    region: { state: 'AR', metro: 'Little Rock' },
    split: splitOf(slug),
    truth: 'proxy',
    tags: {
      canopy: { roofShare: 0, rimShare: 0.4, biteShare: 0, class: 'heavy' },
      complexity: { class: 'simple', faces: 3, source: 'google-segments' },
      lowSlope: false,
      steep: false,
      mainPitchX12: 6,
      pitchSource: 'google-segments',
    },
    data: { downloadedAt: '2026-10-14', deleteBy: '2026-11-13', imageryQuality: 'HIGH', imageryDate: '2024-05-01' },
    ...over,
  };
}
