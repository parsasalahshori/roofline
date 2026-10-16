import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AR_MAX_CORNER_OFF_DEG,
  AR_MAX_OFF_PLANE_IN,
  AR_MAX_SIDE_DIFF,
  AR_POINT_SIGMA_M,
  AR_SCALE_SIGMA,
  type ArDevice,
  type ArPoint,
  type ArQuad,
  INCHES_PER_METRE,
  sizeFromArPoints,
} from '@roofline/shared';

/*
 * Parity fixtures for the iPhone app (apps/ios): the Swift port of sizeFromArPoints (window-photo-math.ts) previews a
 * window's size live, and the server sizes it again with the TypeScript. XCTest reads this file and checks the Swift
 * port gives the same width, height, ± and quality for every case (raw doubles, before the server's 0.01 in rounding).
 *
 *   npm run ios:fixtures      writes apps/ios/RooflineMeasureTests/Fixtures/ar-sizing.json
 *
 * scripts/test/ios-ar-fixtures.test.ts fails when the committed file no longer matches the TypeScript, so a change to
 * the AR math cannot land without new fixtures (and the Swift port following).
 */

export const FIXTURE_PATH = 'apps/ios/RooflineMeasureTests/Fixtures/ar-sizing.json';

const IN = 1 / INCHES_PER_METRE;

/** Rotation about x (lean), then y (the wall turned), then z (in-plane roll), radians. */
function rotate([x, y, z]: ArPoint, ax: number, ay: number, az: number): ArPoint {
  const y1 = y * Math.cos(ax) - z * Math.sin(ax);
  const z1 = y * Math.sin(ax) + z * Math.cos(ax);
  const x2 = x * Math.cos(ay) + z1 * Math.sin(ay);
  const z2 = -x * Math.sin(ay) + z1 * Math.cos(ay);
  const x3 = x2 * Math.cos(az) - y1 * Math.sin(az);
  const y3 = x2 * Math.sin(az) + y1 * Math.cos(az);
  return [x3, y3, z2];
}

const deg = (d: number) => (d * Math.PI) / 180;

/** A wIn x hIn frame (TL, TR, BR, BL; facing +Z, so a person at the origin sees it on a wall along -Z), turned and moved. */
function frame(wIn: number, hIn: number, at: ArPoint, o: { leanDeg?: number; turnDeg?: number; rollDeg?: number } = {}): ArQuad {
  const w = wIn * IN;
  const h = hIn * IN;
  const local: ArPoint[] = [
    [-w / 2, h / 2, 0],
    [w / 2, h / 2, 0],
    [w / 2, -h / 2, 0],
    [-w / 2, -h / 2, 0],
  ];
  return local.map((p) => {
    const r = rotate(p, deg(o.leanDeg ?? 0), deg(o.turnDeg ?? 0), deg(o.rollDeg ?? 0));
    return [r[0] + at[0], r[1] + at[1], r[2] + at[2]];
  }) as ArQuad;
}

/** A seeded random source, so the noisy cases are the same on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const noisy = (q: ArQuad, seed: number, amplitudeM: number): ArQuad => {
  const r = rng(seed);
  return q.map((p) => p.map((v) => v + (r() * 2 - 1) * amplitudeM)) as ArQuad;
};

type Spread = [number, number, number, number];
type Input = { name: string; group: string; device: ArDevice | null; cornerSpreadM: Spread | null; pointsM: ArQuad };

export type ArSizingFixture = Input & {
  /** null: sizeFromArPoints refuses the points (degenerate). */
  expected: {
    widthIn: number;
    heightIn: number;
    uncertaintyIn: { width: number; height: number };
    quality: 'good' | 'check';
    /** Informational: the Swift port need not match the wording, only `quality`. */
    reasons: string[];
    /** Which input point is TL, TR, BR, BL (gravity order; left/right as seen from the AR origin's side). */
    order: [number, number, number, number];
  } | null;
};

function inputs(): Input[] {
  const c = (name: string, group: string, pointsM: ArQuad, device: ArDevice | null = null, cornerSpreadM: Spread | null = null): Input => ({ name, group, device, cornerSpreadM, pointsM });
  const front = frame(36, 60, [0.2, 1.3, -2]);
  const list: Input[] = [
    c('36 x 60 straight on, 2 m ahead, no device (webxr)', 'basic', front),
    c('36 x 60 straight on, arkit', 'basic', front, 'arkit'),
    c('36 x 60 straight on, arkit-lidar', 'basic', front, 'arkit-lidar'),
    c('30 x 48 on a wall turned 35 degrees, arkit-lidar', 'turned', frame(30, 48, [0.9, 1.4, -1.8], { turnDeg: 35 }), 'arkit-lidar'),
    c('24 x 36 on a side wall turned 80 degrees, arkit', 'turned', frame(24, 36, [-1.6, 1.1, -0.4], { turnDeg: 80 }), 'arkit'),
    c('48 x 60 on a wall turned -50 degrees, webxr', 'turned', frame(48, 60, [-1.2, 1.5, -2.2], { turnDeg: -50 }), 'webxr'),
    c('tilted wall: 36 x 48 leaning back 6 degrees, arkit-lidar', 'tilted', frame(36, 48, [0, 1.6, -2], { leanDeg: -6 }), 'arkit-lidar'),
    c('tilted wall: 30 x 30 leaning 12 degrees and turned 40, arkit', 'tilted', frame(30, 30, [0.6, 2.1, -1.9], { leanDeg: 12, turnDeg: 40 }), 'arkit'),
    c('tilted and rolled: 32 x 54 leaning 4, turned -25, rolled 2 degrees, arkit-lidar', 'tilted', frame(32, 54, [-0.3, 1.2, -1.5], { leanDeg: 4, turnDeg: -25, rollDeg: 2 }), 'arkit-lidar'),
    c('picture window 96 x 60, arkit-lidar', 'sizes', frame(96, 60, [0, 1.4, -3]), 'arkit-lidar'),
    c('small 14 x 20, arkit', 'sizes', frame(14, 20, [0.4, 1.7, -1.2]), 'arkit'),
    c('far from the origin (10 m, 8 m), arkit-lidar', 'sizes', frame(36, 48, [10, 1.4, -8], { turnDeg: 15 }), 'arkit-lidar'),
    c('wall behind the origin (the person turned round), arkit', 'turned', frame(36, 60, [0.3, 1.3, 2.2], { turnDeg: 180 }), 'arkit'),
    c('corner spread below the device sigma (device wins), arkit-lidar', 'spread', front, 'arkit-lidar', [0.001, 0.002, 0.0015, 0.0005]),
    c('one corner spread 12 mm (spread wins there), arkit-lidar', 'spread', front, 'arkit-lidar', [0.012, 0.002, 0.002, 0.002]),
    c('all corners spread 8 mm, arkit', 'spread', frame(30, 48, [0.5, 1.2, -2], { turnDeg: 20 }), 'arkit', [0.008, 0.008, 0.008, 0.008]),
    c('noisy +-2 mm, 33 x 57, tilted 3 and turned 30, arkit-lidar', 'noise', noisy(frame(33, 57, [0.4, 1.5, -1.7], { leanDeg: 3, turnDeg: 30 }), 11, 0.002), 'arkit-lidar'),
    c('noisy +-5 mm, 40 x 40, webxr', 'noise', noisy(frame(40, 40, [0, 1.2, -2.4]), 23, 0.005), 'webxr'),
  ];
  // Shapes the checks flag ('check')
  const off = frame(36, 48, [0, 1, -2]);
  off[2] = [off[2][0], off[2][1], off[2][2] + 2.5 * IN];
  list.push(c('one corner 2.5 in proud: not one flat frame (check)', 'check', off, 'arkit-lidar'));
  const h = 48 * IN;
  const dx = Math.tan(deg(8)) * h;
  list.push(c('parallelogram 8 degrees off square (check)', 'check', [[dx, h, -2], [36 * IN + dx, h, -2], [36 * IN, 0, -2], [0, 0, -2]], 'arkit'));
  list.push(c('trapezoid, top 36 bottom 38 (check)', 'check', [[-18 * IN, h, -2], [18 * IN, h, -2], [19 * IN, 0, -2], [-19 * IN, 0, -2]], 'arkit'));
  const p: ArPoint = [0, 1, -1];
  list.push(c('four taps on one spot: refused (null)', 'degenerate', [p, p, p, p], 'arkit'));

  // Every tap order of one tilted, noisy window: the same size, ± and quality each time (order says which is TL)
  const base = noisy(frame(30, 50, [0.8, 1.5, -2.4], { leanDeg: 3, turnDeg: 35, rollDeg: 0.5 }), 7, 0.002);
  const spread: Spread = [0.003, 0.005, 0.007, 0.009];
  for (const perm of permutations([0, 1, 2, 3])) {
    list.push(c(`tap order ${perm.join(',')} of a tilted 30 x 50, arkit with spread`, 'tap-orders', perm.map((i) => base[i]!) as ArQuad, 'arkit', perm.map((i) => spread[i]!) as Spread));
  }
  return list;
}

function permutations(xs: number[]): number[][] {
  return xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r]));
}

export function buildArSizingFixtures() {
  const cases: ArSizingFixture[] = inputs().map((i) => {
    const s = sizeFromArPoints(i.pointsM, { device: i.device ?? undefined, cornerSpreadM: i.cornerSpreadM ?? undefined });
    return { ...i, expected: s === null ? null : { widthIn: s.widthIn, heightIn: s.heightIn, uncertaintyIn: s.uncertaintyIn, quality: s.quality, reasons: s.reasons, order: s.order } };
  });
  return {
    about:
      'Parity fixtures for the Swift port of sizeFromArPoints (packages/shared/src/window-photo-math.ts). Written by scripts/ios-ar-fixtures.ts (npm run ios:fixtures); do not edit by hand. pointsM: metres, AR world space, +Y up, in tap order. device null = absent (webxr). Expected values are raw doubles, inches.',
    tolerance: { inches: 1e-6 },
    constants: {
      inchesPerMetre: INCHES_PER_METRE,
      pointSigmaM: AR_POINT_SIGMA_M,
      scaleSigma: AR_SCALE_SIGMA,
      maxOffPlaneIn: AR_MAX_OFF_PLANE_IN,
      maxCornerOffDeg: AR_MAX_CORNER_OFF_DEG,
      maxSideDiff: AR_MAX_SIDE_DIFF,
    },
    cases,
  };
}

export function fixtureJson(): string {
  return `${JSON.stringify(buildArSizingFixtures(), null, 2)}\n`;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const out = path.join(ROOT, FIXTURE_PATH);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, fixtureJson());
  console.log(`wrote ${FIXTURE_PATH} (${buildArSizingFixtures().cases.length} cases)`);
}
