import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getWindowScan, getWindowScanContext, type StoredWindowUpload, type TenantContext, updateWindowScan, withTenant, type WindowScanRow } from '@roofline/db';
import type { ScanFrame, ScanHistoryEvent, ScanMark, ScanRefinementRecord, ScanResult, ScanVec3, ScanStatus } from '@roofline/shared';
import type { AppDeps } from '../../app.ts';
import { applyMeasuredScan, scanSizeProblem } from '../../estimator/window-scan-apply.ts';
import { describeErrorForLog } from '../../errors.ts';
import type { JobMeta } from '../../jobs/queue.ts';
import { systemContext } from '../../permissions.ts';
import { UUID } from '../../validate.ts';
import { type AiOutcome, runAiFrames } from './ai.ts';
import { type ColmapOutput } from './colmap.ts';
import { combineRefinement } from './combine.ts';

/*
 * The `scan-refine` job (docs/windows/scan-contract.md, "Refinement"). After the phone's scan is stored (and when a reviewer asks
 * again) the worker
 *   1. runs SAM 2 on every frame, prompted with the current triangulated window projected into it (apps/api/src/scans/refine/ai.ts),
 *   2. rebuilds the poses with COLMAP from the photos, with the intrinsics known, aligned to ARKit's world (colmap.ts),
 *   3. merges the AI's marks with the phone's and the reviewer's, triangulates every corner again, robustly, with the refined
 *      poses, and works out the result with the same level fit and gates (combine.ts, shared window-scan-refine.ts).
 * A scan made `processing` at upload is then accepted (every gate passes) or sent to review; a scan already in review keeps its
 * status. The refinement is kept on the scan row (`window_scans.refinement`) next to the first server result; the server's
 * effective result (`server_result`) is the refined one. A failure never strands a scan: it falls back to the first result.
 * AI and COLMAP run side by side: they are different resources (the model in this process, COLMAP in a child process).
 */

/** The statuses a scan can be refined in: waiting for its first refinement, or open for a person. */
const REFINABLE: readonly ScanStatus[] = ['processing', 'needs_review', 'in_review', 'junior_done'];
export const isRefinable = (status: ScanStatus): boolean => REFINABLE.includes(status);
export const refineActive = (rec: Pick<ScanRefinementRecord, 'state'> | null | undefined): boolean => rec?.state === 'queued' || rec?.state === 'running';

/** Whether this server refines scans at all: switched on, and there is an AI model or COLMAP to do it with. */
export function refineAvailable(deps: Pick<AppDeps, 'config' | 'windowSegmenter' | 'scanColmap'>): boolean {
  return deps.config.SCAN_REFINE === 'on' && ((deps.windowSegmenter.configured && deps.windowSegmenter.segmentMask !== undefined) || (deps.scanColmap?.configured ?? false));
}

export const maskKeyOf = (companyId: string, rowId: string, frameId: string): string => `${companyId}/window-scans/${rowId}/masks/${frameId}.png`;
export const cloudKeyOf = (companyId: string, rowId: string): string => `${companyId}/window-scans/${rowId}/cloud.ply`;

/** A refinement waiting in the queue. */
export function queuedRefinement(trigger: 'upload' | 'rerun', now: Date, firstResult: ScanResult | null, previous?: ScanRefinementRecord | null): ScanRefinementRecord {
  return {
    version: 1,
    state: 'queued',
    trigger,
    requestedAt: now.toISOString(),
    startedAt: null,
    finishedAt: null,
    attempt: 0,
    error: null,
    firstResult: previous?.firstResult ?? firstResult,
    poseSource: previous?.poseSource ?? null,
    poseNote: previous?.poseNote ?? null,
    poses: previous?.poses ?? {},
    colmap: previous?.colmap ?? null,
    frames: previous?.frames ?? [],
    aiMarks: previous?.aiMarks ?? [],
    alternatives: previous?.alternatives ?? [],
    dropped: previous?.dropped ?? [],
    cloudKey: previous?.cloudKey ?? null,
    cloudPoints: previous?.cloudPoints ?? 0,
    timings: previous?.timings ?? null,
  };
}

/** Puts the job on the queue (one waiting per scan: a second ask while it waits is the same job). */
export async function enqueueScanRefine(deps: Pick<AppDeps, 'jobs'>, companyId: string, scanRowId: string): Promise<void> {
  await deps.jobs.send('scan-refine', { companyId, scanRowId }, { singletonKey: scanRowId });
}

/** The marks a refinement starts from: the phone's, with whatever a reviewer placed or moved (source 'user') on top. */
export function baseMarksOf(row: Pick<WindowScanRow, 'marks' | 'marksOriginal'>): ScanMark[] {
  const key = (m: ScanMark) => `${m.frameId}\u0000${m.corner}`;
  const by = new Map(row.marksOriginal.map((m) => [key(m), m]));
  for (const m of row.marks) if (m.source === 'user') by.set(key(m), m);
  return [...by.values()];
}

const sentence = (err: unknown): string => {
  const text = err instanceof Error ? err.message : describeErrorForLog(err);
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
};

type Claimed = { row: WindowScanRow; uploads: StoredWindowUpload[] };

type Work = {
  ai: AiOutcome | null;
  colmap: { out: ColmapOutput | null; skipped: string | null };
  ply: Uint8Array | null;
  timings: { totalMs: number; aiMs: number; colmapMs: number };
};

/**
 * The job. Throws only for what is worth another try (the database was not reachable); anything else is a refinement that
 * could not be done, and that is recorded and falls back to the first result.
 */
export async function runScanRefine(deps: AppDeps, companyId: string, scanRowId: string, meta: JobMeta): Promise<void> {
  // A job that names no scan has nothing to do (and nothing a retry could fix)
  if (typeof scanRowId !== 'string' || !UUID.test(scanRowId)) return;
  const ctx = systemContext(companyId);
  const claimed = await claim(deps, ctx, scanRowId, meta);
  if (claimed === null) return;
  let work: Work;
  try {
    work = await doWork(deps, ctx, claimed);
  } catch (err) {
    await fail(deps, ctx, scanRowId, sentence(err));
    return;
  }
  try {
    await persist(deps, ctx, scanRowId, work);
  } catch (err) {
    if (!meta.lastAttempt) throw err;
    await fail(deps, ctx, scanRowId, sentence(err));
  }
}

async function claim(deps: AppDeps, ctx: TenantContext, scanRowId: string, meta: JobMeta): Promise<Claimed | null> {
  const now = deps.clock.now();
  return withTenant(deps.pools, ctx, async (tx) => {
    const row = await getWindowScan(tx, ctx, scanRowId, { lock: true });
    if (row === null || !isRefinable(row.status)) return null;
    const rec: ScanRefinementRecord = { ...(row.refinement ?? queuedRefinement('upload', now, row.serverResult)), state: 'running', startedAt: now.toISOString(), finishedAt: null, attempt: meta.attempt, error: null };
    const updated = await updateWindowScan(tx, ctx, row.id, { refinement: rec }, now);
    const context = await getWindowScanContext(tx, ctx, row);
    return { row: updated ?? row, uploads: context?.uploads ?? [] };
  });
}

/** The AI on every frame and COLMAP on the photos, side by side. */
async function doWork(deps: AppDeps, ctx: TenantContext, claimed: Claimed): Promise<Work> {
  const { row, uploads } = claimed;
  const started = Date.now();
  const frames: ScanFrame[] = row.frames;
  const jpegs = new Map<string, Uint8Array | null>();
  for (const f of frames) {
    const upload = uploads.find((u) => u.id === f.uploadId);
    jpegs.set(f.frameId, upload === undefined ? null : await deps.objectStore.get(upload.key));
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'scan-refine-'));
  try {
    const estimate = row.serverResult.cornersM;
    const ai = (async (): Promise<{ out: AiOutcome | null; ms: number }> => {
      const t0 = Date.now();
      if (!deps.windowSegmenter.configured || deps.windowSegmenter.segmentMask === undefined) return { out: null, ms: 0 };
      const out = await runAiFrames(
        frames.map((frame) => ({ frame, jpeg: jpegs.get(frame.frameId) ?? null })),
        { segmenter: deps.windowSegmenter, detector: deps.windowDetector, estimateM: estimate as ScanVec3[] | null, maskKey: (id) => maskKeyOf(ctx.companyId, row.id, id) },
      );
      return { out, ms: Date.now() - t0 };
    })();
    const colmap = (async (): Promise<{ out: ColmapOutput | null; skipped: string | null; ply: Uint8Array | null; ms: number }> => {
      const t0 = Date.now();
      const runner = deps.scanColmap;
      if (runner === undefined || runner === null || !runner.configured) return { out: null, skipped: 'COLMAP is not set up on this machine.', ply: null, ms: 0 };
      const present = frames.filter((f) => jpegs.get(f.frameId) != null);
      if (present.length < 3) return { out: null, skipped: 'Fewer than three photos could be read.', ply: null, ms: 0 };
      const imgDir = path.join(dir, 'images');
      await mkdir(imgDir, { recursive: true });
      const images = [];
      for (const f of present) {
        const file = path.join(imgDir, `${f.frameId}.jpg`);
        await writeFile(file, jpegs.get(f.frameId)!);
        images.push({ frameId: f.frameId, path: file, imageWidth: f.imageWidth, imageHeight: f.imageHeight, intrinsics: f.intrinsics, cameraTransform: f.cameraTransform });
      }
      const plyPath = path.join(dir, 'cloud.ply');
      let out: ColmapOutput;
      try {
        out = await runner.run({ images, workDir: path.join(dir, 'colmap-run'), plyPath });
      } catch (err) {
        out = { ok: false, reason: 'error', detail: `COLMAP could not be run: ${sentence(err)}` };
      }
      let ply: Uint8Array | null = null;
      if (out.ok && out.points?.ply != null) {
        try {
          ply = new Uint8Array(await readFile(out.points.ply));
        } catch {
          ply = null;
        }
      }
      return { out, skipped: null, ply, ms: Date.now() - t0 };
    })();
    const [a, c] = await Promise.all([ai, colmap]);
    return { ai: a.out, colmap: { out: c.out, skipped: c.skipped }, ply: c.ply, timings: { totalMs: Date.now() - started, aiMs: a.ms, colmapMs: c.ms } };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function describeRefined(r: ScanResult): string {
  const f = r.refined;
  if (f === undefined) return '';
  const size = r.widthIn === null || r.heightIn === null ? 'no size' : `${r.widthIn.toFixed(2)} x ${r.heightIn.toFixed(2)} in`;
  const poses = f.poseSource === 'colmap' ? `COLMAP poses on ${f.colmapFrames} of ${f.frames} frames${f.alignmentRmsCm === null ? '' : ` (${f.alignmentRmsCm.toFixed(1)} cm)`}` : 'ARKit poses kept';
  return `${poses}; AI on ${f.aiFrames} frames (${f.aiMarks} marks); ${size}`;
}

async function persist(deps: AppDeps, ctx: TenantContext, scanRowId: string, work: Work): Promise<void> {
  const now = deps.clock.now();
  // The files first, so a scan never points at a file that is not there. They are keyed by scan and frame: a second run replaces them.
  const maskKeys = new Map<string, string>();
  for (const [frameId, png] of work.ai?.masks ?? []) {
    const key = maskKeyOf(ctx.companyId, scanRowId, frameId);
    await deps.objectStore.put(key, png, 'image/png');
    maskKeys.set(frameId, key);
  }
  let cloudKey: string | null = null;
  if (work.ply !== null) {
    cloudKey = cloudKeyOf(ctx.companyId, scanRowId);
    await deps.objectStore.put(cloudKey, work.ply, 'text/plain');
  }
  await withTenant(deps.pools, ctx, async (tx) => {
    const row = await getWindowScan(tx, ctx, scanRowId, { lock: true });
    if (row === null || !isRefinable(row.status)) return;
    const rec = row.refinement ?? queuedRefinement('upload', now, row.serverResult);
    const firstResult = rec.firstResult ?? row.serverResult;
    const combined = combineRefinement({
      frames: row.frames,
      wall: row.wall,
      base: baseMarksOf(row),
      ai: work.ai === null ? null : { frames: work.ai.frames, marks: work.ai.marks },
      colmap: work.colmap,
      firstResult,
    });
    const record: ScanRefinementRecord = {
      ...rec,
      state: 'done',
      finishedAt: now.toISOString(),
      error: null,
      firstResult,
      poseSource: combined.poseSource,
      poseNote: combined.poseNote,
      poses: combined.poses,
      colmap: combined.colmap,
      frames: (work.ai?.frames ?? []).map((f) => ({ ...f, maskKey: maskKeys.get(f.frameId) ?? null })),
      aiMarks: work.ai?.marks ?? [],
      alternatives: combined.refined.alternatives,
      dropped: combined.refined.dropped,
      cloudKey,
      cloudPoints: cloudKey === null ? 0 : (combined.colmap.points ?? 0),
      timings: work.timings,
    };
    const result = combined.result;
    const wasProcessing = row.status === 'processing';
    // The auto-accept rule is the one the upload route had: every gate passes (and a size a window can have). A scan a person is
    // already working on stays where it is.
    const accepted = wasProcessing && result.status === 'measured' && scanSizeProblem(result) === null;
    if (wasProcessing) result.status = accepted ? 'measured' : 'needs_review';
    const status: ScanStatus = wasProcessing ? (accepted ? 'measured' : 'needs_review') : row.status;
    const events: ScanHistoryEvent[] = [{ at: now.toISOString(), by: null, action: 'refined', ...(wasProcessing && !accepted && { from: 'processing' as const, to: 'needs_review' as const }), note: describeRefined(result) }];
    if (accepted) events.push({ at: now.toISOString(), by: null, action: 'auto_accepted', from: 'processing', to: 'measured' });
    const updated = await updateWindowScan(tx, ctx, row.id, { marks: combined.refined.marks, serverResult: result, refinement: record, status, history: [...row.history, ...events] }, now, 'window_scan.refine');
    if (updated === null || !accepted) return;
    if (await applyMeasuredScan(tx, ctx, updated, now)) return;
    // The window could not take the size: a person looks at it instead
    await updateWindowScan(
      tx,
      ctx,
      row.id,
      { status: 'needs_review', serverResult: { ...result, status: 'needs_review' }, history: [...updated.history, { at: now.toISOString(), by: null, action: 'marks_edited', from: 'measured', to: 'needs_review', note: 'The window could not take the scan size.' }] },
      now,
    );
  });
}

/**
 * A refinement that could not be done: it is recorded, and a scan still `processing` takes the decision the first result gave
 * (accepted when it passed every gate, else to review), so no scan waits for ever.
 */
export async function failRefinement(deps: Pick<AppDeps, 'pools' | 'clock'>, ctx: TenantContext, scanRowId: string, message: string): Promise<void> {
  const now = deps.clock.now();
  await withTenant(deps.pools, ctx, async (tx) => {
    const row = await getWindowScan(tx, ctx, scanRowId, { lock: true });
    if (row === null) return;
    const rec = row.refinement ?? queuedRefinement('upload', now, row.serverResult);
    const record: ScanRefinementRecord = { ...rec, state: 'failed', finishedAt: now.toISOString(), error: message };
    if (row.status !== 'processing') {
      if (isRefinable(row.status)) await updateWindowScan(tx, ctx, row.id, { refinement: record, history: [...row.history, { at: now.toISOString(), by: null, action: 'refine_failed', note: message }] }, now);
      return;
    }
    const first = row.serverResult;
    const accepted = first.status === 'measured' && scanSizeProblem(first) === null;
    const events: ScanHistoryEvent[] = [{ at: now.toISOString(), by: null, action: 'refine_failed', note: message }];
    if (accepted) events.push({ at: now.toISOString(), by: null, action: 'auto_accepted', from: 'processing', to: 'measured' });
    else events[0] = { ...events[0]!, from: 'processing', to: 'needs_review' };
    const updated = await updateWindowScan(
      tx,
      ctx,
      row.id,
      { refinement: record, status: accepted ? 'measured' : 'needs_review', serverResult: { ...first, status: accepted ? 'measured' : 'needs_review' }, history: [...row.history, ...events] },
      now,
      'window_scan.refine_failed',
    );
    if (updated === null || !accepted) return;
    if (await applyMeasuredScan(tx, ctx, updated, now)) return;
    await updateWindowScan(
      tx,
      ctx,
      row.id,
      { status: 'needs_review', serverResult: { ...first, status: 'needs_review' }, history: [...updated.history, { at: now.toISOString(), by: null, action: 'marks_edited', from: 'measured', to: 'needs_review', note: 'The window could not take the scan size.' }] },
      now,
    );
  });
}

async function fail(deps: AppDeps, ctx: TenantContext, scanRowId: string, message: string): Promise<void> {
  try {
    await failRefinement(deps, ctx, scanRowId, message);
  } catch (err) {
    deps.logError?.(err, `scan-refine ${scanRowId}`);
    throw err;
  }
}
