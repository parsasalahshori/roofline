import { createHmac, hkdfSync } from 'node:crypto';
import { countStormRequestsSince, createStormRequest, withTenant, type TenantContext } from '@roofline/db';
import { toE164 } from '@roofline/shared';
import { z } from 'zod';
import type { AppDeps } from '../app.ts';
import type { Config } from '../config.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { GeocoderUnavailableError } from '../providers/geocoder.ts';
import { STORM_CONSENT_TEXT, STORM_REQUEST_LIMITS } from './landing-copy.ts';

/*
 * The form never gives SMS consent and never sends a text (Ruling BF): it records the homeowner's ask
 * on the request, and consent becomes express only when a text from that phone replies YES
 * (confirmFormConsentByYes, called by the Twilio inbound hook).
 *
 * The storm landing page's request (POST /api/public/storm-requests/:code): the form body, the
 * honeypot, the page lookup and limits, the address lookup, and the write. The route itself is in
 * public/storm-requests.ts. Every message a person reads is a plain sentence defined here.
 */

const NAME_MESSAGE = 'Please enter your name.';
const NAME_TOO_LONG = 'That name is too long.';
const PHONE_MESSAGE = "That doesn't look like a US phone number.";
const ADDRESS_MESSAGE = 'Please enter the address of the home.';
const ADDRESS_TOO_LONG = 'That address is too long.';
const ADDRESS_NOT_FOUND = "We couldn't find that address. Please check it.";
const LOOKUP_DOWN = "We can't check addresses right now. Please try again in a few minutes.";

/** Short keys a no-JS form redirect carries in ?error=, each mapped to the sentence the page shows. */
export const STORM_FORM_ERRORS = {
  name: NAME_MESSAGE,
  nameLong: NAME_TOO_LONG,
  phone: PHONE_MESSAGE,
  address: ADDRESS_MESSAGE,
  addressLong: ADDRESS_TOO_LONG,
  addressNotFound: ADDRESS_NOT_FOUND,
  lookupDown: LOOKUP_DOWN,
  busy: MESSAGES.tooFast,
  invalid: MESSAGES.unreadable,
  check: MESSAGES.checkField,
} as const;
export type StormFormErrorKey = keyof typeof STORM_FORM_ERRORS;
/** The key whose sentence is `message`, or 'check' when none matches. */
export function stormFormErrorKey(message: string): StormFormErrorKey {
  const hit = (Object.keys(STORM_FORM_ERRORS) as StormFormErrorKey[]).find((k) => STORM_FORM_ERRORS[k] === message);
  return hit ?? 'check';
}
/** The sentence for a ?error= value, or undefined when the value is not an allowed key. */
export function stormFormErrorMessage(key: unknown): string | undefined {
  return typeof key === 'string' && Object.hasOwn(STORM_FORM_ERRORS, key) ? STORM_FORM_ERRORS[key as StormFormErrorKey] : undefined;
}

const NAME_MAX = 100;
const ADDRESS_MIN = 5;
const ADDRESS_MAX = 200;
const HOUR_MS = 60 * 60 * 1000;

/** The values a browser's checkbox sends when it is ticked; anything else (or nothing) is not consent. */
const TICKED_VALUES: ReadonlySet<string> = new Set(['on', 'true', '1']);

/**
 * The form body. Names are trimmed; the phone is normalised to E.164 (a US number or refused); the
 * checkbox counts only when ticked; `website` is the honeypot and is read before this schema runs.
 */
export const StormRequestBody = z.object({
  name: z
    .string({ error: NAME_MESSAGE })
    .trim()
    .min(1, NAME_MESSAGE)
    .max(NAME_MAX, NAME_TOO_LONG),
  phone: z
    .string({ error: PHONE_MESSAGE })
    .trim()
    .transform((value, ctx) => {
      const e164 = toE164(value);
      if (e164 === null) {
        ctx.addIssue({ code: 'custom', message: PHONE_MESSAGE });
        return z.NEVER;
      }
      return e164;
    }),
  address: z
    .string({ error: ADDRESS_MESSAGE })
    .trim()
    .min(ADDRESS_MIN, ADDRESS_MESSAGE)
    .max(ADDRESS_MAX, ADDRESS_TOO_LONG),
  okToText: z.unknown().optional().transform((value) => typeof value === 'boolean' ? value : typeof value === 'string' && TICKED_VALUES.has(value)),
  website: z.string().optional(),
});

/**
 * Finds a storm page by its code, with the company it belongs to. The route passes
 * `stormPageForCode` from @roofline/db/system (only public routes may import that package); a
 * finder keeps this file free of it. Null for an unknown code.
 */
export type StormPageFinder = (code: string) => Promise<{ pageId: string; companyId: string; activeUntil: Date } | null>;

/** A honeypot field counts as filled when a bot has put anything in it. */
function isFilled(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  return value !== undefined && value !== null && value !== false;
}

/** The form body, checked. The first issue becomes the 422: its field, and its message when it has a field. */
function parseBody(body: unknown): z.infer<typeof StormRequestBody> {
  const result = StormRequestBody.safeParse(body);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path[0];
  if (field === undefined) throw new AppError(422, MESSAGES.checkField);
  throw new AppError(422, issue?.message ?? MESSAGES.checkField, String(field));
}

/**
 * The HMAC key for hashing a requester's address: derived from ENCRYPTION_KEY with HKDF under its
 * own info string, like the unsubscribe key, so the raw address is never stored.
 */
function ipHashKey(config: Pick<Config, 'ENCRYPTION_KEY'>): Buffer {
  const ikm = Buffer.from(config.ENCRYPTION_KEY, 'base64');
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), 'storm-request-ip', 32));
}

/** The stored hash of a requester's IP address. The address itself is never kept. */
export function ipHashFor(config: Pick<Config, 'ENCRYPTION_KEY'>, ip: string): string {
  return createHmac('sha256', ipHashKey(config)).update(ip).digest('hex');
}

/** The geocoded place a request is filed under. */
type Place = {
  addressLine: string;
  city: string;
  state: string;
  zip: string;
  location: [number, number];
  timezone: string | null;
};

/** Looks the typed address up. Anything short of a full US address is the same "couldn't find" answer. */
async function locate(deps: AppDeps, address: string): Promise<Place> {
  let found;
  try {
    found = await deps.geocoder.geocode(address);
  } catch (err) {
    if (err instanceof GeocoderUnavailableError) throw new AppError(503, LOOKUP_DOWN);
    throw err;
  }
  if (found === null || found.city === null || found.state === null || found.zip === null) {
    throw new AppError(422, ADDRESS_NOT_FOUND, 'address');
  }
  return {
    addressLine: found.street ?? address,
    city: found.city,
    state: found.state,
    zip: found.zip,
    location: [found.lng, found.lat],
    timezone: found.timezone,
  };
}

/**
 * Takes one request from a storm landing page. Resolves `{ ok: true }` for a new request and for a
 * repeat of a phone number already on the page (no second job). Throws AppError for a bad form
 * (422 with the field), an unknown or closed page (404), the page's hourly limit or one IP's share
 * of it (429) and an
 * address lookup that is down (503). A filled honeypot resolves at once, with no lookup and no write.
 */
export async function submitStormRequest(
  deps: AppDeps,
  input: { code: string; body: unknown; ip: string; now: Date; findPage: StormPageFinder },
): Promise<{ ok: true }> {
  const raw = typeof input.body === 'object' && input.body !== null ? (input.body as Record<string, unknown>) : {};
  if (isFilled(raw.website)) return { ok: true };

  const form = parseBody(input.body);

  const page = await input.findPage(input.code.toLowerCase());
  if (page === null || page.activeUntil <= input.now) throw new AppError(404, MESSAGES.notFound);

  const ctx: TenantContext = { companyId: page.companyId, userId: null, role: 'system', canApproveSpend: false };
  const since = new Date(input.now.getTime() - HOUR_MS);
  const ipHash = ipHashFor(deps.config, input.ip);
  const [recent, fromThisIp] = await withTenant(deps.pools, ctx, async (tx) => [
    await countStormRequestsSince(tx, ctx, page.pageId, since),
    await countStormRequestsSince(tx, ctx, page.pageId, since, ipHash),
  ]);
  if (recent >= STORM_REQUEST_LIMITS.perPagePerHour || fromThisIp >= STORM_REQUEST_LIMITS.perIpPerPagePerHour) {
    throw new AppError(429, MESSAGES.tooFast);
  }

  const property = await locate(deps, form.address);

  await withTenant(deps.pools, ctx, (tx) =>
    createStormRequest(tx, ctx, {
      stormPageId: page.pageId,
      name: form.name,
      phoneE164: form.phone,
      address: form.address,
      property,
      okToText: form.okToText,
      consentText: STORM_CONSENT_TEXT,
      ipHash,
      now: input.now,
    }),
  );
  return { ok: true };
}
