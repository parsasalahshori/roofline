import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { CAMERA_HEIGHT_M, type Camera, type Vec, wallsOf } from '../../src/estimator/windows-geometry.ts';
import { correctedCamera, decodeGray, FIT_GOOD_SCORE, fitCorners, lineUp, mainWall, type Quad, sobel, wallQuad } from '../../src/estimator/windows-lineup.ts';

/*
 * Synthetic renders: a house's front wall drawn with a known camera (a light wall, a dark roof band over it, a grey
 * street), saved as a JPEG. The line-up, given the camera off by a known heading and the wall height off by a known
 * share, must find both; blank or noise photos are 'unknown' or 'off', never 'good'.
 */

const W = 640;
const H = 640;
const TRUE: Camera = { pos: [0, 0], heightM: CAMERA_HEIGHT_M, heading: 4, pitch: 4, fov: 60, widthPx: W, heightPx: H };
const EAVE = 3.0;
/** A 14 m by 9 m house, front wall 16 m north of the camera. */
const RING: Vec[] = [
  [-7, 16],
  [7, 16],
  [7, 25],
  [-7, 25],
];
const WALL = mainWall(wallsOf(RING), [0, 0])!;

function inside(p: Vec, q: Quad): boolean {
  let hit = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const [xi, yi] = q[i]!;
    const [xj, yj] = q[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Seeded noise in -1..1. */
function noise(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

function render(paint: (x: number, y: number) => number): Uint8Array {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = Math.max(0, Math.min(255, Math.round(paint(x, y))));
    const i = (y * W + x) * 4;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ width: W, height: H, data }, 90).data);
}

function houseJpeg(): Uint8Array {
  const wall = wallQuad(TRUE, WALL, EAVE)!;
  const roof = wallQuad(TRUE, WALL, EAVE + 2.2)!;
  const roofBand: Quad = [wall[3], wall[2], roof[2], roof[3]];
  const n = noise(7);
  return render((x, y) => {
    const p: Vec = [x + 0.5, y + 0.5];
    if (inside(p, wall)) return 190 + 30 * n(); // brick or siding: textured
    if (inside(p, roofBand)) return 55 + 20 * n();
    return (y > H * 0.6 ? 120 : 150) + 20 * n();
  });
}

const edgesOf = (bytes: Uint8Array) => sobel(decodeGray(bytes)!);

describe('the wall line-up', () => {
  const edges = edgesOf(houseJpeg());

  it('a wall drawn with the true camera and height lines up', () => {
    const r = lineUp(edges, TRUE, WALL, EAVE);
    expect(r.fit).toBe('good');
    expect(r.fitScore!).toBeGreaterThanOrEqual(FIT_GOOD_SCORE);
    expect(Math.abs(r.headingCorrectionDeg)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(r.eaveM! - EAVE) / EAVE).toBeLessThan(0.05);
  });

  it('recovers a 3 degree heading error and a 15% height error', () => {
    const r = lineUp(edges, { ...TRUE, heading: TRUE.heading - 3 }, WALL, EAVE / 1.15);
    expect(r.fit).toBe('good');
    expect(Math.abs(r.headingCorrectionDeg - 3)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(r.eaveM! - EAVE) / EAVE).toBeLessThan(0.05);
    // Before the line-up the drawn wall was off; after it, on the edges.
    expect(r.quadBefore![0][0]).not.toBeCloseTo(r.quad![0][0], 0);
  });

  it('a blank photo is unknown (no edges: blurred or blank)', () => {
    const r = lineUp(edgesOf(render(() => 128)), TRUE, WALL, EAVE);
    expect(r.fit).toBe('unknown');
    expect(r.blurred).toBe(true);
  });

  it('a noise photo never lines up', () => {
    const n = noise(3);
    const r = lineUp(edgesOf(render(() => 128 + 120 * n())), TRUE, WALL, EAVE);
    expect(r.fit).not.toBe('good');
  });

  it('a blurred house (smooth wall region in a sharp street) is unknown and flagged blurred', () => {
    const wall = wallQuad(TRUE, WALL, EAVE + 3)!;
    const n = noise(11);
    const bytes = render((x, y) => {
      if (inside([x + 0.5, y + 0.5], wall)) return 150 + 10 * Math.sin(x / 60);
      return ((x >> 3) + (y >> 3)) % 2 === 0 ? 60 + 5 * n() : 200 + 5 * n();
    });
    const r = lineUp(edgesOf(bytes), TRUE, WALL, EAVE);
    expect(r.fit).toBe('unknown');
    expect(r.blurred).toBe(true);
  });

  it('a photo that is not a JPEG is not decoded', () => {
    expect(decodeGray(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('fitting dragged corners', () => {
  it('recovers heading, distance and wall height from the four corners', () => {
    const truth = correctedCamera(TRUE, WALL, 2.5, 1.2);
    const dragged = wallQuad(truth, WALL, 3.4)!;
    const fit = fitCorners(TRUE, WALL, dragged);
    expect(Math.abs(fit.headingCorrectionDeg - 2.5)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(fit.distanceScale - 1.2)).toBeLessThan(0.02);
    expect(Math.abs(fit.eaveM - 3.4) / 3.4).toBeLessThan(0.03);
    expect(fit.errorPx).toBeLessThan(2);
  });
});
