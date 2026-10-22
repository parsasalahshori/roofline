import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
import type { DetectedBox } from './window-detector.ts';
import { fitWindowQuad, type QuadFit } from './window-quad.ts';

/*
 * The OPTIONAL second step of the homeowner app's "find your window": SAM 2.1 (Meta, Apache-2.0; the tiny ONNX export) cuts the window
 * out of the photo, given the box OWLv2 found for it, and the mask is turned into the window's four corners (window-quad.ts). Off by
 * default (WINDOW_SEGMENTER=off: no quad, the app starts from the box); with WINDOW_SEGMENTER=sam2 it is run on this machine through
 * transformers.js from the local model directory only: remote downloads are off, nothing is fetched. Without the model there it is
 * 'segmenter-unconfigured'.
 */

export class SegmenterUnconfiguredError extends Error {}
export class SegmenterError extends Error {}

/** The window's corners, 0..1 of the photo from its top-left, TL, TR, BR, BL, with how good the fit to the mask is. */
export type WindowQuad = {
  corners: [[number, number], [number, number], [number, number], [number, number]];
  /** 0..1, see QuadFit.quality. The app starts from the quad only when this is high. */
  quality: number;
  /** The share of the quad the mask covers. */
  fill: number;
  /** The contour's roughness round the quad's lines, as a share of the window's size. */
  residual: number;
  /** SAM's own score for the mask the quad was fitted to. */
  maskScore: number;
};

export interface WindowSegmenter {
  readonly name: 'sam2' | null;
  readonly configured: boolean;
  /** The window quad inside `box` (and round the point `aim`, 0..1), or null when the mask has no believable quad. */
  segment(jpeg: Uint8Array, box: DetectedBox, aim: { x: number; y: number }): Promise<WindowQuad | null>;
  /** Loads the model ahead of the first call. */
  warm?(): Promise<void>;
}

/** WINDOW_SEGMENTER=off: no segmenter (the default). */
export class NoSegmenter implements WindowSegmenter {
  readonly name = null;
  readonly configured = false;
  segment(): Promise<WindowQuad | null> {
    return Promise.resolve(null);
  }
}

/** WINDOW_SEGMENTER=sam2 without the model on disk. */
export class UnconfiguredSam2 implements WindowSegmenter {
  readonly name = 'sam2' as const;
  readonly configured = false;
  segment(): Promise<WindowQuad | null> {
    return Promise.reject(new SegmenterUnconfiguredError('The segmentation model is not on this machine.'));
  }
}

export const SAM2_MODEL_ID = 'onnx-community/sam2.1-hiera-tiny-ONNX';

/** Whether `dir` (a transformers.js localModelPath) holds the SAM 2.1 tiny ONNX model. */
export function sam2Present(dir: string | undefined): boolean {
  if (dir === undefined) return false;
  const base = path.join(dir, SAM2_MODEL_ID);
  return ['config.json', 'preprocessor_config.json', 'onnx/vision_encoder.onnx', 'onnx/prompt_encoder_mask_decoder.onnx'].every((f) => existsSync(path.join(base, f)));
}

const TIMEOUT_MS = 60_000;
/** A mask whose own bounding box overlaps the OWLv2 box by less than this (IoU) is a different thing (the wall, a corner of the room). */
const MIN_BOX_IOU = 0.5;
/** Masks to fit, best first: the model gives three (small, medium, large). */
const MAX_FITS = 3;
/** A fit this good is taken at once, without trying the other masks. */
const GOOD_ENOUGH = 0.9;

/** What a segmentation run gives back: the picture's size and, for each of the model's candidate masks, 0/1 pixels and the model's score. */
export type SegmentOutput = { width: number; height: number; masks: Uint8Array[]; scores: number[] };
export type SegmentPrompt = { box: DetectedBox; point: { x: number; y: number } | null };
export type SamLoader = (modelDir: string) => Promise<{ run(jpeg: Uint8Array, prompt: SegmentPrompt): Promise<SegmentOutput> }>;

/** The pieces of transformers.js's SAM 2 that are used (typed loosely: the library's own types are wider than this). */
type Tensorish = { data: ArrayLike<number>; dims: number[] };
type Sam2Parts = {
  model: (inputs: unknown) => Promise<{ pred_masks: unknown; iou_scores: Tensorish }>;
  processor: ((image: unknown, o: Record<string, unknown>) => Promise<{ original_sizes: unknown; reshaped_input_sizes: unknown }>) & {
    post_process_masks(masks: unknown, original: unknown, reshaped: unknown): Promise<Tensorish[]>;
  };
  toImage(jpeg: Uint8Array): Promise<{ width: number; height: number }>;
};

/** Loads SAM 2.1 tiny from the local directory only (fp32: the export has no other), with remote models disabled. */
export const loadSam2: SamLoader = async (modelDir) => {
  const tf = await import('@huggingface/transformers');
  tf.env.localModelPath = modelDir;
  tf.env.allowRemoteModels = false;
  tf.env.allowLocalModels = true;
  const parts: Sam2Parts = {
    model: (await tf.Sam2Model.from_pretrained(SAM2_MODEL_ID, { dtype: 'fp32' })) as unknown as Sam2Parts['model'],
    processor: (await tf.AutoProcessor.from_pretrained(SAM2_MODEL_ID)) as unknown as Sam2Parts['processor'],
    toImage: (jpeg) => tf.RawImage.fromBlob(new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' })),
  };
  return {
    async run(jpeg, prompt) {
      const image = await parts.toImage(jpeg);
      const { width: w, height: h } = image;
      const { box, point } = prompt;
      const inputs = (await parts.processor(image, {
        input_boxes: [[[box.x * w, box.y * h, (box.x + box.w) * w, (box.y + box.h) * h]]],
        ...(point === null ? {} : { input_points: [[[[point.x * w, point.y * h]]]], input_labels: [[[1]]] }),
      })) as { original_sizes: unknown; reshaped_input_sizes: unknown };
      const out = await parts.model(inputs);
      const [masks] = await parts.processor.post_process_masks(out.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes);
      if (masks === undefined) throw new SegmenterError('The segmenter returned no masks.');
      // [1, candidates, h, w]
      const candidates = masks.dims[1] ?? 0;
      const size = w * h;
      const flat = masks.data;
      const list: Uint8Array[] = [];
      for (let k = 0; k < candidates; k++) {
        const one = new Uint8Array(size);
        for (let i = 0; i < size; i++) one[i] = flat[k * size + i] ? 1 : 0;
        list.push(one);
      }
      return { width: w, height: h, masks: list, scores: Array.from(out.iou_scores.data).slice(0, candidates) };
    },
  };
};

/** The bounding box of a mask's set pixels, 0..1 of the picture; null for an empty mask. */
function maskBox(mask: Uint8Array, w: number, h: number): DetectedBox | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0 / w, y: y0 / h, w: (x1 + 1 - x0) / w, h: (y1 + 1 - y0) / h, confidence: 1 };
}

function boxIoU(a: DetectedBox, b: DetectedBox): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/**
 * The window quad from the model's candidate masks: the masks whose own box is the box asked about (not the wall, not a corner of the
 * room), best score times overlap first, each fitted; the first fit that is good enough, else the best of the fits.
 */
export function quadFromMasks(out: SegmentOutput, box: DetectedBox): WindowQuad | null {
  return chooseQuad(out, box)?.quad ?? null;
}

/** `quadFromMasks`, and which of the model's masks the quad was fitted to (for the sample script's drawing). */
export function chooseQuad(out: SegmentOutput, box: DetectedBox): { quad: WindowQuad; maskIndex: number } | null {
  const { width: w, height: h } = out;
  const ranked = out.masks
    .map((mask, index) => {
      const mb = maskBox(mask, w, h);
      return { mask, index, iou: mb === null ? 0 : boxIoU(mb, box), score: out.scores[index] ?? 0 };
    })
    .filter((m) => m.iou >= MIN_BOX_IOU)
    .sort((a, b) => b.score * b.iou - a.score * a.iou)
    .slice(0, MAX_FITS);
  let best: { fit: QuadFit; score: number; rank: number; index: number } | null = null;
  for (const m of ranked) {
    const fit = fitWindowQuad(m.mask, w, h);
    if (fit === null) continue;
    const rank = fit.quality * m.iou;
    if (best === null || rank > best.rank) best = { fit, score: m.score, rank, index: m.index };
    if (fit.quality >= GOOD_ENOUGH) break;
  }
  if (best === null) return null;
  const q = (p: { x: number; y: number }): [number, number] => [Math.round((p.x / w) * 10_000) / 10_000, Math.round((p.y / h) * 10_000) / 10_000];
  const [tl, tr, br, bl] = best.fit.corners;
  return {
    maskIndex: best.index,
    quad: {
      corners: [q(tl), q(tr), q(br), q(bl)],
      quality: Math.round(best.fit.quality * 1000) / 1000,
      fill: Math.round(best.fit.fill * 1000) / 1000,
      residual: Math.round(best.fit.residual * 10_000) / 10_000,
      maskScore: Math.round(best.score * 1000) / 1000,
    },
  };
}

export class Sam2Segmenter implements WindowSegmenter {
  readonly name = 'sam2' as const;
  readonly configured = true;
  private loaded: ReturnType<SamLoader> | null = null;
  private readonly modelDir: string;
  private readonly load: SamLoader;
  private readonly timeoutMs: number;

  constructor(o: { modelDir: string; load?: SamLoader; timeoutMs?: number }) {
    this.modelDir = o.modelDir;
    this.load = o.load ?? loadSam2;
    this.timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  }

  async warm(): Promise<void> {
    this.loaded ??= this.load(this.modelDir);
    try {
      await this.loaded;
    } catch {
      this.loaded = null;
    }
  }

  async segment(jpeg: Uint8Array, box: DetectedBox, aim: { x: number; y: number }): Promise<WindowQuad | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SegmenterError('The window segmenter timed out.')), this.timeoutMs);
    });
    try {
      return await Promise.race([this.run(jpeg, box, aim), late]);
    } catch (err) {
      if (err instanceof SegmenterError) throw err;
      this.loaded = null;
      throw new SegmenterError('The window segmenter failed.');
    } finally {
      clearTimeout(timer);
    }
  }

  private async run(jpeg: Uint8Array, box: DetectedBox, aim: { x: number; y: number }): Promise<WindowQuad | null> {
    this.loaded ??= this.load(this.modelDir);
    const { run } = await this.loaded;
    // The prompt is the box, and the point the person aimed at when it is inside the box (it is on the window, not on a neighbour)
    const inside = aim.x >= box.x && aim.x <= box.x + box.w && aim.y >= box.y && aim.y <= box.y + box.h;
    return quadFromMasks(await run(jpeg, { box, point: inside ? aim : null }), box);
  }
}

export function createWindowSegmenter(config: Config): WindowSegmenter {
  if (config.WINDOW_SEGMENTER !== 'sam2') return new NoSegmenter();
  const dir = config.SAM_MODEL_DIR ?? config.WINDOW_MODEL_DIR;
  return dir !== undefined && sam2Present(dir) ? new Sam2Segmenter({ modelDir: dir }) : new UnconfiguredSam2();
}
