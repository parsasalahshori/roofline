import { z, type ZodType } from 'zod';
import { AppError, fieldOf, MESSAGES } from './errors.ts';

/** The longest email address there is (RFC 5321: 254 characters). Every email field in the API is capped at this. */
export const MAX_EMAIL_LENGTH = 254;

export const EMAIL_MESSAGE = 'Please enter a valid email address.';

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
 * Returns the body for the schema that checks the values.
 */
export function assertKnownFields(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new AppError(400, MESSAGES.checkField);
  const keys = Object.keys(body);
  const unknown = keys.find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new AppError(400, MESSAGES.checkField, unknown);
  if (keys.length === 0) throw new AppError(400, MESSAGES.nothingToChange);
  return body as Record<string, unknown>;
}
