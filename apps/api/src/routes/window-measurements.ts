import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { Router } from 'express';
import busboy from 'busboy';
import { z } from 'zod';
import { appendWindowUpload, getWindowMeasurement, type StoredFacadePhoto, type StoredWindowUpload, updateWindowMeasurement, type WindowMeasurementChange, withTenant } from '@roofline/db';
import { type PhotoWindowInput, priceWindows, SHEET_MAX_OFFSET_IN, SHEET_MAX_POINTS, SHEET_PAPER_IN, WINDOW_PHOTO_REFERENCES, WINDOW_SIZE_CLASSES, type WindowAdjustments, type WindowQuote, windowCounts } from '@roofline/shared';
import { readImageInfo, sheetProblem, sizePhotoWindow } from '../estimator/window-uploads.ts';
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
const PATCH_FIELDS = ['excludedWindowIds', 'manualCounts', 'marked', 'wallCorners', 'photoWindows', 'photosCoverAllWindows'] as const;
const PHOTO_WINDOWS_MESSAGE = 'Mark each window inside its photo, with a paper on the glass or one side measured (6 to 200 in; 60 windows at most).';
const COVER_MESSAGE = 'Please check this field.';
const UPLOAD_TOO_BIG_MESSAGE = 'That photo is over 12 MB.';
const UPLOAD_TYPE_MESSAGE = 'Upload a JPEG or PNG photo.';
/** HEIC is refused for now (no converter on the server): the phone can save JPEG instead. */
export const HEIC_MESSAGE = 'Take the photo as JPEG, or set the camera to Most Compatible.';
const UPLOAD_MISSING_MESSAGE = 'Add a photo (form field "photo").';
const UPLOADS_FULL_MESSAGE = 'This measurement has 40 photos already.';
const STORAGE_DOWN_MESSAGE = "Photo storage isn't available right now.";
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
export const MAX_UPLOADS = 40;
export const MAX_PHOTO_WINDOWS = 60;
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

const finite = z.number().finite();
const QuadSchema = z.tuple([z.tuple([finite, finite]), z.tuple([finite, finite]), z.tuple([finite, finite]), z.tuple([finite, finite])]);
const ScaleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reference'), reference: z.enum(Object.keys(WINDOW_PHOTO_REFERENCES) as [keyof typeof WINDOW_PHOTO_REFERENCES]), corners: QuadSchema }).strict(),
  z.object({ kind: z.literal('known-side'), side: z.enum(['width', 'height']), inches: z.number().finite().min(6).max(200) }).strict(),
  // The measuring sheet: matched points (photo pixels <-> inches on the sheet, inside the paper), the frame's offset.
  z
    .object({
      kind: z.literal('sheet'),
      paper: z.enum(['letter', 'a4']),
      imagePoints: z.array(z.tuple([finite, finite])).max(SHEET_MAX_POINTS),
      sheetPointsIn: z.array(z.tuple([finite, finite])).max(SHEET_MAX_POINTS),
      planeOffsetIn: z.number().finite().min(-SHEET_MAX_OFFSET_IN).max(SHEET_MAX_OFFSET_IN),
    })
    .strict()
    .refine((v) => v.imagePoints.length === v.sheetPointsIn.length)
    .refine((v) => v.sheetPointsIn.every(([x, y]) => x >= 0 && y >= 0 && x <= SHEET_PAPER_IN[v.paper].widthIn && y <= SHEET_PAPER_IN[v.paper].heightIn)),
]);
const PhotoWindowsSchema = z
  .array(
    z
      .object({
        id: z.string().regex(WINDOW_ID),
        uploadId: z.string().regex(UUID),
        label: z.string().max(80).refine(noNul).optional(),
        // Several photos of one window share a key (the screen combines them).
        windowKey: z.string().max(80).refine(noNul).optional(),
        corners: QuadSchema,
        scale: ScaleSchema,
      })
      .strict(),
  )
  .max(MAX_PHOTO_WINDOWS)
  .refine((list) => new Set(list.map((w) => w.id)).size === list.length);

/**
 * The photo in an upload request: multipart/form-data with the file in the field "photo" (other fields ignored), or
 * the raw image bytes as the body. At most MAX_UPLOAD_BYTES; a larger one is a 413 before more is read.
 */
function readUpload(req: Request): Promise<Uint8Array> {
  const type = (req.headers['content-type'] ?? '').toLowerCase();
  const tooBig = () => new AppError(413, UPLOAD_TOO_BIG_MESSAGE, 'photo');
  if (type.startsWith('multipart/form-data')) {
    return new Promise((resolve, reject) => {
      let parser: busboy.Busboy;
      try {
        parser = busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, parts: 11 } });
      } catch {
        reject(new AppError(400, UPLOAD_MISSING_MESSAGE, 'photo'));
        return;
      }
      let found: Uint8Array | null = null;
      let failed: AppError | null = null;
      parser.on('file', (name, stream) => {
        if (name !== 'photo') {
          stream.resume();
          return;
        }
        const parts: Buffer[] = [];
        stream.on('data', (d: Buffer) => parts.push(d));
        stream.on('limit', () => {
          failed = tooBig();
        });
        stream.on('end', () => {
          if (failed === null) found = new Uint8Array(Buffer.concat(parts));
        });
      });
      parser.on('error', () => reject(new AppError(400, UPLOAD_MISSING_MESSAGE, 'photo')));
      parser.on('close', () => {
        if (failed !== null) reject(failed);
        else if (found === null || found.length === 0) reject(new AppError(400, UPLOAD_MISSING_MESSAGE, 'photo'));
        else resolve(found);
      });
      req.pipe(parser);
    });
  }
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? '0');
    if (declared > MAX_UPLOAD_BYTES) {
      req.resume();
      reject(tooBig());
      return;
    }
    const parts: Buffer[] = [];
    let total = 0;
    req.on('data', (d: Buffer) => {
      total += d.length;
      if (total > MAX_UPLOAD_BYTES) {
        req.destroy();
        reject(tooBig());
        return;
      }
      parts.push(d);
    });
    req.on('end', () => (total === 0 ? reject(new AppError(400, UPLOAD_MISSING_MESSAGE, 'photo')) : resolve(new Uint8Array(Buffer.concat(parts)))));
    req.on('error', () => reject(new AppError(400, UPLOAD_MISSING_MESSAGE, 'photo')));
  });
}

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
    const photoWindows = 'photoWindows' in raw ? parseOr(PhotoWindowsSchema, raw.photoWindows, PHOTO_WINDOWS_MESSAGE, 'photoWindows') : undefined;
    const coverAll = 'photosCoverAllWindows' in raw ? parseOr(z.boolean(), raw.photosCoverAllWindows, COVER_MESSAGE, 'photosCoverAllWindows') : undefined;

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
      if (photoWindows !== undefined) {
        const list: PhotoWindowInput[] = [];
        for (const w of photoWindows) {
          const input: PhotoWindowInput = { ...w, uploadId: w.uploadId.toLowerCase() } as PhotoWindowInput;
          const upload = found.uploads.find((u) => u.id === input.uploadId);
          if (upload === undefined) throw new AppError(400, PHOTO_WINDOWS_MESSAGE, 'photoWindows');
          // Corners are in the photo's displayed pixels (EXIF orientation applied), inside the photo.
          const quads: [number, number][][] = input.scale.kind === 'reference' ? [input.corners, input.scale.corners] : input.scale.kind === 'sheet' ? [input.corners, input.scale.imagePoints] : [input.corners];
          const inside = quads.every((q) => q.every(([x, y]) => x >= 0 && y >= 0 && x <= upload.widthPx && y <= upload.heightPx));
          if (!inside) throw new AppError(400, PHOTO_WINDOWS_MESSAGE, 'photoWindows');
          const sheet = sheetProblem(input, upload);
          if (sheet !== null) {
            throw new AppError(422, `Window "${input.label ?? input.id}" could not be sized: ${sheet}. Take its photo again with the whole sheet flat on the glass and in view.`, 'photoWindows');
          }
          if (sizePhotoWindow(input, upload) === null) {
            throw new AppError(422, `Window "${input.label ?? input.id}" could not be sized from its corners. Mark its four corners (and the paper's) again.`, 'photoWindows');
          }
          list.push(input);
        }
        next.photoWindows = list;
      }
      if (coverAll !== undefined) next.photosCoverAllWindows = coverAll;
      if (excluded !== undefined) {
        const known = new Set([...found.windows.map((w) => w.id), ...(next.marked ?? []).map((m) => m.id), ...(next.photoWindows ?? []).map((w) => w.id)]);
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
      const ids = new Set([...found.windows.map((w) => w.id), ...(next.marked ?? []).map((m) => m.id), ...(next.photoWindows ?? []).map((w) => w.id)]);
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

  // A photo of one window taken on site: multipart field "photo" (or the raw bytes). JPEG or PNG, at most 12 MB; the
  // bytes are checked, not the declared type. Kept as uploaded (EXIF orientation recorded, sizes reported as displayed).
  router.post('/:id/uploads', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const visible = await withTenant(pools, ctx, (tx) => getWindowMeasurement(tx, ctx, id));
    if (visible === null) throw new AppError(404, MESSAGES.notFound);
    if (visible.uploads.length >= MAX_UPLOADS) throw new AppError(409, UPLOADS_FULL_MESSAGE, 'photo');
    const bytes = await readUpload(req);
    const info = await readImageInfo(bytes);
    if (info === 'heic') throw new AppError(415, HEIC_MESSAGE, 'photo');
    if (info === null) throw new AppError(415, UPLOAD_TYPE_MESSAGE, 'photo');
    if (!deps.objectStore.configured) throw new AppError(503, STORAGE_DOWN_MESSAGE);
    const uploadId = randomUUID();
    const key = `${ctx.companyId}/window-uploads/${uploadId}.${info.kind === 'jpeg' ? 'jpg' : 'png'}`;
    // The bytes are stored before the row that points at them; a refused upload removes them again.
    await deps.objectStore.put(key, bytes, `image/${info.kind}`);
    const now = clock.now();
    const upload: StoredWindowUpload = {
      id: uploadId,
      widthPx: info.widthPx,
      heightPx: info.heightPx,
      focal35mm: info.focal35mm,
      takenAt: info.takenAt,
      key,
      kind: info.kind,
      orientation: info.orientation,
      bytes: bytes.length,
      uploadedAt: now.toISOString(),
    };
    const result = await withTenant(pools, ctx, (tx) => appendWindowUpload(tx, ctx, id, upload, MAX_UPLOADS, now));
    if (result === null || result === 'full') {
      await deps.objectStore.delete(key).catch((err: unknown) => deps.logError?.(err, 'window-upload-delete'));
      if (result === null) throw new AppError(404, MESSAGES.notFound);
      throw new AppError(409, UPLOADS_FULL_MESSAGE, 'photo');
    }
    res.status(201).json({ id: upload.id, widthPx: upload.widthPx, heightPx: upload.heightPx, focal35mm: upload.focal35mm, takenAt: upload.takenAt });
  });

  router.get('/:id/uploads/:uploadId', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const uploadId = idParam(req.params.uploadId);
    const row = await withTenant(pools, ctx, (tx) => getWindowMeasurement(tx, ctx, id));
    const upload = row?.uploads.find((u) => u.id === uploadId);
    if (upload === undefined) throw new AppError(404, MESSAGES.notFound);
    const bytes = await deps.objectStore.get(upload.key);
    if (bytes === null) throw new AppError(404, MESSAGES.notFound);
    res.set('Content-Type', `image/${upload.kind}`);
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
