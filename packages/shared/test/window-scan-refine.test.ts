import { describe, expect, test } from 'vitest';
import { computeScanResult, scanProject, type ScanFrame, type ScanMark, type ScanVec3 } from '../src/window-scan.ts';
import { computeRefinedScan, mergeScanMarks, SCAN_REFINE_LIMITS, scanColmapDecision, scanEffectiveFrames, scanOrderQuad, scanProjectedBox, scanRobustMarks } from '../src/window-scan-refine.ts';
import { buildScene, lookAt, SCENE_INTRINSICS } from './fixtures/window-scan-scene.ts';

const near = (a: number | null, b: number, tol: number) => expect(Math.abs((a ?? NaN) - b)).toBeLessThanOrEqual(tol);
const mark = (frameId: string, corner: 0 | 1 | 2 | 3, x: number, y: number, source: ScanMark['source'] = 'snap'): ScanMark => ({ frameId, corner, x, y, source });

describe('refined poses', () => {
  const scene = buildScene({ noisePx: 0 });
  test('a refined pose replaces only that frame’s transform', () => {
    const moved = lookAt([0.3, 1.3, 0.2], [0, 1.4, -3]);
    const out = scanEffectiveFrames(scene.frames, { r2: moved });
    expect(out[1]!.cameraTransform).toEqual(moved);
    expect(out[0]!.cameraTransform).toEqual(scene.frames[0]!.cameraTransform);
    expect(scene.frames[1]!.cameraTransform).not.toEqual(moved);
    expect(scanEffectiveFrames(scene.frames, null)).toEqual(scene.frames);
    // a pose that is not 16 numbers is ignored
    expect(scanEffectiveFrames(scene.frames, { r1: [1, 2, 3] })[0]!.cameraTransform).toEqual(scene.frames[0]!.cameraTransform);
  });

  test('COLMAP’s poses are taken at 2 cm and 4 frames, and the reason is a plain sentence when they are not', () => {
    expect(scanColmapDecision({ registered: 8, total: 9, alignmentRmsCm: 0.4, rotationRmsDeg: 0.1 })).toEqual({ use: true, reason: null });
    expect(scanColmapDecision({ registered: 4, total: 9, alignmentRmsCm: 1.99, rotationRmsDeg: 0.1 }).use).toBe(true);
    expect(scanColmapDecision({ registered: 3, total: 9, alignmentRmsCm: 0.1, rotationRmsDeg: 0 })).toMatchObject({ use: false, reason: expect.stringContaining('only 3 of 9') });
    expect(scanColmapDecision({ registered: 8, total: 9, alignmentRmsCm: 2.0, rotationRmsDeg: 0 })).toMatchObject({ use: false, reason: expect.stringContaining('cm off') });
    expect(scanColmapDecision({ registered: 8, total: 9, alignmentRmsCm: 0.5, rotationRmsDeg: 3 })).toMatchObject({ use: false, reason: expect.stringContaining('degrees') });
    expect(scanColmapDecision({ registered: 8, total: 9, alignmentRmsCm: null, rotationRmsDeg: null }).use).toBe(false);
  });
});

describe('the prompt for the AI on a frame', () => {
  const scene = buildScene({ noisePx: 0 });
  const truth = scene.truth.cornersM;

  test('the box holds the projected window, padded by 8%, with the centre as the point', () => {
    const f = scene.frames[0]!;
    const px = truth.map((p) => scanProject(p, f.cameraTransform, f.intrinsics)!);
    const b = scanProjectedBox(truth, f)!;
    const [x0, x1] = [Math.min(...px.map((p) => p[0])), Math.max(...px.map((p) => p[0]))];
    const [y0, y1] = [Math.min(...px.map((p) => p[1])), Math.max(...px.map((p) => p[1]))];
    near(b.box[0], x0 - (x1 - x0) * 0.08, 1e-9);
    near(b.box[2], x1 + (x1 - x0) * 0.08, 1e-9);
    near(b.box[1], y0 - (y1 - y0) * 0.08, 1e-9);
    near(b.box[3], y1 + (y1 - y0) * 0.08, 1e-9);
    near(b.point[0], (x0 + x1) / 2, 1e-9);
    expect(b.visibleShare).toBe(1);
  });

  test('a close-up of a corner sees only part of the window: the box is cut to the picture and says so', () => {
    const closeup = scene.frames.find((f) => f.kind === 'closeup')!;
    const b = scanProjectedBox(truth, closeup);
    expect(b).not.toBeNull();
    expect(b!.visibleShare).toBeLessThan(SCAN_REFINE_LIMITS.minVisibleShare);
    expect(b!.box[0]).toBeGreaterThanOrEqual(0);
    expect(b!.box[2]).toBeLessThanOrEqual(closeup.intrinsics.width);
    // the point is inside the picture
    expect(b!.point[0]).toBeGreaterThanOrEqual(0);
    expect(b!.point[1]).toBeLessThanOrEqual(closeup.intrinsics.height);
  });

  test('a window behind the camera, or with no size, has no box', () => {
    const away = { cameraTransform: lookAt([0, 1.4, 0], [0, 1.4, 3]), intrinsics: SCENE_INTRINSICS };
    expect(scanProjectedBox(truth, away)).toBeNull();
    expect(scanProjectedBox([truth[0]!, truth[0]!, truth[0]!, truth[0]!], scene.frames[0]!)).toBeNull();
    expect(scanProjectedBox([truth[0]!], scene.frames[0]!)).toBeNull();
  });
});

describe('the AI quad in the scan’s corner order', () => {
  const scene = buildScene({ noisePx: 0 });
  const frame = scene.frames[2]!;
  const inOrder = scene.truth.cornersM.map((p) => scanProject(p, frame.cameraTransform, frame.intrinsics)!);

  test('an upright picture: the mask fit already has TL, TR, BR, BL', () => {
    expect(scanOrderQuad(inOrder, frame, null)).toEqual(inOrder);
  });

  test('with the current window projected, every cyclic start is put right', () => {
    for (let k = 0; k < 4; k++) {
      const cyc = [0, 1, 2, 3].map((i) => inOrder[(i + k) % 4]!);
      const got = scanOrderQuad(cyc, frame, inOrder);
      got.forEach((p, i) => near(Math.hypot(p[0] - inOrder[i]![0], p[1] - inOrder[i]![1]), 0, 1e-9));
    }
  });

  test('a phone held upright: the native picture is turned a quarter, and gravity still puts TL first', () => {
    // Roll the camera a quarter turn about its own axis: the window is on its side in the (landscape) picture
    const base = frame.cameraTransform;
    const roll = (a: number): number[] => {
      const c = Math.cos(a);
      const s = Math.sin(a);
      // new x = c*x + s*y, new y = -s*x + c*y (columns of the rotation, in the camera's own frame)
      const x = [base[0]! * c + base[4]! * s, base[1]! * c + base[5]! * s, base[2]! * c + base[6]! * s];
      const y = [-base[0]! * s + base[4]! * c, -base[1]! * s + base[5]! * c, -base[2]! * s + base[6]! * c];
      return [x[0]!, x[1]!, x[2]!, 0, y[0]!, y[1]!, y[2]!, 0, base[8]!, base[9]!, base[10]!, 0, base[12]!, base[13]!, base[14]!, 1];
    };
    for (const quarter of [Math.PI / 2, -Math.PI / 2]) {
      const rolled = { ...frame, cameraTransform: roll(quarter) };
      const px = scene.truth.cornersM.map((p) => scanProject(p, rolled.cameraTransform, rolled.intrinsics)!);
      // the picture shows the corners in screen-clockwise order starting anywhere: give them to the function that way
      const clockwiseFromTopLeftOfPicture = (() => {
        const idx = [0, 1, 2, 3];
        const cx = px.reduce((s, p) => s + p[0], 0) / 4;
        const cy = px.reduce((s, p) => s + p[1], 0) / 4;
        const ang = (i: number) => Math.atan2(px[i]![1] - cy, px[i]![0] - cx);
        idx.sort((a, b) => ang(a) - ang(b));
        return idx.map((i) => px[i]!);
      })();
      const got = scanOrderQuad(clockwiseFromTopLeftOfPicture, rolled, null);
      got.forEach((p, i) => near(Math.hypot(p[0] - px[i]![0], p[1] - px[i]![1]), 0, 1e-9));
    }
  });
});

describe('candidate marks', () => {
  test('an AI mark within 8 px of the phone’s replaces it; further off, both stay as candidates; a reviewer’s mark stands alone', () => {
    const base = [mark('a', 0, 100, 100), mark('a', 1, 200, 100), mark('a', 2, 200, 200, 'user'), mark('b', 0, 50, 50)];
    const ai = [mark('a', 0, 104, 103, 'ai'), mark('a', 1, 230, 100, 'ai'), mark('a', 2, 300, 300, 'ai'), mark('c', 3, 10, 10, 'ai')];
    const m = mergeScanMarks(base, ai);
    const get = (f: string, c: number) => m.marks.find((x) => x.frameId === f && x.corner === c);
    expect(get('a', 0)).toMatchObject({ x: 104, y: 103, source: 'ai' });
    expect(get('a', 1)).toMatchObject({ x: 200, source: 'snap' });
    expect(m.alternatives).toEqual([mark('a', 1, 230, 100, 'ai')]);
    expect(get('a', 2)).toMatchObject({ x: 200, y: 200, source: 'user' });
    expect(get('b', 0)).toMatchObject({ x: 50 });
    expect(get('c', 3)).toMatchObject({ x: 10, source: 'ai' });
    expect(m.marks).toHaveLength(5);
    // exactly 8 px agrees
    expect(mergeScanMarks([mark('a', 0, 0, 0)], [mark('a', 0, 8, 0, 'ai')]).alternatives).toHaveLength(0);
    expect(mergeScanMarks([mark('a', 0, 0, 0)], [mark('a', 0, 8.1, 0, 'ai')]).alternatives).toHaveLength(1);
  });
});

describe('robust triangulation', () => {
  const scene = buildScene({ noisePx: 0.4, seed: 5 });
  const frames = scene.frames;

  test('with clean marks every mark is kept and nothing is dropped', () => {
    const r = scanRobustMarks(frames, scene.marks);
    expect(r.marks).toHaveLength(scene.marks.length);
    expect(r.dropped).toEqual([]);
    expect(r.unused).toEqual([]);
  });

  test('a mark 40 px off is thrown out, the rest stay, and the size is right', () => {
    const bad = scene.marks.map((m) => (m.frameId === 'r2' && m.corner === 1 ? { ...m, x: m.x + 40, y: m.y - 25 } : m));
    const r = scanRobustMarks(frames, bad);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]).toMatchObject({ frameId: 'r2', corner: 1 });
    expect(r.marks).toHaveLength(scene.marks.length - 1);
    const comp = computeScanResult(frames, r.marks, scene.wall);
    expect(comp.status).toBe('measured');
    near(comp.widthIn, scene.truth.widthIn, 0.0625);
    near(comp.heightIn, scene.truth.heightIn, 0.0625);
    // without the robust step the same marks fail the gates
    expect(computeScanResult(frames, bad, scene.wall).quality.failed).toContain('reprojection');
  });

  test('a second candidate on a frame: the one that agrees with the others is chosen', () => {
    const right = scene.marks.find((m) => m.frameId === 'r3' && m.corner === 0)!;
    const wrong = mark('r3', 0, right.x + 60, right.y + 30, 'ai');
    const r = scanRobustMarks(frames, [...scene.marks.filter((m) => m !== right), wrong, right]);
    expect(r.marks.find((m) => m.frameId === 'r3' && m.corner === 0)).toEqual(right);
    expect(r.unused).toEqual([wrong]);
    expect(r.dropped).toEqual([]);
    // and the other way round (the wrong one first)
    const r2 = scanRobustMarks(frames, [wrong, right, ...scene.marks.filter((m) => m !== right)]);
    expect(r2.marks.find((m) => m.frameId === 'r3' && m.corner === 0)).toEqual(right);
  });

  test('three marks are kept even when one is off: there is nothing to throw out down to', () => {
    const three = buildScene({ noisePx: 0, regular: [[-1.4, 1.2, 0], [0, 1.3, 0], [1.5, 1.2, 0]], closeups: [] });
    const bad = three.marks.map((m) => (m.frameId === 'r2' && m.corner === 0 ? { ...m, x: m.x + 30 } : m));
    const r = scanRobustMarks(three.frames, bad);
    expect(r.marks.filter((m) => m.corner === 0)).toHaveLength(3);
    expect(r.dropped).toEqual([]);
  });

  test('a reviewer’s mark is never thrown out, however far it is', () => {
    const bad = scene.marks.map((m) => (m.frameId === 'r2' && m.corner === 1 ? { ...m, x: m.x + 40, source: 'user' as const } : m));
    const r = scanRobustMarks(frames, bad);
    expect(r.dropped).toEqual([]);
    expect(r.marks.find((m) => m.frameId === 'r2' && m.corner === 1)).toMatchObject({ source: 'user' });
  });

  test('a corner with marks on one frame only keeps its mark', () => {
    const r = scanRobustMarks(frames, [mark('r1', 0, 900, 700)]);
    expect(r.marks).toEqual([mark('r1', 0, 900, 700)]);
  });
});

describe('the refined scan', () => {
  const scene = buildScene({ noisePx: 0.3, seed: 9 });

  test('the AI’s marks save a scan whose phone marks are off on two frames', () => {
    const phone: ScanMark[] = scene.marks.map((m) => {
      if (m.frameId === 'r1' && m.corner === 0) return { ...m, x: m.x + 15, y: m.y + 11 };
      if (m.frameId === 'r4' && m.corner === 2) return { ...m, x: m.x - 20, y: m.y + 6 };
      return m;
    });
    const ai: ScanMark[] = scene.marks.filter((m) => m.frameId.startsWith('r')).map((m) => ({ ...m, source: 'ai' as const }));
    const plain = computeScanResult(scene.frames, phone, scene.wall);
    expect(plain.status).toBe('needs_review');
    const refined = computeRefinedScan(scene.frames, phone, ai, scene.wall);
    expect(refined.comp.status).toBe('measured');
    near(refined.comp.widthIn, scene.truth.widthIn, 0.0625);
    near(refined.comp.heightIn, scene.truth.heightIn, 0.0625);
    // the two disagreeing phone marks lost to the AI's; nothing had to be thrown out
    expect(refined.alternatives).toHaveLength(2);
    expect(refined.dropped).toEqual([]);
    expect(refined.marks.filter((m) => m.source === 'ai').length).toBeGreaterThan(10);
  });

  test('with no AI marks the refined scan is the plain scan', () => {
    const plain = computeScanResult(scene.frames, scene.marks, scene.wall);
    const refined = computeRefinedScan(scene.frames, scene.marks, [], scene.wall);
    expect(refined.comp.widthIn).toBeCloseTo(plain.widthIn!, 9);
    expect(refined.marks).toHaveLength(scene.marks.length);
  });

  test('refined poses are what the corners are triangulated with', () => {
    // Move every camera a little in the scan, then give the true poses back as the refinement: the size comes back
    const truthFrames: ScanFrame[] = scene.frames;
    const nudged = truthFrames.map((f, k) => ({ ...f, cameraTransform: f.cameraTransform.map((v, i) => (i === 12 ? v + 0.04 * Math.sin(k * 2.1 + 1) : i === 13 ? v + 0.03 * Math.cos(k * 1.7) : v)) }));
    const poses = Object.fromEntries(truthFrames.map((f) => [f.frameId, f.cameraTransform]));
    const off = computeScanResult(nudged, scene.marks, null);
    const fixed = computeScanResult(scanEffectiveFrames(nudged, poses), scene.marks, null);
    expect(Math.abs(off.widthIn! - scene.truth.widthIn)).toBeGreaterThan(0.1);
    near(fixed.widthIn, scene.truth.widthIn, 0.0625);
    const corners: ScanVec3[] = fixed.cornersM!;
    expect(corners).toHaveLength(4);
  });
});
