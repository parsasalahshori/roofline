import express, { type Router } from 'express';
import { z } from 'zod';
import {
  createWindowScan,
  ensureHomeownerMeasurement,
  getHomeownerRequest,
  getWindowMeasurement,
  getWindowScanByScanId,
  updateWindowScan,
  type WindowScanRow,
  withTenant,
} from '@roofline/db';
import { computeScanResult, HOMEOWNER_APP_SOURCE, SCAN_GATE_CODES, SCAN_LIMITS, SCAN_MARK_SOURCES, scanFrameProblem, scanResultOf, type ScanFrame, type ScanMark, type ScanResult } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { applyMeasuredScan, scanSizeProblem } from '../estimator/window-scan-apply.ts';
import { AppError } from '../errors.ts';
import { systemContext } from '../permissions.ts';
import { enqueueScanRefine, failRefinement, queuedRefinement, refineAvailable } from '../scans/refine/run.ts';
import { noNul, parse } from '../validate.ts';
import { authed, type TokenBudget } from './homeowner-auth.ts';
import { route } from './quote-access.ts';

/*
 * POST /api/public/homeowner/:slug/requests/:id/scans (docs/windows/scan-contract.md, docs/windows/homeowner-api.md): the
 * phone's multi-frame scan of a window it already sent. The frames' JPEGs went up through the uploads route first. The
 * server checks the shape, runs the triangulation and the quality gates again from the frames and the marks (its answer is
 * the one that counts; the phone's is kept for comparison), stores the scan, and accepts it at once when no gate fails.
 */

/** A scan body: the frames' camera poses and intrinsics and the marks, a few hundred numbers each. */
export const SCAN_BODY_LIMIT = '1mb';
/** The SLA of a scan that needs a person, from its creation. */
export const SCAN_SLA_MS = SCAN_LIMITS.slaHours * 60 * 60 * 1000;

const SCAN_MESSAGE = 'Please scan this window again.';
const PHOTO_UNKNOWN_MESSAGE = 'A photo of this scan is not part of this request. Please scan the window again.';
const WINDOW_UNKNOWN_MESSAGE = 'Please send the window before its scan.';
const MARK_OUTSIDE_MESSAGE = 'A corner mark is outside its photo. Please scan the window again.';

const WINDOW_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FRAME_ID = /^[A-Za-z0-9_-]{1,40}$/;
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const num = z.number({ error: SCAN_MESSAGE }).finite(SCAN_MESSAGE);
const coord = num.gt(-50).lt(50);
const point = z.tuple([coord, coord, coord], { error: SCAN_MESSAGE });
const corner = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)], { error: SCAN_MESSAGE });
const pixels = num.min(0).max(20000);
const smallInt = (max: number) => z.number({ error: SCAN_MESSAGE }).int(SCAN_MESSAGE).min(0).max(max);

const FrameSchema = z
  .object({
    frameId: z.string({ error: SCAN_MESSAGE }).regex(FRAME_ID, SCAN_MESSAGE),
    kind: z.enum(['regular', 'closeup'], { error: SCAN_MESSAGE }),
    corner: corner.nullable(),
    uploadId: z.string({ error: SCAN_MESSAGE }).regex(UPLOAD_ID, SCAN_MESSAGE),
    imageWidth: smallInt(20000).min(1),
    imageHeight: smallInt(20000).min(1),
    cameraTransform: z.array(num.min(-1000).max(1000), { error: SCAN_MESSAGE }).length(16, SCAN_MESSAGE),
    intrinsics: z
      .object({ fx: num.gt(0).max(100000), fy: num.gt(0).max(100000), cx: pixels, cy: pixels, width: num.gt(0).max(20000), height: num.gt(0).max(20000) })
      .strict(),
  })
  .strict();

const MarkSchema = z
  .object({
    frameId: z.string({ error: SCAN_MESSAGE }).regex(FRAME_ID, SCAN_MESSAGE),
    corner,
    x: num.min(-100).max(21000),
    y: num.min(-100).max(21000),
    source: z.enum(SCAN_MARK_SOURCES, { error: SCAN_MESSAGE }),
  })
  .strict();

const QualitySchema = z
  .object({
    framesPerCorner: z.tuple([smallInt(200), smallInt(200), smallInt(200), smallInt(200)], { error: SCAN_MESSAGE }),
    reprojRmsPx: num.min(0).max(1e6),
    reprojMaxPx: num.min(0).max(1e6),
    minBaselineDeg: num.min(0).max(360),
    symRatioDiff: num.min(0).max(1e6),
    planeMaxCm: num.min(0).max(1e6),
    scaleDiff: num.min(0).max(1e6),
    closeups: smallInt(SCAN_LIMITS.maxFrames),
    failed: z.array(z.enum(SCAN_GATE_CODES, { error: SCAN_MESSAGE }), { error: SCAN_MESSAGE }).max(SCAN_GATE_CODES.length),
  })
  .strict();

const PhoneResultSchema = z
  .object({
    cornersM: z.tuple([point, point, point, point], { error: SCAN_MESSAGE }).nullable(),
    widthIn: num.gt(0).max(1000).nullable(),
    heightIn: num.gt(0).max(1000).nullable(),
    windowFrame: z.object({ widthIn: num.gt(0).max(1000), heightIn: num.gt(0).max(1000), estimated: z.boolean({ error: SCAN_MESSAGE }) }).strict().nullable(),
    quality: QualitySchema,
    status: z.enum(['measured', 'needs_review'], { error: SCAN_MESSAGE }),
  })
  .strict();

const text = (max: number) => z.string({ error: SCAN_MESSAGE }).trim().max(max, SCAN_MESSAGE).refine(noNul, SCAN_MESSAGE);

export const ScanBody = z
  .object({
    scanId: z.string({ error: SCAN_MESSAGE }).regex(SCAN_ID, SCAN_MESSAGE),
    windowId: z.string({ error: SCAN_MESSAGE }).regex(WINDOW_ID, SCAN_MESSAGE),
    app: text(80).optional(),
    device: text(80).optional(),
    wall: z.object({ point, normal: point }).strict().nullable().optional(),
    frames: z.array(FrameSchema, { error: SCAN_MESSAGE }).min(SCAN_LIMITS.minFrames, SCAN_MESSAGE).max(SCAN_LIMITS.maxFrames, SCAN_MESSAGE),
    marks: z.array(MarkSchema, { error: SCAN_MESSAGE }).max(SCAN_LIMITS.maxMarks, SCAN_MESSAGE),
    result: PhoneResultSchema,
  })
  .strict()
  .superRefine((b, ctx) => {
    const bad = (message: string, path: (string | number)[]) => ctx.addIssue({ code: 'custom', message, path });
    const ids = new Set(b.frames.map((f) => f.frameId));
    if (ids.size !== b.frames.length) bad(SCAN_MESSAGE, ['frames']);
    if (new Set(b.frames.map((f) => f.uploadId.toLowerCase())).size !== b.frames.length) bad(SCAN_MESSAGE, ['frames']);
    b.frames.forEach((f, i) => {
      const problem = scanFrameProblem(f as ScanFrame);
      if (problem !== null) bad(SCAN_MESSAGE, ['frames', i]);
    });
    if (b.wall != null && Math.hypot(...b.wall.normal) < 1e-6) bad(SCAN_MESSAGE, ['wall']);
    b.marks.forEach((m, i) => {
      const f = b.frames.find((x) => x.frameId === m.frameId);
      if (f === undefined) bad(SCAN_MESSAGE, ['marks', i]);
      else if (m.x < -2 || m.y < -2 || m.x > f.intrinsics.width + 2 || m.y > f.intrinsics.height + 2) bad(MARK_OUTSIDE_MESSAGE, ['marks', i]);
    });
  });

export type ScanBodyType = z.infer<typeof ScanBody>;

/** The contract's answer: `{ scanId, status, result }` (the server's result). */
export function scanAnswer(row: Pick<WindowScanRow, 'scanId' | 'status' | 'serverResult'>): { scanId: string; status: WindowScanRow['status']; result: ScanResult } {
  return { scanId: row.scanId, status: row.status, result: row.serverResult };
}

export function registerScanRoutes(router: Router, o: { deps: AppDeps; budget: TokenBudget; requireWindows: (request: { status: 'ready' | 'callback'; services: readonly string[] }) => void }): void {
  const { deps, budget, requireWindows } = o;
  const { pools, clock } = deps;

  router.post(
    '/:slug/requests/:id/scans',
    express.json({ limit: SCAN_BODY_LIMIT }),
    route(async (req, res) => {
      const { ctx, request } = authed(res);
      requireWindows(request);
      const body = parse(ScanBody, req.body);
      await budget(request.id, 'scans');
      const now = clock.now();
      const refine = refineAvailable(deps);
      const out = await withTenant(pools, ctx, async (tx) => {
        const locked = await getHomeownerRequest(tx, ctx, request.id, { lock: true });
        if (locked === null) return null;
        const scanId = body.scanId.toLowerCase();
        const again = await getWindowScanByScanId(tx, ctx, locked.id, scanId);
        // The same scan sent again (a lost answer, a retry) is the scan already stored.
        if (again !== null) return { row: again, created: false };
        const made = await ensureHomeownerMeasurement(tx, ctx, locked, now);
        const found = made === null ? null : await getWindowMeasurement(tx, ctx, made.id);
        if (found === null) return null;
        const window = (found.adjustments.photoWindows ?? []).find((w) => w.id === body.windowId && w.source === HOMEOWNER_APP_SOURCE);
        if (window === undefined) throw new AppError(409, WINDOW_UNKNOWN_MESSAGE, 'windowId').coded('window_unknown');
        const uploads = found.uploads ?? [];
        const frames: ScanFrame[] = body.frames.map((f) => ({ ...f, uploadId: f.uploadId.toLowerCase() }) as ScanFrame);
        if (!frames.every((f) => uploads.some((u) => u.id === f.uploadId))) throw new AppError(400, PHOTO_UNKNOWN_MESSAGE, 'frames');
        const marks = body.marks as ScanMark[];
        const comp = computeScanResult(frames, marks, body.wall ?? null);
        const result = scanResultOf(comp, body.result.windowFrame);
        // A scan that passes every gate is accepted at once, unless its size cannot be a window's (then a person looks)
        const accepted = comp.status === 'measured' && scanSizeProblem(result) === null;
        result.status = accepted ? 'measured' : 'needs_review';
        const row = await createWindowScan(
          tx,
          ctx,
          {
            homeownerRequestId: locked.id,
            scanId,
            windowId: body.windowId,
            app: body.app ?? null,
            device: body.device ?? null,
            wall: body.wall ?? null,
            frames,
            marks,
            phoneResult: body.result as ScanResult,
            serverResult: result,
            status: refine ? 'processing' : accepted ? 'measured' : 'needs_review',
            slaDueAt: new Date(now.getTime() + SCAN_SLA_MS),
            ...(refine && { refinement: queuedRefinement('upload', now, result) }),
          },
          now,
        );
        if (row === null) {
          const stored = await getWindowScanByScanId(tx, ctx, locked.id, scanId);
          return stored === null ? null : { row: stored, created: false };
        }
        // Refining: the job decides (accept, or send to a person) when it is done
        if (refine) return { row, created: true, queue: true };
        if (!accepted) return { row, created: true };
        if (await applyMeasuredScan(tx, ctx, row, now)) return { row, created: true };
        // The window could not take the size: a person looks at it instead
        const held = await updateWindowScan(
          tx,
          ctx,
          row.id,
          {
            status: 'needs_review',
            serverResult: { ...row.serverResult, status: 'needs_review' },
            history: [...row.history, { at: now.toISOString(), by: null, action: 'marks_edited', from: 'measured', to: 'needs_review', note: 'The window could not take the scan size.' }],
          },
          now,
        );
        return { row: held ?? row, created: true };
      });
      if (out === null) throw new AppError(409, "We can't take scans for this request.").coded('callback_only');
      if ('queue' in out && out.queue === true) {
        try {
          await enqueueScanRefine(deps, ctx.companyId, out.row.id);
        } catch (err) {
          // The queue is not reachable: the scan must not wait for a job that was never sent
          deps.logError?.(err, 'scan-refine enqueue');
          await failRefinement(deps, systemContext(ctx.companyId), out.row.id, 'The refinement could not be queued.');
        }
      }
      res.status(out.created ? 201 : 200).json(scanAnswer(out.row));
    }),
  );
}
