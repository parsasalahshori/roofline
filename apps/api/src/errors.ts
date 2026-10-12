import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { findPgError, ForbiddenError } from '@roofline/db';

/**
 * Every message below is shown to a person, so each is a plain sentence: no codes, no jargon.
 * The API error body is `{ error, field? }` and nothing else.
 */
export const MESSAGES = {
  notFound: "We couldn't find that.",
  stormScoutPaused: 'Storm Scout is paused. Turn it back on in Agents to draft a plan.',
  crossSite: 'This request came from another site and was blocked.',
  tooLarge: 'That request was too large.',
  unreadable: "We couldn't read that request. Please check it and try again.",
  internal: 'Something went wrong on our side. Please try again.',
  checkField: 'Please check this field.',
  signIn: 'Please sign in.',
  badLogin: "That email and password don't match.",
  emailTaken: 'An account with that email already exists.',
  noAccess: 'Your access to this company is turned off. Ask the owner to turn it back on.',
  tooManyLogins: 'Too many sign-in attempts. Try again in a few minutes.',
  tooFast: "You're going a little fast. Try again in a minute.",
  tooManySignups: 'Too many sign-ups from here. Try again later.',
  tooManyEmails: "We've already sent you a few emails. Please check your inbox, or try again in an hour.",
  linkUsed: 'That link has already been used or has expired.',
  linkIncomplete: 'That link is incomplete. Please open it again from your email.',
  verifyEmailFirst: 'Please confirm your email first. We sent you a link.',
  googleFailed: "We couldn't sign you in with Google. Please try again.",
  googleNotSetUp: "Google sign-in isn't set up yet.",
  googleUnavailable: 'Google sign-in is having trouble right now. Please try again in a minute.',
  googleUnverified: "Google hasn't confirmed this email address, so we can't use it to sign in.",
  googleOtherAccount: 'That email is already connected to a different Google account.',
  googleEmailInUse: 'This email already has a Roofline account. Please sign in with your password.',
  roleCannot: "Your role can't do that. Ask the owner.",
  nothingToChange: "There's nothing to change.",
  tooManyInvites: "You've sent a lot of invites. Please try again in an hour.",
  alreadyOnTeam: 'That person is already on your team.',
  alreadyMember: "You're already on this team.",
  lastOwner: 'Your company needs at least one owner.',
  inviteGone: 'That invite link has expired or was already used. Ask for a new one.',
  inviteWrongGoogle: "This Google account doesn't match the email that was invited.",
  inviteSignIn: 'Sign in to accept this invite.',
  googleAlreadyUsed: 'This Google account is already connected to a different Roofline user.',
  changedWhileLooking: "This changed while you were looking. Here's the latest.",
} as const;

/** `latest` is only on the 409 of an approval that changed under the caller: the current version of what they tried to change. */
export type ErrorBody = { error: string; field?: string; latest?: unknown };

/**
 * An error the caller should see: it carries the HTTP status, a plain-English message, and
 * optionally the name of the field the message is about. Throw this for anything expected
 * (validation, conflicts, "not found"); everything else becomes a generic 500.
 * A 409 that tells the screen to refresh also carries `latest`, the current state of the thing
 * that changed (the approvals routes use it), so the response is `{ error, latest }`.
 */
export class AppError extends Error {
  readonly status: number;
  readonly field?: string;
  readonly latest?: unknown;

  constructor(status: number, message: string, field?: string, latest?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    if (field !== undefined) this.field = field;
    if (latest !== undefined) this.latest = latest;
  }
}

/** The `field` for a zod error: the first issue's path joined with dots, or undefined at the root. */
export function fieldOf(error: ZodError): string | undefined {
  const path = error.issues[0]?.path ?? [];
  return path.length > 0 ? path.map(String).join('.') : undefined;
}

/**
 * Last-stop mapping of a ZodError that nobody wrapped in `parse()`. A bare `schema.parse()` can't
 * tell us whether a message was written by the schema or is zod's default English ("Too small:
 * expected…"), so this path always uses the generic sentence. Route code should call `parse()`
 * (validate.ts), which keeps the schema's own messages.
 */
function zodToAppError(error: ZodError): AppError {
  return new AppError(400, MESSAGES.checkField, fieldOf(error));
}

/**
 * body-parser failures (too large, malformed JSON, unsupported charset or encoding) are http-errors
 * that carry a `type`. Express's own default handler would print their message, so they are
 * recognised here by that shape and mapped to our sentences. Nothing else gets to choose its status.
 */
function bodyParserStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { status, type, expose } = err as { status?: unknown; type?: unknown; expose?: unknown };
  if (typeof type !== 'string' || typeof status !== 'number') return undefined;
  if (expose !== true || status < 400 || status > 499) return undefined;
  return status;
}

/**
 * What may be written to the log about an unexpected error: its name, the first line of its
 * message, and the Postgres error code behind it (`23505`). Nothing else.
 * Drizzle's failed-query message is "Failed query: <sql>\nparams: <values>", and the values can be
 * password hashes, token hashes or customer data, so the `params:` part is cut off before the first
 * line is taken, and the stack (which begins with the full message) and `cause` are never printed.
 */
export function describeErrorForLog(err: unknown): string {
  if (!(err instanceof Error)) return 'A non-Error value was thrown.';
  const firstLine = (err.message.replace(/\s*params:[\s\S]*$/i, '').split('\n')[0] ?? '').trim();
  const pg = findPgError(err);
  return `${err.name}: ${firstLine}${pg ? ` (pg ${pg.code})` : ''}`;
}

/**
 * The default error log: one line, `Unhandled error on <where>: <describeErrorForLog(err)>`, on
 * stderr. Used for a request answered with a 500 and for a step the runner gave up on.
 */
export function logErrorToConsole(err: unknown, where: string): void {
  console.error(`Unhandled error on ${where}: ${describeErrorForLog(err)}`);
}

/**
 * The request path as it may be logged: a homeowner link token (`/public/proposals/<token>/...`) is a
 * credential and is replaced by `:token` (global constraints: the token is never logged).
 */
export function pathForLog(path: string): string {
  return path.replace(/(\/public\/proposals\/)[^/]+/i, '$1:token');
}

/** Fallthrough for any request no route answered. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: MESSAGES.notFound } satisfies ErrorBody);
};

/**
 * The one place errors become responses.
 * - AppError → its status, message and field.
 * - ZodError → 400, field from the first issue, generic sentence (see zodToAppError).
 * - ForbiddenError (a repository's role check) → 403 "Your role can't do that. Ask the owner.".
 * - body-parser errors → 413 or 400 in our own words.
 * - anything else → 500 with the generic sentence. The error (and its `cause`: Drizzle wraps the
 *   Postgres error there, with its `code` and `detail`) is handed to `logError` and never reaches
 *   the response.
 */
export function errorHandler(logError: (err: unknown, path: string) => void): ErrorRequestHandler {
  return (err: unknown, req, res, next) => {
    // Too late to send a clean JSON body; let Express close the connection.
    if (res.headersSent) {
      next(err);
      return;
    }

    // A repository refused a change the member's role may not make (the routes check first; this is the second lock).
    const known = err instanceof ZodError ? zodToAppError(err) : err instanceof ForbiddenError ? new AppError(403, MESSAGES.roleCannot) : err;
    if (known instanceof AppError) {
      const body: ErrorBody = { error: known.message };
      if (known.field !== undefined) body.field = known.field;
      if (known.latest !== undefined) body.latest = known.latest;
      res.status(known.status).json(body);
      return;
    }

    const status = bodyParserStatus(err);
    if (status !== undefined) {
      const error = status === 413 ? MESSAGES.tooLarge : MESSAGES.unreadable;
      res.status(status).json({ error } satisfies ErrorBody);
      return;
    }

    logError(err, pathForLog(req.path));
    res.status(500).json({ error: MESSAGES.internal } satisfies ErrorBody);
  };
}
