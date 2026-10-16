import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  companies,
  createWindowOrder,
  getWindowMeasurement,
  getWindowOrder,
  getWindowOrderForMeasurement,
  getWindowOrderSettings,
  saveWindowOrderSettings,
  updateWindowOrder,
  type TenantContext,
  type WindowOrderRow,
  withTenant,
} from '@roofline/db';
import {
  applyLinePatches,
  checkLine,
  deriveOrder,
  FRAME_COLORS,
  GLASS_PACKAGES,
  GRID_PATTERN,
  GRID_TYPES,
  linesFromPhotoWindows,
  MAX_LOCATION_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_ORDER_QUANTITY,
  MAX_PO_LENGTH,
  ORDER_ROUNDING_STEPS,
  SCREEN_TYPES,
  WINDOW_STYLES,
  type WindowOrderLine,
  type WindowOrderSettingsPatch,
  type WindowOrderView,
  type WindowStyle,
} from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { orderCsv, renderOrderPdf } from '../estimator/window-order-sheet.ts';
import { toWindowView } from '../estimator/windows-view.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { can, requireCapability } from '../permissions.ts';
import { assertKnownFields, noNul, UUID } from '../validate.ts';

export const ONLY_PHOTO_WINDOWS_MESSAGE = 'Only windows measured from on-site photos can be ordered. Photograph and measure a window on site first.';
const LINES_MESSAGE = 'Please check the window lines.';
const PO_MESSAGE = `Enter a PO number of up to ${MAX_PO_LENGTH} characters.`;
const LOCKED_MESSAGE = 'This order is marked ready and its sizes are locked. Reopen it to change it.';
const NOT_READY_MESSAGE = 'Some windows still need attention before the order can be marked ready.';
const NOT_DRAFT_MESSAGE = 'Only a draft order can be marked ready.';
const NOT_READY_FOR_SENT = 'Mark the order ready before recording it as sent.';
const CSV_DRAFT_MESSAGE = 'Mark the order ready before downloading the factory file.';
const REOPEN_MESSAGE = 'Only a ready or sent order can be reopened.';

function idParam(raw: unknown): string {
  const id = (typeof raw === 'string' ? raw : '').toLowerCase();
  if (!UUID.test(id)) throw new AppError(404, MESSAGES.notFound);
  return id;
}

const text = (max: number) => z.string().max(max).refine(noNul);
const LinePatchSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    location: text(MAX_LOCATION_LENGTH).optional(),
    style: z.enum(WINDOW_STYLES).nullable().optional(),
    quantity: z.number().int().min(1).max(MAX_ORDER_QUANTITY).optional(),
    frameInterior: z.enum(FRAME_COLORS).optional(),
    frameExterior: z.enum(FRAME_COLORS).optional(),
    grid: z.object({ type: z.enum(GRID_TYPES), top: z.string().regex(GRID_PATTERN), bottom: z.string().regex(GRID_PATTERN) }).strict().optional(),
    glass: z.enum(GLASS_PACKAGES).optional(),
    tempered: z.boolean().optional(),
    obscure: z.boolean().optional(),
    screen: z.enum(SCREEN_TYPES).optional(),
    notes: text(MAX_NOTES_LENGTH).optional(),
    safety: z
      .object({
        besideDoor: z.boolean().nullable(),
        wetArea: z.boolean().nullable(),
        sillHeightIn: z.number().finite().min(0).max(240).nullable(),
        walkway: z.boolean().nullable(),
      })
      .strict()
      .optional(),
    confirmed: z.boolean().optional(),
  })
  .strict();
const LinesSchema = z
  .array(LinePatchSchema)
  .max(120)
  .refine((list) => new Set(list.map((l) => l.id)).size === list.length);

const inches = (min: number, max: number) => z.number().finite().min(min).max(max);
const LimitsSchema = z
  .object({
    minWidthIn: inches(1, 240),
    maxWidthIn: inches(1, 240),
    minHeightIn: inches(1, 240),
    maxHeightIn: inches(1, 240),
    maxUnitedIn: inches(1, 480),
    maxAreaSqFt: inches(1, 400),
    maxTemperedAreaSqFt: inches(1, 400),
  })
  .partial()
  .strict();
const SettingsSchema = z
  .object({
    widthDeductionIn: inches(0, 2),
    heightDeductionIn: inches(0, 2),
    roundingIn: z.union(ORDER_ROUNDING_STEPS.map((s) => z.literal(s)) as unknown as [z.ZodLiteral<0.0625>, z.ZodLiteral<0.125>, z.ZodLiteral<0.25>]),
    uncertaintyFactor: z.number().finite().min(0).max(3),
    checkUncertaintyIn: inches(0, 2),
    limits: z.partialRecord(z.enum(WINDOW_STYLES), LimitsSchema),
  })
  .partial()
  .strict();

/** The order as the API shows it: the stored lines and settings with every check worked out. */
function toOrderView(row: WindowOrderRow, address: string, ctx: TenantContext): WindowOrderView {
  return {
    id: row.id,
    windowMeasurementId: row.windowMeasurementId,
    address,
    status: row.status,
    poNumber: row.poNumber,
    lines: row.lines,
    settings: row.settings,
    ...deriveOrder(row.lines, row.settings),
    mayMarkReady: can(ctx, 'approve_factory_order'),
    readyAt: row.readyAt?.toISOString() ?? null,
    sentAt: row.sentAt?.toISOString() ?? null,
    sentBy: row.sentByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * `/api/window-measurements/:id/order`: a measurement's factory order.
 * - POST -> 201 a new draft from the measurement's photo windows (the only windows that may be ordered), or 200 the
 *   existing order: a draft is refreshed from the photo windows (the person's options kept per window); a ready or
 *   sent order is returned unchanged. 422 when the measurement has no photo windows.
 * - GET -> the order, 404 when there is none.
 * Anyone who may see the measurement (reps included) may draft its order.
 */
export function windowMeasurementOrderRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  router.post('/:id/order', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const now = clock.now();
    const result = await withTenant(pools, ctx, async (tx) => {
      const m = await getWindowMeasurement(tx, ctx, id);
      if (m === null) return null;
      const view = toWindowView(m, now);
      const excluded = new Set(view.adjustments.excludedWindowIds);
      const settings = await getWindowOrderSettings(tx, ctx);
      const existing = await getWindowOrderForMeasurement(tx, ctx, id);
      if (existing !== null && existing.status !== 'draft') return { row: existing, address: m.address, created: false };
      const lines = linesFromPhotoWindows(view.photoWindows ?? [], excluded, existing?.lines ?? []);
      if (lines.length === 0) throw new AppError(422, ONLY_PHOTO_WINDOWS_MESSAGE);
      if (existing !== null) {
        const row = await updateWindowOrder(tx, ctx, existing.id, 'draft', { lines, settings }, now);
        if (row === null || row === 'changed') throw new AppError(409, MESSAGES.changedWhileLooking);
        return { row, address: m.address, created: false };
      }
      const row = await createWindowOrder(tx, ctx, { windowMeasurementId: id, lines, settings }, now);
      return row === null ? null : { row, address: m.address, created: true };
    });
    if (result === null) throw new AppError(404, MESSAGES.notFound);
    res.status(result.created ? 201 : 200).json(toOrderView(result.row, result.address, ctx));
  });

  router.get('/:id/order', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const found = await withTenant(pools, ctx, async (tx) => {
      const m = await getWindowMeasurement(tx, ctx, id);
      if (m === null) return null;
      const row = await getWindowOrderForMeasurement(tx, ctx, id);
      return row === null ? null : { row, address: m.address };
    });
    if (found === null) throw new AppError(404, MESSAGES.notFound);
    res.json(toOrderView(found.row, found.address, ctx));
  });

  return router;
}

/**
 * `/api/window-orders/:id`: one factory order.
 * - GET -> WindowOrderView. PATCH { poNumber?, lines?: [{ id, ...options }] } -> the view (drafts only; sizes come from
 *   the photos and cannot be typed).
 * - POST /:id/ready -> locks every line's order size (owner and office; every line orderable). POST /:id/reopen -> back
 *   to a draft (owner and office). POST /:id/sent -> records who exported it (owner and office; nothing is emailed).
 * - GET /:id/sheet.csv (ready or sent) and /:id/sheet.pdf (a draft is marked DRAFT).
 */
export function windowOrderRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  /** The order and its measurement's address, or a 404. */
  async function load(ctx: TenantContext, id: string) {
    const found = await withTenant(pools, ctx, async (tx) => {
      const row = await getWindowOrder(tx, ctx, id);
      if (row === null) return null;
      const m = await getWindowMeasurement(tx, ctx, row.windowMeasurementId);
      return m === null ? null : { row, address: m.address };
    });
    if (found === null) throw new AppError(404, MESSAGES.notFound);
    return found;
  }

  router.get('/:id', async (req, res) => {
    const { ctx } = req;
    const { row, address } = await load(ctx, idParam(req.params.id));
    res.json(toOrderView(row, address, ctx));
  });

  router.patch('/:id', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const raw = assertKnownFields(req.body, ['poNumber', 'lines']);
    const po = 'poNumber' in raw ? z.string().trim().max(MAX_PO_LENGTH).refine(noNul).safeParse(raw.poNumber) : null;
    if (po !== null && !po.success) throw new AppError(400, PO_MESSAGE, 'poNumber');
    const patches = 'lines' in raw ? LinesSchema.safeParse(raw.lines) : null;
    if (patches !== null && !patches.success) throw new AppError(400, LINES_MESSAGE, 'lines');
    const { address } = await load(ctx, id);
    const row = await withTenant(pools, ctx, async (tx) => {
      const found = await getWindowOrder(tx, ctx, id);
      if (found === null) return null;
      if (found.status !== 'draft') throw new AppError(409, LOCKED_MESSAGE);
      let lines = found.lines;
      if (patches !== null && patches.success) {
        const next = applyLinePatches(found.lines, patches.data as Parameters<typeof applyLinePatches>[1]);
        if (next === null) throw new AppError(400, LINES_MESSAGE, 'lines');
        lines = next;
      }
      const updated = await updateWindowOrder(tx, ctx, id, 'draft', { lines, ...(po !== null && po.success ? { poNumber: po.data } : {}) }, clock.now());
      if (updated === 'changed') throw new AppError(409, LOCKED_MESSAGE);
      return updated;
    });
    if (row === null) throw new AppError(404, MESSAGES.notFound);
    res.json(toOrderView(row, address, ctx));
  });

  router.post('/:id/ready', requireCapability('approve_factory_order'), async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const { address } = await load(ctx, id);
    const now = clock.now();
    const row = await withTenant(pools, ctx, async (tx) => {
      const found = await getWindowOrder(tx, ctx, id);
      if (found === null) return null;
      if (found.status !== 'draft') throw new AppError(409, NOT_DRAFT_MESSAGE);
      // The settings are taken again now, so the sizes locked are the company's current rule.
      const settings = await getWindowOrderSettings(tx, ctx);
      const unlocked = found.lines.map((l) => ({ ...l, lockedSize: null }));
      const { canMarkReady } = deriveOrder(unlocked, settings);
      if (!canMarkReady) throw new AppError(409, NOT_READY_MESSAGE, 'lines');
      const lines: WindowOrderLine[] = unlocked.map((l) => ({ ...l, lockedSize: checkLine(l, settings).order }));
      const updated = await updateWindowOrder(tx, ctx, id, 'draft', { status: 'ready', lines, settings, readyAt: now, readyByUserId: ctx.userId }, now);
      if (updated === 'changed') throw new AppError(409, NOT_DRAFT_MESSAGE);
      return updated;
    });
    if (row === null) throw new AppError(404, MESSAGES.notFound);
    res.json(toOrderView(row, address, ctx));
  });

  router.post('/:id/reopen', requireCapability('approve_factory_order'), async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const { row: before, address } = await load(ctx, id);
    if (before.status === 'draft') throw new AppError(409, REOPEN_MESSAGE);
    // Back to a draft: sizes unlocked and worked out again with the company's current settings.
    const row = await withTenant(pools, ctx, async (tx) => {
      const settings = await getWindowOrderSettings(tx, ctx);
      const lines = before.lines.map((l) => ({ ...l, lockedSize: null }));
      return updateWindowOrder(tx, ctx, id, before.status, { status: 'draft', lines, settings, readyAt: null, readyByUserId: null, sentAt: null, sentByUserId: null }, clock.now());
    });
    if (row === null) throw new AppError(404, MESSAGES.notFound);
    if (row === 'changed') throw new AppError(409, MESSAGES.changedWhileLooking);
    res.json(toOrderView(row, address, ctx));
  });

  router.post('/:id/sent', requireCapability('approve_factory_order'), async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const { row: before, address } = await load(ctx, id);
    if (before.status !== 'ready') throw new AppError(409, NOT_READY_FOR_SENT);
    const now = clock.now();
    const row = await withTenant(pools, ctx, (tx) => updateWindowOrder(tx, ctx, id, 'ready', { status: 'sent', sentAt: now, sentByUserId: ctx.userId }, now));
    if (row === null) throw new AppError(404, MESSAGES.notFound);
    if (row === 'changed') throw new AppError(409, MESSAGES.changedWhileLooking);
    res.json(toOrderView(row, address, ctx));
  });

  const fileName = (v: WindowOrderView, ext: string) => `window-order-${(v.poNumber !== '' ? v.poNumber : v.id.slice(0, 8)).replace(/[^A-Za-z0-9_-]/g, '_')}.${ext}`;

  router.get('/:id/sheet.csv', async (req, res) => {
    const { ctx } = req;
    const { row, address } = await load(ctx, idParam(req.params.id));
    if (row.status === 'draft') throw new AppError(409, CSV_DRAFT_MESSAGE);
    const view = toOrderView(row, address, ctx);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(view, 'csv')}"`);
    res.send(orderCsv(view));
  });

  router.get('/:id/sheet.pdf', async (req, res) => {
    const { ctx } = req;
    const { row, address } = await load(ctx, idParam(req.params.id));
    const companyName = await withTenant(pools, ctx, async (tx) => {
      const [c] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
      return c?.name ?? '';
    });
    const view = toOrderView(row, address, ctx);
    const generatedOn = clock.now().toISOString().slice(0, 10);
    // Render before any header is sent, so a render failure still reaches the error handler as a clean error.
    const doc = renderOrderPdf({ view, companyName, generatedOn });
    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName(view, 'pdf')}"`);
    doc.pipe(res);
  });

  return router;
}

/**
 * `/api/window-order-settings`: the company's order-size rule and factory limits. GET for everyone signed in (the
 * order page shows the rule); PUT (owner) replaces the stored changes; `{}` goes back to the defaults in code.
 */
export function windowOrderSettingsRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();
  router.get('/', async (req, res) => {
    const { ctx } = req;
    res.json(await withTenant(pools, ctx, (tx) => getWindowOrderSettings(tx, ctx)));
  });
  router.put('/', requireCapability('company_admin'), async (req, res) => {
    const { ctx } = req;
    const parsed = SettingsSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, MESSAGES.checkField);
    const limits = parsed.data.limits as Partial<Record<WindowStyle, Record<string, number>>> | undefined;
    for (const l of Object.values(limits ?? {})) {
      if (l.minWidthIn !== undefined && l.maxWidthIn !== undefined && l.minWidthIn > l.maxWidthIn) throw new AppError(400, MESSAGES.checkField, 'limits');
      if (l.minHeightIn !== undefined && l.maxHeightIn !== undefined && l.minHeightIn > l.maxHeightIn) throw new AppError(400, MESSAGES.checkField, 'limits');
    }
    const stored = Object.keys(parsed.data).length === 0 ? null : (parsed.data as WindowOrderSettingsPatch);
    res.json(await withTenant(pools, ctx, (tx) => saveWindowOrderSettings(tx, ctx, stored, clock.now())));
  });
  return router;
}
