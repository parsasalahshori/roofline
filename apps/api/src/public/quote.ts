import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import {
  AppointmentLinkError,
  createAppointment,
  createQuoteRequest,
  g1AgentOn,
  getProperty,
  getQuoteEstimate,
  getQuoteSettings,
  JobLinkError,
  lockInspector,
  quoteCompany,
  quoteVisitTimes,
  setQuoteRequestAppointment,
  type TenantContext,
  withTenant,
  zoneDayAfter,
  zoneDayStart,
} from '@roofline/db';
import { companyForQuoteSlug } from '@roofline/db/system';
import {
  type InstantQuoteSettings,
  isTimeZone,
  localDate,
  MAX_AVAILABILITY_DAYS,
  type PublicQuoteConfig,
  type PublicQuoteEstimate,
  type PublicQuoteLeadResult,
  type PublicQuoteSlots,
  type PublicQuoteWindows,
  QUOTE_CONSENT_VERSION,
  QUOTE_LIMITS,
  QUOTE_PRODUCTS,
  QUOTE_SLUG_RE,
  QUOTE_WINDOW_COUNT,
  quoteConsentText,
  quoteTextConsentText,
  toE164,
  type QuoteProduct,
} from '@roofline/shared';
import { writeAgentNote } from '../agents/notes.ts';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { INSPECTION_MINUTES, openInspectionSlots, queueCalendarPush, zoneOf } from '../front-desk/tools/times.ts';
import { estimateForAddress, windowsForCount } from '../quote/estimate.ts';
import { checkFormToken, issueFormToken, quoteIpHash, turnstileOn, verifyTurnstile } from '../quote/guards.ts';
import { publicRateLimit } from '../rate-limit.ts';
import { emailField, noNul, parse, UUID } from '../validate.ts';
import { policyUrls } from './policy-urls.ts';

/*
 * The instant quote page's API, signed out, under /api/public/quote/:slug (the page is /q/:slug):
 *   GET  /:slug           the company's name, logo, colour, products, booking on/off and the consent text
 *   POST /:slug/estimate  { address } -> a quote id and price RANGES only (quote/estimate.ts)
 *   POST /:slug/windows   { quoteId, count } -> the windows range for the homeowner's own count (1 to 80)
 *   GET  /:slug/slots     the next open in-home visit times (from tomorrow), when the company offers booking
 *   POST /:slug/lead      the homeowner's details -> customer, address and Lead job, maybe a visit
 *
 * The slug is the only key: it is resolved through the system pool (app_system may read just the slug columns of
 * company_settings), then everything runs inside withTenant for that one company with a 'system' context, the way
 * the storm landing page files its requests. The router is mounted in app.ts ahead of blockCrossSiteMutations and
 * the /api session gate, and brings its own limits, body parser, Origin check and CORS (the company's allowed embed
 * origins). Nothing personal goes in a URL; the audit log gets ids and outcomes only (repos/instant-quote.ts).
 */

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const BODY_LIMIT = '8kb';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Per-IP limits (on top of the 60 a minute every /api/public route has). Per-IP limits need TRUST_PROXY set right. */
export const QUOTE_RATE_LIMITS = { estimatesPerIpPerHour: 10, leadsPerIpPerHour: 5, slotsPerIpPerHour: 60, windowsPerIpPerHour: 120 } as const;

/** The page's per-IP limits are hourly: the answer says so (the app's own "in a minute" would be wrong here). */
export const QUOTE_TOO_MANY = "That's a lot of tries from this connection. Please try again in an hour, or give us a call.";

const ADDRESS_MESSAGE = 'Please enter the address of the home.';
const FIRST_MESSAGE = 'Please enter your first name.';
const LAST_MESSAGE = 'Please enter your last name.';
const PHONE_MESSAGE = "That doesn't look like a US phone number.";
const ZIP_MESSAGE = 'Please enter a 5-digit ZIP code.';
const PRODUCTS_MESSAGE = 'Pick at least one service.';
const CONSENT_MESSAGE = 'Please check the box so we can call or email you.';
const RELOAD_MESSAGE = 'This page was updated. Please reload it and try again.';
const RETRY_MESSAGE = 'Please wait a moment and try again.';
const VERIFY_MESSAGE = "We couldn't confirm you're a person. Please try again.";
const QUOTE_MESSAGE = 'Please get your estimate again.';
const COUNT_MESSAGE = `Use ${QUOTE_WINDOW_COUNT.min} to ${QUOTE_WINDOW_COUNT.max} windows.`;

const name = (message: string) => z.string({ error: message }).trim().min(1, message).max(60, 'That name is too long.').refine(noNul, message);

const EstimateBody = z
  .object({
    address: z.string({ error: ADDRESS_MESSAGE }).trim().min(5, ADDRESS_MESSAGE).max(200, 'That address is too long.').refine(noNul, ADDRESS_MESSAGE),
    website: z.unknown().optional(),
    turnstileToken: z.string().max(2048).optional(),
  })
  .strict();

const LeadBody = z
  .object({
    quoteId: z.string({ error: QUOTE_MESSAGE }).regex(UUID, QUOTE_MESSAGE).transform((v) => v.toLowerCase()),
    firstName: name(FIRST_MESSAGE),
    lastName: name(LAST_MESSAGE),
    email: emailField,
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
    postalCode: z.string({ error: ZIP_MESSAGE }).trim().regex(/^\d{5}(?:-\d{4})?$/, ZIP_MESSAGE),
    products: z
      .array(z.enum(QUOTE_PRODUCTS, { error: PRODUCTS_MESSAGE }), { error: PRODUCTS_MESSAGE })
      .min(1, PRODUCTS_MESSAGE)
      .max(QUOTE_PRODUCTS.length, PRODUCTS_MESSAGE)
      .transform((list) => QUOTE_PRODUCTS.filter((p) => list.includes(p))),
    consent: z.literal(true, { error: CONSENT_MESSAGE }),
    /** The optional "text me" box. */
    textConsent: z.boolean({ error: MESSAGES.checkField }).optional(),
    /** The homeowner's own window count, when they changed it on the page. */
    windowCount: z.number({ error: COUNT_MESSAGE }).int(COUNT_MESSAGE).min(QUOTE_WINDOW_COUNT.min, COUNT_MESSAGE).max(QUOTE_WINDOW_COUNT.max, COUNT_MESSAGE).optional(),
    consentVersion: z.string({ error: RELOAD_MESSAGE }).max(40, RELOAD_MESSAGE),
    slotId: z.iso.datetime({ offset: true, error: MESSAGES.checkField }).optional(),
    formToken: z.string({ error: RETRY_MESSAGE }).max(100, RETRY_MESSAGE),
    website: z.unknown().optional(),
    turnstileToken: z.string().max(2048).optional(),
  })
  .strict();

const WindowsBody = z
  .object({
    quoteId: z.string({ error: QUOTE_MESSAGE }).regex(UUID, QUOTE_MESSAGE).transform((v) => v.toLowerCase()),
    count: z.number({ error: COUNT_MESSAGE }).int(COUNT_MESSAGE).min(QUOTE_WINDOW_COUNT.min, COUNT_MESSAGE).max(QUOTE_WINDOW_COUNT.max, COUNT_MESSAGE),
  })
  .strict();

/** A honeypot counts as filled when a bot has put anything in it. */
function isFilled(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  return value !== undefined && value !== null && value !== false;
}

/** The body as an object, for the honeypot check that runs before the schema. */
const raw = (req: Request): Record<string, unknown> =>
  typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};

const systemCtx = (companyId: string): TenantContext => ({ companyId, userId: null, role: 'system', canApproveSpend: false });

type Page = { ctx: TenantContext; settings: InstantQuoteSettings };

/** The page for `:slug`, or a 404 for an unknown, malformed or turned-off one (all look the same). */
async function pageFor(deps: AppDeps, slugParam: unknown): Promise<Page> {
  const slug = (typeof slugParam === 'string' ? slugParam : '').toLowerCase();
  if (!QUOTE_SLUG_RE.test(slug)) throw new AppError(404, MESSAGES.notFound);
  const company = await companyForQuoteSlug(deps.pools.system, slug);
  if (company === null) throw new AppError(404, MESSAGES.notFound);
  const ctx = systemCtx(company.companyId);
  const settings = await withTenant(deps.pools, ctx, (tx) => getQuoteSettings(tx, ctx));
  if (!settings.enabled) throw new AppError(404, MESSAGES.notFound);
  return { ctx, settings };
}

/** The slug in a request path relative to the mount (`/<slug>` or `/<slug>/...`). */
const slugOfPath = (path: string): string | undefined => /^\/([^/]+)/.exec(path)?.[1]?.toLowerCase();

/** The origins a browser may call this page's API from: the app itself and the company's embed origins. */
async function allowedOrigins(deps: AppDeps, path: string): Promise<Set<string>> {
  const allowed = new Set([deps.config.APP_ORIGIN]);
  const slug = slugOfPath(path);
  if (slug === undefined || !QUOTE_SLUG_RE.test(slug)) return allowed;
  const company = await companyForQuoteSlug(deps.pools.system, slug);
  if (company === null) return allowed;
  const ctx = systemCtx(company.companyId);
  const settings = await withTenant(deps.pools, ctx, (tx) => getQuoteSettings(tx, ctx));
  for (const o of settings.embedOrigins) allowed.add(o);
  return allowed;
}

/**
 * CORS and the Origin check together. A browser request from an allowed origin gets the CORS headers (no
 * credentials: the page never uses cookies); a mutation from any other origin is refused. A request with no Origin
 * (a script, a server) is not a cross-site browser request and passes to the limits and the bot checks.
 */
function originGuard(deps: AppDeps): RequestHandler {
  return (req, res, next) => {
    const origin = req.get('Origin');
    if (origin === undefined) {
      next();
      return;
    }
    allowedOrigins(deps, req.path).then((allowed) => {
      res.vary('Origin');
      if (allowed.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        if (req.method === 'OPTIONS') {
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
          res.setHeader('Access-Control-Max-Age', '600');
          res.status(204).end();
          return;
        }
        next();
        return;
      }
      if (SAFE_METHODS.has(req.method) && req.method !== 'OPTIONS') {
        next(); // a cross-site GET gets no CORS header, so the browser keeps the answer from the page
        return;
      }
      res.status(403).json({ error: MESSAGES.crossSite });
    }, next);
  };
}

function perIpLimit(scope: string, limit: number, windowMs = HOUR_MS): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `quote-${scope}:${ipKeyGenerator(req.ip ?? 'unknown')}`,
    handler: (_req, _res, next) => {
      next(new AppError(429, QUOTE_TOO_MANY));
    },
  });
}

const route = (fn: (req: Request, res: Response) => Promise<void>): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
};

/** Turnstile, when the server has it set up: a missing or bad token is a 403 the page can retry. */
async function requireHuman(deps: AppDeps, req: Request, token: unknown): Promise<void> {
  if (!turnstileOn(deps.config)) return;
  if (!(await verifyTurnstile(deps.config, token, req.ip ?? ''))) throw new AppError(403, VERIFY_MESSAGE);
}

/** The next open visit times, starts only (no inspector names). */
async function openSlots(deps: AppDeps, ctx: TenantContext, propertyId: string | null, from: Date, to: Date) {
  const now = deps.clock.now();
  return withTenant(deps.pools, ctx, (tx) => openInspectionSlots(tx, ctx, { from, to, propertyId, now }));
}

const MAX_SLOTS = 8;
const OFFER_DAYS = 10;

/** The earliest visit the page offers or books: midnight starting tomorrow in the company's zone (never same day). */
async function earliestVisit(deps: AppDeps, ctx: TenantContext, now: Date): Promise<Date> {
  const zone = await withTenant(deps.pools, ctx, (tx) => zoneOf(tx, ctx));
  const tz = isTimeZone(zone) ? zone : 'UTC';
  return zoneDayStart(zoneDayAfter(localDate(now, tz)), tz);
}

export function publicQuoteRoutes(deps: AppDeps): Router {
  const router = Router();
  router.use(publicRateLimit());
  router.use(originGuard(deps));
  router.use(express.json({ limit: BODY_LIMIT }));

  // Every answer is per request and personal to the homeowner's address: never cached, never indexed.
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    next();
  });

  router.get(
    '/:slug',
    route(async (req, res) => {
      const { ctx, settings } = await pageFor(deps, req.params.slug);
      const company = await withTenant(deps.pools, ctx, (tx) => quoteCompany(tx, ctx));
      if (company === null) throw new AppError(404, MESSAGES.notFound);
      const body: PublicQuoteConfig = {
        slug: settings.slug!,
        companyName: company.name,
        logoUrl: company.logoUrl,
        accentColor: settings.accentColor,
        phone: company.phoneE164,
        products: settings.products,
        booking: settings.booking,
        consent: {
          version: QUOTE_CONSENT_VERSION,
          text: quoteConsentText(company.name),
          textingText: quoteTextConsentText(company.name),
          ...(({ privacy, terms }) => ({ privacyUrl: privacy, termsUrl: terms }))(policyUrls(deps.config, company.slug)),
        },
        turnstileSiteKey: turnstileOn(deps.config) ? deps.config.TURNSTILE_SITE_KEY! : null,
      };
      res.json(body);
    }),
  );

  router.post(
    '/:slug/estimate',
    perIpLimit('estimate', QUOTE_RATE_LIMITS.estimatesPerIpPerHour),
    route(async (req, res) => {
      const { ctx, settings } = await pageFor(deps, req.params.slug);
      // A filled honeypot gets the same shape of answer with nothing measured and nothing stored.
      if (isFilled(raw(req).website)) {
        res.status(200).json({ quoteId: '00000000-0000-4000-8000-000000000000', status: 'fallback', address: '', roof: null, windows: null, gutters: null, outline: null, formToken: '' });
        return;
      }
      const body = parse(EstimateBody, req.body);
      await requireHuman(deps, req, body.turnstileToken);
      const ipHash = quoteIpHash(deps.config, req.ip ?? 'unknown', ctx.companyId);
      const estimate: PublicQuoteEstimate = await estimateForAddress(deps, ctx, settings, { address: body.address, ipHash });
      res.json({ ...estimate, formToken: issueFormToken(deps.config, estimate.quoteId, deps.clock.now()) });
    }),
  );

  router.post(
    '/:slug/windows',
    perIpLimit('windows', QUOTE_RATE_LIMITS.windowsPerIpPerHour),
    route(async (req, res) => {
      const { ctx, settings } = await pageFor(deps, req.params.slug);
      const body = parse(WindowsBody, req.body);
      const row = await withTenant(deps.pools, ctx, (tx) => getQuoteEstimate(tx, ctx, body.quoteId));
      const answer = row === null ? null : windowsForCount(row, body.count, settings.rangePct);
      // Another company's quote, one with no windows, or none at all: the same answer.
      if (answer === null) throw new AppError(404, QUOTE_MESSAGE);
      res.json(answer satisfies PublicQuoteWindows);
    }),
  );

  router.get(
    '/:slug/slots',
    perIpLimit('slots', QUOTE_RATE_LIMITS.slotsPerIpPerHour),
    route(async (req, res) => {
      const { ctx, settings } = await pageFor(deps, req.params.slug);
      if (!settings.booking) {
        res.json({ timeZone: 'UTC', slots: [] } satisfies PublicQuoteSlots);
        return;
      }
      const now = deps.clock.now();
      // From tomorrow: a same-day visit a couple of hours out is more than an inspector's day can take on unseen.
      const from = await earliestVisit(deps, ctx, now);
      const world = await openSlots(deps, ctx, null, from, new Date(from.getTime() + OFFER_DAYS * 24 * HOUR_MS));
      // Spread over the days: at most two a day (the earliest, then one at least three hours later), up to MAX_SLOTS.
      const perDay = new Map<string, Date[]>();
      const picked: typeof world.slots = [];
      for (const s of world.slots) {
        if (picked.length >= MAX_SLOTS) break;
        const day = s.start.toLocaleDateString('en-CA', { timeZone: isTimeZone(world.zone) ? world.zone : 'UTC' });
        const taken = perDay.get(day) ?? [];
        if (taken.length >= 2 || taken.some((t) => s.start.getTime() - t.getTime() < 3 * HOUR_MS)) continue;
        taken.push(s.start);
        perDay.set(day, taken);
        picked.push(s);
      }
      const slots = picked.map((s) => ({ id: s.start.toISOString(), start: s.start.toISOString(), end: s.end.toISOString() }));
      res.json({ timeZone: isTimeZone(world.zone) ? world.zone : 'UTC', slots } satisfies PublicQuoteSlots);
    }),
  );

  router.post(
    '/:slug/lead',
    perIpLimit('lead', QUOTE_RATE_LIMITS.leadsPerIpPerHour),
    route(async (req, res) => {
      const { ctx, settings } = await pageFor(deps, req.params.slug);
      if (isFilled(raw(req).website)) {
        res.status(201).json({ ok: true, booked: null } satisfies PublicQuoteLeadResult);
        return;
      }
      const body = parse(LeadBody, req.body);
      const now = deps.clock.now();
      const token = checkFormToken(deps.config, body.quoteId, body.formToken, now, QUOTE_LIMITS.minFillMs);
      if (token === 'too_fast') throw new AppError(422, RETRY_MESSAGE, 'formToken');
      if (token !== 'ok') throw new AppError(422, QUOTE_MESSAGE, 'formToken');
      if (body.consentVersion !== QUOTE_CONSENT_VERSION) throw new AppError(409, RELOAD_MESSAGE);
      await requireHuman(deps, req, body.turnstileToken);
      const products = body.products.filter((p): p is QuoteProduct => settings.products.includes(p));
      if (products.length === 0) throw new AppError(422, PRODUCTS_MESSAGE, 'products');

      const found = await withTenant(deps.pools, ctx, async (tx) => {
        const estimate = await getQuoteEstimate(tx, ctx, body.quoteId);
        if (estimate === null) return null;
        const home = estimate.propertyId === null ? null : await getProperty(tx, ctx, estimate.propertyId);
        const company = await quoteCompany(tx, ctx);
        return { estimate, home, company };
      });
      // Another company's quote id, or none: the same answer as a quote that never existed.
      if (found === null || found.company === null) throw new AppError(404, QUOTE_MESSAGE);
      const { estimate, home, company } = found;

      const property = home
        ? { addressLine: home.addressLine, city: home.city, state: home.state, zip: home.zip, location: home.geom ?? null, timezone: home.timezone ?? null }
        : // The address lookup was down when the estimate was asked for: the request is filed under the typed address.
          { addressLine: estimate.address.slice(0, 200), city: '', state: '', zip: body.postalCode.slice(0, 5), location: null, timezone: null };

      const result = estimate.result as Partial<PublicQuoteEstimate>;
      // The homeowner's own window count, priced the way the page priced it (the summary says it was theirs).
      const ownWindows = body.windowCount === undefined ? null : windowsForCount(estimate, body.windowCount, settings.rangePct);
      const ipHash = quoteIpHash(deps.config, req.ip ?? 'unknown', ctx.companyId);
      const filed = await withTenant(deps.pools, ctx, (tx) =>
        createQuoteRequest(tx, ctx, {
          name: `${body.firstName} ${body.lastName}`,
          firstName: body.firstName,
          lastName: body.lastName,
          email: body.email,
          phoneE164: body.phone,
          postalCode: body.postalCode,
          property,
          quoteEstimateId: estimate.id,
          products,
          consentText: quoteConsentText(company.name),
          consentVersion: QUOTE_CONSENT_VERSION,
          textConsentText: body.textConsent === true ? quoteTextConsentText(company.name) : null,
          ipHash,
          measurementId: estimate.measurementId,
          summary: shownSummary(result, products, ownWindows),
          now,
        }),
      );

      // A picked time is booked for a new request and for a repeat of one with no visit yet (a second send after a
      // first without a time, or a back button); a repeat of a booked request answers the visit already booked.
      let booked: PublicQuoteLeadResult['booked'] = null;
      let slotTaken = false;
      if (filed.appointmentId !== null) booked = await bookedTimes(deps, ctx, filed.appointmentId);
      if (booked === null && settings.booking && body.slotId !== undefined) {
        booked = await bookVisit(deps, ctx, filed, new Date(body.slotId));
        slotTaken = booked === null;
      }
      if (filed.created) {
        await officeAlert(deps, ctx, filed.jobId, { products, booked: booked !== null, priced: estimate.status === 'ready' });
        await startFollowUp(deps, ctx);
      }
      res.status(201).json({ ok: true, booked, ...(slotTaken && { slotTaken: true }) } satisfies PublicQuoteLeadResult);
    }),
  );

  return router;
}

const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;

/**
 * What the homeowner was shown, in one plain line for the job's timeline (ranges only, as on the page). `own`: the
 * window count the homeowner set on the page, with its range, in place of the estimated one.
 */
export function shownSummary(r: Partial<PublicQuoteEstimate>, products: readonly QuoteProduct[], own: PublicQuoteWindows | null = null): string {
  const parts: string[] = [];
  if (products.includes('roof') && r.roof) parts.push(`Roof about ${r.roof.squares} squares, ${dollars(r.roof.range.lowCents)} to ${dollars(r.roof.range.highCents)}`);
  if (products.includes('windows') && r.windows) {
    const w = own ?? r.windows;
    const whose = own !== null && own.count !== r.windows.count ? ` (their count; we estimated ${r.windows.count})` : '';
    parts.push(`about ${w.count} windows${whose}, ${dollars(w.range.lowCents)} to ${dollars(w.range.highCents)}`);
  }
  const asked = `Asked about ${products.join(', ')}.`;
  const visit = products.includes('gutters') ? ' Gutters are priced at the visit.' : '';
  return parts.length > 0 ? `${asked} Shown: ${parts.join('; ')}.${visit}` : `${asked} No estimate was shown; call them.${visit}`;
}

/** The start and end of a visit already booked for a request, or null when it is gone. */
async function bookedTimes(deps: AppDeps, ctx: TenantContext, appointmentId: string): Promise<{ start: string; end: string } | null> {
  const row = await withTenant(deps.pools, ctx, (tx) => quoteVisitTimes(tx, ctx, appointmentId));
  return row === null ? null : { start: row.startsAt.toISOString(), end: row.endsAt.toISOString() };
}

/**
 * The office's alert for a new request: a note on the AI feed of Home ("New instant quote request"), linked to the
 * job. With the job's next step (due today, on every owner's and office member's My Day until someone takes it) the
 * office sees each new lead the day it comes in. Ids and products only, no name, phone or address. Never fails
 * the request.
 */
async function officeAlert(deps: AppDeps, ctx: TenantContext, jobId: string, what: { products: QuoteProduct[]; booked: boolean; priced: boolean }): Promise<void> {
  try {
    const how = what.booked ? 'They booked a visit.' : what.priced ? 'They saw a price range; call them.' : 'No price was shown; call them.';
    await withTenant(deps.pools, ctx, (tx) =>
      writeAgentNote(
        tx,
        ctx,
        {
          agent: 'system',
          kind: 'instant_quote_lead',
          title: 'New instant quote request',
          summary: `Asked about ${what.products.join(', ')}. ${how}`,
          subjectType: 'job',
          subjectId: jobId,
          label: 'New request from the instant quote page',
        },
        deps.clock.now(),
      ),
    );
  } catch (err) {
    deps.logError?.(err, 'quote.office-alert');
  }
}

/**
 * Books the visit the homeowner picked, when it is still open and not before tomorrow: re-checked on fresh busy data
 * under the inspector's lock, then made through createAppointment (so the job moves to Inspection and the calendar
 * push runs, as for any booking); the job's rep becomes the inspector and the "Call the homeowner" next step goes.
 * Any free inspector of the company may get it (no routing by area: the settings page says so). A time taken
 * meanwhile, or any booking problem, leaves the request standing with no visit (null; the page says we will call).
 */
async function bookVisit(
  deps: AppDeps,
  ctx: TenantContext,
  filed: { requestId: string; customerId: string; jobId: string; propertyId: string },
  start: Date,
): Promise<{ start: string; end: string } | null> {
  const now = deps.clock.now();
  const earliest = await earliestVisit(deps, ctx, now);
  if (start.getTime() < earliest.getTime() || start.getTime() > now.getTime() + MAX_AVAILABILITY_DAYS * 24 * HOUR_MS) return null;
  const end = new Date(start.getTime() + INSPECTION_MINUTES * MINUTE_MS);
  // The slot search wants room round the visit (travel buffers), so it looks a few hours either side and matches the start.
  const from = new Date(start.getTime() - 3 * HOUR_MS);
  const to = new Date(end.getTime() + 3 * HOUR_MS);
  try {
    const made = await withTenant(deps.pools, ctx, async (tx) => {
      const before = await openInspectionSlots(tx, ctx, { from, to, propertyId: filed.propertyId, now });
      const open = before.slots.find((s) => s.start.getTime() === start.getTime());
      const inspector = open?.userIds[0];
      if (inspector === undefined) return null;
      await lockInspector(tx, ctx, inspector);
      const fresh = await openInspectionSlots(tx, ctx, { from, to, propertyId: filed.propertyId, now });
      if (!fresh.slots.some((s) => s.start.getTime() === start.getTime() && s.userIds.includes(inspector))) return null;
      const appt = await createAppointment(
        tx,
        ctx,
        {
          kind: 'inspection',
          jobId: filed.jobId,
          customerId: filed.customerId,
          propertyId: filed.propertyId,
          assignedUserId: inspector,
          startsAt: start,
          endsAt: end,
          notes: 'Booked by the homeowner on the instant quote page.',
        },
        now,
      );
      await setQuoteRequestAppointment(tx, ctx, { requestId: filed.requestId, appointmentId: appt.row.id, jobId: filed.jobId, inspectorId: inspector }, now);
      return appt;
    });
    if (made === null) return null;
    if (made.pushDue) await queueCalendarPush(deps, ctx.companyId, made.row.id);
    return { start: start.toISOString(), end: end.toISOString() };
  } catch (err) {
    if (err instanceof AppointmentLinkError || err instanceof JobLinkError) {
      deps.logError?.(err, 'quote.book');
      return null;
    }
    throw err;
  }
}

/**
 * Speed to lead: when the company's Follow-up agent is on, its run is asked for now (the same job "Run now" sends).
 * The agent decides what to do with the new lead under its own rules (consent, spacing, owner approval) and plans at
 * most once a day. Never fails the request.
 */
async function startFollowUp(deps: AppDeps, ctx: TenantContext): Promise<void> {
  try {
    const on = await withTenant(deps.pools, ctx, (tx) => g1AgentOn(tx, ctx, 'follow_up'));
    if (on) await deps.jobs.send('followup-daily', { companyId: ctx.companyId }, { singletonKey: `quote-lead:follow_up:${ctx.companyId}` });
  } catch (err) {
    deps.logError?.(err, 'quote.follow-up');
  }
}
