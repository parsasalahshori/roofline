import {
  SCAN_REFINE_LIMITS,
  type ScanFrame,
  type ScanFrameAi,
  type ScanMark,
  type ScanVec3,
  scanOrderQuad,
  scanProjectedBox,
} from '@roofline/shared';
import { type DetectedBox, pickWindowBox, type WindowDetector } from '../../providers/window-detector.ts';
import type { WindowSegmenter } from '../../providers/window-segmenter.ts';
import { encodeMaskPng } from './png.ts';

/*
 * The AI on every frame of a scan. SAM 2 is asked for the window on each photo with a prompt that is already close: the
 * current triangulated window rectangle projected into that frame (padded 8%) as the box, its centre as a positive point;
 * OWLv2 finds a box only where there is no estimate yet. The mask is fitted with a quad (providers/window-quad.ts), the quad's
 * corners are put in the scan's corner order and become four marks (source 'ai'), and the mask itself goes back as a small
 * PNG for the reviewer's overlay.
 */

export type AiFrameInput = { frame: ScanFrame; jpeg: Uint8Array | null };

export type AiOutcome = {
  frames: ScanFrameAi[];
  /** Four marks for each frame whose quad is believable. */
  marks: ScanMark[];
  /** The mask PNGs by frame id. */
  masks: Map<string, Uint8Array>;
};

export type AiOptions = {
  segmenter: WindowSegmenter;
  detector: WindowDetector;
  /** The current window (four corners, world metres) to project into each frame, or null when there is none yet. */
  estimateM: readonly ScanVec3[] | null;
  /** The key a frame's mask is stored under. */
  maskKey: (frameId: string) => string;
  /** Called after each frame (a job's progress, a test's spy). */
  onFrame?: (done: ScanFrameAi) => void;
  now?: () => number;
};

const failed = (frameId: string, state: ScanFrameAi['state'], note: string, ms: number, box: ScanFrameAi['box'] = null, prompt: ScanFrameAi['prompt'] = null): ScanFrameAi => ({
  frameId,
  state,
  quality: null,
  maskScore: null,
  box,
  prompt,
  maskKey: null,
  marks: 0,
  ms,
  note,
});

const round = (v: number, places: number): number => Math.round(v * 10 ** places) / 10 ** places;

/** Runs the AI on each frame in turn (the model is one process-wide instance; frames queue behind each other). */
export async function runAiFrames(inputs: readonly AiFrameInput[], o: AiOptions): Promise<AiOutcome> {
  const out: AiOutcome = { frames: [], marks: [], masks: new Map() };
  const now = o.now ?? Date.now;
  const segmentMask = o.segmenter.segmentMask?.bind(o.segmenter);
  for (const { frame, jpeg } of inputs) {
    const t0 = now();
    const done = (r: ScanFrameAi) => {
      out.frames.push(r);
      o.onFrame?.(r);
    };
    if (segmentMask === undefined || !o.segmenter.configured) {
      done(failed(frame.frameId, 'error', 'The segmenter is not set up.', 0));
      continue;
    }
    if (jpeg === null) {
      done(failed(frame.frameId, 'error', 'The photo is missing.', now() - t0));
      continue;
    }
    const W = frame.intrinsics.width;
    const H = frame.intrinsics.height;
    try {
      // 1. The prompt
      let box: [number, number, number, number] | null = null;
      let point: [number, number] | null = null;
      let prompt: ScanFrameAi['prompt'] = null;
      let projected: [number, number][] | null = null;
      let tolerancePx = Infinity;
      if (o.estimateM !== null) {
        const pb = scanProjectedBox(o.estimateM, frame, SCAN_REFINE_LIMITS.boxPad);
        if (pb === null) {
          done(failed(frame.frameId, 'not_visible', 'The window is not in this picture.', now() - t0));
          continue;
        }
        box = pb.box;
        point = pb.point;
        projected = pb.corners;
        prompt = 'projected';
        // A corner the AI finds this far from where the window is expected is not that corner (a mask that took in the wall next to it)
        tolerancePx = Math.max(SCAN_REFINE_LIMITS.minCornerTolPx, SCAN_REFINE_LIMITS.cornerTolShare * Math.min(Math.max(...pb.corners.map((c) => c[0])) - Math.min(...pb.corners.map((c) => c[0])), Math.max(...pb.corners.map((c) => c[1])) - Math.min(...pb.corners.map((c) => c[1]))));
      } else if (o.detector.configured && o.detector.detectInterior !== undefined) {
        const found = pickWindowBox(await o.detector.detectInterior(jpeg), { x: 0.5, y: 0.5 });
        if (found !== null) {
          box = [found.x * W, found.y * H, (found.x + found.w) * W, (found.y + found.h) * H];
          point = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
          prompt = 'owlv2';
        }
      }
      if (box === null || point === null) {
        done(failed(frame.frameId, 'no_estimate', 'There is no window estimate to start from.', now() - t0));
        continue;
      }
      const boxN: DetectedBox = { x: box[0] / W, y: box[1] / H, w: (box[2] - box[0]) / W, h: (box[3] - box[1]) / H, confidence: 1 };
      const aim = { x: point[0] / W, y: point[1] / H };

      // 2. SAM 2
      const seg = await segmentMask(jpeg, boxN, aim);
      let maskKey: string | null = null;
      if (seg.mask !== null) {
        const png = encodeMaskPng(seg.mask.data, seg.mask.width, seg.mask.height);
        maskKey = o.maskKey(frame.frameId);
        out.masks.set(frame.frameId, png.png);
      }
      const boxOut: ScanFrameAi['box'] = [round(box[0], 1), round(box[1], 1), round(box[2], 1), round(box[3], 1)];
      if (seg.quad === null) {
        done({ ...failed(frame.frameId, 'no_quad', seg.mask === null ? 'SAM gave no mask.' : 'The mask has no four-sided shape (the window may run off the picture).', now() - t0, boxOut, prompt), maskKey, maskScore: seg.mask === null ? null : round(seg.mask.score, 3) });
        continue;
      }

      // 3. The quad, in the scan's corner order, in native pixels
      const quadPx = seg.quad.corners.map((c) => [c[0] * W, c[1] * H] as [number, number]);
      const ordered = scanOrderQuad(quadPx, frame, projected);
      const fitOk = seg.quad.quality >= SCAN_REFINE_LIMITS.minAiQuality;
      const marks: ScanMark[] = [];
      if (fitOk) {
        ordered.forEach((p, i) => {
          const inPicture = p[0] >= -2 && p[1] >= -2 && p[0] <= W + 2 && p[1] <= H + 2;
          const near = projected === null || Math.hypot(p[0] - projected[i]![0], p[1] - projected[i]![1]) <= tolerancePx;
          if (inPicture && near) marks.push({ frameId: frame.frameId, corner: i as 0 | 1 | 2 | 3, x: round(p[0], 2), y: round(p[1], 2), source: 'ai' });
        });
      }
      const state: ScanFrameAi['state'] = !fitOk ? 'low_quality' : marks.length === 0 ? 'off_target' : 'ok';
      done({
        frameId: frame.frameId,
        state,
        quality: round(seg.quad.quality, 3),
        maskScore: round(seg.quad.maskScore, 3),
        box: boxOut,
        prompt,
        maskKey,
        marks: marks.length,
        ms: now() - t0,
        note: !fitOk ? `The fit to the mask is weak (${round(seg.quad.quality, 2)}); its corners are not used.` : marks.length === 0 ? 'The mask is not where the window should be; its corners are not used.' : marks.length < 4 ? `${4 - marks.length} corner${marks.length === 3 ? '' : 's'} of the mask are not where the window should be and are not used.` : null,
      });
      out.marks.push(...marks);
    } catch (err) {
      done(failed(frame.frameId, 'error', err instanceof Error ? err.message.slice(0, 200) : 'The AI failed on this frame.', now() - t0));
    }
  }
  return out;
}
