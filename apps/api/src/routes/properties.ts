import { Router } from 'express';
import { z } from 'zod';
import {
  AddressHasJobsError,
  AddressNeedsCustomerError,
  createProperty,
  CustomerRequiredError,
  DuplicateAddressError,
  getProperty,
  type LngLat,
  listProperties,
  type PropertyRow,
  setPropertyArchived,
  UnknownCustomerError,
  updateProperty,
  withTenant,
} from '@roofline/db';
import { isTimeZone, type PropertyRecordResponse, type PropertyRecordView, type StreetImageView } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { type GeocodeResult, GeocoderUnavailableError } from '../providers/geocoder.ts';
import { PropertyDataUnavailableError } from '../providers/property-data.ts';
import {
  assertKnownFields,
  limitParam,
  noNul,
  offsetParam,
  parse,
  timeZoneField,
  TOO_LONG,
  UUID,
} from '../validate.ts';

const STREET_MESSAGE = 'Please enter the street address.';
const CITY_MESSAGE = 'Please enter the city.';
const STATE_MESSAGE = 'Please use the 2-letter state code.';
const ZIP_MESSAGE = 'Please enter a 5-digit ZIP code.';
const LATLNG_MESSAGE = 'Please give both latitude and longitude.';
const NO_CUSTOMER = "We couldn't find that customer.";
const SAVED_MESSAGE = 'This address is already saved.';
const PICK_CUSTOMER = 'Pick the customer for this address.';
const HAS_JOBS_MESSAGE = 'This address already has jobs for a different customer.';
const NEEDS_CUSTOMER_MESSAGE = 'This address has jobs, so it needs a customer.';
const NOT_LOCATED_MESSAGE = "We couldn't find that address. Check the street, city and state.";
const MAP_UNAVAILABLE_MESSAGE = "We couldn't reach the map service. Try again in a minute.";
const RECORDS_UNAVAILABLE_MESSAGE = "We couldn't reach the property records service. Try again in a minute.";

const FIRST_YEAR = 1800;

/** The fields of an address that can be sent, on create and on PATCH. Anything else is refused by name. */
const FIELDS = ['customerId', 'addressLine', 'city', 'state', 'zip', 'lat', 'lng', 'timezone', 'yearBuilt'] as const;

/** A street address needs at least one letter or digit: `#.,` is not an address, and would make an empty key. */
const hasLetterOrDigit = (value: string): boolean => /[\p{L}\p{N}]/u.test(value);

/**
 * The request schemas. They are built for a given "this year" (the app clock's), the latest year a
 * house can have been built, so the clock is not read here and tests can move it.
 */
function schemas(maxYear: number) {
  const yearMessage = `Please enter a year from ${FIRST_YEAR} to ${maxYear}.`;
  const customerId = z
    .string({ error: NO_CUSTOMER })
    .refine((v) => UUID.test(v), NO_CUSTOMER)
    .transform((v) => v.toLowerCase());
  const addressLine = z
    .string({ error: STREET_MESSAGE })
    .trim()
    .min(1, STREET_MESSAGE)
    .max(200, TOO_LONG)
    .refine(noNul, STREET_MESSAGE)
    .refine(hasLetterOrDigit, STREET_MESSAGE);
  const city = z.string({ error: CITY_MESSAGE }).trim().min(1, CITY_MESSAGE).max(100, TOO_LONG).refine(noNul, CITY_MESSAGE);
  const state = z
    .string({ error: STATE_MESSAGE })
    .trim()
    .regex(/^[a-z]{2}$/i, STATE_MESSAGE)
    .transform((v) => v.toUpperCase());
  const zip = z.string({ error: ZIP_MESSAGE }).trim().regex(/^\d{5}$/, ZIP_MESSAGE);
  const lat = z.number({ error: LATLNG_MESSAGE }).min(-90, LATLNG_MESSAGE).max(90, LATLNG_MESSAGE);
  const lng = z.number({ error: LATLNG_MESSAGE }).min(-180, LATLNG_MESSAGE).max(180, LATLNG_MESSAGE);
  const timezone = timeZoneField;
  const yearBuilt = z
    .number({ error: yearMessage })
    .int(yearMessage)
    .min(FIRST_YEAR, yearMessage)
    .max(maxYear, yearMessage);

  return {
    create: z.object({
      customerId: customerId.nullish(),
      addressLine,
      city,
      state,
      zip,
      lat: lat.nullish(),
      lng: lng.nullish(),
      timezone: timezone.optional(),
      yearBuilt: yearBuilt.nullish(),
    }),
    patch: z.object({
      customerId: customerId.nullish(),
      addressLine: addressLine.optional(),
      city: city.optional(),
      state: state.optional(),
      zip: zip.optional(),
      lat: lat.nullish(),
      lng: lng.nullish(),
      timezone: timezone.optional(),
      yearBuilt: yearBuilt.nullish(),
    }),
  };
}

const ListQuery = z.object({
  q: z
    .string({ error: MESSAGES.checkField })
    .max(100, 'Please search for 100 characters or fewer.')
    .refine(noNul, MESSAGES.checkField)
    .optional(),
  customerId: z
    .string({ error: MESSAGES.checkField })
    .refine((v) => UUID.test(v), MESSAGES.checkField)
    .transform((v) => v.toLowerCase())
    .optional(),
  limit: limitParam,
  offset: offsetParam,
  includeArchived: z
    .enum(['true', 'false'], { error: MESSAGES.checkField })
    .transform((v) => v === 'true')
    .optional(),
});

/**
 * `lat` and `lng` as the one point they make: both numbers → `[lng, lat]`; both null → null (no
 * location); neither sent → undefined (untouched). One without the other is refused, naming the
 * one that is missing.
 */
function locationOf(lat: number | null | undefined, lng: number | null | undefined): LngLat | null | undefined {
  if (lat === undefined && lng === undefined) return undefined;
  if (lat === undefined) throw new AppError(400, LATLNG_MESSAGE, 'lat');
  if (lng === undefined) throw new AppError(400, LATLNG_MESSAGE, 'lng');
  if (lat === null && lng === null) return null;
  if (lat === null) throw new AppError(400, LATLNG_MESSAGE, 'lat');
  if (lng === null) throw new AppError(400, LATLNG_MESSAGE, 'lng');
  return [lng, lat];
}

/** The address as the API shows it. */
function propertyBody(row: PropertyRow) {
  return {
    id: row.id,
    customerId: row.customerId,
    addressLine: row.addressLine,
    city: row.city,
    state: row.state,
    zip: row.zip,
    lat: row.geom?.[1] ?? null,
    lng: row.geom?.[0] ?? null,
    /** Null unless one was given for this address: texts then go by the company's zone. */
    timezone: row.timezone,
    yearBuilt: row.yearBuilt,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A place the geocoder found for an address: its point, and its time zone when the geocoder gave a real one. */
type Located = { location: LngLat; timezone: string | null };

/**
 * Looks an address up with the geocoder. Provider calls never run inside a transaction, so callers
 * invoke this before `withTenant` (or after it has returned). `notFound` when the geocoder has no
 * match; `unavailable` when it cannot be reached or is not set up.
 */
async function locate(
  deps: Pick<AppDeps, 'geocoder'>,
  line: string,
  city: string,
  state: string,
  zip: string,
): Promise<Located | 'notFound' | 'unavailable'> {
  let result: GeocodeResult | null;
  try {
    result = await deps.geocoder.geocode(`${line}, ${city}, ${state} ${zip}`);
  } catch (err) {
    if (err instanceof GeocoderUnavailableError) return 'unavailable';
    throw err;
  }
  if (result === null) return 'notFound';
  return {
    location: [result.lng, result.lat],
    timezone: result.timezone !== null && isTimeZone(result.timezone) ? result.timezone : null,
  };
}

/** What the repository's refusals mean to the caller. */
function refused(err: unknown): never {
  if (err instanceof DuplicateAddressError) throw new AppError(409, SAVED_MESSAGE, 'addressLine');
  if (err instanceof UnknownCustomerError) throw new AppError(400, NO_CUSTOMER, 'customerId');
  if (err instanceof CustomerRequiredError) throw new AppError(400, PICK_CUSTOMER, 'customerId');
  if (err instanceof AddressHasJobsError) throw new AppError(400, HAS_JOBS_MESSAGE, 'customerId');
  if (err instanceof AddressNeedsCustomerError) throw new AppError(400, NEEDS_CUSTOMER_MESSAGE, 'customerId');
  throw err;
}

/**
 * `/api/properties`: list and search, add, open, edit, archive and restore addresses.
 * - A new address without `lat`/`lng` is looked up with the geocoder before it is saved (outside
 *   the transaction). A found point, and its time zone when no zone was given, are saved with it;
 *   a miss or an unreachable geocoder saves the address with no point. `POST /:id/locate` tries
 *   again for an address that has none (400 when the geocoder cannot find it, 503 when unreachable).
 * - A company cannot save the same street address in the same ZIP twice, however it is written (409).
 * - Reps work with the addresses the visibility rule gives them (scope.ts); any other is a 404, and
 *   the repository applies that, so no route can forget it. A customer named in a body must be one
 *   the caller can see (400 on `customerId`). A rep must name one when adding an address, and cannot
 *   clear it later; owner and office may leave an address with no customer.
 * - An address cannot be given to a customer while it has live jobs for a different one, and cannot
 *   lose its customer while it has any job (400): an address with a job always has a customer
 *   (a new job claims an address nobody owns yet).
 * - Every edit is audited (before and after) and added to the address's timeline.
 * - `GET /:id/record` answers the home's public owner and parcel record and a street photo, live from the
 *   providers (nothing stored). Owner names are for the roofer to read: nothing texts or calls from them.
 * - An address saved without a time zone has none (`timezone: null`); the send gate then uses the
 *   company's zone as it is when the text goes out, so fixing the company's zone later applies to it.
 */
export function propertyRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  /** `:id` as a lowercase UUID; anything else cannot be an address, so it is a 404 like a missing one. */
  const propertyId = (raw: unknown): string => {
    const id = (typeof raw === 'string' ? raw : '').toLowerCase();
    if (!UUID.test(id)) throw new AppError(404, MESSAGES.notFound);
    return id;
  };

  router.get('/', async (req, res) => {
    const { ctx } = req;
    const query = parse(ListQuery, req.query);
    const result = await withTenant(pools, ctx, (tx) => listProperties(tx, ctx, query));
    res.json({ properties: result.properties.map(propertyBody), total: result.total });
  });

  router.post('/', async (req, res) => {
    const { ctx } = req;
    const now = clock.now();
    const body = parse(schemas(now.getUTCFullYear()).create, assertKnownFields(req.body, FIELDS, { allowEmpty: true }));
    const location = locationOf(body.lat, body.lng);
    // Only an address with no point of its own is looked up. A miss or an outage saves it with no point.
    const found = location === undefined ? await locate(deps, body.addressLine, body.city, body.state, body.zip) : undefined;
    const pin = found !== undefined && typeof found === 'object' ? found : undefined;
    const point = location !== undefined ? location : pin?.location;
    const timezone = body.timezone ?? pin?.timezone ?? undefined;

    const created = await withTenant(pools, ctx, (tx) =>
      createProperty(
        tx,
        ctx,
        {
          customerId: body.customerId ?? null,
          addressLine: body.addressLine,
          city: body.city,
          state: body.state,
          zip: body.zip,
          ...(point !== undefined && { location: point }),
          ...(timezone !== undefined && { timezone }),
          ...(body.yearBuilt !== undefined && { yearBuilt: body.yearBuilt }),
        },
        { now, ip: req.ip ?? null },
      ),
    ).catch(refused);
    res.status(201).json(propertyBody(created));
  });

  router.get('/:id', async (req, res) => {
    const { ctx } = req;
    const id = propertyId(req.params.id);
    const row = await withTenant(pools, ctx, (tx) => getProperty(tx, ctx, id));
    if (!row) throw new AppError(404, MESSAGES.notFound);
    res.json(propertyBody(row));
  });

  /*
   * The home's public owner and parcel record (providers/property-data.ts) and the nearest street photo
   * (providers/street-imagery.ts), fetched live each time: nothing is stored, and paid providers bill per
   * record, so the web asks only when a person opens the record. Anyone who can see the home may read it.
   * Provider calls run after the transaction. Not set up: `configured: false` and no record. A provider
   * outage is a 503; a missing street photo never fails the record.
   */
  router.get('/:id/record', async (req, res) => {
    const { ctx } = req;
    const id = propertyId(req.params.id);
    const row = await withTenant(pools, ctx, (tx) => getProperty(tx, ctx, id));
    if (!row) throw new AppError(404, MESSAGES.notFound);
    const point = row.geom ? { lng: row.geom[0], lat: row.geom[1] } : null;

    let record: PropertyRecordView | null = null;
    if (deps.propertyData.configured) {
      try {
        record = await deps.propertyData.lookup({
          point,
          address: { line: row.addressLine, city: row.city, state: row.state, zip: row.zip },
        });
      } catch (err) {
        if (err instanceof PropertyDataUnavailableError) throw new AppError(503, RECORDS_UNAVAILABLE_MESSAGE);
        throw err;
      }
    }

    let streetImage: StreetImageView | null = null;
    if (point !== null && deps.streetImagery.configured) {
      streetImage = await deps.streetImagery.nearest(point).catch((err: unknown) => {
        if (err instanceof PropertyDataUnavailableError) return null;
        throw err;
      });
    }

    const body: PropertyRecordResponse = { configured: deps.propertyData.configured, record, streetImage };
    res.json(body);
  });

  // Tries the geocoder again for an address that has no point. Anyone who may edit the address may do this.
  router.post('/:id/locate', async (req, res) => {
    const { ctx } = req;
    const id = propertyId(req.params.id);
    const row = await withTenant(pools, ctx, (tx) => getProperty(tx, ctx, id));
    if (!row) throw new AppError(404, MESSAGES.notFound);
    const found = await locate(deps, row.addressLine, row.city, row.state, row.zip);
    if (found === 'notFound') throw new AppError(400, NOT_LOCATED_MESSAGE, 'addressLine');
    if (found === 'unavailable') throw new AppError(503, MAP_UNAVAILABLE_MESSAGE);

    const updated = await withTenant(pools, ctx, (tx) =>
      updateProperty(
        tx,
        ctx,
        id,
        {
          location: found.location,
          ...(found.timezone !== null && row.timezone === null && { timezone: found.timezone }),
        },
        { now: clock.now(), ip: req.ip ?? null },
      ),
    );
    if (!updated) throw new AppError(404, MESSAGES.notFound);
    res.json({ located: true });
  });

  router.patch('/:id', async (req, res) => {
    const { ctx } = req;
    const id = propertyId(req.params.id);
    const now = clock.now();
    const body = parse(schemas(now.getUTCFullYear()).patch, assertKnownFields(req.body, FIELDS));
    const location = locationOf(body.lat, body.lng);

    const updated = await withTenant(pools, ctx, (tx) =>
      updateProperty(
        tx,
        ctx,
        id,
        {
          ...(body.customerId !== undefined && { customerId: body.customerId }),
          ...(body.addressLine !== undefined && { addressLine: body.addressLine }),
          ...(body.city !== undefined && { city: body.city }),
          ...(body.state !== undefined && { state: body.state }),
          ...(body.zip !== undefined && { zip: body.zip }),
          ...(location !== undefined && { location }),
          ...(body.timezone !== undefined && { timezone: body.timezone }),
          ...(body.yearBuilt !== undefined && { yearBuilt: body.yearBuilt }),
        },
        { now, ip: req.ip ?? null },
      ),
    ).catch(refused);
    if (!updated) throw new AppError(404, MESSAGES.notFound);
    res.json(propertyBody(updated));
  });

  for (const [action, archived] of [
    ['archive', true],
    ['unarchive', false],
  ] as const) {
    router.post(`/:id/${action}`, async (req, res) => {
      const { ctx } = req;
      const id = propertyId(req.params.id);
      const row = await withTenant(pools, ctx, (tx) =>
        setPropertyArchived(tx, ctx, id, archived, { now: clock.now(), ip: req.ip ?? null }),
      );
      if (!row) throw new AppError(404, MESSAGES.notFound);
      res.json(propertyBody(row));
    });
  }

  return router;
}
