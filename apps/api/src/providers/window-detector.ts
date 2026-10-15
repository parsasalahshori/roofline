import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';

/*
 * The OPTIONAL "auto-find front windows" of Measure windows, off by default (WINDOW_DETECTOR=off): the default path
 * needs no detector (windows come from the walls and from what a person marks on the photo). With
 * WINDOW_DETECTOR=owlv2 it is OWLv2, an open-source zero-shot object detector (Google, Apache-2.0), run on this machine
 * through transformers.js from the local WINDOW_MODEL_DIR only: remote model downloads are switched off, so nothing is
 * fetched from Hugging Face. Without the model there, it is 'detector-unconfigured'.
 */

/** A box in the photo, 0..1 of its width and height from the top-left, with the detector's confidence. */
export type DetectedBox = { x: number; y: number; w: number; h: number; confidence: number };
export type DetectHints = { photoId: string; /** The front wall's region in the photo (0..1), when known. */ region: { x: number; y: number; w: number; h: number } | null };

export interface WindowDetector {
  readonly name: 'owlv2' | null;
  readonly configured: boolean;
  detect(jpeg: Uint8Array, hints: DetectHints): Promise<DetectedBox[]>;
}

export class DetectorUnconfiguredError extends Error {}
export class DetectorError extends Error {}

/** WINDOW_DETECTOR=off: there is no detector (the default). */
export class NoDetector implements WindowDetector {
  readonly name = null;
  readonly configured = false;
  detect(): Promise<DetectedBox[]> {
    return Promise.reject(new DetectorUnconfiguredError('No window detector is set up.'));
  }
}

/** WINDOW_DETECTOR=owlv2 without the model on disk. */
export class UnconfiguredOwlV2 implements WindowDetector {
  readonly name = 'owlv2' as const;
  readonly configured = false;
  detect(): Promise<DetectedBox[]> {
    return Promise.reject(new DetectorUnconfiguredError('The window model is not on this machine.'));
  }
}

export const OWLV2_MODEL_ID = 'Xenova/owlv2-base-patch16-ensemble';
const MODEL_FILE = 'onnx/model_quantized.onnx';

/** Whether `dir` (a transformers.js localModelPath) holds the quantized OWLv2 model. */
export function owlv2Present(dir: string | undefined): boolean {
  return dir !== undefined && existsSync(path.join(dir, OWLV2_MODEL_ID, MODEL_FILE)) && existsSync(path.join(dir, OWLV2_MODEL_ID, 'config.json'));
}

/**
 * The text queries and the score threshold. The first query is the window; the others are what a window is mistaken
 * for on a house front (a door, a garage door's glass lites, shutters): a window box that a higher-scoring box of one
 * of those overlaps is dropped. Tuned by eye on the Street View fronts of three houses only (214 Shane Dr, Centerton
 * and 5437 Summer Pl, Jonesboro, AR; the third, 5107 Cayman Pl, is blurred): a starting point, not a validated setting.
 */
export const OWLV2_LABELS = ['a house window with glass panes', 'a front door', 'a garage door', 'a shutter'] as const;
export const OWLV2_THRESHOLD = 0.2;
/** Boxes larger than this share of the photo are a whole wall or a garage door, not a window. */
const MAX_BOX_W = 0.3;
const MAX_BOX_H = 0.4;
/** A window box overlapping a higher-scoring door / garage door / shutter box by this IoU is that, not a window. */
const OTHER_IOU = 0.5;
/** A window box this much inside a kept one (its lower sash, a pane) is the same window. */
const CONTAINED = 0.6;
const TIMEOUT_MS = 60_000;

/** The transformers.js pipeline's shape that is used: image bytes in, scored boxes out (percentages of the image). */
export type ZeroShotPipeline = (
  image: unknown,
  labels: string[],
  opts: { threshold: number; percentage: true },
) => Promise<{ score: number; label: string; box: { xmin: number; ymin: number; xmax: number; ymax: number } }[]>;
export type PipelineLoader = (modelDir: string) => Promise<{ run: ZeroShotPipeline; toImage(jpeg: Uint8Array): Promise<unknown> }>;

/** Loads OWLv2 from the local directory only (dtype q8: the quantized file), with remote models disabled. */
export const loadOwlV2: PipelineLoader = async (modelDir) => {
  const tf = await import('@huggingface/transformers');
  tf.env.localModelPath = modelDir;
  tf.env.allowRemoteModels = false;
  tf.env.allowLocalModels = true;
  const run = (await tf.pipeline('zero-shot-object-detection', OWLV2_MODEL_ID, { dtype: 'q8' })) as unknown as ZeroShotPipeline;
  return { run, toImage: (jpeg) => tf.RawImage.fromBlob(new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' })) };
};

function overlap(a: DetectedBox, b: DetectedBox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

function iou(a: DetectedBox, b: DetectedBox): number {
  const inter = overlap(a, b);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** A pipeline box with its label: `window` when it is the window query's. */
export type LabelledBox = DetectedBox & { window: boolean };

/**
 * Keeps the window-shaped boxes on the front: a window label, centre in the wall's region, not wall-sized, not taken
 * for a door, garage door or shutter that scored higher, and one box per window (the best; boxes inside it go).
 */
export function keepWindows(raw: LabelledBox[], region: DetectHints['region']): DetectedBox[] {
  const others = raw.filter((b) => !b.window);
  const sorted = raw
    .filter((b) => b.window && b.w > 0 && b.h > 0 && b.w <= MAX_BOX_W && b.h <= MAX_BOX_H)
    .filter((b) => {
      if (region === null) return true;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      return cx >= region.x && cx <= region.x + region.w && cy >= region.y && cy <= region.y + region.h;
    })
    .filter((b) => !others.some((o) => o.confidence > b.confidence && iou(o, b) >= OTHER_IOU))
    .sort((a, b) => b.confidence - a.confidence);
  const kept: DetectedBox[] = [];
  for (const b of sorted) {
    if (kept.some((k) => iou(k, b) > 0.3 || overlap(k, b) / (b.w * b.h) > CONTAINED)) continue;
    kept.push({ x: b.x, y: b.y, w: b.w, h: b.h, confidence: b.confidence });
  }
  return kept;
}

export class OwlV2Detector implements WindowDetector {
  readonly name = 'owlv2' as const;
  readonly configured = true;
  private loaded: ReturnType<PipelineLoader> | null = null;
  private readonly modelDir: string;
  private readonly load: PipelineLoader;
  private readonly timeoutMs: number;

  constructor(o: { modelDir: string; load?: PipelineLoader; timeoutMs?: number }) {
    this.modelDir = o.modelDir;
    this.load = o.load ?? loadOwlV2;
    this.timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  }

  async detect(jpeg: Uint8Array, hints: DetectHints): Promise<DetectedBox[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DetectorError('The window detector timed out.')), this.timeoutMs);
    });
    try {
      return await Promise.race([this.run(jpeg, hints), late]);
    } catch (err) {
      if (err instanceof DetectorError) throw err;
      this.loaded = null;
      throw new DetectorError('The window detector failed.');
    } finally {
      clearTimeout(timer);
    }
  }

  private async run(jpeg: Uint8Array, hints: DetectHints): Promise<DetectedBox[]> {
    this.loaded ??= this.load(this.modelDir);
    const { run, toImage } = await this.loaded;
    const out = await run(await toImage(jpeg), [...OWLV2_LABELS], { threshold: OWLV2_THRESHOLD, percentage: true });
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    const raw = out
      .filter((d) => [d.score, d.box.xmin, d.box.ymin, d.box.xmax, d.box.ymax].every(Number.isFinite))
      .map((d) => {
        const x0 = clamp(d.box.xmin);
        const y0 = clamp(d.box.ymin);
        return { x: x0, y: y0, w: clamp(d.box.xmax) - x0, h: clamp(d.box.ymax) - y0, confidence: clamp(d.score), window: d.label === OWLV2_LABELS[0] };
      });
    return keepWindows(raw, hints.region);
  }
}

export function createWindowDetector(config: Config): WindowDetector {
  if (config.WINDOW_DETECTOR !== 'owlv2') return new NoDetector();
  const dir = config.WINDOW_MODEL_DIR;
  return dir !== undefined && owlv2Present(dir) ? new OwlV2Detector({ modelDir: dir }) : new UnconfiguredOwlV2();
}
