import pg from 'pg';
import { TENANT_TABLES } from './schema/tenant.ts';

/** What `preflight` found. `ok` is true exactly when `problems` is empty. */
export type PreflightResult = { ok: boolean; problems: string[] };

/** The extensions Roofline needs in `public`, when they are installed somewhere else. */
const EXTENSIONS_SQL = `select e.extname, n.nspname
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
 where e.extname in ('citext','postgis') and n.nspname <> 'public'
 order by e.extname`;

/*
 * The Supabase Data API roles' grants on every relation (tables, views and sequences) in public and
 * pgboss. Relations that belong to an extension are skipped: PostGIS grants SELECT on spatial_ref_sys
 * to PUBLIC, so anon could always read it, and that grant is not ours to revoke.
 */
const GRANTS_SQL = `select r.rolname as role, n.nspname as schema, c.relname as "table",
       has_table_privilege(r.oid, c.oid, 'SELECT') as can_read,
       (has_table_privilege(r.oid, c.oid, 'INSERT') or has_table_privilege(r.oid, c.oid, 'UPDATE') or has_table_privilege(r.oid, c.oid, 'DELETE')) as can_write
  from pg_roles r
  cross join pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where r.rolname in ('anon','authenticated')
   and n.nspname in ('public','pgboss')
   and c.relkind in ('r','p','v','m','f','S')
   and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
 order by r.rolname, n.nspname, c.relname`;

const ROLES_SQL = `select rolname, rolsuper, rolbypassrls
  from pg_roles
 where rolname in ('app_tenant','app_system')
 order by rolname`;

const FORCED_RLS_SQL = `select relname
  from pg_class
 where relnamespace = 'public'::regnamespace
   and relkind in ('r','p')
   and relrowsecurity
   and relforcerowsecurity`;

/**
 * Checks that a migrated database is safe to deploy. Run it as the owner after `migrate`. It reads
 * the catalogs only, reports every problem it finds, and changes nothing.
 */
export async function preflight(ownerUrl: string): Promise<PreflightResult> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  const problems: string[] = [];
  try {
    const extensions = await client.query<{ extname: string; nspname: string }>(EXTENSIONS_SQL);
    for (const row of extensions.rows) {
      problems.push(`${row.extname} is in schema ${row.nspname}, not public`);
    }

    const grants = await client.query<{
      role: string;
      schema: string;
      table: string;
      can_read: boolean;
      can_write: boolean;
    }>(GRANTS_SQL);
    for (const row of grants.rows) {
      const relation = `${row.schema}.${row.table}`;
      if (row.can_read) problems.push(`${row.role} can read ${relation}`);
      if (row.can_write) problems.push(`${row.role} can write ${relation}`);
    }

    const roles = await client.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(ROLES_SQL);
    for (const row of roles.rows) {
      if (row.rolsuper) problems.push(`${row.rolname} is a superuser`);
      if (row.rolbypassrls) problems.push(`${row.rolname} bypasses row-level security`);
    }

    const forced = await client.query<{ relname: string }>(FORCED_RLS_SQL);
    const forcedTables = new Set(forced.rows.map((row) => row.relname));
    for (const table of TENANT_TABLES) {
      if (!forcedTables.has(table)) problems.push(`${table} does not force row-level security`);
    }
  } finally {
    await client.end();
  }
  return { ok: problems.length === 0, problems };
}
