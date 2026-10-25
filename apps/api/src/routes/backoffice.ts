import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import {
  acceptBackofficeQuote,
  companies,
  createBackofficeQuote,
  customers,
  findWindowOrderIdForMeasurements,
  getBackofficeEnabled,
  getBackofficeOrder,
  getBackofficeQuote,
  getBackofficeSettings,
  getJob,
  getProductCatalog,
  listBackofficeOrderEvents,
  listBackofficeOrders,
  listBackofficeQuotes,
  moveBackofficeOrder,
  saveBackofficeSettings,
  saveProductCatalog,
  setBackofficeQuoteVisual,
  setOrderEventNotified,
  StageRuleError,
  updateBackofficeQuote,
  updateJob,
  windowUploadsForProperty,
  withTenant,
  type BackofficeOrderEventRow,
  type BackofficeOrderRow,
  type StoredHouseVisual,
  type TenantContext,
} from '@roofline/db';
import {
  autoAccessories,
  daysInStage,
  hasErrors,
  isTimeZone,
  ORDER_STAGES,
  priceQuote,
  QUOTE_DOCUMENTS,
  totalUnits,
  type BackofficeOrder,
  type HouseVisual,
  type OrderEvent,
  type OrderStage,
  type QuoteDocument,
} from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { renderDocument, referenceOf } from '../backoffice/documents.ts';
import { importMeasuredDesigns } from '../backoffice/import-measured.ts';
import { notifyOrderMove } from '../backoffice/notify.ts';
import { catalogFor, toQuoteSummary, toQuoteView } from '../backoffice/quote-view.ts';
import { CreateQuoteSchema, parseCatalog, parseSettings, StageMoveSchema, UpdateQuoteSchema, VisualSchema } from '../backoffice/schemas.ts';
import { readImageInfo } from '../estimator/window-uploads.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { can, requireCapability } from '../permissions.ts';
import { HEIC_MESSAGE, readUpload } from './window-measurements.ts';
import { parse, UUID } from '../validate.ts';

const LOCKED = 'This quote was accepted and is locked. Its order carries on from here.';
const ALREADY_ACCEPTED = 'This quote was already accepted.';
const HAS_ERRORS = 'Fix the problems marked on the quote before accepting it.';
const EMPTY = 'Draw at least one window or door before accepting the quote.';
const NEEDS_APPROVAL = (max: number) => `A discount over ${max}% needs an office approval. Ask the office to accept this quote.`;
const NO_MEASUREMENT = 'This address has no on-site window measurement to start from.';
const WRONG_ADDRESS = 'That measurement is for a different address than this job.';
const VISUAL_MESSAGE = 'Please check the house picture: the photo and the placed units.';
const PHOTO_TYPE = 'Upload a JPEG or PNG photo.';
const STORAGE_DOWN = "Photo storage isn't available right now.";
const NO_PHOTO = 'This quote has no house photo yet.';
const VISUAL_PHOTO_PREFIX = 'backoffice-visuals';

function idParam(raw: unknown): string {
  const id = (typeof raw === 'string' ? raw : '').toLowerCase();
  if (!UUID.test(id)) throw new AppError(404, MESSAGES.notFound);
  return id;
}

function toOrderView(
  o: { order: BackofficeOrderRow; customerName: string; address: string },
  events: OrderEvent[],
  timeZone: string,
  now: Date,
): BackofficeOrder {
  return {
    id: o.order.id,
    jobId: o.order.jobId,
    quoteId: o.order.quoteId,
    customerName: o.customerName,
    address: o.address,
    stage: o.order.stage,
    units: o.order.units,
    totalCents: o.order.totalCents,
    daysInStage: daysInStage(o.order.stageChangedAt, now, timeZone),
    windowOrderId: o.order.windowOrderId,
    events,
  };
}

/**
 * `/api/backoffice`: the WinChoice back office. Every route is a 404 unless the company has company_settings.backoffice_enabled.
 * - catalog: GET (everyone), PUT (owner, office): the price book, version bumped on every save. settings: the same, for the
 *   customer messages per order stage and the stuck days.
 * - quotes: GET list (?jobId=), POST (from a job, optionally importing the address's measured sizes), GET/PUT one (the server
 *   prices it itself from the drawings: lines, totals and issues in the answer are always the server's), POST /:id/accept (makes the
 *   order at 'sold'; answers it), GET/PUT /:id/visual with POST/GET /:id/visual/photo, GET /:id/documents/:kind (a PDF).
 *   Reps see the quotes and orders of the jobs they may see. A rep edits quotes; accepting over the rep discount limit needs the office.
 * - orders: GET (board, with daysInStage), GET /:id (with events), PATCH /:id/stage (owner, office): records the move, texts and
 *   emails the customer when asked (consent rules in notify.ts) and moves the homeowner app's status.
 */
export function backofficeRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();
  const manage = requireCapability('approve_factory_order');

  // Off for the company: the whole area does not exist.
  router.use(async (req, _res, next) => {
    const { ctx } = req;
    const on = await withTenant(pools, ctx, (tx) => getBackofficeEnabled(tx, ctx));
    if (!on) throw new AppError(404, MESSAGES.notFound);
    next();
  });

  const timeZoneOf = async (ctx: TenantContext): Promise<string> => {
    const zone = await withTenant(pools, ctx, async (tx) => (await tx.select({ z: companies.timezone }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1))[0]?.z);
    return zone !== undefined && isTimeZone(zone) ? zone : 'UTC';
  };

  /* Catalog and settings ------------------------------------------------------------------------------------------- */

  router.get('/catalog', async (req, res) => {
    const { ctx } = req;
    res.json(await withTenant(pools, ctx, (tx) => getProductCatalog(tx, ctx)));
  });

  router.put('/catalog', manage, async (req, res) => {
    const { ctx } = req;
    const parsed = parseCatalog(req.body);
    if (!parsed.success) throw new AppError(400, MESSAGES.checkField, parsed.error.issues[0]?.path.join('.'));
    res.json(await withTenant(pools, ctx, (tx) => saveProductCatalog(tx, ctx, parsed.data, clock.now())));
  });

  router.get('/settings', async (req, res) => {
    const { ctx } = req;
    res.json(await withTenant(pools, ctx, (tx) => getBackofficeSettings(tx, ctx)));
  });

  router.put('/settings', manage, async (req, res) => {
    const { ctx } = req;
    const parsed = parseSettings(req.body);
    if (!parsed.success) throw new AppError(400, MESSAGES.checkField, parsed.error.issues[0]?.path.join('.'));
    res.json(await withTenant(pools, ctx, (tx) => saveBackofficeSettings(tx, ctx, parsed.data, clock.now())));
  });

  /* Quotes --------------------------------------------------------------------------------------------------------- */

  /** The quote the member may see, with the company's current catalog; a 404 otherwise. */
  async function loadQuote(ctx: TenantContext, id: string) {
    const found = await withTenant(pools, ctx, async (tx) => {
      const quote = await getBackofficeQuote(tx, ctx, id);
      return quote === null ? null : { quote, catalog: await getProductCatalog(tx, ctx) };
    });
    if (found === null) throw new AppError(404, MESSAGES.notFound);
    return found;
  }

  router.get('/quotes', async (req, res) => {
    const { ctx } = req;
    const jobId = typeof req.query.jobId === 'string' ? req.query.jobId.toLowerCase() : undefined;
    if (jobId !== undefined && !UUID.test(jobId)) throw new AppError(400, MESSAGES.checkField, 'jobId');
    const { list, catalog } = await withTenant(pools, ctx, async (tx) => ({
      list: await listBackofficeQuotes(tx, ctx, jobId !== undefined ? { jobId } : {}),
      catalog: await getProductCatalog(tx, ctx),
    }));
    res.json(list.map((q) => toQuoteSummary(q, catalog)));
  });

  router.post('/quotes', async (req, res) => {
    const { ctx } = req;
    const body = parse(CreateQuoteSchema, req.body);
    const now = clock.now();
    const created = await withTenant(pools, ctx, async (tx) => {
      const job = await getJob(tx, ctx, body.jobId.toLowerCase());
      if (job === null) return null;
      const catalog = await getProductCatalog(tx, ctx);
      let designs: Parameters<typeof createBackofficeQuote>[2]['designs'] = [];
      if (body.importMeasured === true || body.windowMeasurementId !== undefined) {
        const imported = await importMeasuredDesigns(tx, ctx, job.propertyId, body.windowMeasurementId?.toLowerCase(), catalog, now);
        if ('problem' in imported) throw new AppError(422, imported.problem === 'no-measurement' ? NO_MEASUREMENT : WRONG_ADDRESS);
        designs = imported.designs;
      }
      const row = await createBackofficeQuote(tx, ctx, { jobId: job.id, tier: body.tier ?? 'better', designs, accessories: autoAccessories(catalog), catalogVersion: catalog.version }, now);
      return row === null ? null : { id: row.id, catalog };
    });
    if (created === null) throw new AppError(404, MESSAGES.notFound);
    const { quote, catalog } = await loadQuote(ctx, created.id);
    res.status(201).json(toQuoteView(quote, catalog));
  });

  router.get('/quotes/:id', async (req, res) => {
    const { quote, catalog } = await loadQuote(req.ctx, idParam(req.params.id));
    res.json(toQuoteView(quote, catalog));
  });

  router.put('/quotes/:id', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const body = parse(UpdateQuoteSchema, req.body);
    const now = clock.now();
    const result = await withTenant(pools, ctx, async (tx) => {
      const catalog = await getProductCatalog(tx, ctx);
      return updateBackofficeQuote(
        tx,
        ctx,
        id,
        {
          tier: body.tier,
          designs: body.designs as never,
          accessories: body.accessories,
          discountPercent: body.discountPercent,
          catalogVersion: catalog.version,
          ...(body.status !== undefined && { status: body.status }),
        },
        now,
      );
    });
    if (result === null) throw new AppError(404, MESSAGES.notFound);
    if (result === 'locked') throw new AppError(409, LOCKED);
    const { quote, catalog } = await loadQuote(ctx, id);
    res.json(toQuoteView(quote, catalog));
  });

  router.post('/quotes/:id/accept', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const now = clock.now();
    const out = await withTenant(pools, ctx, async (tx) => {
      const found = await getBackofficeQuote(tx, ctx, id);
      if (found === null) return null;
      const { quote } = found;
      if (quote.status === 'accepted') throw new AppError(409, ALREADY_ACCEPTED);
      const catalog = await getProductCatalog(tx, ctx);
      const priced = priceQuote({ designs: quote.designs, accessories: quote.accessories, discountPercent: quote.discountPercent }, catalog);
      if (quote.designs.length === 0) throw new AppError(422, EMPTY);
      if (hasErrors(priced.issues)) throw new AppError(422, HAS_ERRORS);
      if (priced.discountNeedsApproval && !can(ctx, 'approve_factory_order')) throw new AppError(403, NEEDS_APPROVAL(catalog.maxRepDiscountPercent));
      const totalCents = priced.totals[quote.tier].totalCents;
      const measurementIds = [...new Set(quote.designs.flatMap((d) => (d.sizeSource.kind === 'measured' ? [d.sizeSource.windowMeasurementId] : [])))];
      const windowOrderId = await findWindowOrderIdForMeasurements(tx, ctx, measurementIds);
      const made = await acceptBackofficeQuote(tx, ctx, quote, { units: totalUnits(quote.designs), totalCents, windowOrderId, catalog }, now);
      if (made === null) throw new AppError(409, ALREADY_ACCEPTED);
      // The job is won, worth what was sold (a job already won or installed keeps its stage).
      const job = await getJob(tx, ctx, quote.jobId);
      if (job !== null && ['lead', 'inspection', 'proposal'].includes(job.stage) && totalCents > 0) {
        try {
          await updateJob(tx, ctx, job.id, { stage: 'won', valueCents: totalCents }, { now });
        } catch (err) {
          if (!(err instanceof StageRuleError)) throw err;
        }
      }
      return { found, order: made.order, events: await listBackofficeOrderEvents(tx, ctx, [made.order.id]) };
    });
    if (out === null) throw new AppError(404, MESSAGES.notFound);
    const zone = await timeZoneOf(ctx);
    res.status(201).json(toOrderView({ order: out.order, customerName: out.found.customerName, address: out.found.address }, out.events.get(out.order.id) ?? [], zone, now));
  });

  /* The house picture ---------------------------------------------------------------------------------------------- */

  const emptyVisual = (quoteId: string, updatedAt: Date): HouseVisual => ({ quoteId, photoUploadId: null, placements: [], updatedAt: updatedAt.toISOString() });
  const visualOf = (quoteId: string, stored: StoredHouseVisual | null, fallback: Date): HouseVisual =>
    stored === null ? emptyVisual(quoteId, fallback) : { quoteId, photoUploadId: stored.photo?.id ?? null, placements: stored.placements, updatedAt: stored.updatedAt };

  router.get('/quotes/:id/visual', async (req, res) => {
    const { quote } = await loadQuote(req.ctx, idParam(req.params.id));
    res.json(visualOf(quote.quote.id, quote.quote.houseVisual, quote.quote.updatedAt));
  });

  router.put('/quotes/:id/visual', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const parsed = VisualSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, VISUAL_MESSAGE, 'placements');
    const body = parsed.data;
    const now = clock.now();
    const saved = await withTenant(pools, ctx, async (tx) => {
      const found = await getBackofficeQuote(tx, ctx, id);
      if (found === null) return null;
      const designIds = new Set(found.quote.designs.map((d) => d.id));
      if (!body.placements.every((p) => designIds.has(p.designId)) || new Set(body.placements.map((p) => p.id)).size !== body.placements.length) throw new AppError(400, VISUAL_MESSAGE, 'placements');
      const before = found.quote.houseVisual;
      let photo: StoredHouseVisual['photo'] = null;
      if (body.photoUploadId !== null) {
        const wanted = body.photoUploadId.toLowerCase();
        if (before?.photo?.id === wanted) photo = before.photo;
        else {
          // A photo already uploaded for this address (the same store as the window photos).
          const upload = (await windowUploadsForProperty(tx, ctx, found.propertyId)).find((u) => u.id === wanted);
          if (upload === undefined) throw new AppError(400, VISUAL_MESSAGE, 'photoUploadId');
          photo = { id: upload.id, key: upload.key, kind: upload.kind, widthPx: upload.widthPx, heightPx: upload.heightPx, bytes: upload.bytes };
        }
      }
      const stored: StoredHouseVisual = { photo, placements: body.placements, updatedAt: now.toISOString() };
      await setBackofficeQuoteVisual(tx, ctx, id, stored, now);
      return { stored, dropped: before?.photo && before.photo.id !== photo?.id ? before.photo : null };
    });
    if (saved === null) throw new AppError(404, MESSAGES.notFound);
    // A photo uploaded for this picture and replaced or cleared is removed; one that belongs to a window measurement stays.
    if (saved.dropped?.key.includes(`/${VISUAL_PHOTO_PREFIX}/`)) await deps.objectStore.delete(saved.dropped.key).catch((err: unknown) => deps.logError?.(err, 'backoffice-visual-delete'));
    res.json(visualOf(id, saved.stored, now));
  });

  // The photo: multipart field "photo" (or the raw bytes), JPEG or PNG, at most 12 MB, checked by its bytes (the window photo rules).
  router.post('/quotes/:id/visual/photo', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const { quote } = await loadQuote(ctx, id);
    const bytes = await readUpload(req);
    const info = await readImageInfo(bytes);
    if (info === 'heic') throw new AppError(415, HEIC_MESSAGE, 'photo');
    if (info === null) throw new AppError(415, PHOTO_TYPE, 'photo');
    if (!deps.objectStore.configured) throw new AppError(503, STORAGE_DOWN);
    const uploadId = randomUUID();
    const key = `${ctx.companyId}/${VISUAL_PHOTO_PREFIX}/${uploadId}.${info.kind === 'jpeg' ? 'jpg' : 'png'}`;
    await deps.objectStore.put(key, bytes, `image/${info.kind}`);
    const now = clock.now();
    const before = quote.quote.houseVisual;
    const stored: StoredHouseVisual = { photo: { id: uploadId, key, kind: info.kind, widthPx: info.widthPx, heightPx: info.heightPx, bytes: bytes.length }, placements: before?.placements ?? [], updatedAt: now.toISOString() };
    const ok = await withTenant(pools, ctx, (tx) => setBackofficeQuoteVisual(tx, ctx, id, stored, now));
    if (!ok) {
      await deps.objectStore.delete(key).catch((err: unknown) => deps.logError?.(err, 'backoffice-visual-delete'));
      throw new AppError(404, MESSAGES.notFound);
    }
    if (before?.photo?.key.includes(`/${VISUAL_PHOTO_PREFIX}/`)) await deps.objectStore.delete(before.photo.key).catch((err: unknown) => deps.logError?.(err, 'backoffice-visual-delete'));
    res.status(201).json({ id: uploadId, widthPx: info.widthPx, heightPx: info.heightPx });
  });

  router.get('/quotes/:id/visual/photo', async (req, res) => {
    const { quote } = await loadQuote(req.ctx, idParam(req.params.id));
    const photo = quote.quote.houseVisual?.photo;
    if (!photo) throw new AppError(404, NO_PHOTO);
    const bytes = await deps.objectStore.get(photo.key);
    if (bytes === null) throw new AppError(404, NO_PHOTO);
    res.set('Content-Type', `image/${photo.kind}`);
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(Buffer.from(bytes));
  });

  /* Documents ------------------------------------------------------------------------------------------------------ */

  router.get('/quotes/:id/documents/:kind', async (req, res) => {
    const { ctx } = req;
    const kind = req.params.kind as QuoteDocument;
    if (!QUOTE_DOCUMENTS.includes(kind)) throw new AppError(404, MESSAGES.notFound);
    const { quote, catalog } = await loadQuote(ctx, idParam(req.params.id));
    const extra = await withTenant(pools, ctx, async (tx) => {
      const [company] = await tx
        .select({ name: companies.name, phone: companies.phoneE164, email: companies.email, website: companies.website, street: companies.addressStreet, city: companies.addressCity, state: companies.addressState, zip: companies.addressZip, zone: companies.timezone })
        .from(companies)
        .where(eq(companies.id, ctx.companyId))
        .limit(1);
      const [customer] = await tx.select({ phones: customers.phones }).from(customers).where(and(eq(customers.id, quote.customerId), eq(customers.companyId, ctx.companyId))).limit(1);
      const order = quote.orderId === null ? null : await getBackofficeOrder(tx, ctx, quote.orderId);
      return { company, customer, order };
    });
    const company = extra.company;
    const phone = extra.customer?.phones.find((p) => p.primary === true)?.e164 ?? extra.customer?.phones[0]?.e164 ?? null;
    const view = toQuoteView(quote, catalog);
    const doc = renderDocument({
      kind,
      company: {
        name: company?.name ?? '',
        phone: company?.phone ?? null,
        email: company?.email ?? null,
        website: company?.website ?? null,
        address: [company?.street, company?.city, [company?.state, company?.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null,
      },
      customer: { name: quote.customerName, phone },
      address: quote.address,
      view,
      catalog: catalogFor(quote, catalog),
      order: extra.order === null ? null : { id: extra.order.order.id, stage: extra.order.order.stage },
      timeZone: company?.zone !== undefined && isTimeZone(company.zone) ? company.zone : 'UTC',
      generatedAt: clock.now(),
    });
    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${kind}-${referenceOf({ view, order: extra.order === null ? null : { id: extra.order.order.id } })}.pdf"`);
    doc.pipe(res);
  });

  /* Orders --------------------------------------------------------------------------------------------------------- */

  router.get('/orders', async (req, res) => {
    const { ctx } = req;
    const stage = typeof req.query.stage === 'string' ? req.query.stage : undefined;
    if (stage !== undefined && !(ORDER_STAGES as readonly string[]).includes(stage)) throw new AppError(400, MESSAGES.checkField, 'stage');
    const zone = await timeZoneOf(ctx);
    const now = clock.now();
    const { list, events } = await withTenant(pools, ctx, async (tx) => {
      const rows = await listBackofficeOrders(tx, ctx, stage !== undefined ? { stage: stage as OrderStage } : {});
      return { list: rows, events: await listBackofficeOrderEvents(tx, ctx, rows.map((r) => r.order.id)) };
    });
    res.json(list.map((o) => toOrderView(o, events.get(o.order.id) ?? [], zone, now)));
  });

  router.get('/orders/:id', async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const zone = await timeZoneOf(ctx);
    const found = await withTenant(pools, ctx, async (tx) => {
      const o = await getBackofficeOrder(tx, ctx, id);
      return o === null ? null : { o, events: await listBackofficeOrderEvents(tx, ctx, [id]) };
    });
    if (found === null) throw new AppError(404, MESSAGES.notFound);
    res.json(toOrderView(found.o, found.events.get(id) ?? [], zone, clock.now()));
  });

  router.patch('/orders/:id/stage', manage, async (req, res) => {
    const { ctx } = req;
    const id = idParam(req.params.id);
    const move = parse(StageMoveSchema, req.body);
    const now = clock.now();
    const moved = await withTenant(pools, ctx, async (tx) => {
      const result = await moveBackofficeOrder(tx, ctx, id, { stage: move.stage, note: move.note.trim(), plannedFor: move.plannedFor }, now);
      if (result === null) return null;
      const order = await getBackofficeOrder(tx, ctx, id);
      // The job follows the order to installed (the pipeline only allows it from won; a job elsewhere stays where it is).
      if (order !== null && (move.stage === 'installed' || move.stage === 'complete')) {
        const job = await getJob(tx, ctx, result.order.jobId);
        if (job !== null && job.stage === 'won') await updateJob(tx, ctx, job.id, { stage: 'installed' }, { now });
      }
      const settings = await getBackofficeSettings(tx, ctx);
      return { result, customerId: order!.customerId, template: settings.templates.find((t) => t.stage === move.stage) };
    });
    if (moved === null) throw new AppError(404, MESSAGES.notFound);
    if (move.notify) {
      const event: BackofficeOrderEventRow = moved.result.event;
      const notified = await notifyOrderMove(deps, ctx, { orderId: id, eventId: event.id, customerId: moved.customerId, plannedFor: move.plannedFor, template: moved.template });
      await withTenant(pools, ctx, (tx) => setOrderEventNotified(tx, ctx, event.id, notified));
    }
    const zone = await timeZoneOf(ctx);
    const out = await withTenant(pools, ctx, async (tx) => {
      const o = await getBackofficeOrder(tx, ctx, id);
      return o === null ? null : { o, events: await listBackofficeOrderEvents(tx, ctx, [id]) };
    });
    if (out === null) throw new AppError(404, MESSAGES.notFound);
    res.json(toOrderView(out.o, out.events.get(id) ?? [], zone, now));
  });

  return router;
}
