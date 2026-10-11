import pg from 'pg';
import { describe, expect, inject, test } from 'vitest';
import { ExtensionSchemaError, migrate } from '../src/migrate.ts';
import { preflight } from '../src/preflight.ts';

const urls = inject('dbUrls');

/** Creating and migrating a database on the shared PostGIS container is slow under emulation. */
const SLOW_TEST_MS = 180_000;

/** The owner's URL with the database path swapped (same superuser, same password). */
function urlFor(database: string): string {
  const u = new URL(urls.owner);
  u.pathname = '/' + database;
  return u.toString();
}

/** Runs `fn` on a short-lived connection to `url`, and always closes the connection. */
async function inDatabase<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function createDatabase(name: string): Promise<void> {
  await inDatabase(urls.owner, async (client) => {
    await client.query(`drop database if exists ${name} with (force)`);
    await client.query(`create database ${name}`);
  });
}

async function dropDatabase(name: string): Promise<void> {
  await inDatabase(urls.owner, async (client) => {
    await client.query(`drop database if exists ${name} with (force)`);
  });
}

/** Creates the named roles that do not exist yet, and returns only the ones this call created. */
async function ensureRoles(names: string[]): Promise<string[]> {
  return inDatabase(urls.owner, async (client) => {
    const created: string[] = [];
    for (const name of names) {
      const { rows } = await client.query(`select 1 from pg_roles where rolname = $1`, [name]);
      if (rows.length === 0) {
        await client.query(`create role ${name} nologin`);
        created.push(name);
      }
    }
    return created;
  });
}

/**
 * Drops the roles a test created. Roles are cluster-wide, so call this only after the database that
 * held their grants has been dropped.
 */
async function dropRoles(created: string[]): Promise<void> {
  await inDatabase(urls.owner, async (client) => {
    for (const name of created) {
      await client.query(`drop role if exists ${name}`);
    }
  });
}

describe('database hardening', () => {
  test('a freshly migrated shared database passes preflight', async () => {
    expect(await preflight(urls.owner)).toEqual({ ok: true, problems: [] });
  }, SLOW_TEST_MS);

  test('a Supabase-like database is cleaned up by migrate', async () => {
    const created = await ensureRoles(['anon', 'authenticated']);
    const database = 'supa_sim';
    try {
      await createDatabase(database);
      const url = urlFor(database);
      await inDatabase(url, async (client) => {
        await client.query('alter default privileges in schema public grant all on tables to anon, authenticated');
        await client.query('create schema extensions');
        await client.query('create extension citext schema extensions');
      });

      await migrate(url);
      await migrate(url);

      const { citextSchemas, grants } = await inDatabase(url, async (client) => {
        const ext = await client.query<{ nspname: string }>(
          `select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'citext'`,
        );
        const privileges: Array<{ role: string; table: string; ok: boolean }> = [];
        for (const role of ['anon', 'authenticated']) {
          for (const table of ['public.users', 'public.sessions']) {
            const res = await client.query<{ ok: boolean }>(`select has_table_privilege($1, $2, 'SELECT') as ok`, [
              role,
              table,
            ]);
            privileges.push({ role, table, ok: res.rows[0]!.ok });
          }
        }
        return { citextSchemas: ext.rows, grants: privileges };
      });

      expect(citextSchemas).toEqual([{ nspname: 'public' }]);
      for (const grant of grants) {
        expect(grant.ok, `${grant.role} SELECT on ${grant.table}`).toBe(false);
      }
      expect(await preflight(url)).toEqual({ ok: true, problems: [] });
    } finally {
      await dropDatabase(database);
      await dropRoles(created);
    }
  }, SLOW_TEST_MS);

  test('postgis in another schema stops migrate with a plain reason', async () => {
    const database = 'hardening_postgis';
    try {
      await createDatabase(database);
      const url = urlFor(database);
      await inDatabase(url, async (client) => {
        await client.query('create schema extensions');
        await client.query('create extension postgis schema extensions');
      });

      await expect(migrate(url)).rejects.toThrow('postgis is installed in schema "extensions"');
      await expect(migrate(url)).rejects.toThrow(
        'postgis is installed in schema "extensions". Roofline needs it in public: drop it there and let the migration install it, or enable it for the public schema in your database host\'s settings.',
      );
      await expect(migrate(url)).rejects.toBeInstanceOf(ExtensionSchemaError);
    } finally {
      await dropDatabase(database);
    }
  }, SLOW_TEST_MS);

  test('migrate as a plain CREATEROLE owner still revokes, and skips pgboss tables it does not own', async () => {
    const database = 'hardening_managed';
    const migrator = 'hardening_managed_owner';
    const created = await ensureRoles(['anon']);
    try {
      await inDatabase(urls.owner, async (client) => {
        await client.query(`drop database if exists ${database} with (force)`);
        await client.query(`drop role if exists ${migrator}`);
        await client.query(`create role ${migrator} login createrole password 'hardening-owner-pw'`);
        await client.query(`grant app_tenant, app_system to ${migrator} with admin true, inherit false, set false`);
        await client.query(`create database ${database} owner ${migrator}`);
      });
      await inDatabase(urlFor(database), async (client) => {
        await client.query('create extension postgis; create extension citext;');
      });

      const ownerUrl = new URL(urlFor(database));
      ownerUrl.username = migrator;
      ownerUrl.password = 'hardening-owner-pw';
      const managedUrl = ownerUrl.toString();

      await inDatabase(managedUrl, async (client) => {
        await client.query('alter default privileges in schema public grant all on tables to anon');
      });
      await migrate(managedUrl);

      // pg-boss creates its tables as app_system, which the migration owner cannot revoke on.
      const systemUrl = new URL(urls.system);
      systemUrl.pathname = '/' + database;
      await inDatabase(systemUrl.toString(), async (client) => {
        await client.query('create table pgboss.probe (id int)');
      });

      await expect(migrate(managedUrl)).resolves.toBeUndefined();
      expect(await preflight(managedUrl)).toEqual({ ok: true, problems: [] });
    } finally {
      await dropDatabase(database);
      await inDatabase(urls.owner, async (client) => {
        await client.query(`drop role if exists ${migrator}`);
      });
      await dropRoles(created);
    }
  }, SLOW_TEST_MS);

  test('preflight names what is wrong', async () => {
    const created = await ensureRoles(['anon']);
    const database = 'hardening_preflight';
    try {
      await createDatabase(database);
      const url = urlFor(database);
      await migrate(url);
      expect((await preflight(url)).ok).toBe(true);

      await inDatabase(url, (client) => client.query('grant select on users to anon'));
      const readResult = await preflight(url);
      expect(readResult.ok).toBe(false);
      expect(readResult.problems).toContain('anon can read public.users');

      await inDatabase(url, (client) => client.query('grant insert on sessions to anon'));
      expect((await preflight(url)).problems).toContain('anon can write public.sessions');

      await inDatabase(url, (client) => client.query('alter table customers no force row level security'));
      expect((await preflight(url)).problems).toContain('customers does not force row-level security');

      await inDatabase(url, async (client) => {
        await client.query('create sequence probe_seq');
        await client.query('grant select on sequence probe_seq to anon');
      });
      expect((await preflight(url)).problems).toContain('anon can read public.probe_seq');

      await inDatabase(url, async (client) => {
        await client.query('create schema extensions');
        await client.query('alter extension citext set schema extensions');
      });
      expect((await preflight(url)).problems).toContain('citext is in schema extensions, not public');
    } finally {
      await dropDatabase(database);
      await dropRoles(created);
    }
  }, SLOW_TEST_MS);
});
