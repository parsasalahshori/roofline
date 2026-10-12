import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import {
  audit,
  companies,
  companyLocationFacts,
  companySettings,
  insertDefaultSettings,
  setCompanyLocation,
  setServiceAreaRadius,
  type TenantContext,
  type Tx,
  withTenant,
} from '@roofline/db';
import { toE164 } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import {
  ADDRESS_NOT_FOUND_MESSAGE,
  DEFAULT_SERVICE_AREA_MILES,
  locateAddress,
  SERVICE_AREA_CHOICES,
} from '../company/location.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { requireCapability } from '../permissions.ts';
import { assertKnownFields, EMAIL_MESSAGE, emailField, parse, timeZoneField, TOO_LONG } from '../validate.ts';

const MAX_TEXT = 200;
const MAX_URL = 2048;

const PHONE_MESSAGE = "That doesn't look like a US phone number.";
const WEBSITE_MESSAGE = 'Please enter a web address, like https://example.com.';
const LOGO_MESSAGE = 'Please enter the web address of the logo image, starting with https://.';
const STATE_MESSAGE = 'Please use the 2-letter state, like NE.';
const ZIP_MESSAGE = 'Please enter a ZIP code, like 68102.';

// The map and service-area messages (F3). They live here, not in errors.ts MESSAGES.
const ADDRESS_FIRST_MESSAGE = 'Please add your business address first.';
const MAP_DOWN_MESSAGE = "We couldn't reach the map service. Try again in a minute.";
const RADIUS_MESSAGE = 'Pick 10, 20, 40 or 60 miles.';
const NOT_ON_MAP_MESSAGE = 'Place your address on the map first.';

/**
 * `http(s)://host/...` as a string to store, or null when it is not one. A bare `acme.example` is
 * read as `https://acme.example`, since that is how people type their address. The scheme is
 * checked, so `javascript:` and `data:` links can never be saved and later rendered as a link.
 */
function webAddress(input: string, schemes: readonly string[]): string | null {
  const text = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (!schemes.includes(url.protocol) || !url.hostname.includes('.') || withScheme.length > MAX_URL) return null;
    return withScheme;
  } catch {
    return null;
  }
}

/** Optional text: trimmed, at most `max` characters, and empty (or null) means "clear it". */
const optionalText = (max: number) =>
  z
    .string({ error: MESSAGES.checkField })
    .trim()
    .max(max, TOO_LONG)
    .transform((v) => (v === '' ? null : v))
    .nullable();

/** Optional web address: empty (or null) means "clear it". */
const optionalAddress = (schemes: readonly string[], message: string) =>
  z
    .string({ error: message })
    .trim()
    .refine((v) => v === '' || webAddress(v, schemes) !== null, message)
    .transform((v) => (v === '' ? null : webAddress(v, schemes)))
    .nullable();

/**
 * What a company may change about itself. These are exactly the columns app_tenant may UPDATE
 * (minus the service area, which is drawn from the geocoded address in F3). Status, plan, slug,
 * trial and billing are not here: a field outside this list is refused, not ignored.
 */
const CompanyPatch = z.object({
  name: z
    .string({ error: 'Please enter your company name.' })
    .trim()
    .min(1, 'Please enter your company name.')
    .max(MAX_TEXT, 'That company name is too long.'),
  legalName: optionalText(MAX_TEXT),
  phone: z
    .string({ error: PHONE_MESSAGE })
    .trim()
    .refine((v) => v === '' || toE164(v) !== null, PHONE_MESSAGE)
    .transform((v) => (v === '' ? null : toE164(v)))
    .nullable(),
  email: z.union([z.null(), z.literal(''), emailField], { error: EMAIL_MESSAGE }).transform((v) => (v === '' ? null : v)),
  website: optionalAddress(['http:', 'https:'], WEBSITE_MESSAGE),
  addressStreet: optionalText(MAX_TEXT),
  addressCity: optionalText(100),
  addressState: z
    .string({ error: STATE_MESSAGE })
    .trim()
    .refine((v) => v === '' || /^[a-z]{2}$/i.test(v), STATE_MESSAGE)
    .transform((v) => (v === '' ? null : v.toUpperCase()))
    .nullable(),
  addressZip: z
    .string({ error: ZIP_MESSAGE })
    .trim()
    .refine((v) => v === '' || /^\d{5}(-\d{4})?$/.test(v), ZIP_MESSAGE)
    .transform((v) => (v === '' ? null : v))
    .nullable(),
  timezone: timeZoneField,
  logoUrl: optionalAddress(['https:'], LOGO_MESSAGE),
});
const COMPANY_FIELDS = Object.keys(CompanyPatch.shape);

type CompanyPatchValues = Partial<z.output<typeof CompanyPatch>>;

/** API field name → the companies column's property. Only `phone` is named differently. */
const COMPANY_COLUMN: Record<keyof z.output<typeof CompanyPatch>, keyof typeof companies.$inferInsert> = {
  name: 'name',
  legalName: 'legalName',
  phone: 'phoneE164',
  email: 'email',
  website: 'website',
  addressStreet: 'addressStreet',
  addressCity: 'addressCity',
  addressState: 'addressState',
  addressZip: 'addressZip',
  timezone: 'timezone',
  logoUrl: 'logoUrl',
};

/** The columns a member may read: never the billing ones (Stripe customer, plan). */
const COMPANY_READ = {
  id: companies.id,
  name: companies.name,
  slug: companies.slug,
  status: companies.status,
  legalName: companies.legalName,
  phone: companies.phoneE164,
  email: companies.email,
  website: companies.website,
  addressStreet: companies.addressStreet,
  addressCity: companies.addressCity,
  addressState: companies.addressState,
  addressZip: companies.addressZip,
  timezone: companies.timezone,
  logoUrl: companies.logoUrl,
} as const;

const MONEY_MESSAGE = 'Please enter an hourly rate between $0 and $1,000.';
const HAIL_MESSAGE = 'Please pick a hail size from 0.25 to 5 inches, in quarter-inch steps.';
const CAP_MESSAGE = "You can lower this, but it can't go above 2 a week.";
const APR_MESSAGE = 'Please enter an APR between 0% and 40%.';
const TERM_MESSAGE = 'Please enter a term between 6 and 240 months.';

const wholeNumber = (min: number, max: number, message: string) =>
  z.number({ error: message }).int(message).min(min, message).max(max, message);

/** What a company may set about how it works (spec 3.3). */
const SettingsPatch = z.object({
  hourlyRateCents: wholeNumber(0, 100_000, MONEY_MESSAGE),
  hailThresholdIn: z
    .number({ error: HAIL_MESSAGE })
    .min(0.25, HAIL_MESSAGE)
    .max(5, HAIL_MESSAGE)
    // Quarter-inch steps. Multiples of 0.25 are exact in binary, so this is not a rounding test.
    .refine((v) => Number.isInteger(v * 4), HAIL_MESSAGE),
  // The database also refuses anything outside 0-2 (a CHECK); this is the plain-English version.
  marketingCapPer7d: wholeNumber(0, 2, CAP_MESSAGE),
  // Null means the company does not offer financing.
  financingAprBps: wholeNumber(0, 4000, APR_MESSAGE).nullable(),
  financingTermMonths: wholeNumber(6, 240, TERM_MESSAGE).nullable(),
});
const SETTINGS_FIELDS = Object.keys(SettingsPatch.shape);

/** The service-area radius: one of the choices, and only a number (a text "20" is refused). */
const RadiusPatch = z.object({
  radiusMiles: z
    .number({ error: RADIUS_MESSAGE })
    .refine((v) => (SERVICE_AREA_CHOICES as readonly number[]).includes(v), RADIUS_MESSAGE),
});

const SETTINGS_READ = {
  id: companySettings.id,
  hourlyRateCents: companySettings.hourlyRateCents,
  hailThresholdIn: companySettings.hailThresholdIn,
  marketingCapPer7d: companySettings.marketingCapPer7d,
  financingAprBps: companySettings.financingAprBps,
  financingTermMonths: companySettings.financingTermMonths,
} as const;

/** The settings as the API shows them: everything but the row's own id. */
function settingsBody(row: { id: string } & Record<string, unknown>) {
  return pick(row, SETTINGS_FIELDS);
}

/** `body` with only the keys of `touched`, so an audit row records what the request was about. */
function pick<T extends Record<string, unknown>>(row: T, touched: readonly string[]): Partial<T> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => touched.includes(key))) as Partial<T>;
}

/**
 * `/api/company`: the company profile (any member can read it; only `company_admin` changes it),
 * `/api/company/settings` (`company_admin` for both), and the map: `/api/company/locate` (looks the
 * saved address up) and `/api/company/service-area` (`company_admin`). Every change is written
 * together with its audit row, before and after, in one transaction. The address lookup is a
 * network call, so it runs outside any transaction.
 */
export function companyRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  /** The company's profile, with where it stands on the map: `located` and the radius. */
  const loadCompany = async (tx: Tx, ctx: TenantContext, lock = false) => {
    const query = tx.select(COMPANY_READ).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
    const [row] = await (lock ? query.for('update') : query);
    if (!row) throw new AppError(404, MESSAGES.notFound);
    const facts = await companyLocationFacts(tx, ctx);
    return { ...row, located: facts.located, serviceAreaMiles: facts.serviceAreaMiles };
  };

  /** The company's settings row, made with the defaults if it is somehow missing. */
  const loadSettings = async (tx: Tx, companyId: string, lock = false) => {
    const select = () => {
      const query = tx.select(SETTINGS_READ).from(companySettings).where(eq(companySettings.companyId, companyId)).limit(1);
      return lock ? query.for('update') : query;
    };
    let [row] = await select();
    if (!row) {
      await insertDefaultSettings(tx, companyId);
      [row] = await select();
    }
    return row!;
  };

  router.get('/', async (req, res) => {
    res.json(await withTenant(pools, req.ctx, (tx) => loadCompany(tx, req.ctx)));
  });

  router.patch('/', requireCapability('company_admin'), async (req, res) => {
    const { ctx } = req;
    const changes: CompanyPatchValues = parse(
      CompanyPatch.partial(),
      assertKnownFields(req.body, COMPANY_FIELDS),
    );
    const touched = Object.keys(changes);
    const now = clock.now();

    const result = await withTenant(pools, ctx, async (tx) => {
      const before = await loadCompany(tx, ctx, true);
      const set = Object.fromEntries(touched.map((key) => [COMPANY_COLUMN[key as keyof CompanyPatchValues], changes[key as keyof CompanyPatchValues]]));
      await tx
        .update(companies)
        .set({ ...set, updatedAt: now })
        .where(eq(companies.id, ctx.companyId));
      const after = await loadCompany(tx, ctx);
      await audit(tx, ctx, {
        action: 'company.update',
        targetType: 'company',
        targetId: ctx.companyId,
        before: pick(before, touched),
        after: pick(after, touched),
        ip: req.ip ?? null,
        at: now,
      });
      return after;
    });
    res.json(result);
  });

  router.post('/locate', requireCapability('company_admin'), async (req, res) => {
    const { ctx } = req;
    const addressText = await withTenant(pools, ctx, async (tx) => (await companyLocationFacts(tx, ctx)).addressText);
    if (addressText === null) throw new AppError(400, ADDRESS_FIRST_MESSAGE, 'addressStreet');

    // No transaction is open here: the lookup is a network call and must not hold a connection.
    const outcome = await locateAddress(deps.geocoder, addressText);
    if (outcome.kind === 'not_found') throw new AppError(400, ADDRESS_NOT_FOUND_MESSAGE, 'addressStreet');
    if (outcome.kind === 'unavailable') throw new AppError(503, MAP_DOWN_MESSAGE);
    const { result } = outcome;

    const now = clock.now();
    await withTenant(pools, ctx, async (tx) => {
      // The typed address stays as it is; only the point, the time zone and the area change.
      const before = await loadCompany(tx, ctx, true);
      await setCompanyLocation(tx, ctx, {
        street: before.addressStreet,
        city: before.addressCity,
        state: before.addressState,
        zip: before.addressZip,
        timezone: result.timezone,
        point: { lng: result.lng, lat: result.lat },
        serviceAreaMiles: before.serviceAreaMiles ?? DEFAULT_SERVICE_AREA_MILES,
      });
      await audit(tx, ctx, {
        action: 'company.located',
        targetType: 'company',
        targetId: ctx.companyId,
        before: { located: before.located },
        after: { located: true },
        ip: req.ip ?? null,
        at: now,
      });
    });
    res.json({ located: true });
  });

  router.put('/service-area', requireCapability('company_admin'), async (req, res) => {
    const { ctx } = req;
    const { radiusMiles } = parse(RadiusPatch, assertKnownFields(req.body, ['radiusMiles'], { allowEmpty: true }));
    const now = clock.now();

    const result = await withTenant(pools, ctx, async (tx) => {
      const before = await loadCompany(tx, ctx, true);
      // False means there is no point yet; throwing rolls the transaction back.
      if (!(await setServiceAreaRadius(tx, ctx, radiusMiles))) throw new AppError(409, NOT_ON_MAP_MESSAGE);
      await audit(tx, ctx, {
        action: 'company.service_area',
        targetType: 'company',
        targetId: ctx.companyId,
        before: { radiusMiles: before.serviceAreaMiles },
        after: { radiusMiles },
        ip: req.ip ?? null,
        at: now,
      });
      return loadCompany(tx, ctx);
    });
    res.json(result);
  });

  router.get('/settings', requireCapability('company_admin'), async (req, res) => {
    res.json(settingsBody(await withTenant(pools, req.ctx, (tx) => loadSettings(tx, req.ctx.companyId))));
  });

  router.patch('/settings', requireCapability('company_admin'), async (req, res) => {
    const { ctx } = req;
    const changes = parse(SettingsPatch.partial(), assertKnownFields(req.body, SETTINGS_FIELDS));
    const touched = Object.keys(changes);
    const now = clock.now();

    const result = await withTenant(pools, ctx, async (tx) => {
      const before = await loadSettings(tx, ctx.companyId, true);
      await tx
        .update(companySettings)
        .set({ ...changes, updatedAt: now })
        .where(eq(companySettings.companyId, ctx.companyId));
      const after = await loadSettings(tx, ctx.companyId);
      await audit(tx, ctx, {
        action: 'settings.update',
        targetType: 'company_settings',
        targetId: before.id,
        before: pick(before, touched),
        after: pick(after, touched),
        ip: req.ip ?? null,
        at: now,
      });
      return after;
    });
    res.json(settingsBody(result));
  });

  return router;
}
