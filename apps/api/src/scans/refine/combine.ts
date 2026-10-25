import {
  computeRefinedScan,
  type RefinedScan,
  type ScanColmapSummary,
  type ScanFrame,
  type ScanFrameAi,
  type ScanMark,
  type ScanPoseSource,
  type ScanResult,
  type ScanWall,
  scanColmapDecision,
  scanEffectiveFrames,
  scanResultOf,
} from '@roofline/shared';
import type { ColmapOutput } from './colmap.ts';

/*
 * What the refinement does once COLMAP and the AI have answered, as one pure function: decide whether COLMAP's poses are
 * taken (docs/windows/scan-contract.md "Refinement": aligned within 2 cm over at least 4 registered photos), merge the AI's
 * marks with the phone's and the reviewer's, triangulate every corner robustly with the poses it ended up with, and work
 * out the result with the unchanged level fit and seven gates.
 */

/** A camera COLMAP put more than this far from the phone's (cm) or turned more than this (degrees) keeps ARKit's pose. */
export const FRAME_ALIGN_LIMITS = { cm: 5, deg: 5 } as const;

export type CombineInput = {
  /** The frames as the phone sent them (ARKit's poses). */
  frames: readonly ScanFrame[];
  wall: ScanWall | null;
  /** The phone's marks with whatever a reviewer placed or moved on top. */
  base: readonly ScanMark[];
  /** The AI's frames and marks; null when the AI did not run (no segmenter). */
  ai: { frames: ScanFrameAi[]; marks: ScanMark[] } | null;
  /** COLMAP's answer; null when it did not run, with why. */
  colmap: { out: ColmapOutput | null; skipped: string | null };
  firstResult: ScanResult;
};

export type Combined = {
  poseSource: ScanPoseSource;
  poseNote: string | null;
  poses: Record<string, number[]>;
  colmap: ScanColmapSummary;
  refined: RefinedScan;
  result: ScanResult;
};

const round = (v: number, places: number): number => Math.round(v * 10 ** places) / 10 ** places;

export function summariseColmap(out: ColmapOutput | null, skipped: string | null, total: number): ScanColmapSummary {
  const none: ScanColmapSummary = { ran: false, used: false, registered: 0, total, alignmentRmsCm: null, alignmentMaxCm: null, rotationRmsDeg: null, scale: null, method: null, points: 0, meanReprojPx: null, reason: skipped ?? 'COLMAP is not set up on this machine.', ms: null };
  if (out === null) return none;
  if (!out.ok) return { ...none, ran: true, reason: out.detail ?? `COLMAP failed (${out.reason}).` };
  const ms = { extract: round(out.timings.extract * 1000, 0), match: round(out.timings.match * 1000, 0), map: round(out.timings.map * 1000, 0), align: round((out.timings.align ?? 0) * 1000, 0) };
  const base: ScanColmapSummary = { ...none, ran: true, registered: out.registered.length, points: out.points?.count ?? out.model.points, meanReprojPx: round(out.model.meanReprojPx, 3), ms, reason: null };
  const al = out.alignment;
  if (!out.aligned || al === undefined) return { ...base, reason: out.detail ?? 'COLMAP could not line up with the phone.' };
  const decision = scanColmapDecision({ registered: out.registered.length, total, alignmentRmsCm: al.rmsCm, rotationRmsDeg: al.rotationRmsDeg });
  return {
    ...base,
    used: decision.use,
    alignmentRmsCm: round(al.rmsCm, 3),
    alignmentMaxCm: round(al.maxCm, 3),
    rotationRmsDeg: round(al.rotationRmsDeg, 3),
    scale: round(al.scale, 6),
    method: al.method,
    reason: decision.reason,
  };
}

/** The poses of the registered frames that COLMAP and the phone agree on, as the refined camera transforms. */
function colmapPoses(out: ColmapOutput | null): Record<string, number[]> {
  if (out === null || !out.ok || !out.aligned || out.poses === undefined) return {};
  const al = out.alignment;
  const poses: Record<string, number[]> = {};
  for (const [id, p] of Object.entries(out.poses)) {
    if (al !== undefined && ((al.perFrameCm[id] ?? 0) > FRAME_ALIGN_LIMITS.cm || (al.perFrameDeg[id] ?? 0) > FRAME_ALIGN_LIMITS.deg)) continue;
    if (p.cameraTransform.length === 16 && p.cameraTransform.every(Number.isFinite)) poses[id] = p.cameraTransform;
  }
  return poses;
}

export function combineRefinement(i: CombineInput): Combined {
  const frames = [...i.frames];
  const aiMarks = i.ai?.marks ?? [];
  const colmap = summariseColmap(i.colmap.out, i.colmap.skipped, frames.length);
  const poses = colmap.used ? colmapPoses(i.colmap.out) : {};
  const arkit = computeRefinedScan(frames, i.base, aiMarks, i.wall);
  let poseSource: ScanPoseSource = 'arkit';
  let poseNote: string | null = colmap.used ? null : colmap.reason;
  let refined = arkit;
  let kept: Record<string, number[]> = {};
  if (colmap.used && Object.keys(poses).length >= 1) {
    const withColmap = computeRefinedScan(scanEffectiveFrames(frames, poses), i.base, aiMarks, i.wall);
    if (withColmap.comp.quality.failed.length > arkit.comp.quality.failed.length) {
      // COLMAP's poses are within the limits but the result is worse than ARKit's: do not make a scan worse by refining it
      poseNote = `COLMAP's poses fit the marks worse than ARKit's (${withColmap.comp.quality.failed.length} checks fail against ${arkit.comp.quality.failed.length}).`;
      colmap.used = false;
      colmap.reason = poseNote;
    } else {
      poseSource = 'colmap';
      refined = withColmap;
      kept = poses;
      poseNote = null;
    }
  }
  const result = scanResultOf(refined.comp, i.firstResult.windowFrame);
  const aiOk = (i.ai?.frames ?? []).filter((f) => f.state === 'ok').length;
  result.refined = {
    poseSource,
    colmapFrames: Object.keys(kept).length,
    frames: frames.length,
    alignmentRmsCm: poseSource === 'colmap' ? colmap.alignmentRmsCm : null,
    aiFrames: aiOk,
    aiMarks: aiMarks.length,
    marksUsed: refined.marks.length,
    marksDropped: refined.dropped.length,
    firstWidthIn: i.firstResult.widthIn,
    firstHeightIn: i.firstResult.heightIn,
  };
  return { poseSource, poseNote, poses: kept, colmap, refined, result };
}
