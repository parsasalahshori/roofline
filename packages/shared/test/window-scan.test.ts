import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  computeScanResult,
  scanFitPlane,
  scanFitRectangle,
  scanMat4InverseRigid,
  scanMat4Transform,
  scanProject,
  scanRay,
  scanTransformProblem,
  scanTriangulate,
  type ScanFrame,
  type ScanMark,
  type ScanVec3,
  type ScanWall,
} from '../src/window-scan.ts';
import { buildScene, lookAt, SCENE_INTRINSICS, seeded } from './fixtures/window-scan-scene.ts';

const near = (a: number | null, b: number, tol: number) => expect(Math.abs((a ?? NaN) - b)).toBeLessThanOrEqual(tol);

describe('camera math', () => {
  const m = lookAt([0.5, 1.2, 0.1], [0, 1.4, -3]);

  test('a look-at transform is a rigid transform, and its inverse undoes it', () => {
    expect(scanTransformProblem(m)).toBeNull();
    const p: ScanVec3 = [0.3, -0.2, -2];
    const back = scanMat4Transform(scanMat4InverseRigid(m), scanMat4Transform(m, p));
    back.forEach((v, i) => near(v, p[i]!, 1e-12));
  });

  test('a point projects to the pixel whose ray passes through it', () => {
    const p: ScanVec3 = [0.1, 1.9, -3];
    const px = scanProject(p, m, SCENE_INTRINSICS)!;
    const ray = scanRay(px[0], px[1], m, SCENE_INTRINSICS);
    // distance from p to the ray
    const d: ScanVec3 = [p[0] - ray.origin[0], p[1] - ray.origin[1], p[2] - ray.origin[2]];
    const t = d[0] * ray.dir[0] + d[1] * ray.dir[1] + d[2] * ray.dir[2];
    const off = Math.hypot(d[0] - t * ray.dir[0], d[1] - t * ray.dir[1], d[2] - t * ray.dir[2]);
    expect(off).toBeLessThan(1e-9);
  });

  test('the principal point looks straight along the camera -z, and a point behind the camera has no projection', () => {
    const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const { dir } = scanRay(960, 720, id, SCENE_INTRINSICS);
    near(dir[2], -1, 1e-12);
    expect(scanProject([0, 0, 1], id, SCENE_INTRINSICS)).toBeNull();
    expect(scanProject([0, 0, -2], id, SCENE_INTRINSICS)).toEqual([960, 720]);
    // y is down in the image: a point above the axis has a smaller y
    expect(scanProject([0, 0.5, -2], id, SCENE_INTRINSICS)![1]).toBeLessThan(720);
  });

  test('a transform that is not rigid is refused', () => {
    expect(scanTransformProblem([1, 0, 0])).not.toBeNull();
    expect(scanTransformProblem(m.map((v, i) => (i === 15 ? 2 : v)))).not.toBeNull();
    expect(scanTransformProblem(m.map((v, i) => (i === 0 ? v * 2 : v)))).not.toBeNull();
  });
});

describe('triangulation', () => {
  test('two exact rays meet at the point', () => {
    const p: ScanVec3 = [0.2, 1.0, -3];
    const frames = [lookAt([-1, 1.2, 0], p), lookAt([1, 1.5, 0], p)];
    const rays = frames.map((f) => {
      const px = scanProject(p, f, SCENE_INTRINSICS)!;
      return scanRay(px[0], px[1], f, SCENE_INTRINSICS);
    });
    const got = scanTriangulate(rays)!;
    got.forEach((v, i) => near(v, p[i]!, 1e-9));
  });

  test('one ray, or rays that are parallel, give no point', () => {
    const r = { origin: [0, 0, 0] as ScanVec3, dir: [0, 0, -1] as ScanVec3 };
    expect(scanTriangulate([r])).toBeNull();
    expect(scanTriangulate([r, { origin: [0.5, 0, 0], dir: [0, 0, -1] }])).toBeNull();
  });
});

describe('level rectangle', () => {
  const plane = { point: [0, 1.4, -3] as ScanVec3, normal: [0, 0, 1] as ScanVec3 };
  const viewer: ScanVec3 = [0, 1.4, 0];

  test('a true rectangle gives its own width and height, level', () => {
    const w = 0.9;
    const h = 1.4;
    const fit = scanFitRectangle(
      [
        [-w / 2, 1.4 + h / 2, -3],
        [w / 2, 1.4 + h / 2, -3],
        [w / 2, 1.4 - h / 2, -3],
        [-w / 2, 1.4 - h / 2, -3],
      ],
      plane,
      viewer,
    )!;
    near(fit.widthIn, w * 39.37007874, 1e-9);
    near(fit.heightIn, h * 39.37007874, 1e-9);
    expect(fit.disagrees).toBe(false);
    fit.residualIn.forEach((r) => expect(r).toBeLessThan(1e-9));
  });

  test('a corner set too far out disagrees and is named; the normal faces the viewer either way', () => {
    const w = 0.9;
    const h = 1.4;
    const corners: ScanVec3[] = [
      [-w / 2 - 0.05, 1.4 + h / 2 + 0.05, -3],
      [w / 2, 1.4 + h / 2, -3],
      [w / 2, 1.4 - h / 2, -3],
      [-w / 2, 1.4 - h / 2, -3],
    ];
    for (const normal of [[0, 0, 1], [0, 0, -1]] as ScanVec3[]) {
      const fit = scanFitRectangle(corners, { point: plane.point, normal }, viewer)!;
      expect(fit.disagrees).toBe(true);
      expect(fit.worstCorner).toBe(0);
      near(fit.heightIn, (h + 0.025) * 39.37007874, 1e-6);
      near(fit.widthIn, (w + 0.025) * 39.37007874, 1e-6);
    }
  });

  test('a floor (no "up" in the plane) and a degenerate quad give no rectangle', () => {
    const floor = scanFitRectangle(
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 0, 1],
        [0, 0, 1],
      ],
      { point: [0, 0, 0], normal: [0, 1, 0] },
      [0, 2, 0],
    );
    expect(floor).toBeNull();
    expect(scanFitPlane([[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]])).toBeNull();
  });
});

describe('a clean scan: 34.625 x 55.75 in from 5 frames and 4 close-ups, marks within +/- 1 px', () => {
  const scene = buildScene({ noisePx: 1, seed: 7 });
  const result = computeScanResult(scene.frames, scene.marks, scene.wall);

  test('width and height come out within 1/16 in', () => {
    near(result.widthIn, 34.625, 1 / 16);
    near(result.heightIn, 55.75, 1 / 16);
  });

  test('every gate passes and the scan is accepted', () => {
    expect(result.quality.failed).toEqual([]);
    expect(result.status).toBe('measured');
    expect(result.gates.every((g) => g.passed)).toBe(true);
    expect(result.quality.framesPerCorner).toEqual([6, 6, 6, 6]);
    expect(result.quality.closeups).toBe(4);
    expect(result.quality.reprojRmsPx).toBeLessThan(2);
    expect(result.quality.reprojMaxPx).toBeLessThan(4);
    expect(result.quality.minBaselineDeg).toBeGreaterThan(10);
    expect(result.quality.planeMaxCm).toBeLessThan(0.5);
    expect(result.quality.scaleDiff).toBeLessThan(0.01);
  });

  test('the corners are within 3 mm of the truth', () => {
    result.cornersM!.forEach((p, i) => {
      const t = scene.truth.cornersM[i]!;
      expect(Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2])).toBeLessThan(0.003);
    });
  });

  test('exact marks give the exact size', () => {
    const exact = buildScene({ noisePx: 0 });
    const r = computeScanResult(exact.frames, exact.marks, exact.wall);
    near(r.widthIn, 34.625, 1e-3);
    near(r.heightIn, 55.75, 1e-3);
    expect(r.status).toBe('measured');
  });

  test('other window sizes and sides of the wall come out right too', () => {
    for (const [widthIn, heightIn, center] of [[24, 36, [0.4, 1.6]], [72, 48, [0, 1.3]], [30.125, 62.5, [-0.3, 1.5]]] as const) {
      const s = buildScene({ widthIn, heightIn, center: [...center], noisePx: 1, seed: 3 });
      const r = computeScanResult(s.frames, s.marks, s.wall);
      near(r.widthIn, widthIn, 1 / 16);
      near(r.heightIn, heightIn, 1 / 16);
      expect(r.quality.failed).toEqual([]);
    }
  });

  test('a repeated mark for the same frame and corner counts once (the last wins)', () => {
    const extra: ScanMark = { ...scene.marks[0]!, x: scene.marks[0]!.x + 0.5 };
    const r = computeScanResult(scene.frames, [...scene.marks, extra], scene.wall);
    expect(r.quality.framesPerCorner).toEqual([6, 6, 6, 6]);
  });
});

describe('each gate has a failing case', () => {
  const failedOf = (frames: ScanFrame[], marks: ScanMark[], wall: ScanWall | null) => computeScanResult(frames, marks, wall).quality.failed;

  test('too_few_frames: a corner on only two frames', () => {
    const s = buildScene({ noisePx: 1, seed: 2, closeups: [], regular: [[-1.4, 1.2, 0], [1.4, 1.2, 0]] });
    const r = computeScanResult(s.frames, s.marks, s.wall);
    expect(r.quality.framesPerCorner).toEqual([2, 2, 2, 2]);
    expect(r.quality.failed).toContain('too_few_frames');
    expect(r.status).toBe('needs_review');
    // the corners are still found from the two views
    near(r.widthIn, 34.625, 0.2);
  });

  test('too_few_frames: a corner with no marks at all leaves no size', () => {
    const s = buildScene({ noisePx: 0, drop: ['r1:2', 'r2:2', 'r3:2', 'r4:2', 'r5:2', 'c3:2'] });
    const r = computeScanResult(s.frames, s.marks, s.wall);
    expect(r.quality.framesPerCorner[2]).toBe(0);
    expect(r.quality.failed).toEqual(expect.arrayContaining(['too_few_frames', 'baseline']));
    expect(r.widthIn).toBeNull();
    expect(r.cornersM).toBeNull();
    expect(r.status).toBe('needs_review');
  });

  test('reprojection: one mark 12 px off', () => {
    const s = buildScene({ noisePx: 1, seed: 4, nudges: [['r2', 1, 12, -9]] });
    const r = computeScanResult(s.frames, s.marks, s.wall);
    expect(r.quality.reprojMaxPx).toBeGreaterThan(8);
    expect(r.quality.failed).toContain('reprojection');
    // the worst mark is the one moved
    const worst = r.markErrors.reduce((a, b) => (b.errorPx > a.errorPx ? b : a));
    expect([worst.frameId, worst.corner]).toEqual(['r2', 1]);
  });

  test('reprojection: marks that are all 5 px noisy have an RMS over 3 px', () => {
    const s = buildScene({ noisePx: 7, seed: 9 });
    const r = computeScanResult(s.frames, s.marks, s.wall);
    expect(r.quality.reprojRmsPx).toBeGreaterThan(3);
    expect(r.quality.failed).toContain('reprojection');
  });

  test('baseline: frames a few centimetres apart cannot triangulate', () => {
    const eyes: ScanVec3[] = [[0, 1.3, 0], [0.03, 1.3, 0], [-0.03, 1.31, 0], [0.05, 1.29, 0]];
    const s = buildScene({ noisePx: 0.5, seed: 5, closeups: [], regular: eyes });
    const r = computeScanResult(s.frames, s.marks, s.wall);
    expect(r.quality.minBaselineDeg).toBeLessThan(4);
    expect(r.quality.failed).toContain('baseline');
    expect(r.quality.failed).not.toContain('too_few_frames');
  });

  test('sym_ratio: a window whose bottom right corner is 2 in lower than it should be', () => {
    const s = buildScene({ noisePx: 0.5, seed: 6, cornerOffsets: { 2: [0, -2 * 0.0254, 0] } });
    const r = computeScanResult(s.frames, s.marks, s.wall);
    expect(r.quality.failed).toContain('sym_ratio');
    expect(r.gates.find((g) => g.code === 'sym_ratio')!.passed).toBe(false);
    expect(r.fit!.disagrees).toBe(true);
    // a bottom corner too low: it could as well be the other bottom corner too high, so none is named
    expect(r.fit!.worstCorner).toBeNull();
  });

  test('sym_ratio: also fails on 2% when the absolute difference is small', () => {
    // 24 x 24 in: a side 0.6 in (2.5%) long is under 0.75 in, over 2%
    const s = buildScene({ widthIn: 24, heightIn: 24, noisePx: 0, cornerOffsets: { 1: [0.6 * 0.0254, 0, 0] } });
    const r = computeScanResult(s.frames, s.marks, s.wall);
    expect(r.quality.failed).toContain('sym_ratio');
  });

  test('plane: a corner 5 cm out of the wall', () => {
    const s = buildScene({ noisePx: 0.5, seed: 8, cornerOffsets: { 0: [0, 0, 0.05] } });
    const r = computeScanResult(s.frames, s.marks, s.wall);
    expect(r.quality.planeMaxCm).toBeGreaterThan(1);
    expect(r.quality.failed).toContain('plane');
  });

  test('scale: a wall plane 0.5 m too near makes the single-frame size 17% small', () => {
    const s = buildScene({ noisePx: 0.5, seed: 10, wall: { point: [0, 1.4, -2.5], normal: [0, 0, 1] } });
    const r = computeScanResult(s.frames, s.marks, s.wall);
    expect(r.quality.scaleDiff).toBeGreaterThan(0.1);
    expect(r.quality.failed).toEqual(['scale']);
  });

  test('scale: without a wall it is not checked, and passes', () => {
    const s = buildScene({ noisePx: 0.5, seed: 10 });
    const r = computeScanResult(s.frames, s.marks, null);
    expect(r.quality.scaleDiff).toBe(0);
    expect(r.singleFrameIn).toBeNull();
    expect(r.quality.failed).toEqual([]);
  });

  test('no_closeups: only a warning; the scan is still accepted', () => {
    const s = buildScene({ noisePx: 1, seed: 11, closeups: [] });
    const r = computeScanResult(s.frames, s.marks, s.wall);
    expect(r.quality.closeups).toBe(0);
    const g = r.gates.find((x) => x.code === 'no_closeups')!;
    expect(g.passed).toBe(false);
    expect(g.warning).toBe(true);
    expect(r.quality.failed).toEqual([]);
    expect(r.status).toBe('measured');
    near(r.widthIn, 34.625, 1 / 8);
  });

  test('a reviewer fixing the mark brings a failing scan back: the 12 px mark moved to where it belongs passes', () => {
    const s = buildScene({ noisePx: 1, seed: 4, nudges: [['r2', 1, 12, -9]] });
    expect(failedOf(s.frames, s.marks, s.wall)).toContain('reprojection');
    const clean = buildScene({ noisePx: 1, seed: 4 });
    expect(failedOf(s.frames, s.marks.map((m) => (m.frameId === 'r2' && m.corner === 1 ? clean.marks.find((c) => c.frameId === 'r2' && c.corner === 1)! : m)), s.wall)).toEqual([]);
  });

  test('a mark for a frame that is not there is ignored', () => {
    const s = buildScene({ noisePx: 1, seed: 4 });
    const r = computeScanResult(s.frames, [...s.marks, { frameId: 'nope', corner: 0, x: 1, y: 1, source: 'user' }], s.wall);
    expect(r.quality.framesPerCorner).toEqual([6, 6, 6, 6]);
  });
});

describe('random scenes: the size is always within 1/16 in with +/- 1 px marks', () => {
  test('40 windows, eyes and noise drawn at random', () => {
    const rand = seeded(2026);
    for (let i = 0; i < 40; i++) {
      const widthIn = 20 + rand() * 50;
      const heightIn = 24 + rand() * 50;
      const eyes: ScanVec3[] = Array.from({ length: 5 }, () => [(rand() - 0.5) * 3.2, 1.0 + rand() * 0.8, rand() * 0.3]);
      const s = buildScene({ widthIn, heightIn, regular: eyes, noisePx: 1, seed: 100 + i });
      const r = computeScanResult(s.frames, s.marks, s.wall);
      near(r.widthIn, widthIn, 1 / 16);
      near(r.heightIn, heightIn, 1 / 16);
    }
  });
});

describe('the JSON fixtures the iOS code also runs', () => {
  const dir = new URL('./fixtures/window-scan/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

  test('there are 3 or 4 of them', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.length).toBeLessThanOrEqual(4);
  });

  for (const file of files) {
    test(`${file}: the computation matches the expected values`, () => {
      const fx = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as {
        input: { frames: ScanFrame[]; marks: ScanMark[]; wall: ScanWall | null };
        expected: { cornersM: ScanVec3[] | null; widthIn: number | null; heightIn: number | null; failed: string[]; status: string; tolerance: { inches: number; metres: number } };
      };
      const r = computeScanResult(fx.input.frames, fx.input.marks, fx.input.wall);
      expect(r.quality.failed).toEqual(fx.expected.failed);
      expect(r.status).toBe(fx.expected.status);
      if (fx.expected.widthIn === null) {
        expect(r.widthIn).toBeNull();
        return;
      }
      near(r.widthIn, fx.expected.widthIn, fx.expected.tolerance.inches);
      near(r.heightIn, fx.expected.heightIn!, fx.expected.tolerance.inches);
      r.cornersM!.forEach((p, i) => p.forEach((v, k) => near(v, fx.expected.cornersM![i]![k]!, fx.expected.tolerance.metres)));
    });
  }
});
