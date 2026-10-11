import { z, type ZodType } from 'zod';
import { AppError, fieldOf, MESSAGES } from './errors.ts';

/** The longest email address there is (RFC 5321: 254 characters). Every email field in the API is capped at this. */
export const MAX_EMAIL_LENGTH = 254;

export const EMAIL_MESSAGE = 'Please enter a valid email address.';

export const TOO_LONG = 'That is too long.';

/** Postgres cannot store a NUL character in text; refusing it up front keeps a stray one from becoming a 500. */
export const noNul = (value: string): boolean => !value.includes('\0');

export const TIMEZONE_MESSAGE = 'Please pick a valid time zone.';

/** The IANA zone names the platform knows (`America/Chicago`), plus UTC, which the list leaves out. */
export const TIME_ZONES: ReadonlySet<string> = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);

/** A UUID in its written form, either case. Routes use it to tell "malformed id" (a 404) from a real lookup. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Emails are stored trimmed and lowercased, at most 254 characters; the same rule is applied wherever one is asked for. */
export const emailField = z
  .string({ error: EMAIL_MESSAGE })
  .trim()
  .toLowerCase()
  .max(MAX_EMAIL_LENGTH, EMAIL_MESSAGE)
  .pipe(z.email(EMAIL_MESSAGE));

/**
 * Checks `value` against `schema` and returns the parsed result, or throws a 400 AppError.
 * - `field` is the first issue's path joined with dots (`address.zip`, `items.1.qty`).
 * - `error` is the message the schema itself provided (`z.string().min(10, 'Use at least 10
 *   characters.')`). When the schema gave none, it is "Please check this field.". Zod's own
 *   default wording ("Too small: expected string to have >=10 characters") never reaches a person.
 *
 * It works by giving zod an error map that applies only where the schema has no message of its own:
 * schema-level messages win over the per-parse map.
 */
export function parse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value, { error: () => MESSAGES.checkField });
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new AppError(400, issue?.message ?? MESSAGES.checkField, fieldOf(result.error));
}

/**
 * For PATCH bodies: the body must be a plain object whose keys are all in `allowed`. A key outside
 * the list is refused with 400 "Please check this field." naming that key (never silently
 * dropped), and a body with no keys is refused with 400 "There's nothing to change.".
 * `allowEmpty` is for create bodies, where an empty object is left to the schema (which names the
 * first required field that is missing).
 * Returns the body for the schema that checks the values.
 */
export function assertKnownFields(
  body: unknown,
  allowed: readonly string[],
  options: { allowEmpty?: boolean } = {},
): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new AppError(400, MESSAGES.checkField);
  const keys = Object.keys(body);
  const unknown = keys.find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new AppError(400, MESSAGES.checkField, unknown);
  if (keys.length === 0 && options.allowEmpty !== true) throw new AppError(400, MESSAGES.nothingToChange);
  return body as Record<string, unknown>;
}

const LIMIT_MESSAGE = 'Please use a whole number from 1 to 200.';
const OFFSET_MESSAGE = 'Please use a whole number, 0 or higher.';

/**
 * `?limit=` on a list route: a whole number from 1 (up to 7 digits). Anything above 200 is accepted
 * and capped to 200 by the repository, not refused. Absent means the default page size (50).
 */
export const limitParam = z
  .string({ error: LIMIT_MESSAGE })
  .regex(/^\d{1,7}$/, LIMIT_MESSAGE)
  .transform(Number)
  .refine((n) => n >= 1, LIMIT_MESSAGE)
  .optional();

/** `?offset=` on a list route: a whole number from 0 (up to 7 digits). */
export const offsetParam = z
  .string({ error: OFFSET_MESSAGE })
  .regex(/^\d{1,7}$/, OFFSET_MESSAGE)
  .transform(Number)
  .optional();
