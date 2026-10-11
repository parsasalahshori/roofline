import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as runMigrations } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { findPgError } from './errors.ts';

/** drizzle-kit output plus hand-written SQL migrations (extensions, roles, RLS). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/** An extension Roofline needs in `public` is installed somewhere it cannot be moved from. The message says what to do. */
export class ExtensionSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtensionSchemaError';
  }
}

/** The object kinds `REVOKE ... ON ALL <kind> IN SCHEMA` and `ALTER DEFAULT PRIVILEGES ... ON <kind>` take. */
const OBJECT_KINDS = ['TABLES', 'SEQUENCES', 'FUNCTIONS'] as const;

/**
 * Keeps citext and postgis where Roofline expects them, in `public`. citext in another schema is
 * moved there. postgis cannot be moved without a drop, so a postgis in another schema throws
 * ExtensionSchemaError and the owner decides. Needs no superuser, and does nothing when neither
 * extension is outside `public` (also a fresh database with no extensions yet).
 */
export async function ensureExtensionsInPublic(client: pg.ClientBase): Promise<void> {
  const misplaced = await client.query<{ extname: string; nspname: string }>(
    `select e.extname, n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace
      where e.extname in ('citext','postgis') and n.nspname <> 'public'`,
  );
  const postgis = misplaced.rows.find((row) => row.extname === 'postgis');
  if (postgis) {
    throw new ExtensionSchemaError(
      `postgis is installed in schema "${postgis.nspname}". Roofline needs it in public: drop it there and let the migration install it, or enable it for the public schema in your database host's settings.`,
    );
  }
  if (misplaced.rows.some((row) => row.extname === 'citext')) {
    await client.query('alter extension citext set schema public');
  }
}

/**
 * Runs a revoke on the pgboss schema. pgboss's objects are owned by app_system, and on a managed
 * host the migration owner is not a superuser, so it cannot revoke on another role's tables and
 * gets permission denied (42501). That grant is left in place; `npm run db:preflight` still reports it.
 */
async function revokeOnPgboss(client: pg.ClientBase, statement: string): Promise<void> {
  try {
    await client.query(statement);
  } catch (err) {
    if (findPgError(err)?.code === '42501') return;
    throw err;
  }
}

/**
 * Takes back what a Supabase-style host grants the Data API roles `anon` and `authenticated`, so the
 * app's tables are reached only through the app roles. Covers the tables, sequences and functions
 * already in `public` and `pgboss`, the USAGE on `public`, and the default privileges that would give
 * the same grants to tables a later migration creates. Does nothing when neither role exists (a plain
 * Postgres, the test container). Running it again changes nothing.
 */
export async function revokeDataApiExposure(client: pg.ClientBase): Promise<void> {
  const roles = await client.query<{ rolname: string }>(
    `select rolname from pg_roles where rolname in ('anon','authenticated') order by rolname`,
  );
  if (roles.rows.length === 0) return;

  const schemas = await client.query<{ nspname: string }>(
    `select nspname from pg_namespace where nspname in ('public','pgboss')`,
  );
  const present = new Set(schemas.rows.map((row) => row.nspname));

  for (const { rolname } of roles.rows) {
    const role = client.escapeIdentifier(rolname);

    if (present.has('public')) {
      for (const kind of OBJECT_KINDS) {
        await client.query(`revoke all on all ${kind} in schema public from ${role}`);
      }
    }
    if (present.has('pgboss')) {
      for (const kind of OBJECT_KINDS) {
        await revokeOnPgboss(client, `revoke all on all ${kind} in schema pgboss from ${role}`);
      }
    }
    if (present.has('public')) {
      await client.query(`revoke usage on schema public from ${role}`);
      for (const kind of OBJECT_KINDS) {
        await client.query(`alter default privileges in schema public revoke all on ${kind} from ${role}`);
      }
    }
  }
}

/**
 * Borrows one client from the pool for the duration of `fn` and gives it back afterward, so no
 * connection sits idle between the migration steps.
 */
async function withClient<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Applies every pending migration. Also keeps citext and postgis in `public` and revokes the Supabase
 * Data API grants (`anon`, `authenticated`), on every run, as the owner. Run it as the table owner,
 * never as an app role. Every step borrows a client from one single-connection pool, so no connection
 * sits idle during the migration run (a managed host or pooler can drop an idle connection).
 */
export async function migrate(ownerUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  try {
    await withClient(pool, ensureExtensionsInPublic);
    await runMigrations(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
    await withClient(pool, async (client) => {
      await ensureExtensionsInPublic(client);
      await revokeDataApiExposure(client);
    });
  } finally {
    await pool.end();
  }
}
