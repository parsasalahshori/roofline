import { Router } from 'express';
import { z } from 'zod';
import { getWindowMeasurement, type StoredFacadePhoto, updateWindowMeasurement, type WindowMeasurementChange, withTenant } from '@roofline/db';
import { priceWindows, WINDOW_SIZE_CLASSES, type WindowAdjustments, type WindowQuote, windowCounts } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { measureWindows } from '../estimator/measure-windows.ts';
import { fitCorners, mainWall, type Quad } from '../estimator/windows-lineup.ts';
import { planOf, rawCamera, toWindowView } from '../estimator/windows-view.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { can } from '../permissions.ts';
import { assertKnownFields, noNul, parse, UUID } from '../validate.ts';

const PICK_ADDRESS_MESSAGE = 'Pick an address.';
const ADDRESS_MESSAGE = 'Please enter an address up to 300 characters.';
const CHECK_MESSAGE = 'Please check this field.';
const COUNT_MESSAGE = 'Please enter a count from 0 to 200.';
const WINDOWS_MESSAGE = 'Pick windows of this measurement.';
const MARKED_MESSAGE = 'Mark windows inside a photo of this measurement (60 at most).';
const CORNERS_MESSAGE = 'Drag the four corners onto the house in a photo of this measurement.';

const CREATE_FIELDS = ['propertyId', 'address'] as const;
const PATCH_FIELDS = ['excludedWindowIds', 'manualCounts', 'marked', 'wallCorners'] as const;
export const MAX_MARKED = 60;
const MAX_COUNT = 200;
/** Window ids: the server's UUIDs, or the ids the web app gives the boxes a person marks. */
const WINDOW_ID = /^[A-Za-z0-9_-]{1,64}$/;

const CreateBody = z
  .object({
    propertyId: z.string({ error: CHECK_MESSAGE }).regex(UUID, CHECK_MESSAGE).transform((v) => v.toLowerCase()).optional(),
    address: z.string({ error: ADDRESS_MESSAGE }).trim().min(1, PICK_ADDRESS_MESSAGE).max(300, ADDRESS_MESSAGE).refine(noNul, CHECK_MESSAGE).optional(),
  })
  .strict()
  .refine((b) => b.propertyId !== undefined || b.address !== undefined, { message: PICK_ADDRESS_MESSAGE, path: ['address'] });

const unit = z.number().finite().min(0).max(1);
const BoxSchema = z
  .object({ x: unit, y: unit, w: z.number().finite().gt(0.002).max(1), h: z.number().finite().gt(0.002).max(1) })
  .strict()
  .refine((b) => b.x + b.w <= 1 + 1e-9 && b.y + b.h <= 1 + 1e-9);
const MarkedSchema = z
  .array(z.object({ id: z.string().regex(WINDOW_ID), photoId: z.string().regex(UUID), box: BoxSchema }).strict())
  .max(MAX_MARKED)
  .refine((list) => new Set(list.map((m) => m.id)).size === list.length);
const CountsSchema = z
  .object(Object.fromEntries(WINDOW_SIZE_CLASSES.map((c) => [c, z.number().int().min(0).max(MAX_COUNT).optional()])))
  .strict();
/** A dragged corner, 0..1 of the photo; a wall running out of the shot may have corners outside it (-1..2). */
const cornerCoord = z.number().finite().min(-1).max(2);
const point01 = z.tuple([cornerCoord, cornerCoord]);
const CornersSchema = z
  .object({ photoId: z.string().regex(UUID), corners: z.tuple([point01, point01, point01, point01]) })
  .strict()
  .nullable();

/** `:id` as a lowercase UUID; anything else cannot be a measurement, so it is a 404 like a missing one. */
function idParam(raw: unknown): string {
  const id = (typeof raw === 'string' ? raw : '').toLowerCase();
  if (!UUID.test(id)) throw new AppError(404, MESSAGES.notFound);
  return id;
}

/** The person's corner fit for a photo, from four corners in 0..1; null when the photo has no camera to fit. */
function personFitFor(row: { geometry: Parameters<typeof planOf>[0] | null }, photo: StoredFacadePhoto, corners: [number, number][]): StoredFacadePhoto['personFit'] {
  if (row.geometry === null) return null;
  const plan = planOf(row.geometry);
  if (plan === null) return null;
  const cam = rawCamera(plan, photo);
  if (cam === null) return null;
  const wall = mainWall(plan.walls, cam.pos);
  if (wall === null) return null;
  const quad = corners.map(([x, y]) => [x * photo.widthPx, y * photo.heightPx]) as Quad;
  return fitCorners(cam, wall, quad);
}

/**
 * `/api/window-measurements`: Measure windows.
 * - POST { address | propertyId } -> 201 WindowMeasurementView (the walls estimate, front photos with the wall drawn).
 * - GET /:id -> the view. PATCH /:id (WindowMeasurementPatch: excludedWindowIds, manualCounts, marked, wallCorners;
 *   each key given replaces what was there) -> the view, with marked windows sized and the estimate redone.
 * - GET /:id/photos/:photoId -> the JPEG (kept 30 days, Google's terms; 404 after).
 * - GET /:id/preview -> { quotes }: Good/Better/Best priced from the counted windows (null for members who do not see money).
 * Rep visibility and company isolation come from the repository: a measurement the caller may not see is a 404.
 */
export function windowMeasurementRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  router.post('/', async (req, res) => {
    const { ctx } = req;
    const body = parse(CreateBody, assertKnownFields(req.body, CREATE_FIELDS, { allowEmpty: true }));
    const view = await measureWindows(deps, ctx, {
      ...(body.propertyId !== undefined ? { propertyId: body.propertyId } : {}),
      ...(body.address !== undefined ? { address: body.address } : {}),
    });
    res.status(201).json(view);
  });

  router.get('/:id', async (req, res) => {
    const { ctx } = req;
    const row = await withTenant(pools, ctx, (tx) => getWindowMeasurement(tx, ctx, idParam(req.params.id)));
    if (row === null) throw new AppError(404, MESSAGES.notFound);
    res.json(toWindowView(row, clock.now()));
  });

  router.patch('/:id', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const raw = assertKnownFields(req.body, PATCH_FIELDS);
    const excluded = 'excludedWindowIds' in raw ? parseOr(z.array(z.string().regex(WINDOW_ID)).max(500), raw.excludedWindowIds, WINDOWS_MESSAGE, 'excludedWindowIds') : undefined;
    const counts = 'manualCounts' in raw ? parseOr(CountsSchema, raw.manualCounts, COUNT_MESSAGE, 'manualCounts') : undefined;
    const marked = 'marked' in raw ? parseOr(MarkedSchema, raw.marked, MARKED_MESSAGE, 'marked') : undefined;
    const corners = 'wallCorners' in raw ? parseOr(CornersSchema, raw.wallCorners, CORNERS_MESSAGE, 'wallCorners') : undefined;

    const row = await withTenant(pools, ctx, async (tx) => {
      const found = await getWindowMeasurement(tx, ctx, id);
      if (found === null) return null;
      const photoIds = new Set(found.photos.map((p) => p.id));
      const next: WindowAdjustments = { ...found.adjustments };
      const change: WindowMeasurementChange = {};
      if (marked !== undefined) {
        if (marked.some((m) => !photoIds.has(m.photoId.toLowerCase()))) throw new AppError(400, MARKED_MESSAGE, 'marked');
        next.marked = marked.map((m) => ({ id: m.id, photoId: m.photoId.toLowerCase(), box: m.box }));
      }
      if (excluded !== undefined) {
        const known = new Set([...found.windows.map((w) => w.id), ...(next.marked ?? []).map((m) => m.id)]);
        if (excluded.some((w) => !known.has(w))) throw new AppError(400, WINDOWS_MESSAGE, 'excludedWindowIds');
        next.excludedWindowIds = [...new Set(excluded)];
      }
      if (counts !== undefined) next.manualCounts = Object.fromEntries(Object.entries(counts).filter(([, v]) => v !== undefined));
      if (corners !== undefined) {
        if (corners === null) {
          next.wallCorners = null;
          change.photos = found.photos.map((p) => ({ ...p, personFit: null }));
        } else {
          const photoId = corners.photoId.toLowerCase();
          const photo = found.photos.find((p) => p.id === photoId);
          if (photo === undefined) throw new AppError(400, CORNERS_MESSAGE, 'wallCorners');
          const fit = personFitFor(found, photo, corners.corners);
          if (fit === null) throw new AppError(400, CORNERS_MESSAGE, 'wallCorners');
          next.wallCorners = { photoId, corners: corners.corners };
          // One person's fit at a time: it wins over the line-up on its photo and sets the walls' height.
          change.photos = found.photos.map((p) => ({ ...p, personFit: p.id === photoId ? fit : null }));
        }
      }
      // Excluded ids that no longer exist (a marked window taken away) drop out.
      const ids = new Set([...found.windows.map((w) => w.id), ...(next.marked ?? []).map((m) => m.id)]);
      next.excludedWindowIds = next.excludedWindowIds.filter((w) => ids.has(w));
      change.adjustments = next;
      return updateWindowMeasurement(tx, ctx, id, change, clock.now());
    });
    if (row === null) throw new AppError(404, MESSAGES.notFound);
    res.json(toWindowView(row, clock.now()));
  });

  // Google's Street View photo of the front, as taken for this measurement (anyone who may see the measurement).
  router.get('/:id/photos/:photoId', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const photoId = idParam(req.params.photoId);
    const row = await withTenant(pools, ctx, (tx) => getWindowMeasurement(tx, ctx, id));
    const photo = row?.photos.find((p) => p.id === photoId);
    if (photo === undefined || photo.key === null) throw new AppError(404, MESSAGES.notFound);
    if (Date.parse(photo.deleteBy) <= clock.now().getTime()) {
      // Past Google's 30 days: gone (the bytes are removed now if a sweep has not done it yet).
      await deps.objectStore.delete(photo.key).catch((err: unknown) => deps.logError?.(err, 'window-photo-delete'));
      throw new AppError(404, MESSAGES.notFound);
    }
    const bytes = await deps.objectStore.get(photo.key);
    if (bytes === null) throw new AppError(404, MESSAGES.notFound);
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(Buffer.from(bytes));
  });

  router.get('/:id/preview', async (req, res) => {
    const { ctx } = req;
    const row = await withTenant(pools, ctx, (tx) => getWindowMeasurement(tx, ctx, idParam(req.params.id)));
    if (row === null) throw new AppError(404, MESSAGES.notFound);
    const quotes: WindowQuote[] | null = can(ctx, 'view_money_totals') ? priceWindows(windowCounts(toWindowView(row, clock.now()))) : null;
    res.json({ quotes });
  });

  return router;
}

function parseOr<T>(schema: z.ZodType<T>, value: unknown, message: string, field: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new AppError(400, message, field);
  return r.data;
}
