import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler, Router, type RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { z, ZodError } from 'zod';
import {
  addHomeownerNote,
  appendWindowUpload,
  createHomeownerRequest,
  createQuoteRequest,
  ensureHomeownerMeasurement,
  getFiledLead,
  getHomeownerRequest,
  getWindowCatalog,
  getProperty,
  getQuoteEstimate,
  getWindowMeasurement,
  linkHomeownerLead,
  markHomeownerCallMe,
  quoteCompany,
  setHomeownerWindowCount,
  type StoredWindowUpload,
  type TenantContext,
  updateWindowMeasurement,
  withTenant,
} from '@roofline/db';
import {
  AR_DEVICES,
  type HomeownerCompany,
  type HomeownerCreated,
  HOMEOWNER_APP_SOURCE,
  HOMEOWNER_LABEL_MAX,
  HOMEOWNER_MAX_UPLOAD_BYTES_TOTAL,
  HOMEOWNER_MAX_UPLOADS,
  HOMEOWNER_MAX_WINDOWS,
  HOMEOWNER_PHOTO_MAX_BYTES,
  HOMEOWNER_ROOM_MAX,
  HOMEOWNER_TOKEN_DAYS,
  type HomeownerRequestView,
  type PhotoWindowInput,
  QUOTE_CONSENT_VERSION,
  homeownerProducts,
  QUOTE_PRODUCTS,
  QUOTE_WINDOW_COUNT,
  type QuoteProduct,
  quoteConsentText,
  quoteTextConsentText,
  ROOMPLAN_CONFIDENCES,
  toE164,
  WINDOW_STYLES,
  type WindowAdjustments,
  cardProblem,
  publicFactsOf,
} from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { arProblem, readImageInfo, roomPlanProblem, sizePhotoWindow } from '../estimator/window-uploads.ts';
import { AppError, fieldOf, MESSAGES } from '../errors.ts';
import { bookedTimes, bookVisit, offeredSlots, officeAlert, startFollowUp } from '../quote/booking.ts';
import { quoteIpHash } from '../quote/guards.ts';
import { estimateForHomeowner } from '../quote/homeowner-estimate.ts';
import { canonicalJson, HEIC_MESSAGE, readUpload } from '../routes/window-measurements.ts';
import { assertKnownFields, emailField, noNul, parse } from '../validate.ts';
import { authed, authenticate, HOMEOWNER_LIMITS, HOMEOWNER_UNKNOWN_REQUEST, newHomeownerToken, hashHomeownerToken, RateLimitedError, rateLimited } from './homeowner-auth.ts';
import { registerDetectRoutes } from './homeowner-detect.ts';
import { guardUpload, UPLOAD_GUARD, UploadGate } from './homeowner-upload.ts';
import { buildRequestView, buildStatus, leadSummary, storedInput } from './homeowner-view.ts';
import { policyUrls } from './policy-urls.ts';
import { originGuard, pageFor, route } from './quote-access.ts';

/*
 * The homeowner phone app's API, signed out, under /api/public/homeowner/:slug (the contract, with every body and
 * error: docs/windows/homeowner-api.md; the types: packages/shared/src/homeowner.ts):
 *   GET    /:slug/company                  the company's face, services, consent words and window styles
 *   POST   /:slug/requests                 { address, services } -> a request and its token, the home, the estimates
 *   GET    /:slug/requests/:id             the whole view: windows, rooms, quote, booking, status
 *   PATCH  /:slug/requests/:id             { estimatedTotalOverride } the homeowner's own window count
 *   POST   /:slug/requests/:id/uploads     one photo (raw JPEG/PNG bytes, or multipart "photo")
 *   POST   /:slug/requests/:id/detect-windows   one JPEG (raw bytes) -> the windows the AI detector sees (homeowner-detect.ts)
 *   POST   /:slug/requests/:id/debug-captures/:captureId/:file   tester builds' capture dump, only with DEBUG_CAPTURES_DIR
 *   POST   /:slug/requests/:id/windows     one measured window (idempotent on its id)
 *   DELETE /:slug/requests/:id/windows/:windowId
 *   POST   /:slug/requests/:id/contact     the homeowner's details and consent -> the lead is filed
 *   GET    /:slug/requests/:id/slots       the next open visit times
 *   POST   /:slug/requests/:id/book        { slotStart } | { callMe: true }
 *   GET    /:slug/requests/:id/status      where the request is, asked to installed
 *
 * Like the instant quote page (quote.ts) the slug is the only key to the company, resolved through the system pool,
 * and everything runs in withTenant for that company with a 'system' context. Every /requests/:id call sends the
 * request's bearer token (homeowner-auth.ts): only its SHA-256 hash is stored. The router is mounted in app.ts ahead
 * of blockCrossSiteMutations and the /api session gate, and brings its own limits, body parser, Origin check and CORS.
 * The homeowner's windows are kept on a window measurement of the address (adjustments.photoWindows, each marked
 * source 'homeowner-app'), so the company's staff open them on the address like any other windows; they are
 * quote-grade only and never go on a factory order. Nothing personal is logged or put in a URL.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
/** A window or contact body: a few KB in practice; photos go to the upload route as raw bytes. */
const BODY_LIMIT = '256kb';

const ADDRESS_MESSAGE = 'Please enter the address of the home.';
const SERVICES_MESSAGE = 'Pick at least one thing you are looking for.';
const NOT_OFFERED_MESSAGE = "We don't offer that online yet. Please give us a call.";
const ROOM_MESSAGE = `Please name the room (up to ${HOMEOWNER_ROOM_MAX} characters).`;
const LABEL_MESSAGE = `Please keep the window's name to ${HOMEOWNER_LABEL_MAX} characters.`;
const STYLE_MESSAGE = 'Please pick a window style.';
const FROSTED_MESSAGE = 'Please say whether this is a bathroom window.';
const WINDOW_MESSAGE = 'Please check this window and measure it again.';
const COUNT_MESSAGE = `Use ${QUOTE_WINDOW_COUNT.min} to ${QUOTE_WINDOW_COUNT.max} windows.`;
const FIRST_MESSAGE = 'Please enter your first name.';
const LAST_MESSAGE = 'Please enter your last name.';
const PHONE_MESSAGE = "That doesn't look like a US phone number.";
const ZIP_MESSAGE = 'Please enter a 5-digit ZIP code.';
const CONSENT_MESSAGE = 'Please check the box so we can call or email you.';
const RELOAD_MESSAGE = 'The wording on this screen was updated. Please go back and try again.';
const BOOK_MESSAGE = 'Pick a time, or ask us to call you.';
const UPLOAD_TYPE_MESSAGE = 'Upload a JPEG or PNG photo.';
const STORAGE_DOWN_MESSAGE = "Photo storage isn't available right now. Please try again in a few minutes.";
const PHOTO_UNKNOWN_MESSAGE = 'That photo is not part of this request. Please take it again.';
const CORNERS_OUTSIDE_MESSAGE = 'Those corners are outside the photo. Tap them again.';

/* ------------------------------------------------------------------------------------------------------------------ */
/* Bodies                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

const name = (message: string) => z.string({ error: message }).trim().min(1, message).max(60, 'That name is too long.').refine(noNul, message);

const CreateBody = z
  .object({
    address: z.string({ error: ADDRESS_MESSAGE }).trim().min(5, ADDRESS_MESSAGE).max(200, 'That address is too long.').refine(noNul, ADDRESS_MESSAGE),
    services: z
      .array(z.enum(QUOTE_PRODUCTS, { error: SERVICES_MESSAGE }), { error: SERVICES_MESSAGE })
      .min(1, SERVICES_MESSAGE)
      .max(QUOTE_PRODUCTS.length, SERVICES_MESSAGE)
      .refine((list) => new Set(list).size === list.length, SERVICES_MESSAGE)
      .transform((list) => QUOTE_PRODUCTS.filter((p) => list.includes(p))),
  })
  .strict();

const PatchBody = z
  .object({
    estimatedTotalOverride: z
      .number({ error: COUNT_MESSAGE })
      .int(COUNT_MESSAGE)
      .min(QUOTE_WINDOW_COUNT.min, COUNT_MESSAGE)
      .max(QUOTE_WINDOW_COUNT.max, COUNT_MESSAGE)
      .nullable(),
  })
  .strict();

const ContactBody = z
  .object({
    firstName: name(FIRST_MESSAGE),
    lastName: name(LAST_MESSAGE),
    phone: z
      .string({ error: PHONE_MESSAGE })
      .max(40, PHONE_MESSAGE)
      .transform((value, ctx) => {
        const e164 = toE164(value);
        if (e164 === null) {
          ctx.addIssue({ code: 'custom', message: PHONE_MESSAGE });
          return z.NEVER;
        }
        return e164;
      }),
    email: emailField,
    zip: z.string({ error: ZIP_MESSAGE }).trim().regex(/^\d{5}(?:-\d{4})?$/, ZIP_MESSAGE),
    contactConsent: z.literal(true, { error: CONSENT_MESSAGE }),
    textConsent: z.boolean({ error: MESSAGES.checkField }).optional(),
    consentVersion: z.string({ error: RELOAD_MESSAGE }).max(40, RELOAD_MESSAGE),
  })
  .strict();

const BookBody = z.union([
  z.object({ slotStart: z.iso.datetime({ offset: true, error: BOOK_MESSAGE }) }).strict(),
  z.object({ callMe: z.literal(true, { error: BOOK_MESSAGE }) }).strict(),
]);

/** Window ids: the app's UUIDs, or any short id of letters, digits, underscore and hyphen. */
const WINDOW_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const finite = z.number().finite();
const AR_MAX_COORD_M = 50;
const arCoord = z.number().finite().gt(-AR_MAX_COORD_M).lt(AR_MAX_COORD_M);
const arPoint = z.tuple([arCoord, arCoord, arCoord]);
const arSpread = z.number().finite().min(0).max(0.1);
const px = z.number().finite().min(-100_000).max(100_000);
const QuadSchema = z.tuple([z.tuple([px, px]), z.tuple([px, px]), z.tuple([px, px]), z.tuple([px, px])]);

const ScaleSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ar'),
      pointsM: z.tuple([arPoint, arPoint, arPoint, arPoint]),
      trackingLostCount: z.number().int().min(0).max(1000),
      device: z.enum(AR_DEVICES),
      cornerSpreadM: z.tuple([arSpread, arSpread, arSpread, arSpread]).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('roomplan'),
      widthM: z.number().finite().gt(0).max(AR_MAX_COORD_M),
      heightM: z.number().finite().gt(0).max(AR_MAX_COORD_M),
      confidence: z.enum(ROOMPLAN_CONFIDENCES),
    })
    .strict(),
  z
    .object({
      kind: z.literal('card'),
      cardCorners: QuadSchema,
      card: z.object({ widthMm: finite, heightMm: finite }).strict(),
    })
    .strict(),
]);

const WindowBody = z
  .object({
    id: z.string({ error: WINDOW_MESSAGE }).regex(WINDOW_ID, WINDOW_MESSAGE),
    room: z.string({ error: ROOM_MESSAGE }).trim().min(1, ROOM_MESSAGE).max(HOMEOWNER_ROOM_MAX, ROOM_MESSAGE).refine(noNul, ROOM_MESSAGE),
    label: z.string({ error: LABEL_MESSAGE }).trim().max(HOMEOWNER_LABEL_MAX, LABEL_MESSAGE).refine(noNul, LABEL_MESSAGE).optional(),
    style: z.enum(WINDOW_STYLES, { error: STYLE_MESSAGE }),
    frosted: z.boolean({ error: FROSTED_MESSAGE }).optional(),
    scale: ScaleSchema,
    uploadId: z.string({ error: WINDOW_MESSAGE }).regex(UPLOAD_ID, WINDOW_MESSAGE).optional(),
    corners: QuadSchema.optional(),
  })
  .strict()
  // A room scan may have no photo; any other method is sized on its photo (the AR and card corners are on it).
  .refine((w) => (w.scale.kind === 'roomplan' ? w.corners === undefined || w.uploadId !== undefined : w.uploadId !== undefined && w.corners !== undefined), { message: WINDOW_MESSAGE });

type WindowBodyType = z.infer<typeof WindowBody>;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Helpers                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Whether the company entered any trust fact. */
const hasTrust = (t: { rating: unknown; sinceYear: number | null; license: unknown; badges: string[] }): boolean => t.rating !== null || t.sinceYear !== null || t.license !== null || t.badges.length > 0;

/** A #rgb or #rrggbb colour as #rrggbb. */
function hex6(color: string | null): string | null {
  if (color === null) return null;
  const m = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(color);
  return (m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : color).toLowerCase();
}

const DEFAULT_CODES: Record<number, string> = {
  400: 'invalid_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'too_large',
  415: 'unsupported_media',
  422: 'unprocessable',
  429: 'rate_limited',
  503: 'unavailable',
};

/**
 * Gives every error this API answers a machine code (`code` in the body), sends `Retry-After` with every 429, and turns
 * body-parser failures into ours. (An unexpected failure is left to the app's own handler: a 500 with no code.)
 */
const withCodes: ErrorRequestHandler = (err: unknown, _req, res, next) => {
  if (err instanceof ZodError) {
    next(new AppError(400, MESSAGES.checkField, fieldOf(err)).coded('invalid_request'));
    return;
  }
  if (err instanceof AppError) {
    if (err.code === undefined) err.coded(DEFAULT_CODES[err.status] ?? 'error');
    if (err instanceof RateLimitedError && !res.headersSent) res.setHeader('Retry-After', String(err.retryAfterSeconds));
    next(err);
    return;
  }
  // body-parser: too large, malformed JSON, bad charset
  const shape = err as { status?: unknown; type?: unknown; expose?: unknown } | null;
  if (typeof err === 'object' && err !== null && typeof shape?.type === 'string' && typeof shape.status === 'number' && shape.expose === true && shape.status >= 400 && shape.status <= 499) {
    next(shape.status === 413 ? new AppError(413, MESSAGES.tooLarge).coded('too_large') : new AppError(400, MESSAGES.unreadable).coded('invalid_request'));
    return;
  }
  next(err);
};

function perIpLimit(scope: string, limit: number, windowMs: number): RequestHandler {
  const hourly = windowMs >= HOUR_MS;
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `ho-${scope}:${ipKeyGenerator(req.ip ?? 'unknown')}`,
    handler: (_req, _res, next) => {
      next(rateLimited(hourly, Math.ceil(windowMs / 1000)));
    },
  });
}

/** The request must be one the windows calls apply to: not a call back, and asking about windows. */
function requireWindows(request: { status: 'ready' | 'callback'; services: readonly string[] }): void {
  if (request.status === 'callback') throw new AppError(409, "We'll call you about this home, so there is nothing to measure here.").coded('callback_only');
  if (!request.services.includes('windows')) throw new AppError(409, 'This request is not about windows.').coded('windows_not_requested');
}

/** The page must be on to take a new lead or a booking (an existing request can still be looked at when it is off). */
function requireOn(settings: { enabled: boolean }): void {
  if (!settings.enabled) throw new AppError(404, MESSAGES.notFound).coded('not_found');
}

const inside = (q: readonly (readonly [number, number])[], w: number, h: number): boolean => q.every(([x, y]) => x >= 0 && y >= 0 && x <= w && y <= h);

/**
 * One window as the homeowner sent it, checked against this request's photos and sized with the shared math: its photo
 * must be one of the request's uploads and its corners inside it (400); a window the math cannot size is a 422 that says
 * in plain words what to redo, and nothing is saved.
 */
function checkWindow(w: WindowBodyType, uploads: readonly StoredWindowUpload[]): PhotoWindowInput {
  const input = storedInput(w as Parameters<typeof storedInput>[0]);
  const upload = input.uploadId === undefined ? null : uploads.find((u) => u.id === input.uploadId);
  if (upload === undefined) throw new AppError(400, PHOTO_UNKNOWN_MESSAGE, 'uploadId');
  const name = input.label !== undefined && input.label !== '' ? input.label : input.room !== undefined ? `the ${input.room.toLowerCase()} window` : 'that window';
  const unsizable = (what: string) => new AppError(422, `We couldn't size ${name}. ${what}`, 'scale').coded('window_unsizable');
  if (upload !== null) {
    const s = input.scale;
    const quads: (readonly (readonly [number, number])[])[] = [...(input.corners !== undefined ? [input.corners] : []), ...(s.kind === 'card' ? [s.cardCorners] : [])];
    if (!quads.every((q) => inside(q, upload.widthPx, upload.heightPx))) throw new AppError(400, CORNERS_OUTSIDE_MESSAGE, 'corners');
  }
  const s = input.scale;
  if (s.kind === 'ar' && arProblem(input) !== null) throw unsizable('Those four corners are not a window size. Tap the corners of the frame again.');
  if (s.kind === 'roomplan' && roomPlanProblem(input) !== null) throw unsizable('The room scan did not give a window size. Scan the room again or measure the window another way.');
  if (s.kind === 'card' && upload !== null && input.corners !== undefined) {
    const problem = cardProblem({ widthPx: upload.widthPx, heightPx: upload.heightPx, cardCorners: s.cardCorners, windowCorners: input.corners, card: s.card });
    if (problem !== null) throw unsizable(problem);
  }
  if (sizePhotoWindow(input, upload) === null) throw unsizable('Please tap the corners again.');
  return input;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The router                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

export function publicHomeownerRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();
  const auth = authenticate(deps);
  const receiving = new UploadGate();

  // Every answer is per request and personal to the homeowner's address: never cached, never indexed (a refusal included).
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    next();
  });
  // The per-IP limit comes before the Origin check: that check looks the company up, which a caller must not get for free.
  router.use(perIpLimit('all', HOMEOWNER_LIMITS.ipPerMinute, MINUTE_MS));
  router.use(originGuard(deps, { methods: 'GET, POST, PATCH, DELETE', headers: 'Content-Type, Accept, Authorization', coded: true }));
  // JSON bodies only; a photo is raw bytes (image/jpeg) or multipart and is read by the upload route itself (so the JSON
  // parser must not touch that route: a stream it has read cannot be read again, and the upload would wait for ever).
  const json = express.json({ limit: BODY_LIMIT });
  router.use((req, res, next) => {
    if (/\/requests\/[^/]+\/(uploads|detect-windows)\/?$/i.test(req.path) || /\/requests\/[^/]+\/debug-captures\/[^/]+\/[^/]+$/i.test(req.path)) next();
    else json(req, res, next);
  });

  router.get(
    '/:slug/company',
    route(async (req, res) => {
      const { ctx, settings } = await pageFor(deps, req.params.slug);
      const [company, catalog] = await withTenant(pools, ctx, async (tx) => [await quoteCompany(tx, ctx), await getWindowCatalog(tx, ctx)] as const);
      if (company === null) throw new AppError(404, MESSAGES.notFound);
      const facts = publicFactsOf(catalog);
      const urls = policyUrls(deps.config, company.slug);
      const body: HomeownerCompany = {
        apiVersion: 1,
        name: company.name,
        brandColor: hex6(settings.accentColor),
        phone: company.phoneE164,
        services: homeownerProducts(settings.products),
        booking: settings.booking,
        privacyUrl: urls.privacy,
        termsUrl: urls.terms,
        consent: { version: QUOTE_CONSENT_VERSION, text: quoteConsentText(company.name), textingText: quoteTextConsentText(company.name) },
        windowStyles: facts.tiles.map((t) => ({ key: t.style, label: t.label, hint: t.hint, tile: t.id, atVisit: t.atVisit })),
        trust: hasTrust(facts.trust) ? facts.trust : null,
        catalog: { tiers: facts.tiers, included: facts.included, offer: facts.offer, financing: facts.financing },
        limits: {
          maxWindows: HOMEOWNER_MAX_WINDOWS,
          maxPhotoBytes: HOMEOWNER_PHOTO_MAX_BYTES,
          maxRoomLength: HOMEOWNER_ROOM_MAX,
          maxLabelLength: HOMEOWNER_LABEL_MAX,
          tokenDays: HOMEOWNER_TOKEN_DAYS,
        },
      };
      res.json(body);
    }),
  );

  router.post(
    '/:slug/requests',
    perIpLimit('new', HOMEOWNER_LIMITS.newRequestsPerIpPerHour, HOUR_MS),
    route(async (req, res) => {
      const { ctx, settings } = await pageFor(deps, req.params.slug);
      const body = parse(CreateBody, req.body);
      if (!body.services.every((s) => homeownerProducts(settings.products).includes(s))) throw new AppError(422, NOT_OFFERED_MESSAGE, 'services').coded('service_not_offered');
      const ipHash = quoteIpHash(deps.config, req.ip ?? 'unknown', ctx.companyId);
      const outcome = await estimateForHomeowner(deps, ctx, settings, { address: body.address, services: body.services, ipHash });

      const token = newHomeownerToken();
      const now = clock.now();
      const expiresAt = new Date(now.getTime() + HOMEOWNER_TOKEN_DAYS * DAY_MS);
      const created = await withTenant(pools, ctx, async (tx) => {
        const row = await createHomeownerRequest(
          tx,
          ctx,
          {
            tokenHash: hashHomeownerToken(token),
            expiresAt,
            services: body.services,
            address: outcome.address,
            status: outcome.status,
            callbackReason: outcome.callbackReason,
            quoteEstimateId: outcome.estimate?.id ?? null,
            propertyId: outcome.propertyId,
            ipHash,
          },
          now,
        );
        return buildRequestView(tx, ctx, row);
      });
      const answer: HomeownerCreated = {
        requestId: created.request.id,
        token,
        expiresAt: expiresAt.toISOString(),
        status: created.request.status,
        ...(created.request.callbackReason !== undefined && { callbackReason: created.request.callbackReason }),
        home: created.request.home,
        estimate: created.request.estimate,
        services: created.request.services,
      };
      res.status(201).json(answer);
    }),
  );

  // Everything below needs the request's token.
  router.use('/:slug/requests/:id/detect-windows', perIpLimit('detect', HOMEOWNER_LIMITS.detectPerIpPerMinute, MINUTE_MS));
  router.use('/:slug/requests/:id', auth.middleware);

  /** The request's view, read fresh. */
  const view = async (ctx: TenantContext, id: string): Promise<HomeownerRequestView> => {
    const found = await withTenant(pools, ctx, async (tx) => {
      const row = await getHomeownerRequest(tx, ctx, id);
      return row === null ? null : buildRequestView(tx, ctx, row);
    });
    if (found === null) throw new AppError(401, HOMEOWNER_UNKNOWN_REQUEST).coded('unauthorized');
    return found;
  };

  router.get(
    '/:slug/requests/:id',
    route(async (_req, res) => {
      const { ctx, request } = authed(res);
      res.json(await view(ctx, request.id));
    }),
  );

  router.patch(
    '/:slug/requests/:id',
    route(async (req, res) => {
      const { ctx, request } = authed(res);
      requireWindows(request);
      const body = parse(PatchBody, assertKnownFields(req.body, ['estimatedTotalOverride']));
      await withTenant(pools, ctx, (tx) => setHomeownerWindowCount(tx, ctx, request.id, body.estimatedTotalOverride, clock.now()));
      res.json(await view(ctx, request.id));
    }),
  );

  router.post(
    '/:slug/requests/:id/uploads',
    route(async (req, res) => {
      const { ctx, request } = authed(res);
      // A photo is held in memory until it is stored, so only a few are taken at once (per request, per address, in all).
      // A refused one costs nothing: no byte is read, nothing is stored, and the hour's count of uploads is not used.
      const place = receiving.enter(request.id, ipKeyGenerator(req.ip ?? 'unknown'));
      if (place === null) throw rateLimited(false, UPLOAD_GUARD.retryAfterSeconds);
      // The place is given back when the answer is done, or when the phone goes away with the photo half sent.
      res.once('close', place.leave);
      try {
        await auth.budget(request.id, 'uploads');
        requireWindows(request);
        // A photo that stops arriving, or takes minutes, is cut off (the read then fails).
        const stopGuard = guardUpload(req);
        let bytes: Uint8Array;
        try {
          bytes = await readUpload(req);
        } finally {
          stopGuard();
        }
        const info = await readImageInfo(bytes);
        if (info === 'heic') throw new AppError(415, HEIC_MESSAGE, 'photo');
        if (info === null) throw new AppError(415, UPLOAD_TYPE_MESSAGE, 'photo');
        if (!deps.objectStore.configured) throw new AppError(503, STORAGE_DOWN_MESSAGE).coded('storage_unavailable');
        const uploadId = randomUUID();
        const key = `${ctx.companyId}/window-uploads/${uploadId}.${info.kind === 'jpeg' ? 'jpg' : 'png'}`;
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
        // The bytes are stored before the row that points at them; a refused upload removes them again.
        await deps.objectStore.put(key, bytes, `image/${info.kind}`);
        const full = () => new AppError(409, 'This request has all the photos it can hold.', 'photo').coded('uploads_full');
        let refused: AppError | null;
        try {
          refused = await withTenant(pools, ctx, async (tx): Promise<AppError | null> => {
            const locked = await getHomeownerRequest(tx, ctx, request.id, { lock: true });
            const made = locked === null ? null : await ensureHomeownerMeasurement(tx, ctx, locked, now);
            if (made === null) return new AppError(409, "We can't take photos for this request.").coded('callback_only');
            const held = made.uploads ?? [];
            if (held.length >= HOMEOWNER_MAX_UPLOADS || held.reduce((n, u) => n + u.bytes, 0) + bytes.length > HOMEOWNER_MAX_UPLOAD_BYTES_TOTAL) return full();
            const result = await appendWindowUpload(tx, ctx, made.id, upload, HOMEOWNER_MAX_UPLOADS, now);
            return result === null || result === 'full' ? full() : null;
          });
        } catch (err) {
          await deps.objectStore.delete(key).catch((e: unknown) => deps.logError?.(e, 'homeowner-upload-delete'));
          throw err;
        }
        if (refused !== null) {
          await deps.objectStore.delete(key).catch((e: unknown) => deps.logError?.(e, 'homeowner-upload-delete'));
          throw refused;
        }
        res.status(201).json({ id: uploadId, widthPx: info.widthPx, heightPx: info.heightPx });
      } finally {
        place.leave();
      }
    }),
  );

  // "Finding your window" (the AI detector) and the tester builds' capture dump: homeowner-detect.ts
  registerDetectRoutes(router, { deps, budget: auth.budget });

  router.post(
    '/:slug/requests/:id/windows',
    route(async (req, res) => {
      const { ctx, request } = authed(res);
      requireWindows(request);
      const body = parse(WindowBody, req.body);
      await auth.budget(request.id, 'windows');
      const now = clock.now();
      const result = await withTenant(pools, ctx, async (tx) => {
        const locked = await getHomeownerRequest(tx, ctx, request.id, { lock: true });
        if (locked === null) return null;
        const made = await ensureHomeownerMeasurement(tx, ctx, locked, now);
        const found = made === null ? null : await getWindowMeasurement(tx, ctx, made.id, { lock: true });
        if (found === null) return null;
        const input = checkWindow(body, found.uploads ?? []);
        const list = found.adjustments.photoWindows ?? [];
        const same = list.find((x) => x.id === input.id);
        // The request row as it is now: the first window or photo has just made its measurement.
        const current = (await getHomeownerRequest(tx, ctx, request.id)) ?? locked;
        if (same !== undefined) {
          if (canonicalJson(same) !== canonicalJson(input)) throw new AppError(409, 'A different window with this id is already saved. Give the new window its own id.', 'id').coded('window_id_taken');
          return { created: false, view: await buildRequestView(tx, ctx, current) };
        }
        if (list.filter((x) => x.source === HOMEOWNER_APP_SOURCE).length >= HOMEOWNER_MAX_WINDOWS) {
          throw new AppError(409, `This request has ${HOMEOWNER_MAX_WINDOWS} windows already.`, 'windows').coded('windows_full');
        }
        const next: WindowAdjustments = { ...found.adjustments, photoWindows: [...list, input] };
        await updateWindowMeasurement(tx, ctx, found.id, { adjustments: next }, now);
        return { created: true, view: await buildRequestView(tx, ctx, current) };
      });
      if (result === null) throw new AppError(409, "We can't take windows for this request.").coded('callback_only');
      res.status(result.created ? 201 : 200).json(result.view);
    }),
  );

  router.delete(
    '/:slug/requests/:id/windows/:windowId',
    route(async (req, res) => {
      const { ctx, request } = authed(res);
      await auth.budget(request.id, 'windows');
      const windowId = typeof req.params.windowId === 'string' ? req.params.windowId : '';
      if (!WINDOW_ID.test(windowId)) throw new AppError(404, MESSAGES.notFound);
      const now = clock.now();
      const out = await withTenant(pools, ctx, async (tx) => {
        const locked = await getHomeownerRequest(tx, ctx, request.id, { lock: true });
        if (locked === null) return null;
        if (locked.windowMeasurementId !== null) {
          const found = await getWindowMeasurement(tx, ctx, locked.windowMeasurementId, { lock: true });
          const list = found?.adjustments.photoWindows ?? [];
          // Only the homeowner's own windows: a window a rep added to the address is not theirs to take away.
          if (found !== null && list.some((w) => w.id === windowId && w.source === HOMEOWNER_APP_SOURCE)) {
            const next: WindowAdjustments = {
              ...found.adjustments,
              photoWindows: list.filter((w) => w.id !== windowId),
              excludedWindowIds: found.adjustments.excludedWindowIds.filter((w) => w !== windowId),
            };
            await updateWindowMeasurement(tx, ctx, found.id, { adjustments: next }, now);
          }
        }
        return buildRequestView(tx, ctx, locked);
      });
      if (out === null) throw new AppError(401, HOMEOWNER_UNKNOWN_REQUEST).coded('unauthorized');
      res.json(out);
    }),
  );

  router.post(
    '/:slug/requests/:id/contact',
    route(async (req, res) => {
      const { ctx, settings, request } = authed(res);
      requireOn(settings);
      const body = parse(ContactBody, req.body);
      if (body.consentVersion !== QUOTE_CONSENT_VERSION) throw new AppError(409, RELOAD_MESSAGE).coded('consent_changed');
      // Counted once the form is whole: a mistyped phone number or email must not use up the hour's tries.
      await auth.budget(request.id, 'contact');
      const products = request.services.filter((p): p is QuoteProduct => homeownerProducts(settings.products).includes(p as QuoteProduct));
      if (products.length === 0) throw new AppError(422, NOT_OFFERED_MESSAGE, 'services').coded('service_not_offered');
      const now = clock.now();

      const found = await withTenant(pools, ctx, async (tx) => {
        const estimate = request.quoteEstimateId === null ? null : await getQuoteEstimate(tx, ctx, request.quoteEstimateId);
        const home = request.propertyId === null ? null : await getProperty(tx, ctx, request.propertyId);
        const company = await quoteCompany(tx, ctx);
        return { estimate, home, company };
      });
      if (found.company === null) throw new AppError(404, MESSAGES.notFound);
      const { estimate, home, company } = found;
      const property = home
        ? { addressLine: home.addressLine, city: home.city, state: home.state, zip: home.zip, location: home.geom ?? null, timezone: home.timezone ?? null }
        : // The address lookup was down when the request was made: it is filed under the typed address.
          { addressLine: request.address.slice(0, 200), city: '', state: '', zip: body.zip.slice(0, 5), location: null, timezone: null };
      const ipHash = quoteIpHash(deps.config, req.ip ?? 'unknown', ctx.companyId);

      const filed = await withTenant(pools, ctx, async (tx) => {
        const locked = await getHomeownerRequest(tx, ctx, request.id, { lock: true });
        if (locked === null) return null;
        if (locked.quoteRequestId !== null) {
          // Filed already: the same phone gets what was filed; another phone must not make a second lead for this request.
          const lead = await getFiledLead(tx, ctx, locked.quoteRequestId);
          if (lead !== null && lead.phoneE164 !== body.phone) throw new AppError(409, 'We already have your details for this request. Please call us to change them.', 'phone').coded('contact_filed');
          return { created: false, jobId: lead?.jobId ?? null, view: await buildRequestView(tx, ctx, locked) };
        }
        const before = await buildRequestView(tx, ctx, locked);
        const result = await createQuoteRequest(tx, ctx, {
          name: `${body.firstName} ${body.lastName}`,
          firstName: body.firstName,
          lastName: body.lastName,
          email: body.email,
          phoneE164: body.phone,
          postalCode: body.zip,
          property,
          quoteEstimateId: locked.quoteEstimateId,
          products,
          consentText: quoteConsentText(company.name),
          consentVersion: QUOTE_CONSENT_VERSION,
          textConsentText: body.textConsent === true ? quoteTextConsentText(company.name) : null,
          ipHash,
          measurementId: estimate?.measurementId ?? null,
          summary: leadSummary(products, before),
          channel: 'app',
          now,
        });
        await linkHomeownerLead(tx, ctx, locked.id, result.requestId, now);
        const fresh = await getHomeownerRequest(tx, ctx, locked.id);
        return { created: result.created, jobId: result.jobId, view: await buildRequestView(tx, ctx, fresh ?? locked) };
      });
      if (filed === null) throw new AppError(401, HOMEOWNER_UNKNOWN_REQUEST).coded('unauthorized');
      if (filed.created && filed.jobId !== null) {
        await officeAlert(deps, ctx, filed.jobId, { products, booked: false, priced: request.status === 'ready' && estimate?.status === 'ready', channel: 'app' });
        await startFollowUp(deps, ctx);
      }
      res.status(filed.created ? 201 : 200).json(filed.view);
    }),
  );

  router.get(
    '/:slug/requests/:id/slots',
    perIpLimit('slots', HOMEOWNER_LIMITS.slotsPerIpPerHour, HOUR_MS),
    route(async (_req, res) => {
      const { ctx, settings, request } = authed(res);
      requireOn(settings);
      await auth.budget(request.id, 'slots');
      if (!settings.booking) {
        res.json({ timeZone: 'UTC', slots: [] });
        return;
      }
      res.json(await offeredSlots(deps, ctx, request.propertyId));
    }),
  );

  router.post(
    '/:slug/requests/:id/book',
    route(async (req, res) => {
      const { ctx, settings, request } = authed(res);
      requireOn(settings);
      const body = parse(BookBody, req.body);
      await auth.budget(request.id, 'book');
      if (request.quoteRequestId === null) throw new AppError(409, 'Please add your contact details first.').coded('contact_needed');
      const quoteRequestId = request.quoteRequestId;
      const lead = await withTenant(pools, ctx, (tx) => getFiledLead(tx, ctx, quoteRequestId));
      if (lead === null) throw new AppError(409, 'Please add your contact details first.').coded('contact_needed');
      const now = clock.now();
      let changed = false;

      // A visit already booked is the answer, whatever is asked now.
      const booked = lead.appointmentId !== null && (await bookedTimes(deps, ctx, lead.appointmentId)) !== null;
      if (!booked) {
        if ('callMe' in body) {
          if (!request.callMe) {
            await withTenant(pools, ctx, async (tx) => {
              await markHomeownerCallMe(tx, ctx, request.id, now);
              await addHomeownerNote(tx, ctx, lead.jobId, { kind: 'job.app_call_me', summary: 'Homeowner app: they asked to be called to set up the free visit.' }, now);
            });
            changed = true;
          }
        } else {
          if (!settings.booking) throw new AppError(409, 'Online booking is off. Please ask us to call you.', 'slotStart').coded('booking_off');
          const made = await bookVisit(deps, ctx, { requestId: lead.requestId, customerId: lead.customerId, jobId: lead.jobId, propertyId: lead.propertyId }, new Date(body.slotStart), 'app');
          if (made !== null) {
            // `already`: a booking made at the same moment (a double tap) got there first; its visit stands and is not noted twice.
            changed = made.already !== true;
          } else {
            // The time is gone. When it went to this request's own booking, made between our look and our try, that visit is the answer.
            const again = await withTenant(pools, ctx, (tx) => getFiledLead(tx, ctx, quoteRequestId));
            const stands = again?.appointmentId != null && (await bookedTimes(deps, ctx, again.appointmentId)) !== null;
            if (!stands) throw new AppError(409, 'That time was just taken. Please pick another.', 'slotStart').coded('slot_taken');
          }
        }
      }
      // What changed, with the windows and quote the homeowner saw, on the job's timeline as they are now.
      const out = await withTenant(pools, ctx, async (tx) => {
        const fresh = await getHomeownerRequest(tx, ctx, request.id);
        if (fresh === null) return null;
        const full = await buildRequestView(tx, ctx, fresh);
        if (changed) {
          const products = fresh.services.filter((p): p is QuoteProduct => homeownerProducts(settings.products).includes(p as QuoteProduct));
          await addHomeownerNote(tx, ctx, lead.jobId, { kind: 'job.app_windows', summary: `Homeowner app: ${leadSummary(products, full)}` }, now);
        }
        return full;
      });
      if (out === null) throw new AppError(401, HOMEOWNER_UNKNOWN_REQUEST).coded('unauthorized');
      res.json(out);
    }),
  );

  router.get(
    '/:slug/requests/:id/status',
    route(async (_req, res) => {
      const { ctx, request } = authed(res);
      res.json(await withTenant(pools, ctx, (tx) => buildStatus(tx, ctx, request)));
    }),
  );

  // Any other path under this API: a 404 like the rest (with its code and headers), not the app's sign-in refusal.
  router.use((_req, _res, next) => {
    next(new AppError(404, MESSAGES.notFound).coded('not_found'));
  });
  router.use(withCodes);
  return router;
}
