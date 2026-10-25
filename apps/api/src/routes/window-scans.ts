import { Router } from 'express';
import { z } from 'zod';
import {
  countWindowScans,
  getWindowScan,
  getWindowScanContext,
  listWindowScans,
  memberNames,
  type TenantContext,
  updateWindowScan,
  type WindowScanRow,
  withTenant,
} from '@roofline/db';
import {
  computeScanResult,
  type ScanDetailView,
  type ScanFrame,
  type ScanFrameView,
  type ScanHistoryEvent,
  type ScanMark,
  type ScanQueueItem,
  type ScanQueueView,
  SCAN_MARK_SOURCES,
  SCAN_OPEN_STATUSES,
  SCAN_STATUSES,
  scanResultOf,
  scanSlaSecondsLeft,
  type ScanStatus,
} from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { applyMeasuredScan, scanSizeProblem } from '../estimator/window-scan-apply.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { can, requireCapability } from '../permissions.ts';
import { noNul, parse, UUID } from '../validate.ts';

/*
 * `/api/window-scans`: the staff review of the homeowner app's multi-frame window scans (docs/windows/scan-contract.md,
 * "Scan review" in docs/windows/homeowner-api.md). Session auth, every call company-scoped (RLS).
 *   GET   /?status=open|done|all|<status>   the queue, expedited first, then by SLA, with the count in each status
 *   GET   /:id                              one scan: frames (image URLs), marks, the server's result, history
 *   GET   /:id/frames/:frameId/image        a frame's picture (the request's upload, proxied from the object store)
 *   PATCH /:id/marks                        { marks } the reviewer's marks; the result is worked out again
 *   POST  /:id/submit                       the first reviewer is done (needs_review/in_review -> junior_done)
 *   POST  /:id/finalize                     { outcome: 'measured' | 'visit_required', reason?, override? } (senior reviewer)
 *   POST  /:id/expedite                     { expedite?: boolean } moves a scan to the top, out of the regular SLA
 * Roles: any member (owner, office, rep) is a first ("junior") reviewer; the senior reviewer is whoever may mark window
 * factory orders ready (capability approve_factory_order: the owner and the office), the closest existing sign-off for sizes.
 */

const MARKS_MESSAGE = 'Please check the corner marks.';
const CLOSED_MESSAGE = 'This scan is finished. It can no longer be changed.';
const OPEN: readonly ScanStatus[] = SCAN_OPEN_STATUSES;
const DONE: readonly ScanStatus[] = ['measured', 'visit_required'];

const MarkBody = z
  .object({
    frameId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    corner: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    x: z.number().finite().min(-100).max(21000),
    y: z.number().finite().min(-100).max(21000),
    source: z.enum(SCAN_MARK_SOURCES),
  })
  .strict();
const MarksBody = z.object({ marks: z.array(MarkBody).max(200) }).strict();
const FinalizeBody = z
  .object({
    outcome: z.enum(['measured', 'visit_required']),
    reason: z.string().trim().max(500).refine(noNul).optional(),
    override: z.boolean().optional(),
  })
  .strict();
const ExpediteBody = z.object({ expedite: z.boolean().optional() }).strict();

function idParam(raw: unknown): string {
  const id = (typeof raw === 'string' ? raw : '').toLowerCase();
  if (!UUID.test(id)) throw new AppError(404, MESSAGES.notFound);
  return id;
}

const fullName = (f: string | null, l: string | null): string | null => (f === null ? null : `${f} ${l ?? ''}`.trim());

function statusesFor(raw: unknown): readonly ScanStatus[] {
  const v = typeof raw === 'string' && raw !== '' ? raw : 'open';
  if (v === 'open') return OPEN;
  if (v === 'done') return DONE;
  if (v === 'all') return SCAN_STATUSES;
  if ((SCAN_STATUSES as readonly string[]).includes(v)) return [v as ScanStatus];
  throw new AppError(400, MESSAGES.checkField, 'status');
}

export function windowScanRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  const timing = (row: Pick<WindowScanRow, 'slaDueAt' | 'expedite' | 'status'>, now: Date) => {
    const secondsLeft = OPEN.includes(row.status) ? scanSlaSecondsLeft(row.slaDueAt, row.expedite, now) : null;
    return { secondsLeft, overdue: secondsLeft !== null && secondsLeft < 0 };
  };

  router.get('/', async (req, res) => {
    const { ctx } = req;
    const statuses = statusesFor(req.query.status);
    const now = clock.now();
    const out = await withTenant(pools, ctx, async (tx) => {
      const [rows, counts] = await Promise.all([listWindowScans(tx, ctx, { statuses, limit: 200 }), countWindowScans(tx, ctx)]);
      return { rows, counts };
    });
    const sorted = statuses.every((s) => DONE.includes(s)) ? [...out.rows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()) : out.rows;
    const scans: ScanQueueItem[] = sorted.map((r) => {
      const w = r.photoWindows.find((x) => x.id === r.windowId);
      return {
        id: r.id,
        status: r.status,
        expedite: r.expedite,
        slaDueAt: r.slaDueAt.toISOString(),
        ...timing(r, now),
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        windowId: r.windowId,
        room: w?.room ?? '',
        label: w?.label ?? '',
        address: r.address,
        homeowner: fullName(r.firstName, r.lastName),
        frameCount: r.frameCount,
        widthIn: r.serverResult.widthIn,
        heightIn: r.serverResult.heightIn,
        failed: r.serverResult.quality.failed,
        outcome: r.outcome,
      };
    });
    const counts = Object.fromEntries(SCAN_STATUSES.map((s) => [s, out.counts[s] ?? 0])) as Record<ScanStatus, number>;
    const body: ScanQueueView = { scans, counts };
    res.json(body);
  });

  /** One scan as the reviewer sees it. */
  async function detail(ctx: TenantContext, id: string): Promise<ScanDetailView | null> {
    const now = clock.now();
    const found = await withTenant(pools, ctx, async (tx) => {
      const row = await getWindowScan(tx, ctx, id);
      if (row === null) return null;
      const [context, names] = await Promise.all([getWindowScanContext(tx, ctx, row), memberNames(tx)]);
      return { row, context, names };
    });
    if (found === null) return null;
    const { row, context, names } = found;
    const frames: ScanFrameView[] = row.frames.map((f) => ({ ...f, imageUrl: `/api/window-scans/${row.id}/frames/${encodeURIComponent(f.frameId)}/image` }));
    const reviewer = (userId: string | null, at: Date | null) => (userId === null ? null : { id: userId, name: names.get(userId) ?? 'Team member', at: (at ?? row.updatedAt).toISOString() });
    return {
      id: row.id,
      status: row.status,
      expedite: row.expedite,
      slaDueAt: row.slaDueAt.toISOString(),
      ...timing(row, now),
      createdAt: row.createdAt.toISOString(),
      windowId: row.windowId,
      room: context?.photoWindow?.room ?? '',
      label: context?.photoWindow?.label ?? '',
      address: context?.address ?? '',
      homeowner: context === null ? null : fullName(context.firstName, context.lastName),
      app: row.app,
      device: row.device,
      frames,
      marks: row.marks,
      marksOriginal: row.marksOriginal,
      wall: row.wall,
      phoneResult: row.phoneResult,
      result: row.serverResult,
      junior: reviewer(row.juniorUserId, row.juniorAt),
      senior: reviewer(row.seniorUserId, row.seniorAt),
      outcome: row.outcome,
      outcomeReason: row.outcomeReason,
      overrode: row.overrode,
      history: row.history.map((h) => ({ ...h, byName: h.by === null ? null : (names.get(h.by) ?? 'Team member') })),
      mayEdit: OPEN.includes(row.status) && (row.status !== 'junior_done' || can(ctx, 'approve_factory_order')),
      mayFinalize: row.status === 'junior_done' && can(ctx, 'approve_factory_order'),
    };
  }

  router.get('/:id', async (req, res) => {
    const view = await detail(req.ctx, idParam(req.params.id));
    if (view === null) throw new AppError(404, MESSAGES.notFound);
    res.json(view);
  });

  router.get('/:id/frames/:frameId/image', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const frameId = typeof req.params.frameId === 'string' ? req.params.frameId : '';
    const found = await withTenant(pools, ctx, async (tx) => {
      const row = await getWindowScan(tx, ctx, id);
      if (row === null) return null;
      const frame = row.frames.find((f) => f.frameId === frameId);
      const context = await getWindowScanContext(tx, ctx, row);
      return frame === undefined ? null : (context?.uploads.find((u) => u.id === frame.uploadId) ?? null);
    });
    if (found === null) throw new AppError(404, MESSAGES.notFound);
    const bytes = await deps.objectStore.get(found.key);
    if (bytes === null) throw new AppError(404, MESSAGES.notFound);
    res.set('Content-Type', `image/${found.kind}`);
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(Buffer.from(bytes));
  });

  /** Runs `change` on the scan, locked; 404 when it is not this company's. */
  async function changeScan(ctx: TenantContext, id: string, change: (tx: Parameters<Parameters<typeof withTenant>[2]>[0], row: WindowScanRow, now: Date) => Promise<WindowScanRow>): Promise<void> {
    const now = clock.now();
    const done = await withTenant(pools, ctx, async (tx) => {
      const row = await getWindowScan(tx, ctx, id, { lock: true });
      if (row === null) return false;
      await change(tx, row, now);
      return true;
    });
    if (!done) throw new AppError(404, MESSAGES.notFound);
  }

  const event = (ctx: TenantContext, now: Date, e: Omit<ScanHistoryEvent, 'at' | 'by'>): ScanHistoryEvent => ({ at: now.toISOString(), by: ctx.userId, ...e });

  router.patch('/:id/marks', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const body = parse(MarksBody, req.body);
    await changeScan(ctx, id, async (tx, row, now) => {
      if (!OPEN.includes(row.status)) throw new AppError(409, CLOSED_MESSAGE).coded('scan_closed');
      // The first reviewer's work is done: only the senior reviewer moves marks now
      if (row.status === 'junior_done' && !can(ctx, 'approve_factory_order')) throw new AppError(403, MESSAGES.roleCannot);
      const frames: ScanFrame[] = row.frames;
      for (const m of body.marks) {
        const f = frames.find((x) => x.frameId === m.frameId);
        if (f === undefined || m.x < -2 || m.y < -2 || m.x > f.intrinsics.width + 2 || m.y > f.intrinsics.height + 2) throw new AppError(400, MARKS_MESSAGE, 'marks');
      }
      const marks: ScanMark[] = body.marks;
      const result = scanResultOf(computeScanResult(frames, marks, row.wall), row.serverResult.windowFrame);
      const claiming = row.status === 'needs_review';
      const next = await updateWindowScan(
        tx,
        ctx,
        row.id,
        {
          marks,
          serverResult: result,
          ...(claiming && { status: 'in_review' as const }),
          ...(row.juniorUserId === null && row.status !== 'junior_done' && { juniorUserId: ctx.userId, juniorAt: now }),
          history: [...row.history, event(ctx, now, { action: 'marks_edited', ...(claiming && { from: row.status, to: 'in_review' as const }), note: `${marks.length} marks` })],
        },
        now,
        'window_scan.marks',
      );
      return next ?? row;
    });
    res.json(await detail(ctx, id));
  });

  router.post('/:id/submit', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    await changeScan(ctx, id, async (tx, row, now) => {
      if (row.status !== 'needs_review' && row.status !== 'in_review') throw new AppError(409, row.status === 'junior_done' ? 'This scan was already submitted for the senior review.' : CLOSED_MESSAGE).coded('wrong_status');
      const next = await updateWindowScan(
        tx,
        ctx,
        row.id,
        {
          status: 'junior_done',
          juniorUserId: row.juniorUserId ?? ctx.userId,
          juniorAt: now,
          history: [...row.history, event(ctx, now, { action: 'submitted', from: row.status, to: 'junior_done' })],
        },
        now,
        'window_scan.submit',
      );
      return next ?? row;
    });
    res.json(await detail(ctx, id));
  });

  router.post('/:id/finalize', requireCapability('approve_factory_order'), async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const body = parse(FinalizeBody, req.body);
    const reason = body.reason ?? '';
    await changeScan(ctx, id, async (tx, row, now) => {
      if (row.status !== 'junior_done') {
        throw new AppError(409, DONE.includes(row.status) ? CLOSED_MESSAGE : 'A first reviewer has to check this scan before it is finalised.').coded(DONE.includes(row.status) ? 'scan_closed' : 'needs_first_review');
      }
      let overrode = false;
      if (body.outcome === 'visit_required') {
        if (reason === '') throw new AppError(422, 'Say why this window needs a visit.', 'reason').coded('reason_needed');
      } else {
        // Measured: the marks as they stand must make a size, and every gate must pass, or the senior overrides in writing
        const comp = computeScanResult(row.frames, row.marks, row.wall);
        const result = scanResultOf(comp, row.serverResult.windowFrame);
        if (comp.cornersM === null) throw new AppError(422, 'This scan has no size yet. Mark every corner on at least two frames, or choose Visit required.').coded('no_size');
        const sizeProblem = scanSizeProblem(result);
        if (sizeProblem !== null) throw new AppError(422, sizeProblem).coded('no_size');
        if (comp.quality.failed.length > 0) {
          if (body.override !== true || reason.length < 3) throw new AppError(422, 'Some quality checks fail. Fix the marks, or confirm with a written reason.', 'reason').coded('gates_failed');
          overrode = true;
        }
        const updated = await updateWindowScan(tx, ctx, row.id, { serverResult: result }, now);
        if (updated === null || !(await applyMeasuredScan(tx, ctx, updated, now))) throw new AppError(422, 'The window cannot take this size any more. Choose Visit required.').coded('window_cannot_take_size');
      }
      const next = await updateWindowScan(
        tx,
        ctx,
        row.id,
        {
          status: body.outcome,
          outcome: body.outcome,
          outcomeReason: reason === '' ? null : reason,
          seniorUserId: ctx.userId,
          seniorAt: now,
          overrode,
          history: [...row.history, event(ctx, now, { action: 'finalized', from: 'junior_done', to: body.outcome, ...(reason !== '' && { note: reason }) })],
        },
        now,
        'window_scan.finalize',
      );
      return next ?? row;
    });
    res.json(await detail(ctx, id));
  });

  router.post('/:id/expedite', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const body = parse(ExpediteBody, req.body ?? {});
    const want = body.expedite ?? true;
    await changeScan(ctx, id, async (tx, row, now) => {
      if (!OPEN.includes(row.status)) throw new AppError(409, CLOSED_MESSAGE).coded('scan_closed');
      if (row.expedite === want) return row;
      const next = await updateWindowScan(tx, ctx, row.id, { expedite: want, history: [...row.history, event(ctx, now, { action: want ? 'expedited' : 'unexpedited' })] }, now, 'window_scan.expedite');
      return next ?? row;
    });
    res.json(await detail(ctx, id));
  });

  return router;
}
