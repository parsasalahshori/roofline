import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { Router } from 'express';
import busboy from 'busboy';
import { z } from 'zod';
import { appendWindowUpload, getLatestWindowMeasurementForProperty, getWindowCatalog, getWindowMeasurement, type StoredFacadePhoto, type StoredWindowUpload, updateWindowMeasurement, type WindowMeasurementChange, withTenant } from '@roofline/db';
import { AR_DEVICES, cardProblem, type DoorRuler, HOMEOWNER_APP_SOURCE, type PhotoWindowInput, priceCatalogWindows, pricedWindowsOf, estimatedOf, ROOMPLAN_CONFIDENCES, RULER_KINDS, RULER_MAX_IN, RULER_MIN_IN, SHEET_MAX_OFFSET_IN, SHEET_MAX_POINTS, SHEET_PAPER_IN, WINDOW_PHOTO_REFERENCES, WINDOW_SIZE_CLASSES, WINDOW_STYLES, type WindowAdjustments, type WindowQuote, windowCounts } from '@roofline/shared';
import { arProblem, readImageInfo, roomPlanProblem, sheetProblem, sizePhotoWindow } from '../estimator/window-uploads.ts';
import type { AppDeps } from '../app.ts';
import { measureWindows } from '../estimator/measure-windows.ts';
import { fitCorners, mainWall, type Quad } from '../estimator/windows-lineup.ts';
import { applyRuler, levelledCamera, planOf, toWindowView } from '../estimator/windows-view.ts';
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
const RULER_MESSAGE = `Mark the door inside a photo of this measurement, with its size (${RULER_MIN_IN} to ${RULER_MAX_IN} in).`;
const RULER_UNSIZED_MESSAGE = 'That door could not be used as a ruler on this photo: it is off the front wall, or its size is far from what the photo shows. Check the box is on the door and the door size is right.';

const CREATE_FIELDS = ['propertyId', 'address'] as const;
const PATCH_FIELDS = ['excludedWindowIds', 'manualCounts', 'marked', 'wallCorners', 'photoWindows', 'photosCoverAllWindows', 'ruler'] as const;
const PHOTO_WINDOWS_MESSAGE = 'Mark each window inside its photo, with a paper on the glass or one side measured (6 to 200 in; 60 windows at most).';
const COVER_MESSAGE = 'Please check this field.';
const PHOTO_WINDOWS_FULL_MESSAGE = 'This measurement has 60 windows already.';
const PHOTO_WINDOW_TAKEN_MESSAGE = 'A different window with this id is already saved. Give the new window its own id.';
const UPLOAD_TOO_BIG_MESSAGE = 'That photo is over 12 MB.';
const UPLOAD_TYPE_MESSAGE = 'Upload a JPEG or PNG photo.';
/**
 * HEIC is converted to JPEG in the browser where it can be opened (Safari); the server has no HEIC decoder (sharp's
 * prebuilt libvips has no HEVC), so a HEIC that reaches it is refused with what to change on the phone.
 */
export const HEIC_MESSAGE =
  'This photo is in the HEIC (high efficiency) format. Set the camera to save JPEG and take it again: on iPhone, Settings > Camera > Formats > Most Compatible; on Samsung, Camera settings > Advanced > High efficiency pictures off.';
const UPLOAD_MISSING_MESSAGE = 'Add a photo (form field "photo").';
const UPLOADS_FULL_MESSAGE = 'This measurement has 150 photos already.';
const STORAGE_DOWN_MESSAGE = "Photo storage isn't available right now.";
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
export const MAX_UPLOADS = 150;
export const MAX_PHOTO_WINDOWS = 60;
export const MAX_MARKED = 60;
const MAX_COUNT = 200;
/** AR points further than this from AR's origin (metres, any axis) are not a window the person is standing at. */
const AR_MAX_COORD_M = 50;
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

const rulerInches = z.number().finite().min(RULER_MIN_IN).max(RULER_MAX_IN);
const RulerSchema = z
  .object({ photoId: z.string().regex(UUID), box: BoxSchema, kind: z.enum(RULER_KINDS), widthIn: rulerInches, heightIn: rulerInches })
  .strict()
  .nullable();

const finite = z.number().finite();
const arCoord = z.number().finite().gt(-AR_MAX_COORD_M).lt(AR_MAX_COORD_M);
const arPoint = z.tuple([arCoord, arCoord, arCoord]);
const arSpread = z.number().finite().min(0).max(0.1);
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
      sheetIndex: z.array(z.union([z.literal(0), z.literal(1)])).max(SHEET_MAX_POINTS).optional(),
      printScale: z.number().finite().min(0.9).max(1.1).optional(),
    })
    .strict()
    .refine((v) => v.imagePoints.length === v.sheetPointsIn.length)
    .refine((v) => v.sheetIndex === undefined || v.sheetIndex.length === v.sheetPointsIn.length)
    .refine((v) => v.sheetPointsIn.every(([x, y]) => x >= 0 && y >= 0 && x <= SHEET_PAPER_IN[v.paper].widthIn && y <= SHEET_PAPER_IN[v.paper].heightIn)),
  // AR (Android WebXR): the frame's four corners in AR world space, metres (a window is never 50 m from AR's origin).
  z
    .object({
      kind: z.literal('ar'),
      pointsM: z.tuple([arPoint, arPoint, arPoint, arPoint]),
      trackingLostCount: z.number().int().min(0).max(1000),
      // Absent: 'webxr' (the Android web app). The iPhone app says 'arkit' or 'arkit-lidar'.
      device: z.enum(AR_DEVICES).optional(),
      // Each corner's measured spread, metres (a corner wandering more than 10 cm is not a measurement).
      cornerSpreadM: z.tuple([arSpread, arSpread, arSpread, arSpread]).optional(),
    })
    .strict(),
  // RoomPlan (LiDAR iPhone room scan): the window's size straight from the scan, metres. Quote-grade only.
  z
    .object({
      kind: z.literal('roomplan'),
      widthM: z.number().finite().gt(0).max(AR_MAX_COORD_M),
      heightM: z.number().finite().gt(0).max(AR_MAX_COORD_M),
      confidence: z.enum(ROOMPLAN_CONFIDENCES),
    })
    .strict(),
  // A credit card on the glass (the homeowner app): its four tapped corners and its ID-1 size. Quote-grade only.
  z
    .object({
      kind: z.literal('card'),
      cardCorners: QuadSchema,
      card: z.object({ widthMm: finite, heightMm: finite }).strict(),
    })
    .strict(),
]);
const PhotoWindowSchema = z
  .object({
    id: z.string().regex(WINDOW_ID),
    // Absent only for a RoomPlan window with no photo (refined below).
    uploadId: z.string().regex(UUID).optional(),
    label: z.string().max(80).refine(noNul).optional(),
    // Several photos of one window share a key (the screen combines them).
    windowKey: z.string().max(80).refine(noNul).optional(),
    corners: QuadSchema.optional(),
    scale: ScaleSchema,
    // Set by the homeowner app's API; kept only for a window already stored with it, unchanged (checkPhotoWindow).
    source: z.literal(HOMEOWNER_APP_SOURCE).optional(),
    room: z.string().min(1).max(40).refine(noNul).optional(),
    style: z.enum(WINDOW_STYLES).optional(),
    frosted: z.boolean().optional(),
  })
  .strict()
  // Every kind but RoomPlan is sized on its photo: uploadId and corners are required. Corners need their photo.
  .refine((w) => (w.scale.kind === 'roomplan' ? w.corners === undefined || w.uploadId !== undefined : w.uploadId !== undefined && w.corners !== undefined));
const PhotoWindowsSchema = z
  .array(PhotoWindowSchema)
  .max(MAX_PHOTO_WINDOWS)
  .refine((list) => new Set(list.map((w) => w.id)).size === list.length);

/**
 * The photo in an upload request: multipart/form-data with the file in the field "photo" (other fields ignored), or
 * the raw image bytes as the body. At most `maxBytes` (MAX_UPLOAD_BYTES unless a route asks for less or more); a larger one is
 * a 413 before more is read.
 */
export function readUpload(req: Request, maxBytes: number = MAX_UPLOAD_BYTES): Promise<Uint8Array> {
  const type = (req.headers['content-type'] ?? '').toLowerCase();
  const tooBig = () => new AppError(413, UPLOAD_TOO_BIG_MESSAGE, 'photo');
  if (type.startsWith('multipart/form-data')) {
    return new Promise((resolve, reject) => {
      let parser: busboy.Busboy;
      try {
        parser = busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: 1, fields: 10, parts: 11 } });
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
      // A phone that goes away with the photo half sent never ends the parser: without these the read would wait for ever.
      req.on('error', () => reject(new AppError(400, UPLOAD_MISSING_MESSAGE, 'photo')));
      req.on('close', () => {
        if (!req.complete) reject(new AppError(400, UPLOAD_MISSING_MESSAGE, 'photo'));
      });
      req.pipe(parser);
    });
  }
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? '0');
    if (declared > maxBytes) {
      req.resume();
      reject(tooBig());
      return;
    }
    const parts: Buffer[] = [];
    let total = 0;
    req.on('data', (d: Buffer) => {
      total += d.length;
      if (total > maxBytes) {
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
  // On the camera the line-up levelled (pitch and roll), as sizingCamera uses it.
  const cam = levelledCamera(plan, photo);
  if (cam === null) return null;
  const wall = mainWall(plan.walls, cam.pos);
  if (wall === null) return null;
  const quad = corners.map(([x, y]) => [x * photo.widthPx, y * photo.heightPx]) as Quad;
  return fitCorners(cam, wall, quad);
}

/**
 * One photographed window as the person sent it, checked against the measurement's uploads and sized with the shared
 * math (the same checks for PATCH's whole list and POST /:id/photo-windows' one window): its photo must be one of this
 * measurement's uploads and its corners inside it (400); a window the math cannot size is a 422 naming it.
 */
function checkPhotoWindow(w: z.infer<typeof PhotoWindowSchema>, uploads: readonly StoredWindowUpload[], field: string, stored: readonly PhotoWindowInput[]): PhotoWindowInput {
  const input: PhotoWindowInput = { ...w, ...(w.uploadId !== undefined ? { uploadId: w.uploadId.toLowerCase() } : {}) } as PhotoWindowInput;
  // `source` says the homeowner measured this window in the app: only the app's API sets it. A staff request keeps it for
  // a window already stored with it whose measurement (photo, corners, scale) is unchanged, and drops it otherwise, so
  // a staff measurement is never passed off as the homeowner's and an edited homeowner window becomes the staff's own.
  if (input.source !== undefined) {
    const before = stored.find((x) => x.id === input.id);
    const same = before !== undefined && before.source === HOMEOWNER_APP_SOURCE && canonicalJson([before.uploadId, before.corners, before.scale]) === canonicalJson([input.uploadId, input.corners, input.scale]);
    if (!same) delete input.source;
  }
  const upload = input.uploadId === undefined ? null : uploads.find((u) => u.id === input.uploadId);
  if (upload === undefined) throw new AppError(400, PHOTO_WINDOWS_MESSAGE, field);
  if (upload !== null) {
    // Corners are in the photo's displayed pixels (EXIF orientation applied), inside the photo.
    const s = input.scale;
    const quads: [number, number][][] = [
      ...(input.corners !== undefined ? [input.corners] : []),
      ...(s.kind === 'reference' ? [s.corners] : s.kind === 'sheet' ? [s.imagePoints] : s.kind === 'card' ? [s.cardCorners] : []),
    ];
    const inside = quads.every((q) => q.every(([x, y]) => x >= 0 && y >= 0 && x <= upload.widthPx && y <= upload.heightPx));
    if (!inside) throw new AppError(400, PHOTO_WINDOWS_MESSAGE, field);
  }
  const name = input.label ?? input.id;
  const sheet = upload === null ? null : sheetProblem(input, upload);
  if (sheet !== null) throw new AppError(422, `Window "${name}" could not be sized: ${sheet}. Take its photo again with the whole sheet flat on the glass and in view.`, field);
  const ar = arProblem(input);
  if (ar !== null) throw new AppError(422, `Window "${name}" could not be sized: ${ar}. Tap its four frame corners in AR again.`, field);
  const room = roomPlanProblem(input);
  if (room !== null) throw new AppError(422, `Window "${name}" could not be sized: ${room}. Scan the room again or measure the window in AR.`, field);
  if (input.scale.kind === 'card' && upload !== null && input.corners !== undefined) {
    const card = cardProblem({ widthPx: upload.widthPx, heightPx: upload.heightPx, cardCorners: input.scale.cardCorners, windowCorners: input.corners, card: input.scale.card });
    if (card !== null) throw new AppError(422, `Window "${name}" could not be sized: ${card}`, field);
  }
  if (sizePhotoWindow(input, upload) === null) {
    throw new AppError(422, `Window "${name}" could not be sized from its corners. Mark its four corners (and the paper's) again.`, field);
  }
  return input;
}

/**
 * `/api/window-measurements`: Measure windows.
 * - POST { address | propertyId } -> 201 WindowMeasurementView (the walls estimate, front photos with the wall drawn). It
 *   starts with the windows a homeowner measured in the phone app at that address and sent in (marked source
 *   'homeowner-app', quote-grade; adoptHomeownerWindows).
 * - GET /:id -> the view. PATCH /:id (WindowMeasurementPatch: excludedWindowIds, manualCounts, marked, wallCorners,
 *   ruler (a door of known size marked on a photo, or null); each key given replaces what was there) -> the view, with
 *   marked windows sized (on the ruler's photo, to fit the ruler) and the estimate redone.
 * - GET ?propertyId=<uuid> -> the property's newest measurement (404 when there is none; the measurement a homeowner's
 *   own request keeps is not one).
 * - POST /:id/photo-windows (one PhotoWindowInput) -> 201 the view with it added (200 when the same window was there);
 *   DELETE /:id/photo-windows/:windowId -> the view without it. Both checked and recomputed like PATCH.
 * - GET /:id/photos/:photoId -> the JPEG (kept 30 days, Google's terms; 410 after).
 * - GET /:id/preview -> { quotes }: Good/Better/Best priced from the counted windows (null for members who do not see money).
 * Rep visibility and company isolation come from the repository: a measurement the caller may not see is a 404.
 */
export function windowMeasurementRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  // The newest measurement of a property (the iPhone app opens a job's windows with it): 404 when there is none.
  router.get('/', async (req, res) => {
    const { ctx } = req;
    const raw = req.query.propertyId;
    const propertyId = (typeof raw === 'string' ? raw : '').toLowerCase();
    if (!UUID.test(propertyId)) throw new AppError(400, CHECK_MESSAGE, 'propertyId');
    const row = await withTenant(pools, ctx, (tx) => getLatestWindowMeasurementForProperty(tx, ctx, propertyId));
    if (row === null) throw new AppError(404, MESSAGES.notFound);
    res.json(toWindowView(row, clock.now()));
  });

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
    res.json(toWindowView(row, clock.now(), { photoTools: deps.config.WINDOWS_STREET_VIEW_TOOLS === true }));
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
    const ruler = 'ruler' in raw ? parseOr(RulerSchema, raw.ruler, RULER_MESSAGE, 'ruler') : undefined;
    const coverAll = 'photosCoverAllWindows' in raw ? parseOr(z.boolean(), raw.photosCoverAllWindows, COVER_MESSAGE, 'photosCoverAllWindows') : undefined;

    const row = await withTenant(pools, ctx, async (tx) => {
      const found = await getWindowMeasurement(tx, ctx, id, { lock: true });
      if (found === null) return null;
      const photoIds = new Set(found.photos.map((p) => p.id));
      const next: WindowAdjustments = { ...found.adjustments };
      const change: WindowMeasurementChange = {};
      if (marked !== undefined) {
        if (marked.some((m) => !photoIds.has(m.photoId.toLowerCase()))) throw new AppError(400, MARKED_MESSAGE, 'marked');
        next.marked = marked.map((m) => ({ id: m.id, photoId: m.photoId.toLowerCase(), box: m.box }));
      }
      if (photoWindows !== undefined) next.photoWindows = photoWindows.map((w) => checkPhotoWindow(w, found.uploads, 'photoWindows', found.adjustments.photoWindows ?? []));
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
      if (ruler !== undefined) {
        if (ruler === null) next.ruler = null;
        else {
          const photoId = ruler.photoId.toLowerCase();
          // With the corners this PATCH may have fitted
          const photo = (change.photos ?? found.photos).find((p) => p.id === photoId);
          if (photo === undefined) throw new AppError(400, RULER_MESSAGE, 'ruler');
          const value: DoorRuler = { photoId, box: ruler.box, kind: ruler.kind, widthIn: ruler.widthIn, heightIn: ruler.heightIn };
          // The door must size on the photo (on a front wall, the distance correction within x1/3 to x3)
          const plan = found.geometry === null ? null : planOf(found.geometry);
          if (plan === null || applyRuler(plan, photo, value) === null) throw new AppError(422, RULER_UNSIZED_MESSAGE, 'ruler');
          next.ruler = value;
        }
      }
      // Excluded ids that no longer exist (a marked window taken away) drop out.
      const ids = new Set([...found.windows.map((w) => w.id), ...(next.marked ?? []).map((m) => m.id), ...(next.photoWindows ?? []).map((w) => w.id)]);
      next.excludedWindowIds = next.excludedWindowIds.filter((w) => ids.has(w));
      change.adjustments = next;
      return updateWindowMeasurement(tx, ctx, id, change, clock.now());
    });
    if (row === null) throw new AppError(404, MESSAGES.notFound);
    res.json(toWindowView(row, clock.now(), { photoTools: deps.config.WINDOWS_STREET_VIEW_TOOLS === true }));
  });

  // One photographed window added to the list (the iPhone app adds its windows one at a time, so the phone and the web
  // app never overwrite each other's list). Checked exactly as PATCH checks each window. The same window sent again
  // (a retry after a lost answer) is a 200 with nothing changed; a different window with a taken id is a 409.
  router.post('/:id/photo-windows', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const w = parseOr(PhotoWindowSchema, req.body, PHOTO_WINDOWS_MESSAGE, 'photoWindows');
    const result = await withTenant(pools, ctx, async (tx) => {
      const found = await getWindowMeasurement(tx, ctx, id, { lock: true });
      if (found === null) return null;
      const list = found.adjustments.photoWindows ?? [];
      const input = checkPhotoWindow(w, found.uploads, 'photoWindows', list);
      const same = list.find((x) => x.id === input.id);
      if (same !== undefined) {
        if (canonicalJson(same) !== canonicalJson(input)) throw new AppError(409, PHOTO_WINDOW_TAKEN_MESSAGE, 'id');
        return { row: found, created: false };
      }
      if (list.length >= MAX_PHOTO_WINDOWS) throw new AppError(409, PHOTO_WINDOWS_FULL_MESSAGE, 'photoWindows');
      const next: WindowAdjustments = { ...found.adjustments, photoWindows: [...list, input] };
      const row = await updateWindowMeasurement(tx, ctx, id, { adjustments: next }, clock.now());
      return row === null ? null : { row, created: true };
    });
    if (result === null) throw new AppError(404, MESSAGES.notFound);
    res.status(result.created ? 201 : 200).json(toWindowView(result.row, clock.now()));
  });

  // One photographed window taken off the list (and out of the left-out ids). A window already gone is a 200 too, so a
  // retried delete is harmless.
  router.delete('/:id/photo-windows/:windowId', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const windowId = typeof req.params.windowId === 'string' ? req.params.windowId : '';
    if (!WINDOW_ID.test(windowId)) throw new AppError(404, MESSAGES.notFound);
    const row = await withTenant(pools, ctx, async (tx) => {
      const found = await getWindowMeasurement(tx, ctx, id, { lock: true });
      if (found === null) return null;
      const list = found.adjustments.photoWindows ?? [];
      if (!list.some((w) => w.id === windowId)) return found;
      const next: WindowAdjustments = {
        ...found.adjustments,
        photoWindows: list.filter((w) => w.id !== windowId),
        excludedWindowIds: found.adjustments.excludedWindowIds.filter((w) => w !== windowId),
      };
      return updateWindowMeasurement(tx, ctx, id, { adjustments: next }, clock.now());
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
    if (photo === undefined) throw new AppError(404, MESSAGES.notFound);
    // Deleted by the google-retention job: 410, so the photo area can say it expired.
    if (photo.key === null) throw new AppError(photo.deletedAt !== undefined ? 410 : 404, photo.deletedAt !== undefined ? MESSAGES.googlePhotoExpired : MESSAGES.notFound);
    if (Date.parse(photo.deleteBy) <= clock.now().getTime()) {
      // Past Google's 30 days: gone (the bytes are removed now if a sweep has not done it yet).
      await deps.objectStore.delete(photo.key).catch((err: unknown) => deps.logError?.(err, 'window-photo-delete'));
      throw new AppError(410, MESSAGES.googlePhotoExpired);
    }
    const bytes = await deps.objectStore.get(photo.key);
    if (bytes === null) throw new AppError(410, MESSAGES.googlePhotoExpired);
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
    const catalog = can(ctx, 'view_money_totals') ? await withTenant(pools, ctx, (tx) => getWindowCatalog(tx, ctx)) : null;
    // The same pricing the homeowner's page uses: each window by its style and frosted glass
    const view = toWindowView(row, clock.now());
    const quotes: WindowQuote[] | null = catalog === null ? null : priceCatalogWindows(catalog, pricedWindowsOf(view), estimatedOf(windowCounts(view)));
    res.json({ quotes });
  });

  return router;
}

/** JSON with every object's keys sorted (Postgres jsonb does not keep key order), to compare two stored values. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (x !== null && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
}

function parseOr<T>(schema: z.ZodType<T>, value: unknown, message: string, field: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new AppError(400, message, field);
  return r.data;
}
