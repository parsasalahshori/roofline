import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.ts';
import { pickWindowBox, type DetectedBox } from '../../src/providers/window-detector.ts';
import {
  createWindowSegmenter,
  NoSegmenter,
  quadFromMasks,
  SAM2_MODEL_ID,
  sam2Present,
  Sam2Segmenter,
  SegmenterError,
  type SamLoader,
  type SegmentOutput,
  type SegmentPrompt,
  UnconfiguredSam2,
} from '../../src/providers/window-segmenter.ts';
import { polygonMask } from '../../src/providers/window-quad.ts';

/* SAM 2 with a fake pipeline: the masks are drawn, no model, no network. */

const W = 480;
const H = 640;
const rect = (x0: number, y0: number, x1: number, y1: number) =>
  polygonMask(W, H, [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ]);
/** The window, 0.25..0.75 across and 0.25..0.75 down. */
const BOX: DetectedBox = { x: 0.25, y: 0.25, w: 0.5, h: 0.5, confidence: 0.3 };
const WINDOW = rect(120, 160, 360, 480);

function fakeLoader(output: SegmentOutput, seen: SegmentPrompt[] = []): { load: SamLoader; loads: () => number } {
  let loads = 0;
  return {
    loads: () => loads,
    load: async () => {
      loads++;
      return {
        run: async (_jpeg, prompt) => {
          seen.push(prompt);
          return output;
        },
      };
    },
  };
}

describe('quadFromMasks', () => {
  it('takes the mask that is the window: a pane and the whole wall are other things', () => {
    const out: SegmentOutput = { width: W, height: H, masks: [rect(140, 180, 240, 300), WINDOW, rect(0, 0, 479, 639)], scores: [0.95, 0.9, 0.8] };
    const q = quadFromMasks(out, BOX)!;
    expect(q).not.toBeNull();
    expect(q.maskScore).toBe(0.9);
    expect(q.quality).toBeGreaterThan(0.95);
    // TL, TR, BR, BL as fractions of the picture
    expect(q.corners[0][0]).toBeCloseTo(0.25, 1);
    expect(q.corners[0][1]).toBeCloseTo(0.25, 1);
    expect(q.corners[2][0]).toBeCloseTo(0.75, 1);
    expect(q.corners[2][1]).toBeCloseTo(0.75, 1);
  });

  it('with two good masks, the one the model likes better; a poor fit does not stop the next mask being tried', () => {
    const notched = rect(120, 160, 360, 480);
    for (let y = 160; y < 400; y++) for (let x = 120; x < 260; x++) notched[y * W + x] = 0;
    const out: SegmentOutput = { width: W, height: H, masks: [notched, WINDOW], scores: [0.95, 0.9] };
    const q = quadFromMasks(out, BOX)!;
    expect(q.maskScore).toBe(0.9);
  });

  it('no mask on the box, empty masks and no masks are no quad', () => {
    expect(quadFromMasks({ width: W, height: H, masks: [rect(0, 0, 100, 100)], scores: [0.9] }, BOX)).toBeNull();
    expect(quadFromMasks({ width: W, height: H, masks: [new Uint8Array(W * H)], scores: [0.9] }, BOX)).toBeNull();
    expect(quadFromMasks({ width: W, height: H, masks: [], scores: [] }, BOX)).toBeNull();
  });
});

describe('Sam2Segmenter', () => {
  const jpeg = new Uint8Array([0xff, 0xd8]);

  it('asks with the box, and with the aimed point only when it is inside the box; loads once', async () => {
    const seen: SegmentPrompt[] = [];
    const l = fakeLoader({ width: W, height: H, masks: [WINDOW], scores: [0.9] }, seen);
    const s = new Sam2Segmenter({ modelDir: '/x', load: l.load });
    expect((await s.segment(jpeg, BOX, { x: 0.5, y: 0.5 }))?.quality).toBeGreaterThan(0.9);
    await s.segment(jpeg, BOX, { x: 0.05, y: 0.05 });
    expect(seen[0]).toEqual({ box: BOX, point: { x: 0.5, y: 0.5 } });
    expect(seen[1]!.point).toBeNull();
    expect(l.loads()).toBe(1);
  });

  it('a failure is a typed error that says nothing of why, and the model is loaded afresh; a hang times out; warm-up never throws', async () => {
    const failing = new Sam2Segmenter({ modelDir: '/x', load: async () => Promise.reject(new Error('onnx exploded at /secret/path')) });
    await expect(failing.segment(jpeg, BOX, { x: 0.5, y: 0.5 })).rejects.toThrow(new SegmenterError('The window segmenter failed.'));
    await expect(failing.warm()).resolves.toBeUndefined();
    const hung = new Sam2Segmenter({ modelDir: '/x', timeoutMs: 20, load: () => new Promise(() => undefined) });
    await expect(hung.segment(jpeg, BOX, { x: 0.5, y: 0.5 })).rejects.toThrow('timed out');
  });
});

describe('choosing the segmenter', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sam-'));
  const base = path.join(dir, SAM2_MODEL_ID);
  mkdirSync(path.join(base, 'onnx'), { recursive: true });
  for (const f of ['config.json', 'preprocessor_config.json', 'onnx/vision_encoder.onnx', 'onnx/prompt_encoder_mask_decoder.onnx']) writeFileSync(path.join(base, f), 'x');
  const cfg = (o: Partial<Config>) => o as Config;

  it('off by default; sam2 only with the model on disk, from SAM_MODEL_DIR or else WINDOW_MODEL_DIR', async () => {
    expect(createWindowSegmenter(cfg({ WINDOW_SEGMENTER: 'off', SAM_MODEL_DIR: dir }))).toBeInstanceOf(NoSegmenter);
    expect(createWindowSegmenter(cfg({ WINDOW_SEGMENTER: 'sam2', SAM_MODEL_DIR: dir }))).toBeInstanceOf(Sam2Segmenter);
    expect(createWindowSegmenter(cfg({ WINDOW_SEGMENTER: 'sam2', WINDOW_MODEL_DIR: dir }))).toBeInstanceOf(Sam2Segmenter);
    const missing = createWindowSegmenter(cfg({ WINDOW_SEGMENTER: 'sam2', SAM_MODEL_DIR: path.join(dir, 'none') }));
    expect(missing).toBeInstanceOf(UnconfiguredSam2);
    expect(missing.configured).toBe(false);
    await expect(missing.segment(new Uint8Array(), BOX, { x: 0.5, y: 0.5 })).rejects.toThrow();
    expect(sam2Present(undefined)).toBe(false);
    expect(await new NoSegmenter().segment()).toBeNull();
  });
});

describe('pickWindowBox (the phone app picks the same way)', () => {
  const b = (x: number, y: number, w: number, h: number, c: number): DetectedBox => ({ x, y, w, h, confidence: c });

  it('the box that holds the aim, best score; the largest nested box within 70% of the best', () => {
    const picture = b(0.8, 0.2, 0.15, 0.2, 0.5);
    const window = b(0.26, 0.23, 0.5, 0.55, 0.38);
    const sash = b(0.3, 0.4, 0.4, 0.2, 0.4);
    expect(pickWindowBox([picture, window, sash])).toEqual(window);
    // The sash scores a lot higher than the window: it stays the pick
    expect(pickWindowBox([picture, window, b(0.3, 0.4, 0.4, 0.2, 0.6)])).toEqual(b(0.3, 0.4, 0.4, 0.2, 0.6));
    expect(pickWindowBox([picture])).toBeNull();
    expect(pickWindowBox([])).toBeNull();
    expect(pickWindowBox([picture, window], { x: 0.85, y: 0.3 })).toEqual(picture);
  });
});
