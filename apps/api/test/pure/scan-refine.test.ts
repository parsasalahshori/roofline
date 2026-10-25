import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { computeScanResult, scanProject, scanResultOf, type ScanMark, type ScanFrame, type ScanVec3, type ScanWall } from '@roofline/shared';
import { colmapAnswer, FakeWindowSegmenter, type SegmentAnswer } from '../../src/providers/fakes/scan-refine.ts';
import { NoDetector } from '../../src/providers/window-detector.ts';
import { NoSegmenter, chooseMask, type SegmentOutput } from '../../src/providers/window-segmenter.ts';
import { runAiFrames } from '../../src/scans/refine/ai.ts';
import { combineRefinement } from '../../src/scans/refine/combine.ts';
import { MASK_EDGE_ALPHA, MASK_FILL_ALPHA, encodeMaskPng } from '../../src/scans/refine/png.ts';
import { baseMarksOf } from '../../src/scans/refine/run.ts';
import { polygonMask } from '../../src/providers/window-quad.ts';

/* The refinement's pieces that need no database: the mask PNG, the AI on every frame, and what COLMAP and the AI add up to. */

/** A PNG's RGBA pixels back (only filter 0, which is all the encoder writes). */
function decodePng(png: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const b = Buffer.from(png);
  expect([...b.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (pos < b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString('ascii', pos + 4, pos + 8);
    const data = b.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8]).toBe(8);
      expect(data[9]).toBe(6);
    }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width * 4 + 1)]).toBe(0);
    rgba.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
  }
  return { width, height, rgba };
}

describe('the mask PNG', () => {
  test('is transparent outside the window, translucent inside, firmer on its edge', () => {
    const w = 40;
    const h = 30;
    const mask = polygonMask(w, h, [{ x: 10, y: 5 }, { x: 30, y: 5 }, { x: 30, y: 25 }, { x: 10, y: 25 }]);
    const { png, width, height } = encodeMaskPng(mask, w, h);
    expect([width, height]).toEqual([40, 30]);
    const d = decodePng(png);
    const a = (x: number, y: number) => d.rgba[(y * d.width + x) * 4 + 3]!;
    expect(a(2, 2)).toBe(0);
    expect(a(20, 15)).toBe(MASK_FILL_ALPHA);
    expect(a(10, 15)).toBe(MASK_EDGE_ALPHA);
    expect(a(20, 5)).toBe(MASK_EDGE_ALPHA);
    expect([d.rgba[(15 * d.width + 20) * 4]!, d.rgba[(15 * d.width + 20) * 4 + 1]!, d.rgba[(15 * d.width + 20) * 4 + 2]!]).toEqual([10, 132, 255]);
  });

  test('a big mask is scaled down to 640 px wide and stays small', () => {
    const w = 1920;
    const h = 1440;
    const mask = polygonMask(w, h, [{ x: 600, y: 300 }, { x: 1400, y: 300 }, { x: 1400, y: 1200 }, { x: 600, y: 1200 }]);
    const { png, width, height } = encodeMaskPng(mask, w, h);
    expect([width, height]).toEqual([640, 480]);
    expect(png.length).toBeLessThan(8_000);
    const d = decodePng(png);
    expect(d.rgba[(240 * 640 + 320) * 4 + 3]).toBe(MASK_FILL_ALPHA);
    expect(d.rgba[(10 * 640 + 10) * 4 + 3]).toBe(0);
  });
});

describe('the mask when there is no quad', () => {
  const W = 100;
  const H = 100;
  const out = (masks: Uint8Array[], scores: number[]): SegmentOutput => ({ width: W, height: H, masks, scores });
  test('the mask that is the box’s window wins over a better scoring one that is not', () => {
    const box = { x: 0.2, y: 0.2, w: 0.4, h: 0.4, confidence: 1 };
    const window = polygonMask(W, H, [{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 20, y: 60 }]);
    const wall = polygonMask(W, H, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]);
    expect(chooseMask(out([wall, window], [0.99, 0.8]), box)).toEqual({ index: 1, score: 0.8 });
    expect(chooseMask(out([new Uint8Array(W * H)], [0.9]), box)).toBeNull();
  });
});

/** The shared fixture (the same file the iOS code checks): a 34.6 x 55.7 in window, 5 regular frames and 4 close-ups. */
type Fixture = { input: { frames: ScanFrame[]; marks: ScanMark[]; wall: ScanWall | null }; expected: { cornersM: ScanVec3[] } };
const fx = JSON.parse(readFileSync(new URL('../../../../packages/shared/test/fixtures/window-scan/clean-34x55.json', import.meta.url), 'utf8')) as Fixture;
const scene = { frames: fx.input.frames, marks: fx.input.marks, wall: fx.input.wall, truth: { cornersM: fx.expected.cornersM } };
const SCENE_INTRINSICS = scene.frames[0]!.intrinsics;
/** A camera turned half a turn about its own up axis: it looks away from where it looked. */
const lookAway = (m: number[]): number[] => m.map((v, i) => (i < 3 || (i >= 8 && i < 11) ? -v : v));

describe('the AI on every frame', () => {
  const truth = scene.truth.cornersM;
  const quadOf = (f: ScanFrame): NonNullable<SegmentAnswer>['corners'] =>
    truth.map((p) => {
      const q = scanProject(p, f.cameraTransform, f.intrinsics)!;
      return [q[0] / f.intrinsics.width, q[1] / f.intrinsics.height];
    }) as NonNullable<SegmentAnswer>['corners'];
  const jpegs = (frames: ScanFrame[]) => frames.map((frame) => ({ frame, jpeg: new Uint8Array([1, 2, 3]) }));
  const keyOf = (id: string) => `k/${id}`;

  test('each frame is asked with the projected window padded 8% and its centre; four marks per frame, in corner order, at the corners', async () => {
    const sam = new FakeWindowSegmenter((c) => ({ corners: quadOf(scene.frames[c.index]!) }));
    const regular = scene.frames.filter((f) => f.kind === 'regular');
    const out = await runAiFrames(jpegs(regular), { segmenter: sam, detector: new NoDetector(), estimateM: truth, maskKey: keyOf });
    expect(out.frames.map((f) => f.state)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(out.marks).toHaveLength(20);
    for (const f of regular) {
      for (const c of [0, 1, 2, 3] as const) {
        const m = out.marks.find((x) => x.frameId === f.frameId && x.corner === c)!;
        const p = scanProject(truth[c]!, f.cameraTransform, f.intrinsics)!;
        expect(Math.hypot(m.x - p[0], m.y - p[1])).toBeLessThan(0.05);
        expect(m.source).toBe('ai');
      }
    }
    expect(out.masks.size).toBe(5);
    expect(out.frames[0]).toMatchObject({ prompt: 'projected', maskKey: 'k/r1', marks: 4 });
    // the box the model was asked about is the window plus 8% each way
    const px = truth.map((p) => scanProject(p, regular[0]!.cameraTransform, regular[0]!.intrinsics)!);
    const bw = Math.max(...px.map((p) => p[0])) - Math.min(...px.map((p) => p[0]));
    expect(sam.calls[0]!.box.w * regular[0]!.intrinsics.width).toBeCloseTo(bw * 1.16, 3);
  });

  test('a close-up that has no quad still gets its mask; a window out of the picture is "not visible" and SAM is not asked', async () => {
    const closeup = scene.frames.find((f) => f.kind === 'closeup')!;
    const away = { ...scene.frames[0]!, frameId: 'away', cameraTransform: lookAway(scene.frames[0]!.cameraTransform) };
    const sam = new FakeWindowSegmenter((c) => (c.index === 0 ? { corners: null } : null));
    const out = await runAiFrames(jpegs([closeup, away]), { segmenter: sam, detector: new NoDetector(), estimateM: truth, maskKey: keyOf });
    expect(out.frames.map((f) => f.state)).toEqual(['no_quad', 'not_visible']);
    expect(sam.calls).toHaveLength(1);
    expect(out.marks).toEqual([]);
  });

  test('a weak fit gives a mask for the overlay and no marks', async () => {
    const f = scene.frames[0]!;
    const sam = new FakeWindowSegmenter(() => ({ corners: quadOf(f), quality: 0.4 }));
    const out = await runAiFrames(jpegs([f]), { segmenter: sam, detector: new NoDetector(), estimateM: truth, maskKey: keyOf });
    expect(out.frames[0]).toMatchObject({ state: 'low_quality', marks: 0, quality: 0.4, maskKey: 'k/r1' });
    expect(out.marks).toEqual([]);
    expect(out.masks.has('r1')).toBe(true);
  });

  test('corners the AI finds far from where the window is are not marks: a mask on the wrong thing gives none, a sill in the mask costs only the corners it moves', async () => {
    const f = scene.frames[0]!;
    const right = quadOf(f)!;
    const shift = (dx: number, dy: number, which: number[]) => right.map((c, i) => (which.includes(i) ? [c[0] + dx / f.intrinsics.width, c[1] + dy / f.intrinsics.height] : c)) as NonNullable<SegmentAnswer>['corners'];
    const off = await runAiFrames(jpegs([f]), { segmenter: new FakeWindowSegmenter(() => ({ corners: shift(400, 300, [0, 1, 2, 3]) })), detector: new NoDetector(), estimateM: truth, maskKey: keyOf });
    expect(off.frames[0]).toMatchObject({ state: 'off_target', marks: 0, maskKey: 'k/r1' });
    expect(off.marks).toEqual([]);
    // two bottom corners 25 px low (a sill in the mask) are still near: all four are marks (the robust step decides about them)
    const sill = await runAiFrames(jpegs([f]), { segmenter: new FakeWindowSegmenter(() => ({ corners: shift(0, 25, [2, 3]) })), detector: new NoDetector(), estimateM: truth, maskKey: keyOf });
    expect(sill.frames[0]).toMatchObject({ state: 'ok', marks: 4 });
    // two bottom corners 300 px low are not
    const part = await runAiFrames(jpegs([f]), { segmenter: new FakeWindowSegmenter(() => ({ corners: shift(0, 300, [2, 3]) })), detector: new NoDetector(), estimateM: truth, maskKey: keyOf });
    expect(part.frames[0]).toMatchObject({ state: 'ok', marks: 2 });
    expect(part.marks.map((m) => m.corner)).toEqual([0, 1]);
  });

  test('a phone held upright (the picture is on its side): the quad is put in gravity order by the projected window', async () => {
    const base = scene.frames[2]!;
    const c = Math.cos(Math.PI / 2);
    const s = Math.sin(Math.PI / 2);
    const m = base.cameraTransform;
    const rolled = { ...base, frameId: 'portrait', cameraTransform: [m[0]! * c + m[4]! * s, m[1]! * c + m[5]! * s, m[2]! * c + m[6]! * s, 0, -m[0]! * s + m[4]! * c, -m[1]! * s + m[5]! * c, -m[2]! * s + m[6]! * c, 0, m[8]!, m[9]!, m[10]!, 0, m[12]!, m[13]!, m[14]!, 1] };
    const px = truth.map((p) => scanProject(p, rolled.cameraTransform, rolled.intrinsics)!);
    // what the mask fit gives: the picture's own top-left first (clockwise on the screen)
    const idx = [0, 1, 2, 3];
    const cx = px.reduce((a, p) => a + p[0], 0) / 4;
    const cy = px.reduce((a, p) => a + p[1], 0) / 4;
    idx.sort((a, b) => Math.atan2(px[a]![1] - cy, px[a]![0] - cx) - Math.atan2(px[b]![1] - cy, px[b]![0] - cx));
    const fitOrder = idx.map((i) => [px[i]![0] / SCENE_INTRINSICS.width, px[i]![1] / SCENE_INTRINSICS.height]) as NonNullable<SegmentAnswer>['corners'];
    for (const estimateM of [truth, null]) {
      const out = await runAiFrames([{ frame: rolled, jpeg: new Uint8Array(1) }], {
        segmenter: new FakeWindowSegmenter(() => ({ corners: fitOrder })),
        detector: { name: null, configured: false, detect: async () => [] },
        estimateM,
        maskKey: keyOf,
      });
      if (estimateM === null) {
        // without an estimate and without a detector there is nothing to ask about
        expect(out.frames[0]!.state).toBe('no_estimate');
        continue;
      }
      for (const corner of [0, 1, 2, 3] as const) {
        const mk = out.marks.find((x) => x.corner === corner)!;
        expect(Math.hypot(mk.x - px[corner]![0], mk.y - px[corner]![1])).toBeLessThan(0.05);
      }
    }
  });

  test('without an estimate, OWLv2 finds the box; without OWLv2 the frame says so', async () => {
    const f = scene.frames[0]!;
    const detector = { name: 'owlv2' as const, configured: true, detect: async () => [], detectInterior: async () => [{ x: 0.1, y: 0.1, w: 0.5, h: 0.6, confidence: 0.4 }] };
    const sam = new FakeWindowSegmenter(() => ({ corners: quadOf(f) }));
    const out = await runAiFrames(jpegs([f]), { segmenter: sam, detector, estimateM: null, maskKey: keyOf });
    expect(out.frames[0]).toMatchObject({ state: 'ok', prompt: 'owlv2' });
    expect(sam.calls[0]!.box).toMatchObject({ x: 0.1, w: 0.5 });
    const none = await runAiFrames(jpegs([f]), { segmenter: sam, detector: new NoDetector(), estimateM: null, maskKey: keyOf });
    expect(none.frames[0]!.state).toBe('no_estimate');
  });

  test('a missing photo, a model that throws and a segmenter that is not set up are recorded per frame, never thrown', async () => {
    const f = scene.frames[0]!;
    const boom = new FakeWindowSegmenter(() => null);
    boom.failWith = new Error('model crashed');
    const a = await runAiFrames([{ frame: f, jpeg: null }], { segmenter: boom, detector: new NoDetector(), estimateM: truth, maskKey: keyOf });
    expect(a.frames[0]).toMatchObject({ state: 'error', note: 'The photo is missing.' });
    const b = await runAiFrames(jpegs([f]), { segmenter: boom, detector: new NoDetector(), estimateM: truth, maskKey: keyOf });
    expect(b.frames[0]).toMatchObject({ state: 'error', note: 'model crashed' });
    const c = await runAiFrames(jpegs([f]), { segmenter: new NoSegmenter(), detector: new NoDetector(), estimateM: truth, maskKey: keyOf });
    expect(c.frames[0]!.state).toBe('error');
  });
});

describe('what COLMAP and the AI add up to', () => {
  const first = scanResultOf(computeScanResult(scene.frames, scene.marks, scene.wall));
  const job = { images: scene.frames.map((f) => ({ frameId: f.frameId, path: '', imageWidth: 1920, imageHeight: 1440, intrinsics: f.intrinsics, cameraTransform: f.cameraTransform })), workDir: '', plyPath: '' };
  const input = (colmap: ReturnType<typeof colmapAnswer> | null, skipped: string | null = null) => ({ frames: scene.frames, wall: scene.wall, base: scene.marks, ai: null, colmap: { out: colmap, skipped }, firstResult: first });

  test('poses within 2 cm and 4 frames are taken; each is carried with its transform', () => {
    const c = combineRefinement(input(colmapAnswer(job)));
    expect(c.poseSource).toBe('colmap');
    expect(Object.keys(c.poses)).toHaveLength(9);
    expect(c.result.refined).toMatchObject({ poseSource: 'colmap', colmapFrames: 9, alignmentRmsCm: 0.4 });
    expect(c.colmap).toMatchObject({ used: true, registered: 9, alignmentRmsCm: 0.4, ms: { extract: 1500, match: 500, map: 1000 } });
  });

  test('no COLMAP: ARKit, with the reason; a frame COLMAP put far from the phone keeps ARKit’s pose', () => {
    const none = combineRefinement(input(null, 'COLMAP is not set up on this machine.'));
    expect(none).toMatchObject({ poseSource: 'arkit', poseNote: 'COLMAP is not set up on this machine.', poses: {} });
    const out = colmapAnswer(job);
    if (!out.ok || out.alignment === undefined) throw new Error('fake');
    out.alignment.perFrameCm['r2'] = 7;
    const c = combineRefinement(input(out));
    expect(c.poseSource).toBe('colmap');
    expect(Object.keys(c.poses)).toHaveLength(8);
    expect(c.poses['r2']).toBeUndefined();
  });

  test('poses that pass the limits but make the scan worse than ARKit’s do not replace them', () => {
    // every camera moved 8 cm: the marks no longer agree with the rays
    const wild = colmapAnswer(job, { move: (id, m) => m.map((v, i) => (i === 12 ? v + 0.5 * Math.sin(id.charCodeAt(1) * 3.7) : i === 13 ? v + 0.4 * Math.cos(id.charCodeAt(0) * 2.9 + id.charCodeAt(1)) : i === 14 ? v + 0.3 * Math.sin(id.charCodeAt(1) * 1.3) : v)) });
    const c = combineRefinement(input(wild));
    expect(c.poseSource).toBe('arkit');
    expect(c.poseNote).toContain('worse than ARKit');
    expect(c.colmap.used).toBe(false);
  });

  test('the base marks are the phone’s with a reviewer’s own on top', () => {
    const original: ScanMark[] = [
      { frameId: 'a', corner: 0, x: 1, y: 1, source: 'snap' },
      { frameId: 'a', corner: 1, x: 2, y: 2, source: 'ai' },
    ];
    const now: ScanMark[] = [
      { frameId: 'a', corner: 0, x: 5, y: 5, source: 'user' },
      { frameId: 'a', corner: 1, x: 9, y: 9, source: 'ai' },
    ];
    expect(baseMarksOf({ marks: now, marksOriginal: original }).sort((p, q) => p.corner - q.corner)).toEqual([
      { frameId: 'a', corner: 0, x: 5, y: 5, source: 'user' },
      { frameId: 'a', corner: 1, x: 2, y: 2, source: 'ai' },
    ]);
  });
});
