import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/migrate.ts';
import { createPools, type Pools } from '../src/pools.ts';
import { roleUrl } from '../src/roles.ts';
import { companies, customers, textingRegistrations } from '../src/schema/index.ts';
import { TENANT_TABLES } from '../src/schema/tenant.ts';
import { type TenantContext, withTenant } from '../src/tenant.ts';
import { resetDb, type SeededCompany, seedTwoCompanies } from '../src/testing/index.ts';

const urls = inject('dbUrls');

/** Global tables that carry a company_id and that app_tenant may read for its own company. */
const COMPANY_SCOPED_GLOBALS = ['company_phone_numbers', 'texting_registrations'] as const;
/** Global tables app_tenant must never touch directly. */
const PRIVATE_GLOBALS = ['users', 'sessions', 'memberships', 'invites', 'user_tokens', 'webhook_events'] as const;
const GLOBAL_TABLES = [...PRIVATE_GLOBALS, 'companies', ...COMPANY_SCOPED_GLOBALS] as const;
/** The RLS tables app_system holds a grant on, each with its permissive app_system_all policy. */
const APP_SYSTEM_RLS_TABLES = [
  'companies',
  ...COMPANY_SCOPED_GLOBALS,
  'agent_tasks',
  'agent_task_steps',
  'messages',
  'usage_events',
  'early_delivery_reports',
  'calendar_connections',
  'proposals',
  'exact_report_orders',
  'company_storms',
  'ad_campaigns',
  'storm_pages',
  'email_opt_outs',
] as const;
/** Global estimator tables: no tenant data, no RLS. app_system writes them from the loader job. */
const FOOTPRINT_TABLES = ['building_footprints', 'building_footprint_states'] as const;
/** The E1 tenant tables app_tenant reads and writes through its own company's transaction. */
const E1_TENANT_TABLES = [
  'measurements',
  'tier_templates',
  'proposals',
  'proposal_counters',
  'proposal_options',
  'proposal_signatures',
  'proposal_events',
  'exact_report_orders',
  'stored_files',
] as const;
/** Global S1 tables: no tenant data, no RLS. app_hail writes the first three; app_tenant reads all four. */
const HAIL_GLOBAL_TABLES = ['hail_runs', 'storms', 'storm_contours', 'spotter_reports'] as const;
/** The S1 tenant tables app_tenant reads and writes through its own company's transaction. */
const S1_TENANT_TABLES = [
  'company_storms',
  'storm_hits',
  'door_routes',
  'door_stops',
  'door_exclusions',
  'ad_accounts',
  'ad_campaigns',
  'storm_pages',
  'storm_requests',
  'email_opt_outs',
  'storm_photos',
] as const;
/** Tenant tables app_tenant may delete from. No other tenant table grants it DELETE. */
const APP_TENANT_DELETE_TABLES = [
  'opt_outs',
  'calendar_busy_blocks',
  'calendar_event_links',
  'door_exclusions',
  'storm_photos',
] as const;
const COMPANY_PROFILE_COLUMNS = [
  'name',
  'legal_name',
  'phone_e164',
  'email',
  'website',
  'address_street',
  'address_city',
  'address_state',
  'address_zip',
  'timezone',
  'service_area',
  'location',
  'service_area_miles',
  'logo_url',
] as const;

let owner: pg.Client;
let pools: Pools;
/** app_hail's connection URL: the migration creates the role NOLOGIN, so the tests give it a login. */
let hailUrl: string;
let seed: { a: SeededCompany; b: SeededCompany };

async function ownerQuery<T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await owner.query<T>(text, values)).rows;
}

/**
 * Runs raw SQL as a role on its own connection. With `companyId` the statement runs inside a
 * transaction that first calls `set_config('app.company_id', companyId, true)`, exactly as
 * withTenant does; without it, the setting is never touched on that connection.
 */
async function rawAs<T extends pg.QueryResultRow = Record<string, unknown>>(
  url: string,
  text: string,
  opts: { companyId?: string; values?: unknown[] } = {},
): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    if (opts.companyId === undefined) return (await client.query<T>(text, opts.values)).rows;
    await client.query('begin');
    try {
      await client.query(`select set_config('app.company_id', $1, true)`, [opts.companyId]);
      const res = await client.query<T>(text, opts.values);
      await client.query('commit');
      return res.rows;
    } catch (err) {
      await client.query('rollback');
      throw err;
    }
  } finally {
    await client.end();
  }
}

const tenantRaw = <T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  opts?: { companyId?: string; values?: unknown[] },
) => rawAs<T>(urls.tenant, text, opts);

const systemRaw = <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, values?: unknown[]) =>
  rawAs<T>(urls.system, text, { values });

const hailRaw = <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, values?: unknown[]) =>
  rawAs<T>(hailUrl, text, { values });

/** Runs a statement as a role and returns the Postgres error it must raise. */
async function rejectedWith(run: () => Promise<unknown>): Promise<pg.DatabaseError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof pg.DatabaseError) return err;
    throw err;
  }
  throw new Error('Expected the statement to be rejected');
}

const SQUARE = `ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))', 4326)`;
const MULTI_SQUARE = `ST_GeomFromText('MULTIPOLYGON(((0 0,0 1,1 1,1 0,0 0)))', 4326)`;
const CENTER = `ST_GeomFromText('POINT(0.5 0.5)', 4326)`;

/** A storm row, inserted by the owner. */
async function insertStorm(): Promise<string> {
  const [row] = await ownerQuery<{ id: string }>(
    `insert into storms (convective_day, max_in, geom_075, bbox, centroid)
     values (date '2026-10-11', 1.50, ${MULTI_SQUARE}, ${SQUARE}, ${CENTER}) returning id`,
  );
  return row!.id;
}

/**
 * Awaits work that must be rejected and returns the Postgres error. Drizzle wraps driver errors
 * in a DrizzleQueryError ("Failed query: ...") whose `cause` is the pg error.
 */
async function dbError(work: Promise<unknown>): Promise<pg.DatabaseError> {
  try {
    await work;
  } catch (err) {
    const cause = err instanceof pg.DatabaseError ? err : (err as { cause?: unknown }).cause;
    if (cause instanceof pg.DatabaseError) return cause;
    throw err;
  }
  throw new Error('Expected the work to be rejected by the database');
}

function ctx(company: SeededCompany): TenantContext {
  return { companyId: company.companyId, userId: company.owner.userId, role: 'owner', canApproveSpend: true };
}

async function insertCustomer(companyId: string, displayName: string): Promise<string> {
  const [row] = await ownerQuery<{ id: string }>(
    `insert into customers (company_id, display_name) values ($1, $2) returning id`,
    [companyId, displayName],
  );
  return row!.id;
}

async function insertProperty(companyId: string, customerId: string | null, key: string): Promise<string> {
  const [row] = await ownerQuery<{ id: string }>(
    `insert into properties (company_id, customer_id, address_line, city, state, zip, address_key)
     values ($1, $2, '1 Main St', 'Omaha', 'NE', '68102', $3) returning id`,
    [companyId, customerId, key],
  );
  return row!.id;
}

async function insertTask(companyId: string, title: string): Promise<string> {
  const [row] = await ownerQuery<{ id: string }>(
    `insert into agent_tasks (company_id, agent, kind, title, expires_at)
     values ($1, 'storm_scout', 'storm_plan', $2, now() + interval '1 day') returning id`,
    [companyId, title],
  );
  return row!.id;
}

beforeAll(async () => {
  owner = new pg.Client({ connectionString: urls.owner });
  await owner.connect();
  pools = createPools({ tenant: urls.tenant, system: urls.system });
  // Ops does this for real with set-role-passwords (HAIL_DB_PASSWORD); the role is cluster-wide.
  await owner.query(`alter role app_hail with login password 'hail-test-pw'`);
  hailUrl = roleUrl(urls.owner, 'app_hail', 'hail-test-pw');
});

afterAll(async () => {
  await pools?.end();
  await owner?.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
  seed = await seedTwoCompanies(urls.owner);
});

describe('roles', () => {
  test('neither app role is a superuser or bypasses row-level security', async () => {
    // Granting the bypass needs a superuser (or, from PostgreSQL 16, an owner that has it), which a
    // managed host's migration owner need not be, so app_system gets through RLS with its own
    // app_system_all policies instead.
    const rows = await ownerQuery<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(
      `select rolname, rolsuper, rolbypassrls, rolcanlogin from pg_roles
        where rolname in ('app_tenant', 'app_system') order by rolname`,
    );
    expect(rows).toEqual([
      { rolname: 'app_system', rolsuper: false, rolbypassrls: false, rolcanlogin: true },
      { rolname: 'app_tenant', rolsuper: false, rolbypassrls: false, rolcanlogin: true },
    ]);
  });

  test('app_hail is a NOLOGIN-by-migration role that is neither a superuser nor bypasses row-level security', async () => {
    // beforeAll gave it a login for these tests; the migration itself creates it NOLOGIN (checked in
    // migrations.test.ts against the SQL). What matters here is that it never bypasses RLS.
    const rows = await ownerQuery<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }>(
      `select rolname, rolsuper, rolbypassrls, rolcreaterole from pg_roles where rolname = 'app_hail'`,
    );
    expect(rows).toEqual([{ rolname: 'app_hail', rolsuper: false, rolbypassrls: false, rolcreaterole: false }]);
  });

  test('no migration grants the bypass-RLS attribute: BYPASSRLS appears only as NOBYPASSRLS', () => {
    const files = readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const file of files) {
      const text = readFileSync(join(MIGRATIONS_FOLDER, file), 'utf8');
      // Any case, comments included. The one other spelling allowed is pg_roles' read-only
      // `rolbypassrls` column, which 0002 reads to take the attribute off a leftover role.
      const granting = [...text.matchAll(/bypassrls/gi)].filter((m) => !/(no|rol)$/i.test(text.slice(0, m.index)));
      expect(granting.map((m) => text.slice(Math.max(0, m.index - 20), m.index + 9)), file).toEqual([]);
    }
  });

  test('neither app role owns any table or view', async () => {
    const rows = await ownerQuery(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and pg_get_userbyid(c.relowner) in ('app_tenant', 'app_system')`,
    );
    expect(rows).toEqual([]);
  });

  test('app_system owns the pgboss schema', async () => {
    const rows = await ownerQuery<{ owner: string }>(
      `select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = 'pgboss'`,
    );
    expect(rows).toEqual([{ owner: 'app_system' }]);
  });
});

describe('row-level security definitions', () => {
  const expression = (column: string) =>
    `(${column} = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::uuid)`;

  /** app_system's pass through RLS, on the tables it holds a grant on. Its grants are the real limit. */
  const APP_SYSTEM_ALL = {
    policyname: 'app_system_all',
    permissive: 'PERMISSIVE',
    roles: '{app_system}',
    cmd: 'ALL',
    qual: 'true',
    with_check: 'true',
  };

  test.each([...TENANT_TABLES, ...COMPANY_SCOPED_GLOBALS])(
    '%s has RLS enabled and forced, with the tenant_isolation policy (and app_system_all where app_system has a grant)',
    async (table) => {
      const [cls] = await ownerQuery<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `select relrowsecurity, relforcerowsecurity from pg_class where oid = $1::regclass`,
        [`public.${table}`],
      );
      expect(cls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const policies = await ownerQuery(
        `select policyname, permissive, roles, cmd, qual, with_check from pg_policies
          where schemaname = 'public' and tablename = $1 order by policyname`,
        [table],
      );
      const tenantIsolation = {
        policyname: 'tenant_isolation',
        permissive: 'PERMISSIVE',
        roles: '{public}',
        cmd: 'ALL',
        qual: expression('company_id'),
        with_check: expression('company_id'),
      };
      expect(policies).toEqual(
        (APP_SYSTEM_RLS_TABLES as readonly string[]).includes(table) ? [APP_SYSTEM_ALL, tenantIsolation] : [tenantIsolation],
      );
    },
  );

  test('companies has RLS enabled and forced, with the company_self policy on id (and app_system_all)', async () => {
    const [cls] = await ownerQuery(
      `select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.companies'::regclass`,
    );
    expect(cls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await ownerQuery(
      `select policyname, permissive, roles, cmd, qual, with_check from pg_policies
        where schemaname = 'public' and tablename = 'companies' order by policyname`,
    );
    expect(policies).toEqual([
      APP_SYSTEM_ALL,
      {
        policyname: 'company_self',
        permissive: 'PERMISSIVE',
        roles: '{public}',
        cmd: 'ALL',
        qual: expression('id'),
        with_check: expression('id'),
      },
    ]);
  });

  test('every RLS table app_system holds any grant on has app_system_all, and no other table has it', async () => {
    // Worked out from the catalog, so a later migration that grants app_system a new RLS table
    // without the policy (app_system would silently see zero rows there) fails here.
    const granted = await ownerQuery<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
          and (has_table_privilege('app_system', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
               or has_any_column_privilege('app_system', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))
        order by 1`,
    );
    expect(granted.map((r) => r.relname)).toEqual([...APP_SYSTEM_RLS_TABLES].sort());
    const withPolicy = await ownerQuery<{ tablename: string }>(
      `select tablename from pg_policies where schemaname = 'public' and 'app_system' = any(roles) order by 1`,
    );
    expect(withPolicy.map((r) => r.tablename)).toEqual([...APP_SYSTEM_RLS_TABLES].sort());
  });

  test('company_members is a security_barrier view owned by the migration owner', async () => {
    const rows = await ownerQuery(
      `select c.reloptions, pg_get_userbyid(c.relowner) = current_user as owned_by_owner
         from pg_class c where c.oid = 'public.company_members'::regclass and c.relkind = 'v'`,
    );
    expect(rows).toEqual([{ reloptions: ['security_barrier=true'], owned_by_owner: true }]);
  });
});

describe('grants', () => {
  type Privs = { table: string; select: boolean; insert: boolean; update: boolean; delete: boolean; truncate: boolean };

  async function tablePrivileges(role: string, tables: readonly string[]): Promise<Privs[]> {
    return ownerQuery<Privs>(
      `select t as table,
              has_table_privilege($1, t, 'SELECT') as select,
              has_table_privilege($1, t, 'INSERT') as insert,
              has_table_privilege($1, t, 'UPDATE') as update,
              has_table_privilege($1, t, 'DELETE') as delete,
              has_table_privilege($1, t, 'TRUNCATE') as truncate
         from unnest($2::text[]) as t`,
      [role, tables.map((t) => `public.${t}`)],
    ).then((rows) => rows.map((r) => ({ ...r, table: r.table.replace('public.', '') })));
  }

  const privs = (table: string, s: boolean, i: boolean, u: boolean, d: boolean): Privs => ({
    table,
    select: s,
    insert: i,
    update: u,
    delete: d,
    truncate: false,
  });

  test('app_tenant: S/I/U on tenant tables, S/I only on audit_log, and DELETE only on opt_outs, calendar_busy_blocks, calendar_event_links, door_exclusions and storm_photos', async () => {
    const deletable = new Set<string>(APP_TENANT_DELETE_TABLES);
    const expected = TENANT_TABLES.map((t) =>
      t === 'audit_log' ? privs(t, true, true, false, false) : privs(t, true, true, true, deletable.has(t)),
    );
    expect(await tablePrivileges('app_tenant', TENANT_TABLES)).toEqual(expected);
  });

  test('app_tenant may update the new company_settings and jobs columns, table-wide or column-level', async () => {
    const columns: [string, string][] = [
      ['company_settings', 'work_hours'],
      ['company_settings', 'travel_buffer_minutes'],
      ['company_settings', 'min_notice_minutes'],
      ['company_settings', 'stuck_after_days'],
      ['company_settings', 'default_pitch_x12'],
      ['company_settings', 'overhang_ft'],
      ['company_settings', 'proposal_valid_days'],
      ['company_settings', 'aerial_measure'],
      ['company_settings', 'estimate_change_clause'],
      ['jobs', 'next_step'],
      ['jobs', 'next_step_on'],
    ];
    const rows = await ownerQuery<{ table_name: string; column_name: string; can_update: boolean }>(
      `select t as table_name, c as column_name,
              has_column_privilege('app_tenant', 'public.' || t, c, 'UPDATE') as can_update
         from unnest($1::text[], $2::text[]) as v(t, c)`,
      [columns.map(([t]) => t), columns.map(([, c]) => c)],
    );
    expect(rows).toEqual(columns.map(([table_name, column_name]) => ({ table_name, column_name, can_update: true })));
  });

  test('app_tenant: SELECT only on the company-scoped global tables, nothing on the private ones', async () => {
    // texting_registrations has no table-level SELECT: only the column grants checked below.
    expect(await tablePrivileges('app_tenant', ['companies', ...COMPANY_SCOPED_GLOBALS])).toEqual([
      privs('companies', true, false, false, false),
      privs('company_phone_numbers', true, false, false, false),
      privs('texting_registrations', false, false, false, false),
    ]);
    expect(await tablePrivileges('app_tenant', PRIVATE_GLOBALS)).toEqual(
      PRIVATE_GLOBALS.map((t) => privs(t, false, false, false, false)),
    );
  });

  test('app_tenant may read every texting_registrations column except the subaccount auth token', async () => {
    const granted = await ownerQuery<{ column_name: string; privilege_type: string }>(
      `select column_name, privilege_type from information_schema.column_privileges
        where grantee = 'app_tenant' and table_schema = 'public' and table_name = 'texting_registrations'
        order by column_name, privilege_type`,
    );
    const all = await ownerQuery<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'texting_registrations' order by column_name`,
    );
    const expected = all
      .map((c) => c.column_name)
      .filter((c) => c !== 'subaccount_auth_token_encrypted')
      .map((column_name) => ({ column_name, privilege_type: 'SELECT' }));
    expect(expected).toHaveLength(all.length - 1);
    expect(granted).toEqual(expected);
    expect(granted.map((g) => g.column_name)).toEqual(
      expect.arrayContaining([
        'customer_profile_sid',
        'trust_product_sid',
        'brand_info',
        'rejected_fields',
        'last_checked_at',
      ]),
    );
  });

  test('app_tenant may update only the profile columns of companies (plus updated_at)', async () => {
    const rows = await ownerQuery<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where grantee = 'app_tenant' and table_schema = 'public' and table_name = 'companies'
          and privilege_type = 'UPDATE' order by column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([...COMPANY_PROFILE_COLUMNS, 'updated_at'].sort());
  });

  test('app_tenant has privileges on no other relation than the ones listed', async () => {
    // Extension-owned relations (PostGIS's spatial_ref_sys and geometry_columns views) are
    // readable by PUBLIC and hold no app data, so they are left out.
    const rows = await ownerQuery<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
          and (has_table_privilege('app_tenant', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
               or has_any_column_privilege('app_tenant', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))
          and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
        order by 1`,
    );
    expect(rows.map((r) => r.relname)).toEqual(
      [
        ...TENANT_TABLES,
        'companies',
        ...COMPANY_SCOPED_GLOBALS,
        'company_members',
        'building_footprints',
        ...HAIL_GLOBAL_TABLES,
      ].sort(),
    );
  });

  test('app_system: ALL on global tables, DELETE only on early_delivery_reports, and nothing else on tenant tables', async () => {
    expect(await tablePrivileges('app_system', GLOBAL_TABLES)).toEqual(
      GLOBAL_TABLES.map((t) => ({ ...privs(t, true, true, true, true), truncate: true })),
    );
    // calendar_connections holds column-level SELECT only (see the column test below), so it has no table-level privilege here.
    expect(await tablePrivileges('app_system', TENANT_TABLES)).toEqual(
      TENANT_TABLES.map((t) => privs(t, false, false, false, t === 'early_delivery_reports')),
    );
  });

  test('app_tenant has SELECT, INSERT and UPDATE but no DELETE on each E1 tenant table', async () => {
    expect(await tablePrivileges('app_tenant', E1_TENANT_TABLES)).toEqual(
      E1_TENANT_TABLES.map((t) => privs(t, true, true, true, false)),
    );
  });

  test('app_tenant has SELECT, INSERT and UPDATE on each S1 tenant table, and DELETE only on door_exclusions and storm_photos', async () => {
    expect(await tablePrivileges('app_tenant', S1_TENANT_TABLES)).toEqual(
      S1_TENANT_TABLES.map((t) => privs(t, true, true, true, t === 'door_exclusions' || t === 'storm_photos')),
    );
  });

  test('app_tenant has only SELECT on hail_runs, storms, storm_contours and spotter_reports', async () => {
    expect(await tablePrivileges('app_tenant', HAIL_GLOBAL_TABLES)).toEqual(
      HAIL_GLOBAL_TABLES.map((t) => privs(t, true, false, false, false)),
    );
  });

  test('app_hail privileges: SELECT, INSERT and UPDATE on the three hail tables, DELETE only on storm_contours', async () => {
    expect(await tablePrivileges('app_hail', ['hail_runs', 'storms', 'storm_contours'])).toEqual([
      privs('hail_runs', true, true, true, false),
      privs('storms', true, true, true, false),
      privs('storm_contours', true, true, true, true),
    ]);
  });

  test('app_hail has privileges on no other relation than the three hail tables', async () => {
    const rows = await ownerQuery<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
          and (has_table_privilege('app_hail', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
               or has_any_column_privilege('app_hail', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))
          and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
        order by 1`,
    );
    expect(rows.map((r) => r.relname)).toEqual(['hail_runs', 'storm_contours', 'storms']);
  });

  test('app_hail may use the hail_runs sequence and no other', async () => {
    const [row] = await ownerQuery<{ hail: boolean; spotter: boolean; footprints: boolean }>(
      `select has_sequence_privilege('app_hail', 'public.hail_runs_id_seq', 'USAGE') as hail,
              has_sequence_privilege('app_hail', 'public.spotter_reports_id_seq', 'USAGE') as spotter,
              has_sequence_privilege('app_hail', 'public.building_footprints_id_seq', 'USAGE') as footprints`,
    );
    expect(row).toEqual({ hail: true, spotter: false, footprints: false });
  });

  test('app_system: ALL on spotter_reports, SELECT and UPDATE (place_name) only on storms, nothing on the other hail tables', async () => {
    expect(await tablePrivileges('app_system', HAIL_GLOBAL_TABLES)).toEqual([
      privs('hail_runs', false, false, false, false),
      privs('storms', true, false, false, false),
      privs('storm_contours', false, false, false, false),
      { ...privs('spotter_reports', true, true, true, true), truncate: true },
    ]);
    const cols = await ownerQuery<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where grantee = 'app_system' and table_schema = 'public' and table_name = 'storms'
          and privilege_type = 'UPDATE' order by 1`,
    );
    expect(cols).toEqual([{ column_name: 'place_name' }]);
  });

  test('app_tenant: SELECT only on building_footprints, and no privilege on building_footprint_states', async () => {
    expect(await tablePrivileges('app_tenant', FOOTPRINT_TABLES)).toEqual([
      privs('building_footprints', true, false, false, false),
      privs('building_footprint_states', false, false, false, false),
    ]);
  });

  test('app_system has SELECT, INSERT, UPDATE and DELETE on both footprint tables', async () => {
    expect(await tablePrivileges('app_system', FOOTPRINT_TABLES)).toEqual(
      FOOTPRINT_TABLES.map((t) => ({ ...privs(t, true, true, true, true), truncate: true })),
    );
  });

  test('app_system holds column-level SELECT on exactly the whitelisted proposal and exact order columns', async () => {
    const rows = await ownerQuery<{ table_name: string; column_name: string; privilege_type: string }>(
      `select table_name, column_name, privilege_type from information_schema.column_privileges
        where grantee = 'app_system' and table_schema = 'public'
          and table_name in ('proposals', 'exact_report_orders')
        order by 1, 2, 3`,
    );
    const sel = (table_name: string, column_name: string) => ({ table_name, column_name, privilege_type: 'SELECT' });
    expect(rows).toEqual([
      sel('exact_report_orders', 'company_id'),
      sel('exact_report_orders', 'id'),
      sel('exact_report_orders', 'last_polled_at'),
      sel('exact_report_orders', 'status'),
      sel('proposals', 'company_id'),
      sel('proposals', 'id'),
      sel('proposals', 'link_token_hash'),
      sel('proposals', 'status'),
      sel('proposals', 'valid_until'),
    ]);
    const denied: [string, string][] = [
      ['proposals', 'link_token_encrypted'],
      ['proposals', 'message_body'],
      ['exact_report_orders', 'error_plain'],
    ];
    const checks = await ownerQuery<{ table_name: string; column_name: string; can_select: boolean }>(
      `select t as table_name, c as column_name,
              has_column_privilege('app_system', 'public.' || t, c, 'SELECT') as can_select
         from unnest($1::text[], $2::text[]) as v(t, c)`,
      [denied.map(([t]) => t), denied.map(([, c]) => c)],
    );
    expect(checks).toEqual(denied.map(([table_name, column_name]) => ({ table_name, column_name, can_select: false })));
  });

  test('app_system reads whitelisted proposal columns of every company with no app.company_id, while app_tenant sees none', async () => {
    for (const s of [seed.a, seed.b]) {
      const [customer] = await ownerQuery<{ id: string }>(
        `insert into customers (company_id, display_name) values ($1, 'Cust') returning id`,
        [s.companyId],
      );
      const propertyId = await insertProperty(s.companyId, customer!.id, `${s.companyId} main st|68102`);
      const [job] = await ownerQuery<{ id: string }>(
        `insert into jobs (company_id, customer_id, property_id) values ($1, $2, $3) returning id`,
        [s.companyId, customer!.id, propertyId],
      );
      const [measurement] = await ownerQuery<{ id: string }>(
        `insert into measurements (company_id, property_id, kind, method) values ($1, $2, 'estimate', 'manual') returning id`,
        [s.companyId, propertyId],
      );
      await ownerQuery(
        `insert into proposals (company_id, customer_id, property_id, job_id, measurement_id, number,
            status, valid_until, estimate_basis, link_token_hash, link_token_encrypted)
         values ($1, $2, $3, $4, $5, 'P-0001', 'draft', date '2026-12-31', 'estimate', $6, $7)`,
        [
          s.companyId,
          customer!.id,
          propertyId,
          job!.id,
          measurement!.id,
          Buffer.from(`hash-${s.companyId}`),
          Buffer.from('encrypted-placeholder'),
        ],
      );
    }

    const rows = await systemRaw<{ company_id: string; status: string; link_token_hash: Buffer }>(
      `select company_id, status, link_token_hash from proposals`,
    );
    expect(rows.map((r) => r.company_id).sort()).toEqual([seed.a.companyId, seed.b.companyId].sort());
    expect(rows.every((r) => r.status === 'draft')).toBe(true);
    await expect(systemRaw(`select message_body from proposals`)).rejects.toThrow(/permission denied/);
    await expect(systemRaw(`select link_token_encrypted from proposals`)).rejects.toThrow(/permission denied/);

    expect(await tenantRaw(`select count(*)::int n from proposals`)).toEqual([{ n: 0 }]);
    expect(await tenantRaw(`select count(*)::int n from proposals`, { companyId: seed.a.companyId })).toEqual([
      { n: 1 },
    ]);
  });

  test('neither app role may create schemas in the database (pg-boss runs with createSchema: false in the schema 0002 made)', async () => {
    const [row] = await ownerQuery<{ system: boolean; tenant: boolean }>(
      `select has_database_privilege('app_system', current_database(), 'CREATE') as system,
              has_database_privilege('app_tenant', current_database(), 'CREATE') as tenant`,
    );
    expect(row).toEqual({ system: false, tenant: false });
  });

  test('app_system: column-level SELECT on the scheduler columns, plus INSERT on the email_opt_outs unsubscribe columns', async () => {
    const rows = await ownerQuery<{ table_name: string; column_name: string; privilege_type: string }>(
      `select table_name, column_name, privilege_type from information_schema.column_privileges
        where grantee = 'app_system' and table_schema = 'public' and table_name = any($1::text[])
        order by 1, 2, 3`,
      [[...TENANT_TABLES]],
    );
    const sel = (table_name: string, column_name: string) => ({ table_name, column_name, privilege_type: 'SELECT' });
    const ins = (table_name: string, column_name: string) => ({ table_name, column_name, privilege_type: 'INSERT' });
    expect(rows).toEqual([
      sel('ad_campaigns', 'company_id'),
      sel('ad_campaigns', 'external_campaign_id'),
      sel('ad_campaigns', 'id'),
      sel('ad_campaigns', 'platform'),
      sel('ad_campaigns', 'status'),
      sel('agent_task_steps', 'company_id'),
      sel('agent_task_steps', 'id'),
      sel('agent_task_steps', 'lease_expires_at'),
      sel('agent_task_steps', 'run_seq'),
      sel('agent_task_steps', 'status'),
      sel('agent_task_steps', 'task_id'),
      sel('agent_task_steps', 'updated_at'),
      sel('agent_tasks', 'company_id'),
      sel('agent_tasks', 'expires_at'),
      sel('agent_tasks', 'id'),
      sel('agent_tasks', 'status'),
      sel('calendar_connections', 'company_id'),
      sel('calendar_connections', 'id'),
      sel('calendar_connections', 'last_synced_at'),
      sel('calendar_connections', 'status'),
      sel('calendar_connections', 'user_id'),
      sel('company_storms', 'company_id'),
      sel('company_storms', 'id'),
      sel('company_storms', 'last_matched_at'),
      sel('company_storms', 'plan_task_id'),
      sel('company_storms', 'status'),
      sel('company_storms', 'storm_id'),
      sel('early_delivery_reports', 'applied_at'),
      sel('early_delivery_reports', 'id'),
      sel('early_delivery_reports', 'received_at'),
      ins('email_opt_outs', 'at'),
      ins('email_opt_outs', 'company_id'),
      sel('email_opt_outs', 'company_id'),
      ins('email_opt_outs', 'email'),
      sel('email_opt_outs', 'email'),
      sel('email_opt_outs', 'id'),
      ins('email_opt_outs', 'source'),
      sel('exact_report_orders', 'company_id'),
      sel('exact_report_orders', 'id'),
      sel('exact_report_orders', 'last_polled_at'),
      sel('exact_report_orders', 'status'),
      sel('messages', 'company_id'),
      sel('messages', 'id'),
      sel('messages', 'scheduled_for'),
      sel('messages', 'status'),
      sel('proposals', 'company_id'),
      sel('proposals', 'id'),
      sel('proposals', 'link_token_hash'),
      sel('proposals', 'status'),
      sel('proposals', 'valid_until'),
      sel('storm_pages', 'active_until'),
      sel('storm_pages', 'code'),
      sel('storm_pages', 'company_id'),
      sel('storm_pages', 'company_storm_id'),
      sel('storm_pages', 'id'),
      sel('usage_events', 'company_id'),
      sel('usage_events', 'id'),
      sel('usage_events', 'kind'),
      sel('usage_events', 'reported_to_stripe_at'),
    ]);
  });

  test('app_tenant can update companies.location and service_area_miles, but not the billing columns', async () => {
    const companyId = seed.a.companyId;
    await tenantRaw(`update companies set service_area_miles = 20 where id = $1`, {
      companyId,
      values: [companyId],
    });
    await tenantRaw(`update companies set location = st_setsrid(st_makepoint(-95.9345, 41.2565), 4326) where id = $1`, {
      companyId,
      values: [companyId],
    });
    expect(await ownerQuery(`select service_area_miles from companies where id = $1`, [companyId])).toEqual([
      { service_area_miles: 20 },
    ]);
    for (const assignment of [
      `stripe_subscription_id = 'sub_x'`,
      `billing_event_at = now()`,
      `billing_period_start = now()`,
      `past_due_at = now()`,
    ]) {
      await expect(
        tenantRaw(`update companies set ${assignment} where id = $1`, { companyId, values: [companyId] }),
      ).rejects.toThrow(/permission denied/);
    }
  });
});

describe('app_tenant isolation', () => {
  test('tenant role sees zero rows when the company setting is absent', async () => {
    await insertCustomer(seed.a.companyId, 'Alice');
    expect(await tenantRaw(`select count(*)::int n from customers`)).toEqual([{ n: 0 }]);
  });

  test('tenant role sees zero rows when the setting is empty', async () => {
    await insertCustomer(seed.a.companyId, 'Alice');
    expect(await tenantRaw(`select count(*)::int n from customers`, { companyId: '' })).toEqual([{ n: 0 }]);
  });

  test('tenant role sees only its own company', async () => {
    const aId = await insertCustomer(seed.a.companyId, 'Alice');
    await insertCustomer(seed.b.companyId, 'Bob');
    const rows = await withTenant(pools, ctx(seed.a), (tx) => tx.select({ id: customers.id }).from(customers));
    expect(rows).toEqual([{ id: aId }]);
  });

  test('tenant role sees zero rows of another company even when asking for its id', async () => {
    const bId = await insertCustomer(seed.b.companyId, 'Bob');
    const rows = await withTenant(pools, ctx(seed.a), (tx) => tx.select().from(customers).where(eq(customers.id, bId)));
    expect(rows).toEqual([]);
  });

  test('insert with another company_id is rejected', async () => {
    const err = await dbError(
      withTenant(pools, ctx(seed.a), (tx) =>
        tx.insert(customers).values({ companyId: seed.b.companyId, displayName: 'Mallory' }),
      ),
    );
    expect(err.message).toMatch(/row-level security/);
    expect(await ownerQuery(`select count(*)::int n from customers`)).toEqual([{ n: 0 }]);
  });

  test('insert with no company setting is rejected', async () => {
    await expect(
      tenantRaw(`insert into customers (company_id, display_name) values ($1, 'Nobody')`, {
        values: [seed.a.companyId],
      }),
    ).rejects.toThrow(/row-level security/);
  });

  test('update that moves a row to another company is rejected', async () => {
    const aId = await insertCustomer(seed.a.companyId, 'Alice');
    const err = await dbError(
      withTenant(pools, ctx(seed.a), (tx) =>
        tx.update(customers).set({ companyId: seed.b.companyId }).where(eq(customers.id, aId)),
      ),
    );
    expect(err.message).toMatch(/row-level security/);
    expect(await ownerQuery(`select company_id from customers where id = $1`, [aId])).toEqual([
      { company_id: seed.a.companyId },
    ]);
  });

  test("update of another company's row changes nothing", async () => {
    const bId = await insertCustomer(seed.b.companyId, 'Bob');
    const updated = await withTenant(pools, ctx(seed.a), (tx) =>
      tx.update(customers).set({ displayName: 'Hacked' }).where(eq(customers.id, bId)).returning(),
    );
    expect(updated).toEqual([]);
    expect(await ownerQuery(`select display_name from customers where id = $1`, [bId])).toEqual([
      { display_name: 'Bob' },
    ]);
  });

  test('tenant role cannot update or delete audit_log', async () => {
    const [row] = await tenantRaw<{ id: string }>(
      `insert into audit_log (company_id, action) values ($1, 'test.event') returning id`,
      { companyId: seed.a.companyId, values: [seed.a.companyId] },
    );
    expect(row?.id).toBeTruthy();
    await expect(
      tenantRaw(`update audit_log set action = 'rewritten'`, { companyId: seed.a.companyId }),
    ).rejects.toThrow(/permission denied/);
    await expect(tenantRaw(`delete from audit_log`, { companyId: seed.a.companyId })).rejects.toThrow(
      /permission denied/,
    );
  });

  test('tenant role cannot delete customers (archive instead)', async () => {
    await insertCustomer(seed.a.companyId, 'Alice');
    await expect(tenantRaw(`delete from customers`, { companyId: seed.a.companyId })).rejects.toThrow(
      /permission denied/,
    );
  });

  test("tenant role can delete its own opt_outs but not another company's", async () => {
    await ownerQuery(
      `insert into opt_outs (company_id, phone_e164, keyword)
       values ($1, '+14025550144', 'STOP'), ($2, '+14025550144', 'STOP')`,
      [seed.a.companyId, seed.b.companyId],
    );
    const deleted = await tenantRaw(`delete from opt_outs returning company_id`, { companyId: seed.a.companyId });
    expect(deleted).toEqual([{ company_id: seed.a.companyId }]);
    expect(await ownerQuery(`select company_id from opt_outs`)).toEqual([{ company_id: seed.b.companyId }]);
  });

  test('tenant role reads its own companies row only and cannot change status', async () => {
    expect(await tenantRaw(`select id from companies`, { companyId: seed.a.companyId })).toEqual([
      { id: seed.a.companyId },
    ]);
    expect(
      await tenantRaw(`select id from companies where id = $1`, {
        companyId: seed.a.companyId,
        values: [seed.b.companyId],
      }),
    ).toEqual([]);
    expect(await tenantRaw(`select count(*)::int n from companies`)).toEqual([{ n: 0 }]);
    for (const column of ['status', 'plan_key', 'stripe_customer_id', 'trial_ends_at', 'slug']) {
      const value = column === 'status' ? `'active'` : column === 'trial_ends_at' ? 'now()' : `'x'`;
      await expect(
        tenantRaw(`update companies set ${column} = ${value} where id = $1`, {
          companyId: seed.a.companyId,
          values: [seed.a.companyId],
        }),
      ).rejects.toThrow(/permission denied/);
    }
  });

  test('tenant role can update its company profile through drizzle, but not another company', async () => {
    const mine = await withTenant(pools, ctx(seed.a), (tx) =>
      tx
        .update(companies)
        .set({ name: 'Acme Roofing Co', website: 'https://acme.test' })
        .where(eq(companies.id, seed.a.companyId))
        .returning({ id: companies.id, name: companies.name }),
    );
    expect(mine).toEqual([{ id: seed.a.companyId, name: 'Acme Roofing Co' }]);
    const theirs = await withTenant(pools, ctx(seed.a), (tx) =>
      tx.update(companies).set({ name: 'Hacked' }).where(eq(companies.id, seed.b.companyId)).returning(),
    );
    expect(theirs).toEqual([]);
    expect(await ownerQuery(`select name from companies where id = $1`, [seed.b.companyId])).toEqual([
      { name: 'Bolt Roofing' },
    ]);
  });

  test('tenant role can read its texting_registrations row but not write it', async () => {
    expect(
      await tenantRaw(`select company_id, campaign_status from texting_registrations`, {
        companyId: seed.a.companyId,
      }),
    ).toEqual([{ company_id: seed.a.companyId, campaign_status: 'approved' }]);
    await expect(
      tenantRaw(`update texting_registrations set campaign_status = 'none'`, { companyId: seed.a.companyId }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      tenantRaw(`insert into texting_registrations (company_id) values ($1)`, {
        companyId: seed.a.companyId,
        values: [seed.a.companyId],
      }),
    ).rejects.toThrow(/permission denied/);
  });

  test('tenant role cannot read the texting subaccount auth token, even its own', async () => {
    const tokenErr = await dbError(
      withTenant(pools, ctx(seed.a), (tx) =>
        tx.execute(sql`select subaccount_auth_token_encrypted from texting_registrations`),
      ),
    );
    expect(tokenErr.message).toMatch(/permission denied/);
    // A Drizzle select of the whole row names the token column too, so it is refused as well.
    const rowErr = await dbError(withTenant(pools, ctx(seed.a), (tx) => tx.select().from(textingRegistrations)));
    expect(rowErr.message).toMatch(/permission denied/);
    const status = await withTenant(pools, ctx(seed.a), (tx) =>
      tx.select({ campaignStatus: textingRegistrations.campaignStatus }).from(textingRegistrations),
    );
    expect(status).toEqual([{ campaignStatus: 'approved' }]);
  });

  test('tenant role can read its company_phone_numbers but not write them', async () => {
    await ownerQuery(
      `insert into company_phone_numbers (company_id, e164) values ($1, '+14025550100'), ($2, '+14025550101')`,
      [seed.a.companyId, seed.b.companyId],
    );
    expect(await tenantRaw(`select e164 from company_phone_numbers`, { companyId: seed.a.companyId })).toEqual([
      { e164: '+14025550100' },
    ]);
    await expect(
      tenantRaw(`insert into company_phone_numbers (company_id, e164) values ($1, '+14025550102')`, {
        companyId: seed.a.companyId,
        values: [seed.a.companyId],
      }),
    ).rejects.toThrow(/permission denied/);
  });

  test.each(PRIVATE_GLOBALS)('tenant role cannot read %s directly', async (table) => {
    await expect(tenantRaw(`select 1 from ${table} limit 1`, { companyId: seed.a.companyId })).rejects.toThrow(
      /permission denied/,
    );
  });

  test("company_members lists the current company's members only", async () => {
    type Member = {
      id: string;
      user_id: string;
      name: string;
      email: string;
      role: string;
      status: string;
      can_approve_spend: boolean;
    };
    const rows = await tenantRaw<Member>(`select * from company_members order by email`, {
      companyId: seed.a.companyId,
    });
    const memberships = await ownerQuery<{ id: string; user_id: string }>(
      `select id, user_id from memberships where company_id = $1`,
      [seed.a.companyId],
    );
    // can_approve_spend was appended by migration 0004; the first six keep their order.
    const columns = ['id', 'user_id', 'name', 'email', 'role', 'status', 'can_approve_spend'];
    expect(rows.map((r) => Object.keys(r))).toEqual(rows.map(() => columns));
    expect(rows.every((r) => r.can_approve_spend === false)).toBe(true);
    expect(rows.map((r) => r.email)).toEqual(['office@a.test', 'owner@a.test', 'rep2@a.test', 'rep@a.test']);
    expect(rows.every((r) => r.status === 'active')).toBe(true);
    expect(new Set(rows.map((r) => `${r.id}/${r.user_id}`))).toEqual(
      new Set(memberships.map((m) => `${m.id}/${m.user_id}`)),
    );
    expect(await tenantRaw(`select count(*)::int n from company_members`)).toEqual([{ n: 0 }]);
    expect(await tenantRaw(`select count(*)::int n from company_members`, { companyId: '' })).toEqual([{ n: 0 }]);
  });

  test('company_members shows each member\'s spend delegation, for the current company only', async () => {
    await ownerQuery(
      `update memberships set can_approve_spend = true
        where role = 'office' and company_id = $1`,
      [seed.a.companyId],
    );
    const a = await tenantRaw<{ email: string; can_approve_spend: boolean }>(
      `select email, can_approve_spend from company_members order by email`,
      { companyId: seed.a.companyId },
    );
    expect(a).toEqual([
      { email: 'office@a.test', can_approve_spend: true },
      { email: 'owner@a.test', can_approve_spend: false },
      { email: 'rep2@a.test', can_approve_spend: false },
      { email: 'rep@a.test', can_approve_spend: false },
    ]);
    const b = await tenantRaw<{ can_approve_spend: boolean }>(`select can_approve_spend from company_members`, {
      companyId: seed.b.companyId,
    });
    expect(b.map((r) => r.can_approve_spend)).toEqual([false, false, false, false]);
  });

  test('an app_tenant session in company A cannot link a company-A job to a company-B customer', async () => {
    const bCustomer = await insertCustomer(seed.b.companyId, 'Bob');
    const aProperty = await insertProperty(seed.a.companyId, null, '1 main st|68102');
    let error: unknown;
    try {
      await tenantRaw(`insert into jobs (company_id, customer_id, property_id) values ($1, $2, $3)`, {
        companyId: seed.a.companyId,
        values: [seed.a.companyId, bCustomer, aProperty],
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(pg.DatabaseError);
    const { code, message } = error as pg.DatabaseError;
    expect(code === '23503' || /row-level security/.test(message)).toBe(true);
    expect(await ownerQuery(`select count(*)::int n from jobs`)).toEqual([{ n: 0 }]);
  });

  test.each<[string, string]>([
    ['setup_items', `insert into setup_items (company_id, key) values ($1, 'company_basics')`],
    ['imports', `insert into imports (company_id, file_name) values ($1, 'customers.csv')`],
    [
      'early_delivery_reports',
      `insert into early_delivery_reports (company_id, provider_message_sid, status) values ($1, 'SM' || repeat('a', 32), 'delivered')`,
    ],
  ])('tenant role sees and writes only its own %s rows and cannot delete them', async (table, insert) => {
    await ownerQuery(insert, [seed.a.companyId]);
    await ownerQuery(insert, [seed.b.companyId]);
    expect(await tenantRaw(`select company_id from ${table}`, { companyId: seed.a.companyId })).toEqual([
      { company_id: seed.a.companyId },
    ]);
    await expect(
      tenantRaw(insert, { companyId: seed.a.companyId, values: [seed.b.companyId] }),
    ).rejects.toThrow(/row-level security/);
    await expect(tenantRaw(`delete from ${table}`, { companyId: seed.a.companyId })).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('withTenant', () => {
  test('sets app.company_id for its transaction only', async () => {
    const inside = await withTenant(pools, ctx(seed.a), async (tx) => {
      const res = await tx.execute<{ pid: number; v: string }>(
        sql`select pg_backend_pid() as pid, current_setting('app.company_id', true) as v`,
      );
      return res.rows[0]!;
    });
    expect(inside.v).toBe(seed.a.companyId);
    // The pool hands back its most recently released connection, so this runs on the same backend.
    const after = await pools.tenant.execute<{ pid: number; v: string | null }>(
      sql`select pg_backend_pid() as pid, nullif(current_setting('app.company_id', true), '') as v`,
    );
    expect(after.rows[0]).toEqual({ pid: inside.pid, v: null });
  });

  test('rolls back everything when fn throws', async () => {
    await expect(
      withTenant(pools, ctx(seed.a), async (tx) => {
        await tx.insert(customers).values({ companyId: seed.a.companyId, displayName: 'Ghost' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await ownerQuery(`select count(*)::int n from customers`)).toEqual([{ n: 0 }]);
  });

  test('relational queries work on the transaction', async () => {
    await insertCustomer(seed.a.companyId, 'Alice');
    const bId = await insertCustomer(seed.b.companyId, 'Bob');
    const rows = await withTenant(pools, ctx(seed.b), (tx) =>
      tx.query.customers.findMany({ columns: { id: true, displayName: true } }),
    );
    expect(rows).toEqual([{ id: bId, displayName: 'Bob' }]);
  });

  test('the system context role is accepted', async () => {
    const systemCtx: TenantContext = {
      companyId: seed.a.companyId,
      userId: null,
      role: 'system',
      canApproveSpend: false,
    };
    const rows = await withTenant(pools, systemCtx, (tx) => tx.select({ id: companies.id }).from(companies));
    expect(rows).toEqual([{ id: seed.a.companyId }]);
  });
});

describe('app_system', () => {
  test('with no app.company_id set, app_system reads the whitelisted columns of every company (its policies, not a bypass)', async () => {
    for (const s of [seed.a, seed.b]) {
      const task = await insertTask(s.companyId, 'Storm plan');
      await ownerQuery(
        `insert into agent_task_steps (company_id, task_id, position, type, approval_class, idempotency_key)
         values ($1, $2, 1, 'send_sms_batch', 'message', $3)`,
        [s.companyId, task, `k1-${s.companyId}`],
      );
      await ownerQuery(
        `insert into messages (company_id, channel, direction, purpose, body, status, scheduled_for)
         values ($1, 'sms', 'out', 'marketing', 'Hi', 'scheduled', now())`,
        [s.companyId],
      );
      await ownerQuery(`insert into usage_events (company_id, kind, quantity) values ($1, 'sms_segment', 1)`, [
        s.companyId,
      ]);
      await ownerQuery(
        `insert into calendar_connections (company_id, user_id, provider, encrypted_credentials)
         values ($1, $2, 'google', $3)`,
        [s.companyId, s.owner.userId, Buffer.from('encrypted-placeholder')],
      );
    }
    await ownerQuery(
      `insert into company_phone_numbers (company_id, e164) values ($1, '+14025550100'), ($2, '+14025550101')`,
      [seed.a.companyId, seed.b.companyId],
    );
    const reads = {
      companies: `select id as company_id, status, plan_key from companies`,
      company_phone_numbers: `select company_id, e164 from company_phone_numbers`,
      texting_registrations: `select company_id, campaign_status, subaccount_auth_token_encrypted from texting_registrations`,
      agent_tasks: `select id, company_id, status, expires_at from agent_tasks`,
      agent_task_steps: `select id, task_id, company_id, status, updated_at, lease_expires_at, run_seq from agent_task_steps`,
      messages: `select id, company_id, status, scheduled_for from messages`,
      usage_events: `select id, company_id, kind, reported_to_stripe_at from usage_events`,
      calendar_connections: `select id, company_id, user_id, status, last_synced_at from calendar_connections`,
    } satisfies Record<
      Exclude<
        (typeof APP_SYSTEM_RLS_TABLES)[number],
        | 'early_delivery_reports'
        | 'proposals'
        | 'exact_report_orders'
        | 'company_storms'
        | 'ad_campaigns'
        | 'storm_pages'
        | 'email_opt_outs'
      >,
      string
    >;

    const client = new pg.Client({ connectionString: urls.system });
    await client.connect();
    try {
      const [who] = (await client.query(`select current_user as role, current_setting('app.company_id', true) as setting`)).rows;
      expect(who.role).toBe('app_system');
      expect(who.setting ?? '').toBe('');
      for (const [table, text] of Object.entries(reads)) {
        const rows = (await client.query<{ company_id: string }>(text)).rows;
        expect(rows.map((r) => r.company_id).sort(), table).toEqual([seed.a.companyId, seed.b.companyId].sort());
      }
    } finally {
      await client.end();
    }
  });

  test('system role can read only whitelisted columns of agent_tasks', async () => {
    await insertTask(seed.a.companyId, 'Storm plan A');
    await insertTask(seed.b.companyId, 'Storm plan B');
    const rows = await systemRaw<{ company_id: string }>(
      `select id, company_id, status, expires_at from agent_tasks order by company_id`,
    );
    expect(rows.map((r) => r.company_id).sort()).toEqual([seed.a.companyId, seed.b.companyId].sort());
    await expect(systemRaw(`select title from agent_tasks`)).rejects.toThrow(/permission denied/);
    await expect(systemRaw(`select * from agent_tasks`)).rejects.toThrow(/permission denied/);
  });

  test('system role can read only whitelisted columns of agent_task_steps and messages', async () => {
    const task = await insertTask(seed.a.companyId, 'Storm plan A');
    await ownerQuery(
      `insert into agent_task_steps (company_id, task_id, position, type, approval_class, idempotency_key)
       values ($1, $2, 1, 'send_sms_batch', 'message', 'k1')`,
      [seed.a.companyId, task],
    );
    await ownerQuery(
      `insert into messages (company_id, channel, direction, purpose, body, status, scheduled_for)
       values ($1, 'sms', 'out', 'marketing', 'Hi', 'scheduled', now())`,
      [seed.b.companyId],
    );
    expect(
      await systemRaw(`select id, task_id, company_id, status, updated_at, lease_expires_at, run_seq from agent_task_steps`),
    ).toHaveLength(1);
    expect(await systemRaw(`select id, company_id, status, scheduled_for from messages`)).toHaveLength(1);
    await expect(systemRaw(`select payload from agent_task_steps`)).rejects.toThrow(/permission denied/);
    await expect(systemRaw(`select attempts from agent_task_steps`)).rejects.toThrow(/permission denied/);
    // The sweeper only lists; the writes are app_tenant's, per company.
    await expect(systemRaw(`update agent_task_steps set status = 'queued'`)).rejects.toThrow(/permission denied/);
    await expect(systemRaw(`update agent_tasks set status = 'expired'`)).rejects.toThrow(/permission denied/);
    await expect(systemRaw(`select body from messages`)).rejects.toThrow(/permission denied/);
    await expect(systemRaw(`update messages set status = 'sent'`)).rejects.toThrow(/permission denied/);
  });

  test('system role can read only the reporting columns of usage_events, and cannot write them', async () => {
    await ownerQuery(
      `insert into usage_events (company_id, kind, quantity) values ($1, 'sms_segment', 1), ($2, 'ai_call_minute', 1)`,
      [seed.a.companyId, seed.b.companyId],
    );
    const rows = await systemRaw<{ company_id: string; kind: string }>(
      `select id, company_id, kind, reported_to_stripe_at from usage_events`,
    );
    expect(rows.map((r) => r.company_id).sort()).toEqual([seed.a.companyId, seed.b.companyId].sort());
    expect(rows.map((r) => r.kind).sort()).toEqual(['ai_call_minute', 'sms_segment']);
    await expect(systemRaw(`select quantity from usage_events`)).rejects.toThrow(/permission denied/);
    await expect(systemRaw(`update usage_events set reported_to_stripe_at = now()`)).rejects.toThrow(/permission denied/);
  });

  test('system role reads only the prune columns of early_delivery_reports across companies, cannot update, and may delete', async () => {
    const insert = `insert into early_delivery_reports (company_id, provider_message_sid, status) values ($1, 'SM' || repeat('a', 32), 'delivered')`;
    await ownerQuery(insert, [seed.a.companyId]);
    await ownerQuery(insert, [seed.b.companyId]);
    expect(await systemRaw(`select id, received_at, applied_at from early_delivery_reports`)).toHaveLength(2);
    await expect(systemRaw(`select company_id from early_delivery_reports`)).rejects.toThrow(/permission denied/);
    await expect(systemRaw(`select status from early_delivery_reports`)).rejects.toThrow(/permission denied/);
    await expect(systemRaw(`select reason from early_delivery_reports`)).rejects.toThrow(/permission denied/);
    await expect(systemRaw(`update early_delivery_reports set applied_at = now()`)).rejects.toThrow(/permission denied/);
    expect(await systemRaw(`delete from early_delivery_reports returning id`)).toHaveLength(2);
    expect(await ownerQuery(`select count(*)::int as n from early_delivery_reports`)).toEqual([{ n: 0 }]);
  });

  test('system role cannot read or write tenant content', async () => {
    await insertCustomer(seed.a.companyId, 'Alice');
    await expect(systemRaw(`select id from customers`)).rejects.toThrow(/permission denied/);
    await expect(
      systemRaw(`insert into customers (company_id, display_name) values ($1, 'x')`, [seed.a.companyId]),
    ).rejects.toThrow(/permission denied/);
  });

  test('system role reads and writes global tables across companies through the pool', async () => {
    const members = await pools.system.execute<{ n: number }>(sql`select count(*)::int as n from memberships`);
    expect(members.rows).toEqual([{ n: 8 }]);
    const updated = await pools.system
      .update(companies)
      .set({ status: 'active', planKey: 'pro' })
      .where(eq(companies.id, seed.b.companyId))
      .returning({ status: companies.status });
    expect(updated).toEqual([{ status: 'active' }]);
    const regs = await systemRaw(`select company_id from texting_registrations`);
    expect(regs).toHaveLength(2);
  });
});

describe('S1 storm tables', () => {
  /** A company_storm for a company, with the storm it points at. Returns both ids. */
  async function makeCompanyStorm(companyId: string, stormId?: string): Promise<{ stormId: string; id: string }> {
    const storm = stormId ?? (await insertStorm());
    const [row] = await ownerQuery<{ id: string }>(
      `insert into company_storms (company_id, storm_id, max_in) values ($1, $2, 1.50) returning id`,
      [companyId, storm],
    );
    return { stormId: storm, id: row!.id };
  }

  test('S1 tables are tenant tables with RLS forced', async () => {
    expect([...TENANT_TABLES]).toEqual(expect.arrayContaining([...S1_TENANT_TABLES]));
    for (const table of S1_TENANT_TABLES) {
      const [cls] = await ownerQuery<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `select relrowsecurity, relforcerowsecurity from pg_class where oid = $1::regclass`,
        [`public.${table}`],
      );
      expect(cls, table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const policies = await ownerQuery<{ policyname: string }>(
        `select policyname from pg_policies where schemaname = 'public' and tablename = $1`,
        [table],
      );
      expect(policies.map((p) => p.policyname), table).toContain('tenant_isolation');
    }
  });

  test('the global hail tables carry no row-level security', async () => {
    const rows = await ownerQuery<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
        where relnamespace = 'public'::regnamespace and relname = any($1::text[]) order by 1`,
      [[...HAIL_GLOBAL_TABLES]],
    );
    expect(rows).toEqual([
      { relname: 'hail_runs', relrowsecurity: false },
      { relname: 'spotter_reports', relrowsecurity: false },
      { relname: 'storm_contours', relrowsecurity: false },
      { relname: 'storms', relrowsecurity: false },
    ]);
  });

  test('app_hail can SELECT, INSERT and UPDATE hail_runs, storms and storm_contours, and DELETE contours', async () => {
    const [run] = await hailRaw<{ id: string }>(
      `insert into hail_runs (source_key, valid_at, convective_day, status, max_in)
       values ('mrms-1', now(), date '2026-10-11', 'processed', 1.25) returning id`,
    );
    expect(run?.id).toBeTruthy();
    await hailRaw(`update hail_runs set max_in = 1.5 where source_key = 'mrms-1'`);
    expect(await hailRaw(`select max_in::float as max_in from hail_runs`)).toEqual([{ max_in: 1.5 }]);

    const [storm] = await hailRaw<{ id: string }>(
      `insert into storms (convective_day, max_in, geom_075, bbox, centroid)
       values (date '2026-10-11', 1.50, ${MULTI_SQUARE}, ${SQUARE}, ${CENTER}) returning id`,
    );
    await hailRaw(`update storms set status = 'final', max_in = 2 where id = $1`, [storm!.id]);
    expect(await hailRaw(`select status from storms where id = $1`, [storm!.id])).toEqual([{ status: 'final' }]);

    await hailRaw(`insert into storm_contours (storm_id, threshold_in, geom) values ($1, 1, ${MULTI_SQUARE})`, [
      storm!.id,
    ]);
    await hailRaw(`update storm_contours set threshold_in = 1.25 where storm_id = $1`, [storm!.id]);
    expect(await hailRaw(`select threshold_in::float as t from storm_contours`)).toEqual([{ t: 1.25 }]);
    expect(await hailRaw(`delete from storm_contours where storm_id = $1 returning storm_id`, [storm!.id])).toHaveLength(1);
  });

  test('app_hail cannot delete runs or storms', async () => {
    await insertStorm();
    for (const text of [`delete from storms`, `delete from hail_runs`]) {
      const err = await rejectedWith(() => hailRaw(text));
      expect(err.code, text).toBe('42501');
    }
  });

  test('app_hail cannot SELECT customers (42501)', async () => {
    await insertCustomer(seed.a.companyId, 'Alice');
    const err = await rejectedWith(() => hailRaw(`select id from customers`));
    expect(err.code).toBe('42501');
  });

  test('app_hail has no access to any tenant table or to the company_members view', async () => {
    for (const table of [...TENANT_TABLES, 'company_members', 'companies', 'users', 'memberships']) {
      const err = await rejectedWith(() => hailRaw(`select count(*) from ${table}`));
      expect(err.code, table).toBe('42501');
    }
  });

  test('app_hail cannot touch spotter_reports (42501)', async () => {
    for (const text of [
      `select id from spotter_reports`,
      `insert into spotter_reports (report_date, time_utc, size_in, state, geom)
       values (date '2026-10-11', time '18:05', 1.25, 'NE', ${CENTER})`,
      `update spotter_reports set size_in = 2`,
      `delete from spotter_reports`,
    ]) {
      const err = await rejectedWith(() => hailRaw(text));
      expect(err.code, text).toBe('42501');
    }
  });

  test('app_tenant reads storms under any app.company_id and cannot INSERT, UPDATE or DELETE them (42501)', async () => {
    const stormId = await insertStorm();
    for (const companyId of [seed.a.companyId, seed.b.companyId]) {
      expect(await tenantRaw(`select id from storms`, { companyId })).toEqual([{ id: stormId }]);
    }
    expect(await tenantRaw(`select id from storms`)).toEqual([{ id: stormId }]);
    for (const text of [
      `insert into storms (convective_day, max_in, geom_075, bbox, centroid)
       values (date '2026-10-11', 1, ${MULTI_SQUARE}, ${SQUARE}, ${CENTER})`,
      `update storms set max_in = 3`,
      `delete from storms`,
    ]) {
      const err = await rejectedWith(() => tenantRaw(text, { companyId: seed.a.companyId }));
      expect(err.code, text).toBe('42501');
    }
  });

  test('app_tenant reads hail_runs, storm_contours and spotter_reports and writes none of them', async () => {
    const stormId = await insertStorm();
    await ownerQuery(`insert into storm_contours (storm_id, threshold_in, geom) values ($1, 1, ${MULTI_SQUARE})`, [
      stormId,
    ]);
    await ownerQuery(
      `insert into hail_runs (source_key, valid_at, convective_day, status) values ('k', now(), date '2026-10-11', 'failed')`,
    );
    await ownerQuery(
      `insert into spotter_reports (report_date, time_utc, size_in, state, geom)
       values (date '2026-10-11', time '18:05', 1.25, 'NE', ${CENTER})`,
    );
    for (const table of ['hail_runs', 'storm_contours', 'spotter_reports']) {
      expect(await tenantRaw(`select count(*)::int n from ${table}`, { companyId: seed.a.companyId }), table).toEqual([
        { n: 1 },
      ]);
      const err = await rejectedWith(() => tenantRaw(`delete from ${table}`, { companyId: seed.a.companyId }));
      expect(err.code, table).toBe('42501');
    }
  });

  test('app_system can update storms.place_name but not storms.max_in (42501)', async () => {
    const stormId = await insertStorm();
    await systemRaw(`update storms set place_name = 'Omaha, NE' where id = $1`, [stormId]);
    expect(await ownerQuery(`select place_name from storms where id = $1`, [stormId])).toEqual([
      { place_name: 'Omaha, NE' },
    ]);
    for (const text of [
      `update storms set max_in = 3 where id = $1`,
      `update storms set status = 'final' where id = $1`,
      `delete from storms where id = $1`,
    ]) {
      const err = await rejectedWith(() => systemRaw(text, [stormId]));
      expect(err.code, text).toBe('42501');
    }
  });

  test('app_system loads spotter_reports with the bigserial sequence', async () => {
    const [row] = await systemRaw<{ id: string }>(
      `insert into spotter_reports (report_date, time_utc, size_in, state, geom)
       values (date '2026-10-11', time '18:05', 1.25, 'NE', ${CENTER}) returning id`,
    );
    expect(row?.id).toBeTruthy();
    expect(await systemRaw(`delete from spotter_reports returning id`)).toHaveLength(1);
  });

  test('tenant role sees and writes only its own company_storms rows and cannot delete them', async () => {
    const stormId = await insertStorm();
    const a = await makeCompanyStorm(seed.a.companyId, stormId);
    await makeCompanyStorm(seed.b.companyId, stormId);
    expect(await tenantRaw(`select company_id from company_storms`, { companyId: seed.a.companyId })).toEqual([
      { company_id: seed.a.companyId },
    ]);
    const insert = `insert into company_storms (company_id, storm_id, max_in) values ($1, $2, 1)`;
    const err = await rejectedWith(() =>
      tenantRaw(insert, { companyId: seed.a.companyId, values: [seed.b.companyId, stormId] }),
    );
    expect(err.message).toMatch(/row-level security/);
    await tenantRaw(`update company_storms set status = 'planned' where id = $1`, {
      companyId: seed.a.companyId,
      values: [a.id],
    });
    const del = await rejectedWith(() =>
      tenantRaw(`delete from company_storms`, { companyId: seed.a.companyId }),
    );
    expect(del.code).toBe('42501');
  });

  test('door_exclusions and storm_photos allow DELETE for app_tenant, door_stops does not', async () => {
    const [file] = await ownerQuery<{ id: string }>(
      `insert into stored_files (company_id, kind, object_key, sha256, bytes, content_type)
       values ($1, 'storm_photo', 'k1', repeat('a', 64), 10, 'image/jpeg') returning id`,
      [seed.a.companyId],
    );
    await ownerQuery(`insert into storm_photos (company_id, stored_file_id) values ($1, $2)`, [
      seed.a.companyId,
      file!.id,
    ]);
    await ownerQuery(`insert into door_exclusions (company_id, footprint_id, reason) values ($1, 42, 'asked')`, [
      seed.a.companyId,
    ]);
    const companyId = seed.a.companyId;
    expect(await tenantRaw(`delete from door_exclusions returning id`, { companyId })).toHaveLength(1);
    expect(await tenantRaw(`delete from storm_photos returning id`, { companyId })).toHaveLength(1);

    const cs = await makeCompanyStorm(companyId);
    const [route] = await ownerQuery<{ id: string }>(
      `insert into door_routes (company_id, company_storm_id, user_id, name) values ($1, $2, $3, 'R1') returning id`,
      [companyId, cs.id, seed.a.owner.userId],
    );
    await ownerQuery(
      `insert into door_stops (company_id, route_id, position, point) values ($1, $2, 1, ${CENTER})`,
      [companyId, route!.id],
    );
    const err = await rejectedWith(() => tenantRaw(`delete from door_stops`, { companyId }));
    expect(err.code).toBe('42501');
  });

  test('storm_pages.code is unique across companies (23505)', async () => {
    const stormId = await insertStorm();
    const insertPage = (companyId: string, companyStormId: string) =>
      ownerQuery(
        `insert into storm_pages (company_id, company_storm_id, code, active_until)
         values ($1, $2, 'abc123', now() + interval '14 days')`,
        [companyId, companyStormId],
      );
    const a = await makeCompanyStorm(seed.a.companyId, stormId);
    const b = await makeCompanyStorm(seed.b.companyId, stormId);
    await insertPage(seed.a.companyId, a.id);
    const err = await rejectedWith(() => insertPage(seed.b.companyId, b.id));
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('storm_pages_code_uniq');
  });

  test('app_system reads the whitelisted columns of company_storms, ad_campaigns and storm_pages across companies', async () => {
    const stormId = await insertStorm();
    for (const s of [seed.a, seed.b]) {
      const cs = await makeCompanyStorm(s.companyId, stormId);
      await ownerQuery(
        `insert into storm_pages (company_id, company_storm_id, code, active_until)
         values ($1, $2, $3, now() + interval '14 days')`,
        [s.companyId, cs.id, `code-${s.companyId}`],
      );
    }
    const both = [seed.a.companyId, seed.b.companyId].sort();
    const stormRows = await systemRaw<{ company_id: string }>(
      `select id, company_id, storm_id, status, plan_task_id, last_matched_at from company_storms`,
    );
    expect(stormRows.map((r) => r.company_id).sort()).toEqual(both);
    const pageRows = await systemRaw<{ company_id: string }>(
      `select id, company_id, code, active_until, company_storm_id from storm_pages`,
    );
    expect(pageRows.map((r) => r.company_id).sort()).toEqual(both);
    for (const text of [
      `select max_in from company_storms`,
      `select customers_hit from company_storms`,
      `select address from storm_requests`,
      `select creative from ad_campaigns`,
      `update company_storms set status = 'dismissed'`,
    ]) {
      const err = await rejectedWith(() => systemRaw(text));
      expect(err.code, text).toBe('42501');
    }
    expect(await tenantRaw(`select count(*)::int n from company_storms`)).toEqual([{ n: 0 }]);
  });

  test('email_opt_outs: app_system can INSERT (company_id, email, source) but not UPDATE, DELETE or SELECT other columns', async () => {
    await systemRaw(`insert into email_opt_outs (company_id, email, source) values ($1, 'Pat@Example.com', 'one_click')`, [
      seed.a.companyId,
    ]);
    const stored = await ownerQuery<{ email: string; source: string; at: Date }>(
      `select email::text, source, at from email_opt_outs`,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ email: 'Pat@Example.com', source: 'one_click' });
    expect(stored[0]!.at).toBeInstanceOf(Date);
    expect(await systemRaw(`select id, company_id, email from email_opt_outs`)).toHaveLength(1);
    for (const text of [
      `select source from email_opt_outs`,
      `select at from email_opt_outs`,
      `update email_opt_outs set source = 'manual'`,
      `delete from email_opt_outs`,
    ]) {
      const err = await rejectedWith(() => systemRaw(text));
      expect(err.code, text).toBe('42501');
    }
    // The same address is refused twice for one company (case-insensitive), free for another company.
    const dup = await rejectedWith(() =>
      systemRaw(`insert into email_opt_outs (company_id, email, source) values ($1, 'pat@example.com', 'manual')`, [
        seed.a.companyId,
      ]),
    );
    expect(dup.code).toBe('23505');
    await systemRaw(`insert into email_opt_outs (company_id, email, source) values ($1, 'pat@example.com', 'manual')`, [
      seed.b.companyId,
    ]);
  });

  test('app_tenant sees only its own email_opt_outs, and app_system cannot write other tenant tables', async () => {
    await ownerQuery(
      `insert into email_opt_outs (company_id, email, source) values ($1, 'a@x.test', 'link'), ($2, 'b@x.test', 'link')`,
      [seed.a.companyId, seed.b.companyId],
    );
    expect(await tenantRaw(`select email::text from email_opt_outs`, { companyId: seed.a.companyId })).toEqual([
      { email: 'a@x.test' },
    ]);
    const err = await rejectedWith(() =>
      systemRaw(`insert into storm_requests (company_id, storm_page_id, name, phone_e164, address) values ($1, $2, 'x', 'y', 'z')`, [
        seed.a.companyId,
        seed.a.owner.userId,
      ]),
    );
    expect(err.code).toBe('42501');
  });
});
