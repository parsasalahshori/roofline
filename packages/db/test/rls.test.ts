import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/migrate.ts';
import { createPools, type Pools } from '../src/pools.ts';
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
  'calls',
] as const;
/** Tenant tables app_tenant may delete from. No other tenant table grants it DELETE. */
const APP_TENANT_DELETE_TABLES = [
  'opt_outs',
  'calendar_busy_blocks',
  'calendar_event_links',
  'calendar_connections',
  'blocked_numbers',
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

async function insertConversation(companyId: string, channel: 'voice' | 'sms', phone: string): Promise<string> {
  const [row] = await ownerQuery<{ id: string }>(
    `insert into conversations (company_id, channel, phone_e164, company_number_e164)
     values ($1, $2, $3, '+14025550100') returning id`,
    [companyId, channel, phone],
  );
  return row!.id;
}

/** A call SID is 'CA' plus 32 hex digits; the company id's hex digits make it unique per company. */
const callSidFor = (companyId: string) => `CA${companyId.replaceAll('-', '')}`;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: urls.owner });
  await owner.connect();
  pools = createPools({ tenant: urls.tenant, system: urls.system });
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

  test('app_tenant: S/I/U on tenant tables, S/I only on audit_log and conversation_turns, S/I/D on blocked_numbers, and DELETE only on opt_outs, calendar_busy_blocks, calendar_event_links, calendar_connections and blocked_numbers', async () => {
    const deletable = new Set<string>(APP_TENANT_DELETE_TABLES);
    const expected = TENANT_TABLES.map((t) =>
      // audit_log is append-only; conversation_turns is updated by column only (see the column test below).
      t === 'audit_log' || t === 'conversation_turns'
        ? privs(t, true, true, false, false)
        : t === 'blocked_numbers'
          ? privs(t, true, true, false, true)
          : privs(t, true, true, true, deletable.has(t)),
    );
    expect(await tablePrivileges('app_tenant', TENANT_TABLES)).toEqual(expected);
  });

  test('app_tenant: DELETE only on blocked_numbers among the D1 tables; conversation_turns has no table-level UPDATE', async () => {
    expect(
      await tablePrivileges('app_tenant', ['conversations', 'calls', 'conversation_turns', 'claim_intakes', 'blocked_numbers']),
    ).toEqual([
      privs('conversations', true, true, true, false),
      privs('calls', true, true, true, false),
      privs('conversation_turns', true, true, false, false),
      privs('claim_intakes', true, true, true, false),
      privs('blocked_numbers', true, true, false, true),
    ]);
  });

  test('app_tenant UPDATE on conversation_turns is column-level: text, tool_calls and truncated only', async () => {
    const columns: [string, boolean][] = [
      ['text', true],
      ['tool_calls', true],
      ['truncated', true],
      ['speaker', false],
      ['position', false],
    ];
    const rows = await ownerQuery<{ column_name: string; can_update: boolean }>(
      `select c as column_name, has_column_privilege('app_tenant', 'public.conversation_turns', c, 'UPDATE') as can_update
         from unnest($1::text[]) as c`,
      [columns.map(([c]) => c)],
    );
    expect(rows).toEqual(columns.map(([column_name, can_update]) => ({ column_name, can_update })));
  });

  test('review note 31: the unused D1 grants are gone (app_system on conversations, turns and the call recording columns; app_tenant UPDATE on blocked_numbers and anything on line_lookups)', async () => {
    const [row] = await ownerQuery<Record<string, boolean>>(
      `select has_any_column_privilege('app_system', 'public.conversations', 'SELECT,INSERT,UPDATE') as conversations,
              has_any_column_privilege('app_system', 'public.conversation_turns', 'SELECT,INSERT,UPDATE') as turns,
              has_column_privilege('app_system', 'public.calls', 'conversation_id', 'SELECT') as call_conversation,
              has_column_privilege('app_system', 'public.calls', 'recording_key', 'SELECT') as call_key_select,
              has_column_privilege('app_system', 'public.calls', 'recording_status', 'SELECT') as call_status_select,
              has_any_column_privilege('app_system', 'public.calls', 'UPDATE') as call_update,
              has_column_privilege('app_system', 'public.calls', 'call_sid', 'SELECT') as call_sid,
              has_table_privilege('app_tenant', 'public.blocked_numbers', 'UPDATE') as blocked_update,
              has_table_privilege('app_tenant', 'public.line_lookups', 'SELECT') as lookups`,
    );
    expect(row).toEqual({
      conversations: false,
      turns: false,
      call_conversation: false,
      call_key_select: false,
      call_status_select: false,
      call_update: false,
      call_sid: true,
      blocked_update: false,
      lookups: false,
    });
  });

  test('app_tenant and app_system: line_lookups is a global cache, app_system read/write and app_tenant has no grant', async () => {
    expect(await tablePrivileges('app_system', ['line_lookups'])).toEqual([privs('line_lookups', true, true, true, false)]);
    expect(await tablePrivileges('app_tenant', ['line_lookups'])).toEqual([privs('line_lookups', false, false, false, false)]);
  });

  test('app_tenant may update the new company_settings and jobs columns, table-wide or column-level', async () => {
    const columns: [string, string][] = [
      ['company_settings', 'work_hours'],
      ['company_settings', 'travel_buffer_minutes'],
      ['company_settings', 'min_notice_minutes'],
      ['company_settings', 'stuck_after_days'],
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
      [...TENANT_TABLES, 'companies', ...COMPANY_SCOPED_GLOBALS, 'company_members'].sort(),
    );
  });

  test('app_system: only the privileges its code uses on global tables, DELETE only on early_delivery_reports, and nothing else on tenant tables', async () => {
    const expected: Record<(typeof GLOBAL_TABLES)[number], Privs> = {
      users: privs('users', true, true, true, true),
      sessions: privs('sessions', true, true, true, true),
      memberships: privs('memberships', true, true, true, true),
      invites: privs('invites', true, true, true, true),
      user_tokens: privs('user_tokens', true, true, true, true),
      webhook_events: privs('webhook_events', true, true, false, false),
      companies: privs('companies', true, true, true, true),
      company_phone_numbers: privs('company_phone_numbers', true, true, false, false),
      texting_registrations: privs('texting_registrations', true, true, true, false),
    };
    expect(await tablePrivileges('app_system', GLOBAL_TABLES)).toEqual(GLOBAL_TABLES.map((t) => expected[t]));
    // calendar_connections holds column-level SELECT only (see the column test below), so it has no table-level privilege here.
    expect(await tablePrivileges('app_system', TENANT_TABLES)).toEqual(
      TENANT_TABLES.map((t) => privs(t, false, false, false, t === 'early_delivery_reports')),
    );
  });

  test('app_system holds no TRUNCATE, TRIGGER or REFERENCES on any relation in public', async () => {
    // TRUNCATE skips row-level security; TRIGGER would let it plant code that runs as another role.
    const rows = await ownerQuery<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
          and (has_table_privilege('app_system', c.oid, 'TRUNCATE,TRIGGER,REFERENCES')
               or has_any_column_privilege('app_system', c.oid, 'REFERENCES'))
        order by 1`,
    );
    expect(rows).toEqual([]);
  });

  test('neither app role may create schemas in the database (pg-boss runs with createSchema: false in the schema 0002 made)', async () => {
    const [row] = await ownerQuery<{ system: boolean; tenant: boolean }>(
      `select has_database_privilege('app_system', current_database(), 'CREATE') as system,
              has_database_privilege('app_tenant', current_database(), 'CREATE') as tenant`,
    );
    expect(row).toEqual({ system: false, tenant: false });
  });

  test('app_system: column-level SELECT only on the scheduler columns', async () => {
    const rows = await ownerQuery<{ table_name: string; column_name: string; privilege_type: string }>(
      `select table_name, column_name, privilege_type from information_schema.column_privileges
        where grantee = 'app_system' and table_schema = 'public' and table_name = any($1::text[])
        order by 1, 2, 3`,
      [[...TENANT_TABLES]],
    );
    const sel = (table_name: string, column_name: string) => ({ table_name, column_name, privilege_type: 'SELECT' });
    expect(rows).toEqual([
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
      sel('calls', 'call_sid'),
      sel('calls', 'company_id'),
      sel('calls', 'id'),
      sel('calls', 'status'),
      sel('early_delivery_reports', 'applied_at'),
      sel('early_delivery_reports', 'id'),
      sel('early_delivery_reports', 'received_at'),
      sel('messages', 'company_id'),
      sel('messages', 'id'),
      sel('messages', 'scheduled_for'),
      sel('messages', 'status'),
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

/**
 * C1 tables with no other behavioural isolation test (security finding 22). Each case makes one row
 * for a company as the owner (with the parents it needs, all in that company), and names a column
 * the tenant role may set. Company A's session must not read, change or delete B's row, must not
 * move its own row to B, and must not insert a row carrying B's company_id.
 */
describe('app_tenant isolation on the C1 calendar, schedule and pricing tables', () => {
  async function connectionFor(company: SeededCompany): Promise<string> {
    const [row] = await ownerQuery<{ id: string }>(
      `insert into calendar_connections (company_id, user_id, provider, encrypted_credentials)
       values ($1, $2, 'google', $3) returning id`,
      [company.companyId, company.owner.userId, Buffer.from('encrypted-placeholder')],
    );
    return row!.id;
  }

  async function appointmentFor(company: SeededCompany): Promise<string> {
    const [row] = await ownerQuery<{ id: string }>(
      `insert into appointments (company_id, kind, starts_at, ends_at)
       values ($1, 'other', now(), now() + interval '1 hour') returning id`,
      [company.companyId],
    );
    return row!.id;
  }

  type Case = {
    table: string;
    /** The insert statement and its values for `company`, its parents made first. */
    insert: (company: SeededCompany) => Promise<{ text: string; values: unknown[] }>;
    /** A column assignment the tenant role is allowed to make; null when app_tenant holds no UPDATE (0020). */
    set: string | null;
    /** app_tenant holds DELETE on the table. */
    deletable: boolean;
  };

  const CASES: Case[] = [
    {
      table: 'calendar_event_links',
      insert: async (c) => ({
        text: `insert into calendar_event_links (company_id, appointment_id, connection_id, provider_event_id)
               values ($1, $2, $3, $4) returning id`,
        values: [c.companyId, await appointmentFor(c), await connectionFor(c), `evt-${c.companyId}`],
      }),
      set: `etag = 'changed'`,
      deletable: true,
    },
    {
      table: 'calendar_busy_blocks',
      insert: async (c) => ({
        text: `insert into calendar_busy_blocks (company_id, connection_id, user_id, provider_event_id, starts_at, ends_at)
               values ($1, $2, $3, $4, now(), now() + interval '1 hour') returning id`,
        values: [c.companyId, await connectionFor(c), c.owner.userId, `busy-${c.companyId}`],
      }),
      set: `all_day = true`,
      deletable: true,
    },
    {
      table: 'member_schedules',
      insert: async (c) => ({
        text: `insert into member_schedules (company_id, user_id, weekly_hours) values ($1, $2, '{}'::jsonb) returning id`,
        values: [c.companyId, c.owner.userId],
      }),
      set: `weekly_hours = '{"mon": []}'::jsonb`,
      deletable: false,
    },
    {
      table: 'pricebooks',
      insert: async (c) => ({
        text: `insert into pricebooks (company_id, prices) values ($1, '{}'::jsonb) returning id`,
        values: [c.companyId],
      }),
      set: `prices = '{"changed": true}'::jsonb`,
      deletable: false,
    },
    {
      table: 'quote_counters',
      insert: async (c) => ({
        text: `insert into quote_counters (company_id) values ($1) returning id`,
        values: [c.companyId],
      }),
      set: `next_number = 99`,
      deletable: false,
    },
  ];

  async function rowFor(c: Case, company: SeededCompany): Promise<string> {
    const { text, values } = await c.insert(company);
    const [row] = await ownerQuery<{ id: string }>(text, values);
    return row!.id;
  }

  /** The row as the owner sees it, to show a refused write changed nothing. */
  const ownerRow = (c: Case, id: string) => ownerQuery(`select * from ${c.table} where id = $1`, [id]);

  test.each(CASES.map((c) => [c.table, c] as const))('%s: company A reads only its own rows, never B\'s by id', async (_t, c) => {
    const aId = await rowFor(c, seed.a);
    const bId = await rowFor(c, seed.b);
    expect(await tenantRaw(`select id, company_id from ${c.table}`, { companyId: seed.a.companyId })).toEqual([
      { id: aId, company_id: seed.a.companyId },
    ]);
    expect(
      await tenantRaw(`select id from ${c.table} where id = $1`, { companyId: seed.a.companyId, values: [bId] }),
    ).toEqual([]);
    expect(
      await tenantRaw(`select id from ${c.table} where company_id = $1`, {
        companyId: seed.a.companyId,
        values: [seed.b.companyId],
      }),
    ).toEqual([]);
  });

  test.each(CASES.map((c) => [c.table, c] as const))("%s: company A cannot change or delete B's row", async (_t, c) => {
    await rowFor(c, seed.a);
    const bId = await rowFor(c, seed.b);
    const before = await ownerRow(c, bId);

    expect(
      await tenantRaw(`update ${c.table} set ${c.set} where id = $1 returning id`, {
        companyId: seed.a.companyId,
        values: [bId],
      }),
    ).toEqual([]);
    if (c.deletable) {
      expect(
        await tenantRaw(`delete from ${c.table} where id = $1 returning id`, { companyId: seed.a.companyId, values: [bId] }),
      ).toEqual([]);
    }
    expect(await ownerRow(c, bId)).toEqual(before);
  });

  test.each(CASES.map((c) => [c.table, c] as const))('%s: company A cannot move its own row to B', async (_t, c) => {
    const aId = await rowFor(c, seed.a);
    const before = await ownerRow(c, aId);
    let error: unknown;
    try {
      await tenantRaw(`update ${c.table} set company_id = $1 where id = $2`, {
        companyId: seed.a.companyId,
        values: [seed.b.companyId, aId],
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(pg.DatabaseError);
    const { code, message } = error as pg.DatabaseError;
    // RLS's WITH CHECK refuses it; a same-company foreign key may refuse it first.
    expect(code === '23503' || /row-level security/.test(message)).toBe(true);
    expect(await ownerRow(c, aId)).toEqual(before);
  });

  test.each(CASES.map((c) => [c.table, c] as const))("%s: company A cannot insert a row with B's company_id", async (_t, c) => {
    // B's parents exist (made by the owner), so only row-level security stands in the way.
    const { text, values } = await c.insert(seed.b);
    await expect(tenantRaw(text, { companyId: seed.a.companyId, values })).rejects.toThrow(/row-level security/);
    expect(await ownerQuery(`select count(*)::int n from ${c.table}`)).toEqual([{ n: 0 }]);
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
      const conversation = await insertConversation(s.companyId, 'voice', '+14025550120');
      await ownerQuery(
        `insert into calls (company_id, call_sid, from_e164, to_e164, conversation_id)
         values ($1, $2, '+14025550121', '+14025550100', $3)`,
        [s.companyId, callSidFor(s.companyId), conversation],
      );
      await ownerQuery(
        `insert into conversation_turns (company_id, conversation_id, position, speaker, text)
         values ($1, $2, 1, 'caller', 'Hi')`,
        [s.companyId, conversation],
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
      calls: `select id, company_id, call_sid, status from calls`,
    } satisfies Record<Exclude<(typeof APP_SYSTEM_RLS_TABLES)[number], 'early_delivery_reports'>, string>;

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

describe('front desk tables', () => {
  /** One conversation, call, turn, claim intake and blocked number for a company; `tag` makes the numbers differ. */
  async function seedFrontDesk(companyId: string, tag: string): Promise<void> {
    const conversation = await insertConversation(companyId, 'voice', `+1402555${tag}`);
    await ownerQuery(
      `insert into calls (company_id, call_sid, from_e164, to_e164, conversation_id)
       values ($1, $2, $3, '+14025550100', $4)`,
      [companyId, callSidFor(companyId), `+1402555${tag}`, conversation],
    );
    await ownerQuery(
      `insert into conversation_turns (company_id, conversation_id, position, speaker, text)
       values ($1, $2, 1, 'caller', 'Hi')`,
      [companyId, conversation],
    );
    await ownerQuery(
      `insert into claim_intakes (company_id, insurer, description, taken_by)
       values ($1, 'State Farm', 'Hail on the north slope', 'front_desk')`,
      [companyId],
    );
    await ownerQuery(`insert into blocked_numbers (company_id, e164) values ($1, $2)`, [companyId, `+1402556${tag}`]);
  }

  test('app_tenant cannot DELETE conversation_turns', async () => {
    const conversation = await insertConversation(seed.a.companyId, 'voice', '+14025550130');
    await ownerQuery(
      `insert into conversation_turns (company_id, conversation_id, position, speaker, text)
       values ($1, $2, 1, 'caller', 'Hi')`,
      [seed.a.companyId, conversation],
    );
    const err = await dbError(withTenant(pools, ctx(seed.a), (tx) => tx.execute(sql`delete from conversation_turns`)));
    expect(err.code).toBe('42501');
    expect(await ownerQuery(`select count(*)::int as n from conversation_turns`)).toEqual([{ n: 1 }]);
  });

  test('app_tenant sees only its own company in each D1 table', async () => {
    await seedFrontDesk(seed.a.companyId, '1001');
    await seedFrontDesk(seed.b.companyId, '2001');
    const tables = ['conversations', 'calls', 'conversation_turns', 'claim_intakes', 'blocked_numbers'] as const;
    for (const table of tables) {
      const rows = await tenantRaw<{ company_id: string }>(`select company_id from ${table}`, {
        companyId: seed.a.companyId,
      });
      expect(rows.map((r) => r.company_id), table).toEqual([seed.a.companyId]);
    }
  });

  test('app_system holds exactly the column privileges the call, turn and conversation fan-outs need', async () => {
    const checks: [string, string, string, boolean][] = [
      ['calls', 'id', 'SELECT', true],
      ['calls', 'company_id', 'SELECT', true],
      ['calls', 'call_sid', 'SELECT', true],
      ['calls', 'status', 'SELECT', true],
      ['calls', 'conversation_id', 'SELECT', false],
      ['calls', 'from_e164', 'SELECT', false],
      ['calls', 'recording_key', 'SELECT', false],
      ['calls', 'recording_key', 'UPDATE', false],
      ['calls', 'recording_status', 'UPDATE', false],
      ['calls', 'from_e164', 'UPDATE', false],
      ['calls', 'recording_status', 'SELECT', false],
      // Review note 31: app_system has no grant on conversations or the turns, and writes no column of calls.
      // Ruling BF: app_system never reads or writes transcript text or tool records.
      ['conversation_turns', 'at', 'SELECT', false],
      ['conversation_turns', 'text', 'UPDATE', false],
      ['conversation_turns', 'tool_calls', 'UPDATE', false],
      ['conversation_turns', 'speaker', 'UPDATE', false],
      ['conversation_turns', 'text', 'SELECT', false],
      ['conversation_turns', 'tool_calls', 'SELECT', false],
      ['conversations', 'status', 'SELECT', false],
      // Task 17's voice-URL repair marks the number; nothing else on company_phone_numbers changes.
      ['company_phone_numbers', 'capabilities', 'UPDATE', true],
      ['company_phone_numbers', 'updated_at', 'UPDATE', true],
      ['company_phone_numbers', 'e164', 'UPDATE', false],
      ['company_phone_numbers', 'status', 'UPDATE', false],
      ['conversations', 'phone_e164', 'SELECT', false],
    ];
    const rows = await ownerQuery<{ table_name: string; column_name: string; privilege: string; allowed: boolean }>(
      `select t as table_name, c as column_name, p as privilege,
              has_column_privilege('app_system', 'public.' || t, c, p) as allowed
         from unnest($1::text[], $2::text[], $3::text[]) as v(t, c, p)`,
      [checks.map(([t]) => t), checks.map(([, c]) => c), checks.map(([, , p]) => p)],
    );
    expect(rows).toEqual(
      checks.map(([table_name, column_name, privilege, allowed]) => ({ table_name, column_name, privilege, allowed })),
    );
  });
});

/**
 * D1 tables (security finding 36, as finding 22 did for C1 and E1). Each case makes one row for a
 * company as the owner (with the parents it needs, all in that company) and names a column the tenant
 * role may set. Company A's session must not read, change or delete B's row, must not move its own row
 * to B, and must not insert a row carrying B's company_id. Column-level grants are respected: app_tenant
 * holds no UPDATE on conversation_turns.company_id, so moving a turn is refused by the grant itself.
 */
describe('app_tenant isolation on the D1 tables', () => {
  type Case = {
    table: string;
    /** The insert statement and its values for `company`, its parents made first. */
    insert: (company: SeededCompany) => Promise<{ text: string; values: unknown[] }>;
    /** A column assignment the tenant role is allowed to make. */
    set: string;
    /** app_tenant holds DELETE on the table. */
    deletable: boolean;
    /** app_tenant may UPDATE company_id (else the grant refuses the move). */
    movable: boolean;
  };

  let phoneSeq = 0;
  const nextPhone = () => `+1402557${String(1000 + ++phoneSeq)}`;

  const CASES: Case[] = [
    {
      table: 'conversations',
      insert: async (c) => ({
        text: `insert into conversations (company_id, channel, phone_e164, company_number_e164)
               values ($1, 'sms', $2, '+14025550100') returning id`,
        values: [c.companyId, nextPhone()],
      }),
      set: `summary = 'changed'`,
      deletable: false,
      movable: true,
    },
    {
      table: 'calls',
      insert: async (c) => ({
        text: `insert into calls (company_id, call_sid, from_e164, to_e164) values ($1, $2, $3, '+14025550100') returning id`,
        values: [c.companyId, callSidFor(c.companyId), nextPhone()],
      }),
      set: `status = 'ended'`,
      deletable: false,
      movable: true,
    },
    {
      table: 'conversation_turns',
      insert: async (c) => ({
        text: `insert into conversation_turns (company_id, conversation_id, position, speaker, text)
               values ($1, $2, 1, 'caller', 'Hi') returning id`,
        values: [c.companyId, await insertConversation(c.companyId, 'voice', nextPhone())],
      }),
      set: `text = 'changed'`,
      deletable: false,
      movable: false,
    },
    {
      table: 'claim_intakes',
      insert: async (c) => ({
        text: `insert into claim_intakes (company_id, insurer, description, taken_by)
               values ($1, 'State Farm', 'Hail on the north slope', 'front_desk') returning id`,
        values: [c.companyId],
      }),
      set: `insurer = 'Changed'`,
      deletable: false,
      movable: true,
    },
    {
      table: 'blocked_numbers',
      insert: async (c) => ({
        text: `insert into blocked_numbers (company_id, e164) values ($1, $2) returning id`,
        values: [c.companyId, nextPhone()],
      }),
      set: null,
      deletable: true,
      movable: false,
    },
  ];

  test('every case is a tenant table', () => {
    for (const c of CASES) expect(TENANT_TABLES as readonly string[], c.table).toContain(c.table);
  });

  async function rowFor(c: Case, company: SeededCompany): Promise<string> {
    const { text, values } = await c.insert(company);
    const [row] = await ownerQuery<{ id: string }>(text, values);
    return row!.id;
  }

  /** The row as the owner sees it, to show a refused write changed nothing. */
  const ownerRow = (c: Case, id: string) => ownerQuery(`select * from ${c.table} where id = $1`, [id]);

  test.each(CASES.map((c) => [c.table, c] as const))("%s: company A reads only its own rows, never B's by id", async (_t, c) => {
    const aId = await rowFor(c, seed.a);
    const bId = await rowFor(c, seed.b);
    expect(await tenantRaw(`select id, company_id from ${c.table}`, { companyId: seed.a.companyId })).toEqual([
      { id: aId, company_id: seed.a.companyId },
    ]);
    expect(
      await tenantRaw(`select id from ${c.table} where id = $1`, { companyId: seed.a.companyId, values: [bId] }),
    ).toEqual([]);
    expect(
      await tenantRaw(`select id from ${c.table} where company_id = $1`, {
        companyId: seed.a.companyId,
        values: [seed.b.companyId],
      }),
    ).toEqual([]);
  });

  test.each(CASES.map((c) => [c.table, c] as const))("%s: company A cannot change or delete B's row", async (_t, c) => {
    await rowFor(c, seed.a);
    const bId = await rowFor(c, seed.b);
    const before = await ownerRow(c, bId);
    if (c.set === null) {
      await expect(
        tenantRaw(`update ${c.table} set company_id = company_id where id = $1`, { companyId: seed.a.companyId, values: [bId] }),
      ).rejects.toMatchObject({ code: '42501' });
    } else {
      expect(
        await tenantRaw(`update ${c.table} set ${c.set} where id = $1 returning id`, {
          companyId: seed.a.companyId,
          values: [bId],
        }),
      ).toEqual([]);
    }
    if (c.deletable) {
      expect(
        await tenantRaw(`delete from ${c.table} where id = $1 returning id`, { companyId: seed.a.companyId, values: [bId] }),
      ).toEqual([]);
    }
    expect(await ownerRow(c, bId)).toEqual(before);
  });

  test.each(CASES.map((c) => [c.table, c] as const))('%s: company A can change its own row (the control)', async (_t, c) => {
    const aId = await rowFor(c, seed.a);
    if (c.set === null) {
      // No UPDATE grant at all (blocked_numbers: insert-on-conflict and delete are enough).
      expect(c.deletable).toBe(true);
      expect(
        await tenantRaw(`delete from ${c.table} where id = $1 returning id`, { companyId: seed.a.companyId, values: [aId] }),
      ).toEqual([{ id: aId }]);
      return;
    }
    expect(
      await tenantRaw(`update ${c.table} set ${c.set} where id = $1 returning id`, {
        companyId: seed.a.companyId,
        values: [aId],
      }),
    ).toEqual([{ id: aId }]);
  });

  test.each(CASES.map((c) => [c.table, c] as const))('%s: company A cannot move its own row to B', async (_t, c) => {
    const aId = await rowFor(c, seed.a);
    const before = await ownerRow(c, aId);
    let error: unknown;
    try {
      await tenantRaw(`update ${c.table} set company_id = $1 where id = $2`, {
        companyId: seed.a.companyId,
        values: [seed.b.companyId, aId],
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(pg.DatabaseError);
    const { code, message } = error as pg.DatabaseError;
    if (c.movable) {
      // RLS's WITH CHECK refuses it; a same-company foreign key may refuse it first.
      expect(code === '23503' || /row-level security/.test(message)).toBe(true);
    } else {
      expect(code).toBe('42501');
    }
    expect(await ownerRow(c, aId)).toEqual(before);
  });

  test.each(CASES.map((c) => [c.table, c] as const))("%s: company A cannot insert a row with B's company_id", async (_t, c) => {
    // B's parents exist (made by the owner), so only row-level security stands in the way.
    const { text, values } = await c.insert(seed.b);
    await expect(tenantRaw(text, { companyId: seed.a.companyId, values })).rejects.toThrow(/row-level security/);
    expect(await ownerQuery(`select count(*)::int n from ${c.table}`)).toEqual([{ n: 0 }]);
  });

  // Cross-company references: a company-A row pointing at a company-B parent. The composite
  // (company_id, id) foreign keys refuse it (23503); RLS may refuse it first.
  async function callFor(companyId: string): Promise<string> {
    const [row] = await ownerQuery<{ id: string }>(
      `insert into calls (company_id, call_sid, from_e164, to_e164) values ($1, $2, $3, '+14025550100') returning id`,
      [companyId, callSidFor(companyId), nextPhone()],
    );
    return row!.id;
  }

  async function jobFor(companyId: string): Promise<string> {
    const customer = await insertCustomer(companyId, 'Job Owner');
    const property = await insertProperty(companyId, customer, `${companyId}|68102`);
    const [row] = await ownerQuery<{ id: string }>(
      `insert into jobs (company_id, customer_id, property_id) values ($1, $2, $3) returning id`,
      [companyId, customer, property],
    );
    return row!.id;
  }

  async function messageFor(companyId: string): Promise<string> {
    const [row] = await ownerQuery<{ id: string }>(
      `insert into messages (company_id, channel, direction, body, status) values ($1, 'sms', 'out', 'Hi', 'sent') returning id`,
      [companyId],
    );
    return row!.id;
  }

  async function claimFor(companyId: string): Promise<string> {
    const [row] = await ownerQuery<{ id: string }>(
      `insert into claim_intakes (company_id, insurer, description, taken_by)
       values ($1, 'State Farm', 'Hail', 'front_desk') returning id`,
      [companyId],
    );
    return row!.id;
  }

  type FkCase = {
    name: string;
    /** Makes A's and B's rows as the owner; returns the tenant statement A runs and a check that nothing was written. */
    attempt: () => Promise<{ text: string; values: unknown[]; unchanged: () => Promise<void> }>;
  };

  const turnCount = async () => (await ownerQuery<{ n: number }>(`select count(*)::int n from conversation_turns`))[0]!.n;
  const columnOf = async (table: string, column: string, id: string) =>
    (await ownerQuery<Record<string, unknown>>(`select ${column} as v from ${table} where id = $1`, [id]))[0]!['v'];

  const FK_CASES: FkCase[] = [
    {
      name: "conversation_turns.conversation_id (insert) to B's conversation",
      attempt: async () => {
        const bConversation = await insertConversation(seed.b.companyId, 'voice', nextPhone());
        return {
          text: `insert into conversation_turns (company_id, conversation_id, position, speaker, text) values ($1, $2, 1, 'caller', 'Hi')`,
          values: [seed.a.companyId, bConversation],
          unchanged: async () => expect(await turnCount()).toBe(0),
        };
      },
    },
    {
      name: "conversation_turns.call_id (insert) to B's call",
      attempt: async () => {
        const aConversation = await insertConversation(seed.a.companyId, 'voice', nextPhone());
        const bCall = await callFor(seed.b.companyId);
        return {
          text: `insert into conversation_turns (company_id, conversation_id, call_id, position, speaker, text)
                 values ($1, $2, $3, 1, 'caller', 'Hi')`,
          values: [seed.a.companyId, aConversation, bCall],
          unchanged: async () => expect(await turnCount()).toBe(0),
        };
      },
    },
    {
      name: "claim_intakes.job_id (insert) to B's job",
      attempt: async () => {
        const bJob = await jobFor(seed.b.companyId);
        return {
          text: `insert into claim_intakes (company_id, job_id, insurer, description, taken_by) values ($1, $2, 'X', 'Hail', 'front_desk')`,
          values: [seed.a.companyId, bJob],
          unchanged: async () =>
            expect(await ownerQuery(`select count(*)::int n from claim_intakes where company_id = $1`, [seed.a.companyId])).toEqual([{ n: 0 }]),
        };
      },
    },
    {
      name: "claim_intakes.job_id (update) to B's job",
      attempt: async () => {
        const aClaim = await claimFor(seed.a.companyId);
        const bJob = await jobFor(seed.b.companyId);
        return {
          text: `update claim_intakes set job_id = $1 where id = $2`,
          values: [bJob, aClaim],
          unchanged: async () => expect(await columnOf('claim_intakes', 'job_id', aClaim)).toBeNull(),
        };
      },
    },
    {
      name: "claim_intakes.conversation_id (insert) to B's conversation",
      attempt: async () => {
        const bConversation = await insertConversation(seed.b.companyId, 'voice', nextPhone());
        return {
          text: `insert into claim_intakes (company_id, conversation_id, insurer, description, taken_by) values ($1, $2, 'X', 'Hail', 'front_desk')`,
          values: [seed.a.companyId, bConversation],
          unchanged: async () =>
            expect(await ownerQuery(`select count(*)::int n from claim_intakes where company_id = $1`, [seed.a.companyId])).toEqual([{ n: 0 }]),
        };
      },
    },
    {
      name: "claim_intakes.conversation_id (update) to B's conversation",
      attempt: async () => {
        const aClaim = await claimFor(seed.a.companyId);
        const bConversation = await insertConversation(seed.b.companyId, 'voice', nextPhone());
        return {
          text: `update claim_intakes set conversation_id = $1 where id = $2`,
          values: [bConversation, aClaim],
          unchanged: async () => expect(await columnOf('claim_intakes', 'conversation_id', aClaim)).toBeNull(),
        };
      },
    },
    {
      name: "calls.text_back_message_id (update) to B's message",
      attempt: async () => {
        const aCall = await callFor(seed.a.companyId);
        const bMessage = await messageFor(seed.b.companyId);
        return {
          text: `update calls set text_back_message_id = $1 where id = $2`,
          values: [bMessage, aCall],
          unchanged: async () => expect(await columnOf('calls', 'text_back_message_id', aCall)).toBeNull(),
        };
      },
    },
    {
      name: "calls.text_back_message_id (insert) to B's message",
      attempt: async () => {
        const bMessage = await messageFor(seed.b.companyId);
        return {
          text: `insert into calls (company_id, call_sid, from_e164, to_e164, text_back_message_id) values ($1, $2, $3, '+14025550100', $4)`,
          values: [seed.a.companyId, callSidFor(seed.a.companyId), nextPhone(), bMessage],
          unchanged: async () =>
            expect(await ownerQuery(`select count(*)::int n from calls where company_id = $1`, [seed.a.companyId])).toEqual([{ n: 0 }]),
        };
      },
    },
    {
      name: "messages.conversation_id (update) to B's conversation",
      attempt: async () => {
        const aMessage = await messageFor(seed.a.companyId);
        const bConversation = await insertConversation(seed.b.companyId, 'sms', nextPhone());
        return {
          text: `update messages set conversation_id = $1 where id = $2`,
          values: [bConversation, aMessage],
          unchanged: async () => expect(await columnOf('messages', 'conversation_id', aMessage)).toBeNull(),
        };
      },
    },
    {
      name: "messages.conversation_id (insert) to B's conversation",
      attempt: async () => {
        const bConversation = await insertConversation(seed.b.companyId, 'sms', nextPhone());
        return {
          text: `insert into messages (company_id, conversation_id, channel, direction, body, status) values ($1, $2, 'sms', 'in', 'Hi', 'received')`,
          values: [seed.a.companyId, bConversation],
          unchanged: async () =>
            expect(await ownerQuery(`select count(*)::int n from messages where company_id = $1`, [seed.a.companyId])).toEqual([{ n: 0 }]),
        };
      },
    },
    {
      name: "conversations.customer_id (update) to B's customer",
      attempt: async () => {
        const aConversation = await insertConversation(seed.a.companyId, 'sms', nextPhone());
        const bCustomer = await insertCustomer(seed.b.companyId, 'Bob');
        return {
          text: `update conversations set customer_id = $1 where id = $2`,
          values: [bCustomer, aConversation],
          unchanged: async () => expect(await columnOf('conversations', 'customer_id', aConversation)).toBeNull(),
        };
      },
    },
    {
      name: "conversations.customer_id (insert) to B's customer",
      attempt: async () => {
        const bCustomer = await insertCustomer(seed.b.companyId, 'Bob');
        return {
          text: `insert into conversations (company_id, customer_id, channel, phone_e164, company_number_e164) values ($1, $2, 'sms', $3, '+14025550100')`,
          values: [seed.a.companyId, bCustomer, nextPhone()],
          unchanged: async () =>
            expect(await ownerQuery(`select count(*)::int n from conversations where company_id = $1`, [seed.a.companyId])).toEqual([{ n: 0 }]),
        };
      },
    },
  ];

  test.each(FK_CASES.map((c) => [c.name, c] as const))('company A cannot point %s', async (_n, c) => {
    const { text, values, unchanged } = await c.attempt();
    let error: unknown;
    try {
      await tenantRaw(text, { companyId: seed.a.companyId, values });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(pg.DatabaseError);
    const { code, message } = error as pg.DatabaseError;
    expect(code === '23503' || /row-level security/.test(message)).toBe(true);
    await unchanged();
  });
});
