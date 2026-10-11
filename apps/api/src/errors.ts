import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

/**
 * Every message below is shown to a person, so each is a plain sentence: no codes, no jargon.
 * The API error body is `{ error, field? }` and nothing else.
 */
export const MESSAGES = {
  notFound: "We couldn't find that.",
  crossSite: 'This request came from another site and was blocked.',
  tooLarge: 'That request was too large.',
  unreadable: "We couldn't read that request. Please check it and try again.",
  internal: 'Something went wrong on our side. Please try again.',
  checkField: 'Please check this field.',
} as const;

export type ErrorBody = { error: string; field?: string };

/**
 * An error the caller should see: it carries the HTTP status, a plain-English message, and
 * optionally the name of the field the message is about. Throw this for anything expected
 * (validation, conflicts, "not found"); everything else becomes a generic 500.
 */
export class AppError extends Error {
  readonly status: number;
  readonly field?: string;

  constructor(status: number, message: string, field?: string) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    if (field !== undefined) this.field = field;
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

/** Fallthrough for any request no route answered. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: MESSAGES.notFound } satisfies ErrorBody);
};

/**
 * The one place errors become responses.
 * - AppError → its status, message and field.
 * - ZodError → 400, field from the first issue, generic sentence (see zodToAppError).
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

    const known = err instanceof ZodError ? zodToAppError(err) : err;
    if (known instanceof AppError) {
      const body: ErrorBody = { error: known.message };
      if (known.field !== undefined) body.field = known.field;
      res.status(known.status).json(body);
      return;
    }

    const status = bodyParserStatus(err);
    if (status !== undefined) {
      const error = status === 413 ? MESSAGES.tooLarge : MESSAGES.unreadable;
      res.status(status).json({ error } satisfies ErrorBody);
      return;
    }

    logError(err, req.path);
    res.status(500).json({ error: MESSAGES.internal } satisfies ErrorBody);
  };
}
