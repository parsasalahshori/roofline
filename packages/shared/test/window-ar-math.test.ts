import { describe, expect, it } from 'vitest';
import { AR_POINT_SIGMA_M, AR_SCALE_SIGMA, arCornerOrder, INCHES_PER_METRE, sizeFromArPoints, type ArPoint, type ArQuad } from '../src/window-photo-math.ts';

// A seeded random source so the noise trials are the same on every run.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IN = 1 / INCHES_PER_METRE;

/** Rotation about x, then y, then z (radians). */
function rotate([x, y, z]: ArPoint, ax: number, ay: number, az: number): ArPoint {
  const y1 = y * Math.cos(ax) - z * Math.sin(ax);
  const z1 = y * Math.sin(ax) + z * Math.cos(ax);
  const x2 = x * Math.cos(ay) + z1 * Math.sin(ay);
  const z2 = -x * Math.sin(ay) + z1 * Math.cos(ay);
  const x3 = x2 * Math.cos(az) - y1 * Math.sin(az);
  const y3 = x2 * Math.sin(az) + y1 * Math.cos(az);
  return [x3, y3, z2];
}

/** A wIn x hIn frame (TL, TR, BR, BL in its own plane, y up), turned and moved somewhere in AR space, metres. */
function frame(wIn: number, hIn: number, ax: number, ay: number, az: number, at: ArPoint): ArQuad {
  const w = wIn * IN;
  const h = hIn * IN;
  const local: ArPoint[] = [
    [-w / 2, h / 2, 0],
    [w / 2, h / 2, 0],
    [w / 2, -h / 2, 0],
    [-w / 2, -h / 2, 0],
  ];
  return local.map((p) => {
    const r = rotate(p, ax, ay, az);
    return [r[0] + at[0], r[1] + at[1], r[2] + at[2]];
  }) as ArQuad;
}

describe('sizeFromArPoints', () => {
  it('an exact rectangle anywhere in space gives its size, good, with only the AR noise and scale term as its ±', () => {
    const s = sizeFromArPoints(frame(35.5, 59.25, 0.3, -0.7, 0.05, [1.2, 1.4, -2.1]))!;
    expect(s.widthIn).toBeCloseTo(35.5, 6);
    expect(s.heightIn).toBeCloseTo(59.25, 6);
    expect(s.quality).toBe('good');
    expect(s.reasons).toEqual([]);
    // No device: 'webxr'. Point noise and 1% of the side, in quadrature
    const point = AR_POINT_SIGMA_M.webxr * INCHES_PER_METRE;
    expect(s.uncertaintyIn.width).toBeCloseTo(Math.hypot(point, AR_SCALE_SIGMA * 35.5), 6);
    expect(s.uncertaintyIn.height).toBeCloseTo(Math.hypot(point, AR_SCALE_SIGMA * 59.25), 6);
  });

  it('the device sets the point noise: LiDAR < ARKit < WebXR; absent is WebXR', () => {
    const q = frame(30, 40, 0, 0.4, 0, [0, 1.3, -1.8]);
    const u = (device?: 'webxr' | 'arkit' | 'arkit-lidar') => sizeFromArPoints(q, { device })!.uncertaintyIn.width;
    expect(u()).toBeCloseTo(u('webxr'), 12);
    expect(u('arkit-lidar')).toBeLessThan(u('arkit'));
    expect(u('arkit')).toBeLessThan(u('webxr'));
    expect(u('arkit-lidar')).toBeCloseTo(Math.hypot(0.0025 * INCHES_PER_METRE, 0.3), 9);
  });

  it('a measured corner spread larger than the device noise replaces it for that corner; a smaller one does not', () => {
    const q = frame(30, 40, 0, 0, 0, [0, 1.3, -1.8]);
    const base = sizeFromArPoints(q, { device: 'arkit-lidar' })!;
    const small = sizeFromArPoints(q, { device: 'arkit-lidar', cornerSpreadM: [0.001, 0.001, 0.001, 0.001] })!;
    expect(small.uncertaintyIn).toEqual(base.uncertaintyIn);
    // One corner at 10 mm: point term sqrt(3 x 2.5^2 + 10^2) / 2 mm
    const one = sizeFromArPoints(q, { device: 'arkit-lidar', cornerSpreadM: [0.01, 0, 0, 0] })!;
    const pointIn = (Math.sqrt(3 * 0.0025 ** 2 + 0.01 ** 2) / 2) * INCHES_PER_METRE;
    expect(one.uncertaintyIn.width).toBeCloseTo(Math.hypot(pointIn, 0.3), 9);
    expect(one.uncertaintyIn.height).toBeCloseTo(Math.hypot(pointIn, 0.4), 9);
  });

  it('corners are ordered by gravity, never by tap order: all 24 tap orders give the same size, ± and quality', () => {
    // A 30 x 50 in frame (tall), on a wall turned 35 degrees, leaning 3 degrees, with a little noise
    const rand = rng(7);
    const q = frame(30, 50, 0.05, 0.6, 0.01, [0.8, 1.5, -2.4]).map((p) => p.map((v) => v + (rand() * 2 - 1) * 0.002)) as ArQuad;
    const want = sizeFromArPoints(q, { device: 'arkit', cornerSpreadM: [0.003, 0.005, 0.007, 0.009] })!;
    expect(want.widthIn).toBeGreaterThan(29.5);
    expect(want.widthIn).toBeLessThan(30.5);
    expect(want.heightIn).toBeGreaterThan(49.5);
    const perms = (xs: number[]): number[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r])));
    const all = perms([0, 1, 2, 3]);
    expect(all).toHaveLength(24);
    for (const perm of all) {
      const tapped = perm.map((i) => q[i]!) as ArQuad;
      const spread = perm.map((i) => [0.003, 0.005, 0.007, 0.009][i]!) as [number, number, number, number];
      const s = sizeFromArPoints(tapped, { device: 'arkit', cornerSpreadM: spread })!;
      expect(s.widthIn).toBeCloseTo(want.widthIn, 9);
      expect(s.heightIn).toBeCloseTo(want.heightIn, 9);
      expect(s.uncertaintyIn.width).toBeCloseTo(want.uncertaintyIn.width, 9);
      expect(s.uncertaintyIn.height).toBeCloseTo(want.uncertaintyIn.height, 9);
      expect(s.quality).toBe(want.quality);
      // The same physical corner comes out as top-left every time
      expect(perm[s.order[0]]).toBe(want.order[0]);
    }
  });

  it('a person standing in front (AR origin on their side) gets TL on their left, whichever side of the origin the wall is', () => {
    // Wall 2 m ahead along -Z: x grows to the right. The input is tapped BR, BL, TL, TR.
    const q = frame(36, 48, 0, 0, 0, [0.3, 1.2, -2]);
    expect(arCornerOrder([q[2], q[3], q[0], q[1]])).toEqual([2, 3, 0, 1]);
    // Wall 2 m behind along +Z (the person turned round): right is -X now
    const back = frame(36, 48, 0, Math.PI, 0, [0.3, 1.2, 2]);
    expect(back[0][0]).toBeGreaterThan(back[1][0]);
    expect(arCornerOrder(back)).toEqual([0, 1, 2, 3]);
  });

  it('the old tap-order bug: tapping TL, BL, BR, TR (down the left first) no longer swaps width and height', () => {
    const q = frame(24, 60, 0, 0.2, 0, [0, 1.2, -1.5]);
    const s = sizeFromArPoints([q[0], q[3], q[2], q[1]])!;
    expect(s.widthIn).toBeCloseTo(24, 6);
    expect(s.heightIn).toBeCloseTo(60, 6);
    expect(s.quality).toBe('good');
  });

  it('rotated and tilted rectangles with ±3 mm noise per axis recover the size within 1/16 in on average', () => {
    const rand = rng(42);
    const errs: number[] = [];
    const signed: number[] = [];
    let checks = 0;
    for (let t = 0; t < 400; t++) {
      const wIn = 14 + rand() * 60;
      const hIn = 14 + rand() * 60;
      const q = frame(wIn, hIn, (rand() - 0.5) * 1.2, (rand() - 0.5) * 3, (rand() - 0.5) * 0.1, [(rand() - 0.5) * 4, rand() * 2, -1 - rand() * 2]);
      const noisy = q.map((p) => p.map((v) => v + (rand() * 2 - 1) * 0.003)) as ArQuad;
      const s = sizeFromArPoints(noisy)!;
      errs.push(Math.abs(s.widthIn - wIn), Math.abs(s.heightIn - hIn));
      signed.push(s.widthIn - wIn, s.heightIn - hIn);
      if (s.quality === 'check') checks += 1;
    }
    const mean = (vs: number[]) => vs.reduce((a, b) => a + b, 0) / vs.length;
    expect(mean(errs)).toBeLessThan(1 / 16);
    expect(Math.abs(mean(signed))).toBeLessThan(1 / 64);
    // ±3 mm on windows of 14 in and up is well inside the shape checks
    expect(checks).toBe(0);
  });

  it('a skewed quad (a parallelogram, 8 degrees off square) is flagged', () => {
    const w = 36 * IN;
    const h = 48 * IN;
    const dx = Math.tan((8 * Math.PI) / 180) * h;
    const q: ArQuad = [
      [dx, h, -2],
      [w + dx, h, -2],
      [w, 0, -2],
      [0, 0, -2],
    ];
    const s = sizeFromArPoints(q)!;
    expect(s.quality).toBe('check');
    expect(s.reasons.join(' ')).toMatch(/off square/);
  });

  it('corners that are not on one flat frame (one 2.5 in proud: 0.625 in off the plane) are flagged and the ± grows', () => {
    const q = frame(36, 48, 0, 0, 0, [0, 1, -2]);
    q[2] = [q[2][0], q[2][1], q[2][2] + 2.5 * IN];
    const s = sizeFromArPoints(q)!;
    expect(s.quality).toBe('check');
    expect(s.reasons.join(' ')).toMatch(/flat frame/);
    expect(s.uncertaintyIn.width).toBeGreaterThan(0.2);
  });

  it('opposite sides that differ by more than 3% are flagged, with half the difference in the ±', () => {
    // A trapezoid: top 36 in, bottom 38 in (5.4%), symmetric so the corners are only ~1.2 degrees off square
    const h = 48 * IN;
    const q: ArQuad = [
      [-18 * IN, h, -2],
      [18 * IN, h, -2],
      [19 * IN, 0, -2],
      [-19 * IN, 0, -2],
    ];
    const s = sizeFromArPoints(q)!;
    expect(s.widthIn).toBeCloseTo(37, 6);
    expect(s.quality).toBe('check');
    expect(s.reasons.join(' ')).toMatch(/top and bottom differ/);
    expect(s.uncertaintyIn.width).toBeGreaterThan(1);
  });

  it('degenerate input gives null', () => {
    const p: ArPoint = [0, 0, -1];
    expect(sizeFromArPoints([p, p, p, p])).toBeNull();
    expect(sizeFromArPoints([[Number.NaN, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]])).toBeNull();
  });
});
