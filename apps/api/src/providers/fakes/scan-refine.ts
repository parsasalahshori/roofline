import { polygonMask } from '../window-quad.ts';
import type { DetectedBox } from '../window-detector.ts';
import type { MaskedSegment, WindowQuad, WindowSegmenter } from '../window-segmenter.ts';
import type { ColmapJob, ColmapOutput, ColmapRunner } from '../../scans/refine/colmap.ts';

/*
 * Stand-ins for SAM 2 and COLMAP, for the tests of the scan refinement and for demo mode. No model, no process: each answers
 * what a function it was given says, and remembers what it was asked.
 */

export type SegmentCall = { index: number; box: DetectedBox; aim: { x: number; y: number }; bytes: number };
/** What the fake gives for a call: the quad's corners (0..1 of the picture, TL TR BR BL), its quality, and SAM's score; null for "no mask". */
export type SegmentAnswer = { corners: [[number, number], [number, number], [number, number], [number, number]] | null; quality?: number; maskScore?: number } | null;

export class FakeWindowSegmenter implements WindowSegmenter {
  readonly name = 'sam2' as const;
  configured = true;
  readonly calls: SegmentCall[] = [];
  /** Throw this on every call (a model that falls over). */
  failWith: Error | null = null;

  /** `answer(call)` says what the window looks like for each call, in the order the calls come (one per frame). */
  constructor(private answer: (call: SegmentCall) => SegmentAnswer) {}

  async segment(jpeg: Uint8Array, box: DetectedBox, aim: { x: number; y: number }): Promise<WindowQuad | null> {
    return (await this.segmentMask(jpeg, box, aim)).quad;
  }

  async segmentMask(jpeg: Uint8Array, box: DetectedBox, aim: { x: number; y: number }): Promise<MaskedSegment> {
    const call: SegmentCall = { index: this.calls.length, box, aim, bytes: jpeg.length };
    this.calls.push(call);
    if (this.failWith !== null) throw this.failWith;
    const a = this.answer(call);
    if (a === null || a.corners === null) return { quad: null, mask: null };
    const w = 192;
    const h = 144;
    const poly = a.corners.map((c) => ({ x: c[0] * w, y: c[1] * h }));
    const data = polygonMask(w, h, poly);
    const maskScore = a.maskScore ?? 0.95;
    return { quad: { corners: a.corners, quality: a.quality ?? 0.9, fill: 0.97, residual: 0.003, maskScore }, mask: { width: w, height: h, data, score: maskScore } };
  }
}

/** COLMAP that answers from a function of the job (the images it was given), and records the jobs. */
export class FakeColmap implements ColmapRunner {
  readonly configured = true;
  readonly jobs: ColmapJob[] = [];
  constructor(private answer: (job: ColmapJob) => ColmapOutput | Promise<ColmapOutput>) {}
  async run(job: ColmapJob): Promise<ColmapOutput> {
    this.jobs.push(job);
    return this.answer(job);
  }
}

/** A COLMAP answer that registers every photo, with the camera transforms it was given (optionally moved) and this alignment. */
export function colmapAnswer(job: ColmapJob, o: { rmsCm?: number; rotationRmsDeg?: number; move?: (frameId: string, m: number[]) => number[]; registered?: string[]; points?: number } = {}): ColmapOutput {
  const ids = o.registered ?? job.images.map((i) => i.frameId);
  const poses: Record<string, { cameraTransform: number[]; numPoints: number }> = {};
  const perFrameCm: Record<string, number> = {};
  const perFrameDeg: Record<string, number> = {};
  for (const im of job.images) {
    if (!ids.includes(im.frameId)) continue;
    poses[im.frameId] = { cameraTransform: o.move === undefined ? im.cameraTransform : o.move(im.frameId, im.cameraTransform), numPoints: 400 };
    perFrameCm[im.frameId] = o.rmsCm ?? 0.4;
    perFrameDeg[im.frameId] = o.rotationRmsDeg ?? 0.1;
  }
  return {
    ok: true,
    aligned: true,
    registered: ids,
    unregistered: job.images.map((i) => i.frameId).filter((i) => !ids.includes(i)),
    model: { images: ids.length, points: o.points ?? 0, meanReprojPx: 0.2, meanTrackLength: 3.5, models: 1 },
    timings: { extract: 1.5, match: 0.5, map: 1, align: 0.01 },
    alignment: { method: 'centres', scale: 0.4, rmsCm: o.rmsCm ?? 0.4, maxCm: (o.rmsCm ?? 0.4) * 1.5, rotationRmsDeg: o.rotationRmsDeg ?? 0.1, rotationMaxDeg: (o.rotationRmsDeg ?? 0.1) * 1.4, registered: ids.length, total: job.images.length, perFrameCm, perFrameDeg },
    poses,
    points: { count: o.points ?? 0, ply: null },
  };
}
