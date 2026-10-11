import { Router } from 'express';
import { z } from 'zod';
import {
  createCustomer,
  type CustomerRow,
  DuplicatePhoneError,
  getCustomer,
  listCustomers,
  setArchived,
  type TenantContext,
  updateCustomer,
  withTenant,
} from '@roofline/db';
import { CONSENT_STATUSES, toE164 } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { assertKnownFields, emailField, limitParam, offsetParam, parse, UUID } from '../validate.ts';

const MAX_PHONES = 10;
const MAX_EMAILS = 10;
const MAX_TAGS = 20;

const NAME_MESSAGE = 'Please enter a name.';
const PHONE_MESSAGE = "That doesn't look like a US phone number.";
const TWICE_MESSAGE = 'This number is listed twice.';
const TAKEN_MESSAGE = 'Another customer already has this number.';
const TOO_LONG = 'That is too long.';
const ATTESTED_MESSAGE = 'That consent type can only come from a customer import.';
const NOTE_MESSAGE = 'A note can only be added when texting consent is set to OK for offers.';
const NOTE_TOO_LONG = 'Please keep the note to 500 characters or fewer.';

/** Postgres cannot store a NUL character in text; refusing it here keeps a stray one from becoming a 500. */
const noNul = (value: string): boolean => !value.includes('\0');

/** Optional text: trimmed, at most `max` characters; empty means "none". */
const optionalText = (max: number) =>
  z
    .string({ error: MESSAGES.checkField })
    .trim()
    .max(max, TOO_LONG)
    .refine(noNul, MESSAGES.checkField)
    .transform((v) => (v === '' ? null : v));

const PhoneEntry = z.object({
  // To E.164 right here, so the position of a bad number is reported by zod's own path (`phones.1.number`).
  number: z.string({ error: PHONE_MESSAGE }).transform((value, ctx) => {
    const e164 = toE164(value);
    if (e164 === null) {
      ctx.addIssue({ code: 'custom', message: PHONE_MESSAGE });
      return z.NEVER;
    }
    return e164;
  }),
  label: optionalText(40).optional(),
  primary: z.boolean({ error: MESSAGES.checkField }).optional(),
});

const Tag = z
  .string({ error: MESSAGES.checkField })
  .trim()
  .min(1, MESSAGES.checkField)
  .max(40, TOO_LONG)
  .refine(noNul, MESSAGES.checkField);

/** The shape of every customer field on create; PATCH makes each optional (and lets the optional ones be cleared). */
const Fields = {
  displayName: z.string({ error: NAME_MESSAGE }).trim().min(1, NAME_MESSAGE).max(200, TOO_LONG).refine(noNul, NAME_MESSAGE),
  firstName: optionalText(100),
  lastName: optionalText(100),
  phones: z.array(PhoneEntry).max(MAX_PHONES, `You can add up to ${MAX_PHONES} phone numbers.`),
  emails: z.array(emailField).max(MAX_EMAILS, `You can add up to ${MAX_EMAILS} email addresses.`),
  tags: z.array(Tag).max(MAX_TAGS, `You can add up to ${MAX_TAGS} tags.`),
  doNotContact: z.boolean({ error: MESSAGES.checkField }),
  // 'attested' is a real status but only a customer import may set it.
  smsConsentStatus: z
    .enum(CONSENT_STATUSES, { error: MESSAGES.checkField })
    .refine((status) => status !== 'attested', ATTESTED_MESSAGE),
  consentNote: z
    .string({ error: MESSAGES.checkField })
    .trim()
    .max(500, NOTE_TOO_LONG)
    .refine(noNul, MESSAGES.checkField)
    .transform((v) => (v === '' ? undefined : v)),
} as const;

const CreateBody = z.object({
  displayName: Fields.displayName,
  firstName: Fields.firstName.optional(),
  lastName: Fields.lastName.optional(),
  phones: Fields.phones.optional(),
  emails: Fields.emails.optional(),
  tags: Fields.tags.optional(),
  doNotContact: Fields.doNotContact.optional(),
  smsConsentStatus: Fields.smsConsentStatus.optional(),
  consentNote: Fields.consentNote.optional(),
});
const CREATE_FIELDS = Object.keys(CreateBody.shape);

const PatchBody = z.object({
  displayName: Fields.displayName,
  firstName: Fields.firstName.nullable(),
  lastName: Fields.lastName.nullable(),
  phones: Fields.phones,
  emails: Fields.emails,
  tags: Fields.tags,
  doNotContact: Fields.doNotContact,
  smsConsentStatus: Fields.smsConsentStatus,
  consentNote: Fields.consentNote,
});
const PATCH_FIELDS = Object.keys(PatchBody.shape);

/** Fields only the owner and the office may send (R16: consent and do-not-contact). */
const CONSENT_FIELDS = ['smsConsentStatus', 'doNotContact', 'consentNote'] as const;

const ListQuery = z.object({
  q: z
    .string({ error: MESSAGES.checkField })
    .max(100, 'Please search for 100 characters or fewer.')
    .refine(noNul, MESSAGES.checkField)
    .optional(),
  limit: limitParam,
  offset: offsetParam,
  includeArchived: z
    .enum(['true', 'false'], { error: MESSAGES.checkField })
    .transform((v) => v === 'true')
    .optional(),
});

/**
 * A rep may not send consent or do-not-contact fields at all: 403, before the body is checked, so a
 * rep learns nothing from the error. Owner and office may.
 */
function requireConsentRole(ctx: TenantContext, body: unknown): void {
  if (ctx.role === 'owner' || ctx.role === 'office') return;
  if (typeof body !== 'object' || body === null) return;
  if (CONSENT_FIELDS.some((field) => Object.hasOwn(body, field))) throw new AppError(403, MESSAGES.roleCannot);
}

/** A note belongs to the move to "OK for offers" and only to that. */
function checkNote(body: { smsConsentStatus?: string; consentNote?: string }): void {
  if (body.consentNote !== undefined && body.smsConsentStatus !== 'written') {
    throw new AppError(400, NOTE_MESSAGE, 'consentNote');
  }
}

type PhoneInput = z.output<typeof PhoneEntry>;

/**
 * The phones as they are stored: refuse the same number twice (written however; `phones.N.number`
 * names the later one), then fix the primary. None marked → the first; several marked → only the
 * first marked one.
 */
function storedPhones(list: PhoneInput[]) {
  const seen = new Set<string>();
  list.forEach((phone, index) => {
    if (seen.has(phone.number)) throw new AppError(400, TWICE_MESSAGE, `phones.${index}.number`);
    seen.add(phone.number);
  });
  const primaryIndex = Math.max(
    0,
    list.findIndex((phone) => phone.primary === true),
  );
  return list.map((phone, index) => ({
    e164: phone.number,
    ...(phone.label !== undefined && phone.label !== null && { label: phone.label }),
    primary: index === primaryIndex,
  }));
}

/** First occurrence wins; the lists keep their order. */
const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

/** The customer as the API shows it. */
function customerBody(row: CustomerRow) {
  return {
    id: row.id,
    displayName: row.displayName,
    firstName: row.firstName,
    lastName: row.lastName,
    phones: row.phones.map((phone) => ({ number: phone.e164, label: phone.label ?? null, primary: phone.primary === true })),
    emails: row.emails,
    tags: row.tags,
    doNotContact: row.doNotContact,
    smsConsent: { status: row.smsConsentStatus, source: row.smsConsentSource, at: row.smsConsentAt },
    source: row.source,
    createdByUserId: row.createdByUserId,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Another customer holds the number at `phones.<index>.number`: 409, naming it. */
function taken(err: unknown): never {
  if (err instanceof DuplicatePhoneError) throw new AppError(409, TAKEN_MESSAGE, `phones.${err.index}.number`);
  throw err;
}

/**
 * `/api/customers`: list and search, create, open, edit, archive and restore (R16).
 * - Reps work only with the customers they created; any other customer is a 404 (the repository
 *   applies that rule, so no route can forget it). Owner and office see all of the company's.
 * - `smsConsentStatus`, `doNotContact` and `consentNote` are owner/office only (403 for a rep).
 * - Every edit is audited (before and after) and added to the customer's timeline, in the same
 *   transaction as the change.
 */
export function customerRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  /** `:id` as a lowercase UUID; anything else cannot be a customer, so it is a 404 like a missing one. */
  const customerId = (raw: unknown): string => {
    const id = (typeof raw === 'string' ? raw : '').toLowerCase();
    if (!UUID.test(id)) throw new AppError(404, MESSAGES.notFound);
    return id;
  };

  router.get('/', async (req, res) => {
    const { ctx } = req;
    const query = parse(ListQuery, req.query);
    const result = await withTenant(pools, ctx, (tx) => listCustomers(tx, ctx, query));
    res.json({ customers: result.customers.map(customerBody), total: result.total });
  });

  router.post('/', async (req, res) => {
    const { ctx } = req;
    requireConsentRole(ctx, req.body);
    const body = parse(CreateBody, assertKnownFields(req.body, CREATE_FIELDS, { allowEmpty: true }));
    checkNote(body);
    const phones = storedPhones(body.phones ?? []);

    const created = await withTenant(pools, ctx, (tx) =>
      createCustomer(
        tx,
        ctx,
        {
          displayName: body.displayName,
          firstName: body.firstName ?? null,
          lastName: body.lastName ?? null,
          phones,
          emails: unique(body.emails ?? []),
          tags: unique(body.tags ?? []),
          ...(body.doNotContact !== undefined && { doNotContact: body.doNotContact }),
          ...(body.smsConsentStatus !== undefined && { smsConsentStatus: body.smsConsentStatus }),
          ...(body.consentNote !== undefined && { consentNote: body.consentNote }),
        },
        { now: clock.now(), ip: req.ip ?? null },
      ),
    ).catch(taken);
    res.status(201).json(customerBody(created));
  });

  router.get('/:id', async (req, res) => {
    const { ctx } = req;
    const id = customerId(req.params.id);
    const row = await withTenant(pools, ctx, (tx) => getCustomer(tx, ctx, id));
    if (!row) throw new AppError(404, MESSAGES.notFound);
    res.json(customerBody(row));
  });

  router.patch('/:id', async (req, res) => {
    const { ctx } = req;
    const id = customerId(req.params.id);
    requireConsentRole(ctx, req.body);
    const body = parse(PatchBody.partial(), assertKnownFields(req.body, PATCH_FIELDS));
    checkNote(body);
    const phones = body.phones === undefined ? undefined : storedPhones(body.phones);

    const updated = await withTenant(pools, ctx, (tx) =>
      updateCustomer(
        tx,
        ctx,
        id,
        {
          ...(body.displayName !== undefined && { displayName: body.displayName }),
          ...(body.firstName !== undefined && { firstName: body.firstName }),
          ...(body.lastName !== undefined && { lastName: body.lastName }),
          ...(phones !== undefined && { phones }),
          ...(body.emails !== undefined && { emails: unique(body.emails) }),
          ...(body.tags !== undefined && { tags: unique(body.tags) }),
          ...(body.doNotContact !== undefined && { doNotContact: body.doNotContact }),
          ...(body.smsConsentStatus !== undefined && { smsConsentStatus: body.smsConsentStatus }),
          ...(body.consentNote !== undefined && { consentNote: body.consentNote }),
        },
        { now: clock.now(), ip: req.ip ?? null },
      ),
    ).catch(taken);
    if (!updated) throw new AppError(404, MESSAGES.notFound);
    res.json(customerBody(updated));
  });

  for (const [action, archived] of [
    ['archive', true],
    ['unarchive', false],
  ] as const) {
    router.post(`/:id/${action}`, async (req, res) => {
      const { ctx } = req;
      const id = customerId(req.params.id);
      const row = await withTenant(pools, ctx, (tx) =>
        setArchived(tx, ctx, id, archived, { now: clock.now(), ip: req.ip ?? null }),
      ).catch(taken);
      if (!row) throw new AppError(404, MESSAGES.notFound);
      res.json(customerBody(row));
    });
  }

  return router;
}
