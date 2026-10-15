import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createWindowDetector,
  DetectorError,
  DetectorUnconfiguredError,
  keepWindows,
  NoDetector,
  OWLV2_MODEL_ID,
  OwlV2Detector,
  owlv2Present,
  type PipelineLoader,
  UnconfiguredOwlV2,
} from '../../src/providers/window-detector.ts';
import type { Config } from '../../src/config.ts';

/* The optional OWLv2 detector with a mocked transformers.js pipeline: no model, no network. */

const box = (xmin: number, ymin: number, xmax: number, ymax: number, score: number, label = 'a window') => ({ score, label, box: { xmin, ymin, xmax, ymax } });

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
      box(0.305, 0.505, 0.36, 0.6, 0.3, 'a house window'), // the same window, another label
      box(0.6, 0.5, 0.66, 0.6, 0.2),
      box(0.05, 0.5, 0.1, 0.6, 0.5), // off the front
      box(0.3, 0.3, 0.8, 0.9, 0.6), // wall-sized (a garage door)
    ]);
    const d = new OwlV2Detector({ modelDir: '/nowhere', load: l.load });
    const got = await d.detect(new Uint8Array([0xff, 0xd8]), { photoId: 'p', region: { x: 0.2, y: 0.3, w: 0.6, h: 0.5 } });
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ confidence: 0.4 });
    expect(got[0]!.x).toBeCloseTo(0.3);
    expect(got[0]!.w).toBeCloseTo(0.06);
    expect(l.calls[0]!.labels).toContain('a window');
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
    expect(keepWindows([{ x: 0, y: 0, w: 0.5, h: 0.1, confidence: 0.9 }], null)).toEqual([]);
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
