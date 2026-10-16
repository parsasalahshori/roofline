import { describe, expect, it } from 'vitest';
import { AR_POINT_SIGMA_M, INCHES_PER_METRE, sizeFromArPoints, type ArPoint, type ArQuad } from '../src/window-photo-math.ts';

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
  it('an exact rectangle anywhere in space gives its size, good, with only the AR noise as its ±', () => {
    const s = sizeFromArPoints(frame(35.5, 59.25, 0.3, -0.7, 0.05, [1.2, 1.4, -2.1]))!;
    expect(s.widthIn).toBeCloseTo(35.5, 6);
    expect(s.heightIn).toBeCloseTo(59.25, 6);
    expect(s.quality).toBe('good');
    expect(s.reasons).toEqual([]);
    expect(s.uncertaintyIn.width).toBeCloseTo(AR_POINT_SIGMA_M * INCHES_PER_METRE, 6);
    expect(s.uncertaintyIn.height).toBeCloseTo(AR_POINT_SIGMA_M * INCHES_PER_METRE, 6);
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
