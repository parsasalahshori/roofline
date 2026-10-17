import express, { Router, type Request, type RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { createQuoteRequest, getProperty, getQuoteEstimate, getWindowCatalog, quoteCompany, withTenant } from '@roofline/db';
import {
  type PublicQuoteConfig,
  type PublicQuoteEstimate,
  type PublicQuoteLeadResult,
  type PublicQuoteSlots,
  type PublicQuoteWindows,
  QUOTE_CONSENT_VERSION,
  QUOTE_LIMITS,
  homeownerProducts,
  QUOTE_PRODUCTS,
  publicFactsOf,
  QUOTE_WINDOW_COUNT,
  quoteConsentText,
  quoteTextConsentText,
  toE164,
  type QuoteProduct,
} from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { bookedTimes, bookVisit, HOUR_MS, offeredSlots, officeAlert, startFollowUp } from '../quote/booking.ts';
import { estimateForAddress, type StoredSatellite, windowsForCount } from '../quote/estimate.ts';
import { checkFormToken, issueFormToken, quoteIpHash, turnstileOn, verifyTurnstile } from '../quote/guards.ts';
import { publicRateLimit } from '../rate-limit.ts';
import { emailField, noNul, parse, UUID } from '../validate.ts';
import { policyUrls } from './policy-urls.ts';
import { isFilled, originGuard, pageFor, raw, route } from './quote-access.ts';

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

const BODY_LIMIT = '8kb';

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

/** Turnstile, when the server has it set up: a missing or bad token is a 403 the page can retry. */
async function requireHuman(deps: AppDeps, req: Request, token: unknown): Promise<void> {
  if (!turnstileOn(deps.config)) return;
  if (!(await verifyTurnstile(deps.config, token, req.ip ?? ''))) throw new AppError(403, VERIFY_MESSAGE);
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
      const catalog = await withTenant(deps.pools, ctx, (tx) => getWindowCatalog(tx, ctx));
      const body: PublicQuoteConfig = {
        slug: settings.slug!,
        companyName: company.name,
        logoUrl: company.logoUrl,
        accentColor: settings.accentColor,
        phone: company.phoneE164,
        products: homeownerProducts(settings.products),
        booking: settings.booking,
        consent: {
          version: QUOTE_CONSENT_VERSION,
          text: quoteConsentText(company.name),
          textingText: quoteTextConsentText(company.name),
          ...(({ privacy, terms }) => ({ privacyUrl: privacy, termsUrl: terms }))(policyUrls(deps.config, company.slug)),
        },
        turnstileSiteKey: turnstileOn(deps.config) ? deps.config.TURNSTILE_SITE_KEY! : null,
        homeownerApp: deps.config.HOMEOWNER_APP_URL === undefined ? null : { url: deps.config.HOMEOWNER_APP_URL, name: deps.config.HOMEOWNER_APP_NAME ?? 'WinChoice' },
        catalog: publicFactsOf(catalog),
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
      const { row, catalog } = await withTenant(deps.pools, ctx, async (tx) => ({ row: await getQuoteEstimate(tx, ctx, body.quoteId), catalog: await getWindowCatalog(tx, ctx) }));
      const answer = row === null ? null : windowsForCount(row, body.count, settings.rangePct, catalog.tiers);
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
      res.json((await offeredSlots(deps, ctx, null)) satisfies PublicQuoteSlots);
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
      const products = body.products.filter((p): p is QuoteProduct => homeownerProducts(settings.products).includes(p));
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
      const ownWindows = body.windowCount === undefined ? null : windowsForCount(estimate, body.windowCount, settings.rangePct, (await withTenant(deps.pools, ctx, (tx) => getWindowCatalog(tx, ctx))).tiers);
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
        const made = await bookVisit(deps, ctx, filed, new Date(body.slotId));
        booked = made === null ? null : { start: made.start, end: made.end };
        slotTaken = made === null;
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

/** For staff: why the roof was not priced from satellite images (the homeowner is only told the one sentence). */
function satelliteNote(r: { satellite?: StoredSatellite }, products: readonly QuoteProduct[]): string {
  const sat = r.satellite;
  if (sat === undefined || !products.includes('roof')) return '';
  const imagery = [sat.quality, sat.date].filter((x): x is string => x !== null).join(' ');
  return ` Roof not priced, satellite images unusable: ${sat.problems.join(', ')}${imagery === '' ? '' : ` (imagery ${imagery})`}. Measure the roof at the visit.`;
}

const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;

/**
 * What the homeowner was shown, in one plain line for the job's timeline (ranges only, as on the page). `own`: the
 * window count the homeowner set on the page, with its range, in place of the estimated one.
 */
export function shownSummary(
  r: { roof?: PublicQuoteEstimate['roof']; windows?: PublicQuoteWindows | null; satellite?: StoredSatellite },
  products: readonly QuoteProduct[], own: PublicQuoteWindows | null = null,
): string {
  const parts: string[] = [];
  if (products.includes('roof') && r.roof) parts.push(`Roof about ${r.roof.squares} squares, ${dollars(r.roof.range.lowCents)} to ${dollars(r.roof.range.highCents)}`);
  if (products.includes('windows') && r.windows) {
    const w = own ?? r.windows;
    const whose = own !== null && own.count !== r.windows.count ? ` (their count; we estimated ${r.windows.count})` : '';
    parts.push(`about ${w.count} windows${whose}, ${dollars(w.range.lowCents)} to ${dollars(w.range.highCents)}`);
  }
  const asked = `Asked about ${products.join(', ')}.`;
  const visit = (products.includes('gutters') ? ' Gutters are priced at the visit.' : '') + satelliteNote(r, products);
  return parts.length > 0 ? `${asked} Shown: ${parts.join('; ')}.${visit}` : `${asked} No estimate was shown; call them.${visit}`;
}
