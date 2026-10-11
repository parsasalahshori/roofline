/** The parts of a Postgres error that code may branch on. */
export type PgErrorInfo = { code: string; constraint?: string };

const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * Finds the Postgres error behind a failed query. Drizzle wraps the driver's error and puts it on
 * `cause`, so the SQLSTATE `code` (23505 = unique violation) is usually at `err.cause.code`, but a
 * raw `pg` error carries it directly. Returns undefined for anything that is not a Postgres error.
 * Only the code and the constraint name come back: the message and `detail` can hold row values.
 */
export function findPgError(err: unknown): PgErrorInfo | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const { code, constraint, cause } = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof code === 'string' && SQLSTATE.test(code)) {
      return typeof constraint === 'string' ? { code, constraint } : { code };
    }
    current = cause;
  }
  return undefined;
}

/** True when `err` is a unique violation (23505), on `constraint` when one is given. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const pg = findPgError(err);
  return pg?.code === '23505' && (constraint === undefined || pg.constraint === constraint);
}
