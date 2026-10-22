import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createWindowDetector,
  DetectorError,
  DetectorUnconfiguredError,
  keepInteriorWindows,
  keepWindows,
  NoDetector,
  OWLV2_INTERIOR_LABELS,
  OWLV2_INTERIOR_THRESHOLD,
  OWLV2_LABELS,
  OWLV2_MODEL_ID,
  OwlV2Detector,
  owlv2Present,
  type PipelineLoader,
  UnconfiguredOwlV2,
  type WindowDetector,
} from '../../src/providers/window-detector.ts';
import type { Config } from '../../src/config.ts';

/* The optional OWLv2 detector with a mocked transformers.js pipeline: no model, no network. */

const box = (xmin: number, ymin: number, xmax: number, ymax: number, score: number, label: string = OWLV2_LABELS[0]) => ({ score, label, box: { xmin, ymin, xmax, ymax } });

function loader(out: ReturnType<typeof box>[]): { load: PipelineLoader; calls: { labels: string[]; threshold: number }[]; loads: number } {
  const state = { calls: [] as { labels: string[]; threshold: number }[], loads: 0 };
  const load: PipelineLoader = async () => {
    state.loads++;
    return {
      run: async (_img, labels, opts) => {
        state.calls.push({ labels, threshold: opts.threshold });
        return out;
      },
      toImage: async (jpeg) => jpeg,
    };
  };
  return { load, ...state, get calls() { return state.calls; }, get loads() { return state.loads; } };
}

describe('OWLv2 detector', () => {
  it('turns pipeline boxes into 0..1 boxes, keeps the front windows, one per window', async () => {
    const l = loader([
      box(0.3, 0.5, 0.36, 0.6, 0.4),
      box(0.305, 0.53, 0.36, 0.6, 0.3), // its lower sash: inside it
      box(0.6, 0.5, 0.66, 0.6, 0.2),
      box(0.45, 0.5, 0.48, 0.6, 0.25), // a shutter, which scored higher as a shutter
      box(0.45, 0.5, 0.48, 0.6, 0.35, 'a shutter'),
      box(0.05, 0.5, 0.1, 0.6, 0.5), // off the front
      box(0.3, 0.3, 0.8, 0.9, 0.6), // wall-sized (a garage door)
    ]);
    const d = new OwlV2Detector({ modelDir: '/nowhere', load: l.load });
    const got = await d.detect(new Uint8Array([0xff, 0xd8]), { photoId: 'p', region: { x: 0.2, y: 0.3, w: 0.6, h: 0.5 } });
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ confidence: 0.4 });
    expect(got[0]!.x).toBeCloseTo(0.3);
    expect(got[0]!.w).toBeCloseTo(0.06);
    expect(l.calls[0]!.labels).toEqual([...OWLV2_LABELS]);
    // The model loads once.
    await d.detect(new Uint8Array([0xff, 0xd8]), { photoId: 'p', region: null });
    expect(l.loads).toBe(1);
  });

  it('a pipeline failure is a typed detector error; a hang times out', async () => {
    const failing = new OwlV2Detector({ modelDir: '/x', load: async () => Promise.reject(new Error('onnx exploded at /secret/path')) });
    await expect(failing.detect(new Uint8Array(), { photoId: 'p', region: null })).rejects.toBeInstanceOf(DetectorError);
    vi.useFakeTimers();
    try {
      const hung = new OwlV2Detector({ modelDir: '/x', timeoutMs: 1000, load: () => new Promise(() => undefined) });
      const p = expect(hung.detect(new Uint8Array(), { photoId: 'p', region: null })).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(1000);
      await p;
    } finally {
      vi.useRealTimers();
    }
  });

  it('non-maximum suppression and size limits', () => {
    expect(keepWindows([{ x: 0, y: 0, w: 0.5, h: 0.1, confidence: 0.9, window: true }], null)).toEqual([]);
    expect(keepWindows([{ x: 0, y: 0, w: 0.1, h: 0.1, confidence: 0.9, window: false }], null)).toEqual([]);
  });
});

describe('OWLv2 detector, photos taken inside a home', () => {
  const win = OWLV2_INTERIOR_LABELS[0];
  const frame = OWLV2_INTERIOR_LABELS[1];
  const picture = OWLV2_INTERIOR_LABELS[2];
  const jpeg = new Uint8Array([0xff, 0xd8]);

  it('asks the model for windows and what they are mistaken for, and returns 0..1 boxes best first', async () => {
    const l = loader([
      box(0.27, 0.23, 0.76, 0.78, 0.276, win),
      box(0.27, 0.23, 0.76, 0.78, 0.292, frame), // the same box under the other window query: one box, the better score
      box(0.27, 0.23, 0.76, 0.78, 0.05, 'a television'), // far below the window's score: does not take it
      box(0.3, 0.3, 0.7, 0.5, 0.15, win), // the upper sash inside the window: kept, the caller chooses
    ]);
    const d = new OwlV2Detector({ modelDir: '/nowhere', load: l.load });
    const got = await d.detectInterior(jpeg);
    expect(l.calls[0]!.labels).toEqual([...OWLV2_INTERIOR_LABELS]);
    expect(l.calls[0]!.threshold).toBe(OWLV2_INTERIOR_THRESHOLD);
    expect(got.map((b) => b.confidence)).toEqual([0.292, 0.15]);
    expect(got[0]).toMatchObject({ x: 0.27, y: 0.23 });
    expect(got[0]!.w).toBeCloseTo(0.49);
    expect(got[0]!.h).toBeCloseTo(0.55);
  });

  it('a picture frame, door, mirror or television that scores about as well on the same box takes it; a clear window does not lose to a faint one', () => {
    const b = (label: string, score: number, x = 0.6, y = 0.2, w = 0.3, h = 0.3) => ({ x, y, w, h, confidence: score, window: label === win || label === frame });
    // The drawn room's picture on the wall: scored 0.268 as a window frame and 0.191 as a picture frame
    expect(keepInteriorWindows([b(frame, 0.268), b(picture, 0.191), b(win, 0.16)])).toEqual([]);
    // A window that the picture query barely scores
    expect(keepInteriorWindows([b(frame, 0.29), b(picture, 0.1)])).toHaveLength(1);
    // The picture frame is somewhere else
    expect(keepInteriorWindows([b(frame, 0.29), b(picture, 0.28, 0.0, 0.0, 0.1, 0.1)])).toHaveLength(1);
  });

  it('drops what is too faint, too small or the whole picture, and keeps at most eight', () => {
    const w = (x: number, y: number, ww: number, hh: number, c: number) => ({ x, y, w: ww, h: hh, confidence: c, window: true });
    expect(keepInteriorWindows([w(0.1, 0.1, 0.4, 0.4, 0.05)])).toEqual([]);
    expect(keepInteriorWindows([w(0.1, 0.1, 0.03, 0.4, 0.5)])).toEqual([]);
    expect(keepInteriorWindows([w(0, 0, 1, 1, 0.5)])).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => w(0.02 + i * 0.01, 0.1, 0.3 + i * 0.03, 0.4, 0.5 - i * 0.02));
    expect(keepInteriorWindows(many)).toHaveLength(8);
  });

  it('a photo with nothing in it is an empty list; a failure is a typed error; the model can be loaded ahead', async () => {
    const empty = loader([]);
    const d = new OwlV2Detector({ modelDir: '/x', load: empty.load });
    expect(await d.detectInterior(jpeg)).toEqual([]);
    const failing = new OwlV2Detector({ modelDir: '/x', load: async () => Promise.reject(new Error('onnx exploded at /secret/path')) });
    await expect(failing.detectInterior(jpeg)).rejects.toBeInstanceOf(DetectorError);
    const warmed = loader([]);
    const w = new OwlV2Detector({ modelDir: '/x', load: warmed.load });
    await w.warm();
    await w.detectInterior(jpeg);
    expect(warmed.loads).toBe(1);
    // A model that cannot load is not a crash on warm-up: the next photo reports it
    await expect(new OwlV2Detector({ modelDir: '/x', load: async () => Promise.reject(new Error('no')) }).warm()).resolves.toBeUndefined();
  });

  it('the detectors that cannot do it have no interior call at all (the route answers 503)', () => {
    const asDetectors: WindowDetector[] = [new NoDetector(), new UnconfiguredOwlV2()];
    for (const d of asDetectors) expect(d.detectInterior).toBeUndefined();
  });
});

describe('choosing the detector', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'owl-'));
  mkdirSync(path.join(dir, OWLV2_MODEL_ID, 'onnx'), { recursive: true });
  writeFileSync(path.join(dir, OWLV2_MODEL_ID, 'onnx', 'model_quantized.onnx'), 'x');
  writeFileSync(path.join(dir, OWLV2_MODEL_ID, 'config.json'), '{}');
  const cfg = (o: Partial<Config>) => o as Config;

  it('off by default; owlv2 only with the model on disk', async () => {
    expect(createWindowDetector(cfg({ WINDOW_DETECTOR: 'off', WINDOW_MODEL_DIR: dir }))).toBeInstanceOf(NoDetector);
    expect(createWindowDetector(cfg({ WINDOW_DETECTOR: 'owlv2', WINDOW_MODEL_DIR: dir }))).toBeInstanceOf(OwlV2Detector);
    const missing = createWindowDetector(cfg({ WINDOW_DETECTOR: 'owlv2', WINDOW_MODEL_DIR: path.join(dir, 'none') }));
    expect(missing).toBeInstanceOf(UnconfiguredOwlV2);
    await expect(missing.detect(new Uint8Array(), { photoId: 'p', region: null })).rejects.toBeInstanceOf(DetectorUnconfiguredError);
    expect(owlv2Present(undefined)).toBe(false);
  });
});
