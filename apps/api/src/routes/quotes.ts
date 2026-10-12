import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import {
  companies,
  copyQuote,
  createQuote,
  finalizeQuote,
  getCustomer,
  getJob,
  getPricebook,
  getProperty,
  getQuote,
  listQuoteSummaries,
  QuoteJobNotFoundError,
  type TenantContext,
  type Tx,
  updateQuote,
  withTenant,
} from '@roofline/db';
import {
  defaultScope,
  isTimeZone,
  type QuoteDefaults,
  type QuoteMeasurement,
  type QuoteView,
  type Scope,
  scopeSchema,
} from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { type QuotePdfInput, renderQuotePdf } from '../quotes/pdf.ts';
import { assertKnownFields, noNul, parse, UUID } from '../validate.ts';

/** Used only when the company's stored zone is missing or not a real zone. */
const FALLBACK_TIME_ZONE = 'America/Chicago';

const FINAL_MESSAGE = 'This quote is final. Copy it to make changes.';
const MEASUREMENT_MESSAGE = 'Please enter the roof measurement.';
const AREA_MESSAGE = 'Please enter the roof area in square feet, from 1 to 100,000.';
const AREA_TYPE_MESSAGE = 'Pick whether the area is the roof surface or the footprint.';
const PITCH_MESSAGE = 'Please enter a pitch from 0 to 24.';
const MEASUREMENT_NOTES_MESSAGE = 'Please keep the measurement notes to 2000 characters or fewer.';
const NOTES_MESSAGE = 'Please keep the notes to 5000 characters or fewer.';
const REFRESH_MESSAGE = 'Please choose whether to refresh the prices.';

const MAX_AREA_SQ_FT = 100000;

/** A note: trimmed, empty means none, no NUL characters, at most `max` characters. */
const noteField = (max: number, message: string) =>
  z
    .string({ error: MESSAGES.checkField })
    .trim()
    .max(max, message)
    .refine(noNul, MESSAGES.checkField)
    .transform((v) => (v === '' ? null : v));

/** The measurement a rep or owner types in. Only manual measurements exist in v1. */
const MeasurementBody = z
  .object(
    {
      source: z.literal('manual', { error: MEASUREMENT_MESSAGE }).default('manual'),
      areaSqFt: z
        .number({ error: AREA_MESSAGE })
        .finite(AREA_MESSAGE)
        .gt(0, AREA_MESSAGE)
        .max(MAX_AREA_SQ_FT, AREA_MESSAGE),
      areaType: z.enum(['surface', 'footprint'], { error: AREA_TYPE_MESSAGE }),
      pitch: z.number({ error: PITCH_MESSAGE }).finite(PITCH_MESSAGE).min(0, PITCH_MESSAGE).max(24, PITCH_MESSAGE),
      notes: noteField(2000, MEASUREMENT_NOTES_MESSAGE)
        .nullish()
        .transform((v) => v ?? null),
    },
    { error: MEASUREMENT_MESSAGE },
  )
  .strict();

/** Scope overrides on create: any subset of the scope, checked by the shared schema. */
const ScopePatch = scopeSchema.partial().strict();

/** A scope sent on PATCH replaces the whole scope, so every field must be there. */
const ScopeFull = scopeSchema.strict();

const CREATE_FIELDS = ['measurement', 'scope', 'notes'] as const;
const PATCH_FIELDS = ['measurement', 'scope', 'notes', 'refreshPrices'] as const;

const CreateBody = z.object({
  measurement: MeasurementBody,
  scope: ScopePatch.optional(),
  notes: noteField(5000, NOTES_MESSAGE).nullish(),
});

const PatchBody = z.object({
  measurement: MeasurementBody.optional(),
  scope: ScopeFull.optional(),
  notes: noteField(5000, NOTES_MESSAGE).nullish(),
  refreshPrices: z.boolean({ error: REFRESH_MESSAGE }).optional(),
});

/** `:id` as a lowercase UUID; anything else cannot be a job or quote, so it is a 404 like a missing one. */
function idParam(raw: unknown): string {
  const id = (typeof raw === 'string' ? raw : '').toLowerCase();
  if (!UUID.test(id)) throw new AppError(404, MESSAGES.notFound);
  return id;
}

/**
 * The route params of a request. A router mounted at `/` has no typed params of its own; the parent
 * mount (`/api/jobs/:jobId/quotes`) supplies them through mergeParams.
 */
const paramsOf = (req: { params: unknown }): Record<string, unknown> => req.params as Record<string, unknown>;

/** The non-empty parts joined with `sep`; an empty list is an empty string. */
function joinPresent(parts: ReadonlyArray<string | null | undefined>, sep: string): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(sep);
}

/** The company's time zone, read inside the tenant transaction; the fallback covers a missing or unknown zone. */
async function companyZone(tx: Tx, ctx: TenantContext): Promise<string> {
  const [row] = await tx
    .select({ timezone: companies.timezone })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  return row && isTimeZone(row.timezone) ? row.timezone : FALLBACK_TIME_ZONE;
}

/**
 * The scope a new quote is priced on: v1's default roof, the company's quote defaults (waste,
 * markup, tax, material), any scope the caller gave, and then the measurement's area, type and pitch,
 * which always win. The result is checked against the full shared schema.
 */
function fullScope(defaults: QuoteDefaults, given: Partial<Scope> | undefined, measurement: QuoteMeasurement): Scope {
  return parse(scopeSchema, {
    ...defaultScope,
    ...defaults,
    ...(given ?? {}),
    areaSqFt: measurement.areaSqFt,
    areaType: measurement.areaType,
    pitch: measurement.pitch,
  });
}

/** A missing quote or job is a 404; a final quote refused an edit is a 409; anything else is the quote. */
function found(view: QuoteView | null): QuoteView {
  if (!view) throw new AppError(404, MESSAGES.notFound);
  return view;
}

function settled(result: QuoteView | 'final' | null): QuoteView {
  if (result === 'final') throw new AppError(409, FINAL_MESSAGE);
  return found(result);
}

/**
 * `/api/jobs/:jobId/quotes` (mounted with mergeParams): a job's quotes, and a new one.
 * - Visibility is the job's: a job the member cannot see is a 404 here, the same as a missing one.
 * - A new quote starts as a draft, numbered for the company, priced on the company's pricebook, and
 *   leaves a line on the job.
 */
export function jobQuoteRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router({ mergeParams: true });

  router.get('/', async (req, res) => {
    const { ctx } = req;
    const jobId = idParam(paramsOf(req).jobId);
    const quotes = await withTenant(pools, ctx, async (tx) => {
      if (!(await getJob(tx, ctx, jobId))) return null;
      return listQuoteSummaries(tx, ctx, jobId);
    });
    if (!quotes) throw new AppError(404, MESSAGES.notFound);
    res.json({ quotes });
  });

  router.post('/', async (req, res) => {
    const { ctx } = req;
    const jobId = idParam(paramsOf(req).jobId);
    const body = parse(CreateBody, assertKnownFields(req.body, CREATE_FIELDS, { allowEmpty: true }));
    const now = clock.now();

    const view = await withTenant(pools, ctx, async (tx) => {
      const pricebook = await getPricebook(tx, ctx);
      const scope = fullScope(pricebook.defaults, body.scope, body.measurement);
      const timeZone = await companyZone(tx, ctx);
      return createQuote(tx, ctx, { jobId, measurement: body.measurement, scope, notes: body.notes ?? null }, now, timeZone);
    }).catch((err: unknown) => {
      if (err instanceof QuoteJobNotFoundError) return null;
      throw err;
    });
    if (!view) throw new AppError(404, MESSAGES.notFound);
    res.status(201).json(view);
  });

  return router;
}

/**
 * `/api/quotes/:id` (mounted with mergeParams): read, edit a draft, finalize, copy, and the estimate
 * PDF (`GET /:id/pdf`).
 * - A final quote never changes: an edit is a 409, and copying it makes a new draft at today's prices.
 * - Finalizing sets the job's value when the job has none, and leaves a set value alone.
 * - The PDF is visible exactly when the quote is: a missing quote, job, customer or address, or a
 *   quote outside the member's scope, is a 404. It is streamed as an attachment.
 */
export function quoteRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router({ mergeParams: true });

  router.get('/:id', async (req, res) => {
    const { ctx } = req;
    const id = idParam(paramsOf(req).id);
    const view = await withTenant(pools, ctx, (tx) => getQuote(tx, ctx, id));
    res.json(found(view));
  });

  router.patch('/:id', async (req, res) => {
    const { ctx } = req;
    const id = idParam(paramsOf(req).id);
    const body = parse(PatchBody, assertKnownFields(req.body, PATCH_FIELDS));
    const now = clock.now();
    const patch = {
      ...(body.measurement !== undefined && { measurement: body.measurement }),
      ...(body.scope !== undefined && { scope: body.scope }),
      ...(body.notes !== undefined && { notes: body.notes }),
      ...(body.refreshPrices !== undefined && { refreshPrices: body.refreshPrices }),
    };
    const result = await withTenant(pools, ctx, (tx) => updateQuote(tx, ctx, id, patch, now));
    res.json(settled(result));
  });

  router.post('/:id/finalize', async (req, res) => {
    const { ctx } = req;
    const id = idParam(paramsOf(req).id);
    const now = clock.now();
    const result = await withTenant(pools, ctx, (tx) => finalizeQuote(tx, ctx, id, now));
    res.json(settled(result));
  });

  router.get('/:id/pdf', async (req, res) => {
    const { ctx } = req;
    const id = idParam(paramsOf(req).id);
    const input = await withTenant(pools, ctx, async (tx): Promise<QuotePdfInput | null> => {
      const quote = await getQuote(tx, ctx, id);
      if (!quote) return null;
      const job = await getJob(tx, ctx, quote.jobId);
      if (!job) return null;
      const customer = await getCustomer(tx, ctx, job.customerId);
      const property = await getProperty(tx, ctx, job.propertyId);
      if (!customer || !property) return null;
      const [company] = await tx
        .select({
          name: companies.name,
          phoneE164: companies.phoneE164,
          email: companies.email,
          website: companies.website,
          addressStreet: companies.addressStreet,
          addressCity: companies.addressCity,
          addressState: companies.addressState,
          addressZip: companies.addressZip,
        })
        .from(companies)
        .where(eq(companies.id, ctx.companyId))
        .limit(1);
      if (!company) return null;

      const cityLine = joinPresent(
        [company.addressCity, joinPresent([company.addressState, company.addressZip], ' ')],
        ', ',
      );
      const primaryPhone = customer.phones.find((p) => p.primary) ?? customer.phones[0];
      return {
        quote,
        company: {
          name: company.name,
          phone: company.phoneE164 ?? null,
          email: company.email ?? null,
          website: company.website ?? null,
          address: joinPresent([company.addressStreet, cityLine], ', ') || null,
        },
        customer: {
          name: customer.displayName,
          phone: primaryPhone?.e164 ?? null,
          email: customer.emails[0] ?? null,
        },
        address: `${property.addressLine}, ${property.city}, ${property.state} ${property.zip}`,
        timeZone: await companyZone(tx, ctx),
      };
    });
    if (!input) throw new AppError(404, MESSAGES.notFound);

    // Render before any header is sent, so a render failure still reaches the error handler as a clean error.
    const doc = renderQuotePdf(input);
    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${input.quote.number}-roofing-estimate.pdf"`);
    doc.pipe(res);
  });

  router.post('/:id/copy', async (req, res) => {
    const { ctx } = req;
    const id = idParam(paramsOf(req).id);
    const now = clock.now();
    const view = await withTenant(pools, ctx, async (tx) => {
      const timeZone = await companyZone(tx, ctx);
      return copyQuote(tx, ctx, id, now, timeZone);
    });
    res.status(201).json(found(view));
  });

  return router;
}
