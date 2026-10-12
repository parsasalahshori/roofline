import { scrypt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { eq, getTableName, is } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgTable } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { MIGRATIONS_FOLDER, migrate } from '../src/migrate.ts';
import { companies, customers, properties } from '../src/schema/index.ts';
import * as tenantSchema from '../src/schema/tenant.ts';
import { TENANT_TABLES } from '../src/schema/tenant.ts';
import { resetDb, seedTwoCompanies } from '../src/testing/index.ts';

const urls = inject('dbUrls');
const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

let client: pg.Client;

async function ownerQuery<T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const res = await client.query<T>(text, values);
  return res.rows;
}

async function count(table: string, companyId: string): Promise<number> {
  const rows = await ownerQuery<{ n: number }>(`select count(*)::int as n from ${table} where company_id = $1`, [
    companyId,
  ]);
  return rows[0]!.n;
}

/** Runs a statement that must be rejected and returns the Postgres error. */
async function rejected(text: string, values: unknown[] = []): Promise<pg.DatabaseError> {
  try {
    await client.query(text, values);
  } catch (err) {
    return err as pg.DatabaseError;
  }
  throw new Error(`Expected this statement to be rejected: ${text}`);
}

beforeAll(async () => {
  client = new pg.Client({ connectionString: urls.owner });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
});

describe('schema', () => {
  test('every tenant table has a non-null company_id', async () => {
    const rows = await ownerQuery<{ table_name: string }>(`select table_name from information_schema.columns
      where table_schema='public' and column_name='company_id' and is_nullable='NO'`);
    expect(rows.map((r) => r.table_name)).toEqual(expect.arrayContaining([...TENANT_TABLES]));
  });

  test('TENANT_TABLES lists exactly the tables defined in schema/tenant.ts', () => {
    const defined = Object.values(tenantSchema as Record<string, unknown>)
      .filter((v): v is PgTable => is(v, PgTable))
      .map((t) => getTableName(t));
    expect([...defined].sort()).toEqual([...TENANT_TABLES].sort());
  });

  test('the postgis and citext extensions are installed', async () => {
    const rows = await ownerQuery<{ extname: string }>(
      `select extname from pg_extension where extname in ('postgis','citext')`,
    );
    expect(rows.map((r) => r.extname).sort()).toEqual(['citext', 'postgis']);
  });

  test('geometry columns have the right type and SRID', async () => {
    // Filter to the two known tables so a geometry column added later doesn't break this test.
    const rows = await ownerQuery<{ f_table_name: string; f_geometry_column: string; srid: number; type: string }>(
      `select f_table_name, f_geometry_column, srid, type from geometry_columns
        where f_table_schema='public' and f_table_name in ('companies', 'properties') order by 1, 2`,
    );
    expect(rows).toEqual([
      { f_table_name: 'companies', f_geometry_column: 'location', srid: 4326, type: 'POINT' },
      { f_table_name: 'companies', f_geometry_column: 'service_area', srid: 4326, type: 'MULTIPOLYGON' },
      { f_table_name: 'properties', f_geometry_column: 'geom', srid: 4326, type: 'POINT' },
    ]);
  });

  test('F3 tables are tenant tables with RLS forced', async () => {
    const f3Tables = ['setup_items', 'imports', 'import_rows', 'early_delivery_reports'] as const;
    expect([...TENANT_TABLES]).toEqual(expect.arrayContaining([...f3Tables]));
    for (const table of f3Tables) {
      const [cls] = await ownerQuery<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `select relrowsecurity, relforcerowsecurity from pg_class where oid = $1::regclass`,
        [`public.${table}`],
      );
      expect(cls, table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    }
  });

  test('C1 tables are tenant tables with RLS forced', async () => {
    const c1Tables = [
      'appointments',
      'calendar_connections',
      'calendar_event_links',
      'calendar_busy_blocks',
      'member_schedules',
      'pricebooks',
      'quotes',
      'quote_counters',
    ] as const;
    expect([...TENANT_TABLES]).toEqual(expect.arrayContaining([...c1Tables]));
    for (const table of c1Tables) {
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

  test('E1 tables are tenant tables with RLS forced', async () => {
    const e1Tables = [
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
    expect([...TENANT_TABLES]).toEqual(expect.arrayContaining([...e1Tables]));
    for (const table of e1Tables) {
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

  test('running migrate a second time changes nothing', async () => {
    const before = await ownerQuery<{ n: number }>(`select count(*)::int as n from drizzle.__drizzle_migrations`);
    await migrate(urls.owner);
    const after = await ownerQuery<{ n: number }>(`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(after).toEqual(before);
  });

  test('every migration applies as a CREATEROLE owner that is not a superuser (a managed host such as Supabase)', async () => {
    // The test container's owner is a superuser, which hides anything only a superuser may do. This
    // owner has what a managed host gives: CREATEROLE, its own database, the extensions already
    // enabled, and ADMIN (but not SET) on the app roles, as PostgreSQL 16 gives a CREATEROLE role
    // on the roles it creates. The app roles are cluster-wide, so they already exist here.
    const database = 'roofline_managed_host';
    const migrator = 'roofline_managed_owner';
    const membership = () =>
      ownerQuery<{ role: string; admin: boolean; inherit: boolean; set: boolean }>(
        `select r.rolname as role, a.admin_option as admin, a.inherit_option as inherit, a.set_option as set
           from pg_auth_members a join pg_roles r on r.oid = a.roleid join pg_roles m on m.oid = a.member
          where m.rolname = $1 order by 1`,
        [migrator],
      );
    await ownerQuery(`drop database if exists ${database}`);
    await ownerQuery(`drop role if exists ${migrator}`);
    await ownerQuery(`create role ${migrator} login createrole password 'managed-owner-pw'`);
    try {
      await ownerQuery(`grant app_tenant, app_system to ${migrator} with admin true, inherit false, set false`);
      await ownerQuery(`create database ${database} owner ${migrator}`);
      const url = new URL(urls.owner);
      url.pathname = `/${database}`;
      const superuser = new pg.Client({ connectionString: url.toString() });
      await superuser.connect();
      try {
        await superuser.query('create extension postgis; create extension citext;');
      } finally {
        await superuser.end();
      }
      url.username = migrator;
      url.password = 'managed-owner-pw';

      await migrate(url.toString());

      // Everything the superuser-run test database has, it has too.
      const summary = `select (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
          (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'pgboss') as pgboss_owner,
          (select string_agg(tablename || '.' || policyname, ',' order by tablename, policyname)
             from pg_policies where schemaname = 'public') as policies`;
      const check = new pg.Client({ connectionString: url.toString() });
      await check.connect();
      try {
        const [managed] = (await check.query(summary)).rows;
        const [reference] = await ownerQuery(summary);
        expect(managed).toEqual(reference);
        expect(managed).toMatchObject({ pgboss_owner: 'app_system' });
        expect(managed.policies).toContain('messages.app_system_all');
      } finally {
        await check.end();
      }
      // Its grant of app_system for the pgboss schema was taken back: ADMIN only, as before.
      expect(await membership()).toEqual([
        { role: 'app_system', admin: true, inherit: false, set: false },
        { role: 'app_tenant', admin: true, inherit: false, set: false },
      ]);
      const roles = await ownerQuery(
        `select rolname, rolbypassrls from pg_roles where rolname in ('app_tenant', 'app_system') order by 1`,
      );
      expect(roles).toEqual([
        { rolname: 'app_system', rolbypassrls: false },
        { rolname: 'app_tenant', rolbypassrls: false },
      ]);
    } finally {
      await ownerQuery(`drop database if exists ${database} with (force)`);
      await ownerQuery(`drop role if exists ${migrator}`);
    }
  });

  test('a property point round-trips through drizzle as [lng, lat] with SRID 4326', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const db = drizzle(client);
    const [row] = await db
      .insert(properties)
      .values({
        companyId: s.a.companyId,
        addressLine: '1 Main St',
        city: 'Omaha',
        state: 'NE',
        zip: '68102',
        addressKey: '1 main st|68102',
        geom: [-95.9345, 41.2565],
      })
      .returning();
    expect(row!.geom).toEqual([-95.9345, 41.2565]);
    const [check] = await ownerQuery<{ srid: number; x: number }>(
      `select st_srid(geom) as srid, st_x(geom) as x from properties where id = $1`,
      [row!.id],
    );
    expect(check).toEqual({ srid: 4326, x: -95.9345 });
    const [reread] = await db.select({ geom: properties.geom }).from(properties).where(eq(properties.id, row!.id));
    expect(reread!.geom).toEqual([-95.9345, 41.2565]);
  });

  test('a company service area accepts an EWKT multipolygon', async () => {
    const db = drizzle(client);
    const [row] = await db
      .insert(companies)
      .values({
        name: 'Area Co',
        slug: 'area-co',
        serviceArea: 'SRID=4326;MULTIPOLYGON(((-96 41,-95 41,-95 42,-96 42,-96 41)))',
      })
      .returning({ id: companies.id });
    const [check] = await ownerQuery<{ n: number }>(
      `select st_npoints(service_area)::int as n from companies where id = $1`,
      [row!.id],
    );
    expect(check).toEqual({ n: 5 });
  });

  test('updated_at moves forward when drizzle updates a row', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const db = drizzle(client);
    const [created] = await db
      .insert(customers)
      .values({ companyId: s.a.companyId, displayName: 'Before' })
      .returning();
    // created_at comes from the container's clock and the $onUpdate value from this process's clock,
    // so compare the new value against a timestamp taken here rather than against created_at.
    const beforeUpdate = new Date();
    const [updated] = await db
      .update(customers)
      .set({ displayName: 'After' })
      .where(eq(customers.id, created!.id))
      .returning();
    expect(updated!.updatedAt).not.toEqual(created!.updatedAt);
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(beforeUpdate.getTime());
    expect(updated!.createdAt).toEqual(created!.createdAt);
  });

  test('ids default to gen_random_uuid and timestamps to now()', async () => {
    const [row] = await ownerQuery<{ id: string; created_at: Date; updated_at: Date }>(
      `insert into companies (name, slug) values ('Defaults Co', 'defaults-co') returning id, created_at, updated_at`,
    );
    expect(row!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(row!.created_at).toBeInstanceOf(Date);
    expect(row!.updated_at).toBeInstanceOf(Date);
  });
});

describe('constraints', () => {
  test('check constraints cover the enum columns of tenant tables', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const cid = s.a.companyId;
    const badInserts = [
      `insert into companies (name, slug, status) values ('X', 'x', 'bogus')`,
      `update texting_registrations set campaign_status = 'bogus' where company_id = '${cid}'`,
      `insert into memberships (company_id, user_id, role) values ('${cid}', '${s.a.owner.userId}', 'boss')`,
      `insert into customers (company_id, display_name, sms_consent_status) values ('${cid}', 'C', 'maybe')`,
      `insert into customers (company_id, display_name, source) values ('${cid}', 'C', 'fax')`,
      `insert into agent_tasks (company_id, agent, kind, title) values ('${cid}', 'robot', 'k', 't')`,
      `insert into agent_tasks (company_id, agent, kind, title, status) values ('${cid}', 'system', 'k', 't', 'bogus')`,
      `insert into messages (company_id, channel, direction, body, status) values ('${cid}', 'pigeon', 'out', 'b', 'sent')`,
      `insert into messages (company_id, channel, direction, body, status) values ('${cid}', 'sms', 'out', 'b', 'bogus')`,
      `insert into messages (company_id, channel, direction, body, status, block_rule) values ('${cid}', 'sms', 'out', 'b', 'blocked', 'nope')`,
      `insert into usage_events (company_id, kind, quantity) values ('${cid}', 'bogus', 1)`,
      `insert into user_tokens (user_id, kind, token_hash, expires_at) values ('${s.a.owner.userId}', 'bogus', 'h', now())`,
    ];
    for (const sql of badInserts) {
      const err = await rejected(sql);
      expect(err.code, sql).toBe('23514');
    }
  });

  test('marketing_cap_per_7d can be lowered but never raised above 2', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const err = await rejected(`update company_settings set marketing_cap_per_7d = 3 where company_id = $1`, [
      s.a.companyId,
    ]);
    expect(err.code).toBe('23514');
    await ownerQuery(`update company_settings set marketing_cap_per_7d = 0 where company_id = $1`, [s.a.companyId]);
  });

  test('users.email is case-insensitive unique', async () => {
    await ownerQuery(`insert into users (email, name) values ('Dup@Example.com', 'One')`);
    const err = await rejected(`insert into users (email, name) values ('dup@example.COM', 'Two')`);
    expect(err.code).toBe('23505');
  });

  test('property address_key is unique per company, not across companies', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const insert = `insert into properties (company_id, address_line, city, state, zip, address_key)
      values ($1, '1 Main St', 'Omaha', 'NE', '68102', '1 main st|68102')`;
    await ownerQuery(insert, [s.a.companyId]);
    const err = await rejected(insert, [s.a.companyId]);
    expect(err.code).toBe('23505');
    await ownerQuery(insert, [s.b.companyId]);
  });

  test('messages.customer_id is nullable for inbound texts from unknown numbers', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const [row] = await ownerQuery<{ customer_id: string | null; segments: number }>(
      `insert into messages (company_id, channel, direction, body, status, to_e164)
       values ($1, 'sms', 'in', 'Hello?', 'received', '+14025550199') returning customer_id, segments`,
      [s.a.companyId],
    );
    expect(row).toEqual({ customer_id: null, segments: 1 });
  });

  test('messages.retryable is a non-null boolean that starts false', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const [row] = await ownerQuery<{ retryable: boolean }>(
      `insert into messages (company_id, channel, direction, body, status) values ($1, 'sms', 'out', 'Hi', 'failed') returning retryable`,
      [s.a.companyId],
    );
    expect(row).toEqual({ retryable: false });
    const err = await rejected(
      `insert into messages (company_id, channel, direction, body, status, retryable) values ($1, 'sms', 'out', 'Hi', 'failed', null)`,
      [s.a.companyId],
    );
    expect(err.code).toBe('23502');
  });

  test('a step can send at most one message per customer, but null step ids are unrestricted', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const cid = s.a.companyId;
    const [customer] = await ownerQuery<{ id: string }>(
      `insert into customers (company_id, display_name) values ($1, 'Cust') returning id`,
      [cid],
    );
    const [task] = await ownerQuery<{ id: string }>(
      `insert into agent_tasks (company_id, agent, kind, title) values ($1, 'system', 'k', 't') returning id`,
      [cid],
    );
    const [step] = await ownerQuery<{ id: string }>(
      `insert into agent_task_steps (company_id, task_id, position, type, approval_class, idempotency_key)
       values ($1, $2, 0, 'send_sms_batch', 'message', 'key-1') returning id`,
      [cid, task!.id],
    );
    const withStep = `insert into messages (company_id, customer_id, step_id, channel, direction, body, status)
      values ($1, $2, $3, 'sms', 'out', 'Hi', 'queued')`;
    await ownerQuery(withStep, [cid, customer!.id, step!.id]);
    const err = await rejected(withStep, [cid, customer!.id, step!.id]);
    expect(err.code).toBe('23505');

    const noStep = `insert into messages (company_id, customer_id, channel, direction, body, status)
      values ($1, $2, 'sms', 'in', 'Hi', 'received')`;
    await ownerQuery(noStep, [cid, customer!.id]);
    await ownerQuery(noStep, [cid, customer!.id]);
  });

  test('agent task steps default to version 1, attempts 0, enabled', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const [task] = await ownerQuery<{ id: string }>(
      `insert into agent_tasks (company_id, agent, kind, title) values ($1, 'system', 'k', 't') returning id`,
      [s.a.companyId],
    );
    const [step] = await ownerQuery<{ version: number; attempts: number; enabled: boolean; status: string }>(
      `insert into agent_task_steps (company_id, task_id, position, type, approval_class, idempotency_key)
       values ($1, $2, 0, 'demo_noop', 'internal', 'key-2') returning version, attempts, enabled, status`,
      [s.a.companyId, task!.id],
    );
    expect(step).toEqual({ version: 1, attempts: 0, enabled: true, status: 'pending' });
  });

  test('global lookups are unique: phone number, webhook event, one registration per company', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const phone = `insert into company_phone_numbers (company_id, e164) values ($1, '+14025550177')`;
    await ownerQuery(phone, [s.a.companyId]);
    expect((await rejected(phone, [s.b.companyId])).code).toBe('23505');

    const hook = `insert into webhook_events (provider, event_id) values ('twilio', 'evt-1')`;
    await ownerQuery(hook);
    expect((await rejected(hook)).code).toBe('23505');
    await ownerQuery(`insert into webhook_events (provider, event_id) values ('stripe', 'evt-1')`);

    const reg = `insert into texting_registrations (company_id) values ($1)`;
    expect((await rejected(reg, [s.a.companyId])).code).toBe('23505');
  });

  test('one inbound row per provider message per company', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const sid = 'SM' + 'a'.repeat(32);
    const inbound = `insert into messages (company_id, channel, direction, body, status, provider_message_sid)
      values ($1, 'sms', 'in', 'Hi', 'received', $2)`;
    await ownerQuery(inbound, [s.a.companyId, sid]);
    const err = await rejected(inbound, [s.a.companyId, sid]);
    expect(err.code).toBe('23505');

    // The partial index covers direction 'in' only, so an outbound row may share the SID.
    await ownerQuery(
      `insert into messages (company_id, channel, direction, body, status, provider_message_sid)
       values ($1, 'sms', 'out', 'Hi', 'sent', $2)`,
      [s.a.companyId, sid],
    );
    // Another company may receive the same SID.
    await ownerQuery(inbound, [s.b.companyId, sid]);
  });

  test('customers.phones has a jsonb_path_ops GIN index', async () => {
    const phones = await ownerQuery<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = 'public' and indexname = 'customers_phones_gin'`,
    );
    expect(phones).toHaveLength(1);
    expect(phones[0]!.indexdef).toMatch(/using gin/i);
    expect(phones[0]!.indexdef).toContain('jsonb_path_ops');

    const emails = await ownerQuery<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = 'public' and indexname = 'customers_emails_gin'`,
    );
    expect(emails).toHaveLength(1);
    expect(emails[0]!.indexdef).toMatch(/using gin/i);
  });

  test('service_area_miles accepts only 10, 20, 40 or 60', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const update = `update companies set service_area_miles = $2 where id = $1`;
    const err = await rejected(update, [s.a.companyId, 25]);
    expect(err.code).toBe('23514');
    for (const miles of [10, 20, 40, 60, null]) {
      await ownerQuery(update, [s.a.companyId, miles]);
    }
  });

  test('F3 enum columns carry CHECK constraints', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const cid = s.a.companyId;
    const badInserts = [
      `insert into setup_items (company_id, key) values ('${cid}', 'bogus')`,
      `insert into setup_items (company_id, key, status) values ('${cid}', 'company_basics', 'bogus')`,
      `insert into imports (company_id, file_name, status) values ('${cid}', 'c.csv', 'bogus')`,
      `insert into early_delivery_reports (company_id, provider_message_sid, status) values ('${cid}', 'SM1', 'bogus')`,
    ];
    for (const sql of badInserts) {
      const err = await rejected(sql);
      expect(err.code, sql).toBe('23514');
    }
  });
});

/** One customer, property and job in a company, for rows that link to a job. */
async function makeJob(companyId: string, tag: string): Promise<string> {
  const [customer] = await ownerQuery<{ id: string }>(
    `insert into customers (company_id, display_name) values ($1, $2) returning id`,
    [companyId, `Customer ${tag}`],
  );
  const [property] = await ownerQuery<{ id: string }>(
    `insert into properties (company_id, customer_id, address_line, city, state, zip, address_key)
     values ($1, $2, '1 Main St', 'Omaha', 'NE', '68102', $3) returning id`,
    [companyId, customer!.id, `${tag} main st|68102`],
  );
  const [job] = await ownerQuery<{ id: string }>(
    `insert into jobs (company_id, customer_id, property_id) values ($1, $2, $3) returning id`,
    [companyId, customer!.id, property!.id],
  );
  return job!.id;
}

/** Runs SQL as app_tenant with app.company_id set, as withTenant does, and returns the rows. */
async function asTenant(companyId: string, text: string, values: unknown[] = []): Promise<pg.QueryResultRow[]> {
  const tenant = new pg.Client({ connectionString: urls.tenant });
  await tenant.connect();
  try {
    await tenant.query('begin');
    await tenant.query(`select set_config('app.company_id', $1, true)`, [companyId]);
    const res = await tenant.query(text, values);
    await tenant.query('commit');
    return res.rows;
  } finally {
    // Closing the connection with a transaction still open rolls it back.
    await tenant.end();
  }
}

/** Runs a statement as app_tenant that must be refused and returns the Postgres error. */
async function rejectedAsTenant(companyId: string, text: string, values: unknown[] = []): Promise<pg.DatabaseError> {
  try {
    await asTenant(companyId, text, values);
  } catch (err) {
    return err as pg.DatabaseError;
  }
  throw new Error(`Expected app_tenant to be refused: ${text}`);
}

/** The rows a proposal links to in one company: a customer, property, job and estimate measurement. */
type ProposalParents = { customerId: string; propertyId: string; jobId: string; measurementId: string };

async function makeProposalParents(companyId: string, tag: string): Promise<ProposalParents> {
  const jobId = await makeJob(companyId, tag);
  const [job] = await ownerQuery<{ customer_id: string; property_id: string }>(
    `select customer_id, property_id from jobs where id = $1`,
    [jobId],
  );
  const [measurement] = await ownerQuery<{ id: string }>(
    `insert into measurements (company_id, property_id, kind, method)
     values ($1, $2, 'estimate', 'manual') returning id`,
    [companyId, job!.property_id],
  );
  return { customerId: job!.customer_id, propertyId: job!.property_id, jobId, measurementId: measurement!.id };
}

/** Parameters: company, customer, property, job, measurement, number, link_token_hash, link_token_encrypted. */
const insertProposal = `insert into proposals (company_id, customer_id, property_id, job_id, measurement_id, number,
    status, valid_until, estimate_basis, link_token_hash, link_token_encrypted)
  values ($1, $2, $3, $4, $5, $6, 'draft', date '2026-12-31', 'estimate', $7, $8)`;

/** The parameters of `insertProposal` for a proposal on `parents`. */
function proposalValues(
  companyId: string,
  parents: ProposalParents,
  number: string,
  hash: Buffer,
  measurementId: string = parents.measurementId,
): unknown[] {
  return [
    companyId,
    parents.customerId,
    parents.propertyId,
    parents.jobId,
    measurementId,
    number,
    hash,
    Buffer.from('encrypted-placeholder'),
  ];
}

describe('C1 constraints', () => {
  test('an appointment cannot end before it starts', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const err = await rejected(
      `insert into appointments (company_id, kind, starts_at, ends_at)
       values ($1, 'inspection', now() + interval '2 hours', now() + interval '1 hour')`,
      [s.a.companyId],
    );
    expect(err.code).toBe('23514');
    await ownerQuery(
      `insert into appointments (company_id, kind, starts_at, ends_at)
       values ($1, 'inspection', now() + interval '1 hour', now() + interval '2 hours')`,
      [s.a.companyId],
    );
  });

  test('one calendar connection per person per company', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const insert = `insert into calendar_connections (company_id, user_id, provider, encrypted_credentials)
      values ($1, $2, 'google', $3)`;
    const credentials = Buffer.from('encrypted-placeholder');
    await ownerQuery(insert, [s.a.companyId, s.a.rep.userId, credentials]);
    const err = await rejected(insert, [s.a.companyId, s.a.rep.userId, credentials]);
    expect(err.code).toBe('23505');
    // A second person in the same company may connect their own calendar.
    await ownerQuery(insert, [s.a.companyId, s.a.otherRep.userId, credentials]);
  });

  test('quote numbers are unique per company', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const jobA = await makeJob(s.a.companyId, 'a');
    const jobB = await makeJob(s.b.companyId, 'b');
    const insert = `insert into quotes (company_id, job_id, number, measurement, scope, prices, calculation, valid_until)
      values ($1, $2, 'Q-0001', '{}', '{}', '{}', '{}', '2026-12-31')`;
    await ownerQuery(insert, [s.a.companyId, jobA]);
    const err = await rejected(insert, [s.a.companyId, jobA]);
    expect(err.code).toBe('23505');
    // The same number is free in another company.
    await ownerQuery(insert, [s.b.companyId, jobB]);
  });

  test('stuck_after_days accepts 3 to 90', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const update = `update company_settings set stuck_after_days = $2 where company_id = $1`;
    const err = await rejected(update, [s.a.companyId, 2]);
    expect(err.code).toBe('23514');
    for (const days of [3, 90]) {
      await ownerQuery(update, [s.a.companyId, days]);
    }
    expect((await rejected(update, [s.a.companyId, 91])).code).toBe('23514');
    expect(await ownerQuery(`select stuck_after_days from company_settings where company_id = $1`, [s.a.companyId])).toEqual(
      [{ stuck_after_days: 90 }],
    );
  });

  test('texting_registrations.messaging_service_sid is unique when set', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const sid = 'MG' + 'a'.repeat(32);
    const set = `update texting_registrations set messaging_service_sid = $2 where company_id = $1`;
    await ownerQuery(set, [s.a.companyId, sid]);
    const err = await rejected(set, [s.b.companyId, sid]);
    expect(err.code).toBe('23505');

    // Unset values never collide: two registrations may both have no messaging service SID.
    await ownerQuery(
      `update texting_registrations set messaging_service_sid = null where company_id = any($1::uuid[])`,
      [[s.a.companyId, s.b.companyId]],
    );
    const nulls = await ownerQuery<{ n: number }>(
      `select count(*)::int as n from texting_registrations
        where company_id = any($1::uuid[]) and messaging_service_sid is null`,
      [[s.a.companyId, s.b.companyId]],
    );
    expect(nulls).toEqual([{ n: 2 }]);
  });
});

describe('E1 constraints', () => {
  const linkHash = Buffer.alloc(32, 7);

  test('proposals.link_token_hash is unique across companies', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const a = await makeProposalParents(s.a.companyId, 'a');
    const b = await makeProposalParents(s.b.companyId, 'b');
    await ownerQuery(insertProposal, proposalValues(s.a.companyId, a, 'P-0001', linkHash));
    const err = await rejected(insertProposal, proposalValues(s.b.companyId, b, 'P-0001', linkHash));
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('proposals_link_token_hash_uniq');
  });

  test('tier_templates allows one row per tier per company', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const insertTier = (companyId: string, tier: string) =>
      ownerQuery(
        `insert into tier_templates (company_id, tier, name, material, waste_percent)
         values ($1, $2, 'Shingles', 'architectural', 10)`,
        [companyId, tier],
      );
    const insertGood = `insert into tier_templates (company_id, tier, name, material, waste_percent)
      values ($1, 'good', 'Shingles', 'architectural', 10)`;
    await insertTier(s.a.companyId, 'good');
    const err = await rejected(insertGood, [s.a.companyId]);
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('tier_templates_company_tier_uniq');
    // The same tier is free in another company, and another tier is free in the same one.
    await insertTier(s.b.companyId, 'good');
    await insertTier(s.a.companyId, 'better');
  });

  test('building_footprints is readable by app_tenant with any app.company_id and not writable', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const square = `ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))', 4326)`;
    await ownerQuery(
      `insert into building_footprints (state, geom, area_sq_ft, source)
       values ('TX', ${square}, 100.5, 'test')`,
    );
    for (const companyId of [s.a.companyId, s.b.companyId]) {
      expect(await asTenant(companyId, `select count(*)::int as n from building_footprints`)).toEqual([{ n: 1 }]);
    }
    const insertErr = await rejectedAsTenant(
      s.a.companyId,
      `insert into building_footprints (state, geom, area_sq_ft, source)
       values ('NE', ${square}, 1, 'test')`,
    );
    expect(insertErr.code).toBe('42501');
    const updateErr = await rejectedAsTenant(s.a.companyId, `update building_footprints set source = 'changed'`);
    expect(updateErr.code).toBe('42501');
  });

  test('company_settings has the estimator defaults', async () => {
    const s = await seedTwoCompanies(urls.owner);
    expect(
      await ownerQuery(
        `select default_pitch_x12::float as pitch, overhang_ft::float as overhang, proposal_valid_days,
                aerial_measure, estimate_change_clause
           from company_settings where company_id = $1`,
        [s.a.companyId],
      ),
    ).toEqual([
      { pitch: 6, overhang: 1, proposal_valid_days: 30, aerial_measure: false, estimate_change_clause: true },
    ]);
  });

  test.each([
    ['default_pitch_x12', '25'],
    ['default_pitch_x12', '-1'],
    ['overhang_ft', '3.5'],
    ['proposal_valid_days', '0'],
    ['proposal_valid_days', '181'],
  ])('company_settings.%s = %s is refused by its CHECK', async (column, value) => {
    const s = await seedTwoCompanies(urls.owner);
    const err = await rejected(`update company_settings set ${column} = ${value} where company_id = $1`, [
      s.a.companyId,
    ]);
    expect(err.code).toBe('23514');
  });

  test('company_settings estimator columns accept their edge values', async () => {
    const s = await seedTwoCompanies(urls.owner);
    for (const [column, value] of [
      ['default_pitch_x12', '24'],
      ['overhang_ft', '3'],
      ['proposal_valid_days', '1'],
      ['proposal_valid_days', '180'],
    ]) {
      await ownerQuery(`update company_settings set ${column} = ${value} where company_id = $1`, [s.a.companyId]);
    }
  });
});

describe('S1 constraints', () => {
  const SQUARE = `ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))', 4326)`;
  const MULTI_SQUARE = `ST_GeomFromText('MULTIPOLYGON(((0 0,0 1,1 1,1 0,0 0)))', 4326)`;
  const CENTER = `ST_GeomFromText('POINT(0.5 0.5)', 4326)`;

  const S1_TABLES = [
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

  async function insertStorm(): Promise<string> {
    const [row] = await ownerQuery<{ id: string }>(
      `insert into storms (convective_day, max_in, geom_075, bbox, centroid)
       values (date '2026-10-11', 1.50, ${MULTI_SQUARE}, ${SQUARE}, ${CENTER}) returning id`,
    );
    return row!.id;
  }

  async function insertCompanyStorm(companyId: string, stormId?: string): Promise<string> {
    const [row] = await ownerQuery<{ id: string }>(
      `insert into company_storms (company_id, storm_id, max_in) values ($1, $2, 1.50) returning id`,
      [companyId, stormId ?? (await insertStorm())],
    );
    return row!.id;
  }

  /** A stored_files row of the given kind for a company. */
  async function insertStoredFile(companyId: string, kind: string, key: string): Promise<string> {
    const [row] = await ownerQuery<{ id: string }>(
      `insert into stored_files (company_id, kind, object_key, sha256, bytes, content_type)
       values ($1, $2, $3, repeat('a', 64), 10, 'image/jpeg') returning id`,
      [companyId, kind, key],
    );
    return row!.id;
  }

  test('S1 tables are tenant tables with RLS forced, and the four global hail tables exist', async () => {
    expect([...TENANT_TABLES]).toEqual(expect.arrayContaining([...S1_TABLES]));
    for (const table of S1_TABLES) {
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
    const globals = await ownerQuery<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_name in ('hail_runs', 'storms', 'storm_contours', 'spotter_reports')
        order by 1`,
    );
    expect(globals.map((g) => g.table_name)).toEqual(['hail_runs', 'spotter_reports', 'storm_contours', 'storms']);
    expect([...TENANT_TABLES]).not.toEqual(expect.arrayContaining(['hail_runs']));
  });

  test('0018 creates app_hail as NOLOGIN and never grants it the bypass attribute', () => {
    const text = readFileSync(join(MIGRATIONS_FOLDER, '0018_storm_grants_rls.sql'), 'utf8');
    expect(text).toMatch(/CREATE ROLE app_hail NOLOGIN NOBYPASSRLS/);
    // Login is ops' job (set-role-passwords), never a migration's: no statement, comments aside, grants it.
    const statements = text
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(statements).not.toMatch(/ALTER ROLE app_hail[^;]*\bLOGIN\b/i);
    expect(statements).not.toMatch(/\bLOGIN\b/);
  });

  test('messages: the email CHECK needs to_email', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const insert = `insert into messages (company_id, channel, direction, body, status) values ($1, 'email', 'out', 'Hi', 'failed')`;
    const err = await rejected(insert, [s.a.companyId]);
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('messages_email_to_email_check');
    const [row] = await ownerQuery<{ to_email: string; subject: string | null }>(
      `insert into messages (company_id, channel, direction, body, status, to_email, subject)
       values ($1, 'email', 'out', 'Hi', 'failed', 'Pat@Example.com', 'Hail') returning to_email::text, subject`,
      [s.a.companyId],
    );
    expect(row).toEqual({ to_email: 'Pat@Example.com', subject: 'Hail' });
    // A text message needs neither column.
    await ownerQuery(
      `insert into messages (company_id, channel, direction, body, status) values ($1, 'sms', 'out', 'Hi', 'failed')`,
      [s.a.companyId],
    );
  });

  test('company_settings has the storm defaults', async () => {
    const s = await seedTwoCompanies(urls.owner);
    expect(
      await ownerQuery(
        `select storm_ad_budget_cents, storm_ad_days, storm_ad_google_share_pct, storm_email_enabled,
                storm_sms_template, storm_email_subject, storm_email_template
           from company_settings where company_id = $1`,
        [s.a.companyId],
      ),
    ).toEqual([
      {
        storm_ad_budget_cents: 27000,
        storm_ad_days: 7,
        storm_ad_google_share_pct: 55,
        storm_email_enabled: true,
        storm_sms_template: null,
        storm_email_subject: null,
        storm_email_template: null,
      },
    ]);
  });

  test.each([
    ['storm_ad_budget_cents', '-1', 'company_settings_storm_ad_budget_cents_check'],
    ['storm_ad_budget_cents', '1000001', 'company_settings_storm_ad_budget_cents_check'],
    ['storm_ad_days', '0', 'company_settings_storm_ad_days_check'],
    ['storm_ad_days', '31', 'company_settings_storm_ad_days_check'],
    ['storm_ad_google_share_pct', '-1', 'company_settings_storm_ad_google_share_pct_check'],
    ['storm_ad_google_share_pct', '101', 'company_settings_storm_ad_google_share_pct_check'],
  ])('company_settings.%s = %s is refused by its CHECK', async (column, value, constraint) => {
    const s = await seedTwoCompanies(urls.owner);
    const err = await rejected(`update company_settings set ${column} = ${value} where company_id = $1`, [
      s.a.companyId,
    ]);
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe(constraint);
  });

  test('company_settings storm columns accept their edge values', async () => {
    const s = await seedTwoCompanies(urls.owner);
    for (const [column, value] of [
      ['storm_ad_budget_cents', '0'],
      ['storm_ad_budget_cents', '1000000'],
      ['storm_ad_days', '1'],
      ['storm_ad_days', '30'],
      ['storm_ad_google_share_pct', '0'],
      ['storm_ad_google_share_pct', '100'],
    ]) {
      await ownerQuery(`update company_settings set ${column} = ${value} where company_id = $1`, [s.a.companyId]);
    }
  });

  test('memberships.storm_alert_email defaults to true', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const rows = await ownerQuery<{ storm_alert_email: boolean }>(
      `select storm_alert_email from memberships where company_id = $1`,
      [s.a.companyId],
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.storm_alert_email === true)).toBe(true);
    const [off] = await ownerQuery<{ storm_alert_email: boolean }>(
      `update memberships set storm_alert_email = false where user_id = $1 returning storm_alert_email`,
      [s.a.owner.userId],
    );
    expect(off).toEqual({ storm_alert_email: false });
  });

  test('SMS consent source door is accepted and an unknown source is refused', async () => {
    const s = await seedTwoCompanies(urls.owner);
    await ownerQuery(`insert into customers (company_id, display_name, sms_consent_source) values ($1, 'Door', 'door')`, [
      s.a.companyId,
    ]);
    const err = await rejected(
      `insert into customers (company_id, display_name, sms_consent_source) values ($1, 'Bad', 'bogus')`,
      [s.a.companyId],
    );
    expect(err.code).toBe('23514');
  });

  test('stored_files accepts the storm_photo and ad_image kinds and refuses an unknown one', async () => {
    const s = await seedTwoCompanies(urls.owner);
    await insertStoredFile(s.a.companyId, 'storm_photo', 'photo-1');
    await insertStoredFile(s.a.companyId, 'ad_image', 'ad-1');
    await insertStoredFile(s.a.companyId, 'signed_proposal_pdf', 'pdf-1');
    const err = await rejected(
      `insert into stored_files (company_id, kind, object_key, sha256, bytes, content_type)
       values ($1, 'bogus', 'x', repeat('a', 64), 1, 'image/jpeg')`,
      [s.a.companyId],
    );
    expect(err.code).toBe('23514');
  });

  test('door_stops.footprint_id and door_exclusions.footprint_id are bigint with no foreign key (Ruling SH)', async () => {
    const cols = await ownerQuery<{ table_name: string; data_type: string }>(
      `select table_name, data_type from information_schema.columns
        where table_schema = 'public' and column_name = 'footprint_id'
          and table_name in ('door_stops', 'door_exclusions') order by 1`,
    );
    expect(cols).toEqual([
      { table_name: 'door_exclusions', data_type: 'bigint' },
      { table_name: 'door_stops', data_type: 'bigint' },
    ]);
    const fks = await ownerQuery<{ conname: string; referenced: string }>(
      `select c.conname, c.confrelid::regclass::text as referenced from pg_constraint c
        where c.contype = 'f' and c.conrelid = any(array['public.door_stops'::regclass, 'public.door_exclusions'::regclass])`,
    );
    expect(fks.filter((f) => f.referenced === 'building_footprints')).toEqual([]);
    // And in practice: a footprint id nothing in building_footprints has is accepted.
    const s = await seedTwoCompanies(urls.owner);
    await ownerQuery(`insert into door_exclusions (company_id, footprint_id) values ($1, 987654321)`, [s.a.companyId]);
    const err = await rejected(`insert into door_exclusions (company_id, footprint_id) values ($1, 987654321)`, [
      s.a.companyId,
    ]);
    expect(err.code).toBe('23505');
    await ownerQuery(`insert into door_exclusions (company_id, footprint_id) values ($1, 987654321)`, [s.b.companyId]);
  });

  test('storm_hits allows one row per property per company storm', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const jobId = await makeJob(s.a.companyId, 'a');
    const [job] = await ownerQuery<{ property_id: string }>(`select property_id from jobs where id = $1`, [jobId]);
    const companyStormId = await insertCompanyStorm(s.a.companyId);
    const insert = `insert into storm_hits (company_id, company_storm_id, property_id, hail_in) values ($1, $2, $3, 1.25)`;
    await ownerQuery(insert, [s.a.companyId, companyStormId, job!.property_id]);
    const err = await rejected(insert, [s.a.companyId, companyStormId, job!.property_id]);
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('storm_hits_storm_property_uniq');
  });

  test('door_stops allows one stop per position on a route', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const companyStormId = await insertCompanyStorm(s.a.companyId);
    const [route] = await ownerQuery<{ id: string }>(
      `insert into door_routes (company_id, company_storm_id, user_id, name) values ($1, $2, $3, 'R1') returning id`,
      [s.a.companyId, companyStormId, s.a.owner.userId],
    );
    const insert = `insert into door_stops (company_id, route_id, position, point) values ($1, $2, $3, ${CENTER})`;
    await ownerQuery(insert, [s.a.companyId, route!.id, 1]);
    const err = await rejected(insert, [s.a.companyId, route!.id, 1]);
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('door_stops_route_position_uniq');
    await ownerQuery(insert, [s.a.companyId, route!.id, 2]);
  });

  test('a storm_photos row cannot point at another company stored file', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const aFile = await insertStoredFile(s.a.companyId, 'storm_photo', 'a-photo');
    const bFile = await insertStoredFile(s.b.companyId, 'storm_photo', 'b-photo');
    const insert = `insert into storm_photos (company_id, stored_file_id) values ($1, $2)`;
    const err = await rejected(insert, [s.a.companyId, bFile]);
    expect(err.code).toBe('23503');
    await ownerQuery(insert, [s.a.companyId, aFile]);
    await ownerQuery(insert, [s.b.companyId, bFile]);
  });

  test('hail_runs.source_key is unique', async () => {
    const insert = `insert into hail_runs (source_key, valid_at, convective_day, status)
      values ('mrms-20261011-1800', now(), date '2026-10-11', 'processed')`;
    await ownerQuery(insert);
    const err = await rejected(insert);
    expect(err.code).toBe('23505');
  });

  test('spotter_reports is unique on (report_date, time_utc, geom)', async () => {
    const insert = (point: string) =>
      `insert into spotter_reports (report_date, time_utc, size_in, state, geom)
       values (date '2026-10-11', time '18:05', 1.25, 'NE', ST_GeomFromText('${point}', 4326))`;
    await ownerQuery(insert('POINT(-96 41)'));
    const err = await rejected(insert('POINT(-96 41)'));
    expect(err.code).toBe('23505');
    await ownerQuery(insert('POINT(-96 42)'));
  });

  test('ad_accounts: a live (platform, external_account_id) belongs to one company; a revoked row frees it (Ruling BF)', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const insert = `insert into ad_accounts (company_id, platform, external_account_id, status) values ($1, $2, $3, $4)`;
    await ownerQuery(insert, [s.b.companyId, 'google', '1234567890', 'pending']);
    // Another company cannot hold the same account, in any live status.
    for (const status of ['pending', 'active', 'error']) {
      const err = await rejected(insert, [s.a.companyId, 'google', '1234567890', status]);
      expect(err.code, status).toBe('23505');
      expect(err.constraint, status).toBe('ad_accounts_platform_external_live_uq');
    }
    // The same id on the other platform, and another id on the same platform, are different accounts.
    await ownerQuery(insert, [s.a.companyId, 'meta', '1234567890', 'pending']);
    await ownerQuery(insert, [s.b.companyId, 'meta', 'act_77', 'active']);
    // Once the holder revokes, the other company can connect.
    await ownerQuery(`update ad_accounts set status = 'revoked' where company_id = $1 and platform = 'google'`, [s.b.companyId]);
    await ownerQuery(insert, [s.a.companyId, 'google', '1234567890', 'pending']);
  });
});

describe('same-company foreign keys', () => {
  type Ids ={ customerId: string; propertyId: string; taskId: string; stepId: string };

  /** One customer, property, task and step for a company. */
  async function makeGraph(companyId: string, tag: string): Promise<Ids> {
    const [customer] = await ownerQuery<{ id: string }>(
      `insert into customers (company_id, display_name) values ($1, $2) returning id`,
      [companyId, `Customer ${tag}`],
    );
    const [property] = await ownerQuery<{ id: string }>(
      `insert into properties (company_id, customer_id, address_line, city, state, zip, address_key)
       values ($1, $2, '1 Main St', 'Omaha', 'NE', '68102', '1 main st|68102') returning id`,
      [companyId, customer!.id],
    );
    const [task] = await ownerQuery<{ id: string }>(
      `insert into agent_tasks (company_id, agent, kind, title) values ($1, 'system', 'k', 't') returning id`,
      [companyId],
    );
    const [step] = await ownerQuery<{ id: string }>(
      `insert into agent_task_steps (company_id, task_id, position, type, approval_class, idempotency_key)
       values ($1, $2, 0, 'demo_noop', 'internal', $3) returning id`,
      [companyId, task!.id, `key-${tag}`],
    );
    return { customerId: customer!.id, propertyId: property!.id, taskId: task!.id, stepId: step!.id };
  }

  type Fixture = { a: string; b: string; ga: Ids; gb: Ids };

  /** Company ids for A and B, plus a full set of rows in each (`ga` and `gb`). */
  async function twoCompanies(): Promise<Fixture> {
    const s = await seedTwoCompanies(urls.owner);
    return {
      a: s.a.companyId,
      b: s.b.companyId,
      ga: await makeGraph(s.a.companyId, 'a'),
      gb: await makeGraph(s.b.companyId, 'b'),
    };
  }

  const insertJob = `insert into jobs (company_id, customer_id, property_id) values ($1, $2, $3)`;
  const insertStep = `insert into agent_task_steps (company_id, task_id, position, type, approval_class, idempotency_key)
    values ($1, $2, 1, 'demo_noop', 'internal', 'key-extra')`;
  const insertMessageForCustomer = `insert into messages (company_id, customer_id, channel, direction, body, status)
    values ($1, $2, 'sms', 'in', 'Hi', 'received')`;
  const insertMessageForStep = `insert into messages (company_id, step_id, channel, direction, body, status)
    values ($1, $2, 'sms', 'out', 'Hi', 'queued')`;
  const insertProperty = `insert into properties (company_id, customer_id, address_line, city, state, zip, address_key)
    values ($1, $2, '2 Oak Ave', 'Omaha', 'NE', '68102', '2 oak ave|68102')`;

  test('links between rows of the same company are accepted', async () => {
    const { a, ga } = await twoCompanies();
    await ownerQuery(insertJob, [a, ga.customerId, ga.propertyId]);
    await ownerQuery(insertStep, [a, ga.taskId]);
    await ownerQuery(insertMessageForCustomer, [a, ga.customerId]);
    await ownerQuery(insertMessageForStep, [a, ga.stepId]);
    await ownerQuery(insertProperty, [a, ga.customerId]);
  });

  test('optional links may still be empty', async () => {
    const { a } = await twoCompanies();
    await ownerQuery(
      `insert into properties (company_id, address_line, city, state, zip, address_key)
       values ($1, '3 Elm St', 'Omaha', 'NE', '68102', '3 elm st|68102')`,
      [a],
    );
    await ownerQuery(
      `insert into messages (company_id, channel, direction, body, status) values ($1, 'sms', 'in', 'Hi', 'received')`,
      [a],
    );
  });

  test.each<[string, string, (c: Fixture) => [string, unknown[]]]>([
    ['properties.customer_id', 'properties_company_customer_fk', (c) => [insertProperty, [c.a, c.gb.customerId]]],
    ['jobs.customer_id', 'jobs_company_customer_fk', (c) => [insertJob, [c.a, c.gb.customerId, c.ga.propertyId]]],
    ['jobs.property_id', 'jobs_company_property_fk', (c) => [insertJob, [c.a, c.ga.customerId, c.gb.propertyId]]],
    ['agent_task_steps.task_id', 'agent_task_steps_company_task_fk', (c) => [insertStep, [c.a, c.gb.taskId]]],
    ['messages.customer_id', 'messages_company_customer_fk', (c) => [insertMessageForCustomer, [c.a, c.gb.customerId]]],
    ['messages.step_id', 'messages_company_step_fk', (c) => [insertMessageForStep, [c.a, c.gb.stepId]]],
  ])('a company-A row cannot point at a company-B row through %s', async (_column, constraint, build) => {
    const c = await twoCompanies();
    const [sql, values] = build(c);
    const err = await rejected(sql, values);
    expect(err.code).toBe('23503');
    expect(err.constraint).toBe(constraint);
  });

  test("a company-A proposal cannot reference company B's measurement", async () => {
    const s = await seedTwoCompanies(urls.owner);
    const a = await makeProposalParents(s.a.companyId, 'a');
    const b = await makeProposalParents(s.b.companyId, 'b');
    const err = await rejected(
      insertProposal,
      proposalValues(s.a.companyId, a, 'P-0001', Buffer.alloc(32, 9), b.measurementId),
    );
    expect(err.code).toBe('23503');
    expect(err.constraint).toBe('proposals_company_measurement_fk');
  });
});

describe('resetDb', () => {
  test('truncates every app table but leaves PostGIS reference data alone', async () => {
    await seedTwoCompanies(urls.owner);
    const [before] = await ownerQuery<{ n: number }>(`select count(*)::int as n from spatial_ref_sys`);
    expect(before!.n).toBeGreaterThan(0);

    await resetDb(urls.owner);

    for (const table of ['companies', 'users', 'memberships', 'company_settings', 'texting_registrations']) {
      const [row] = await ownerQuery<{ n: number }>(`select count(*)::int as n from ${table}`);
      expect(row!.n, table).toBe(0);
    }
    const [after] = await ownerQuery<{ n: number }>(`select count(*)::int as n from spatial_ref_sys`);
    expect(after).toEqual(before);
  });

  test('the migration history survives a reset', async () => {
    await resetDb(urls.owner);
    const [row] = await ownerQuery<{ n: number }>(`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(row!.n).toBeGreaterThan(0);
  });
});

describe('seedTwoCompanies', () => {
  test('seed creates two companies with four members each', async () => {
    const s = await seedTwoCompanies(urls.owner);
    expect(await count('memberships', s.a.companyId)).toBe(4);
    expect(await count('memberships', s.b.companyId)).toBe(4);
    expect(s.a.companyId).not.toBe(s.b.companyId);
  });

  test('companies carry the agreed names, slugs, phones, time zone, state and trial status', async () => {
    const s = await seedTwoCompanies(urls.owner);
    expect(s.a.slug).toBe('acme-roofing');
    expect(s.b.slug).toBe('bolt-roofing');
    const rows = await ownerQuery(
      `select id, name, slug, phone_e164, timezone, address_state, status from companies order by slug`,
    );
    expect(rows).toEqual([
      {
        id: s.a.companyId,
        name: 'Acme Roofing',
        slug: 'acme-roofing',
        phone_e164: '+14025550199',
        timezone: 'America/Chicago',
        address_state: 'NE',
        status: 'trial',
      },
      {
        id: s.b.companyId,
        name: 'Bolt Roofing',
        slug: 'bolt-roofing',
        phone_e164: '+14025550198',
        timezone: 'America/Chicago',
        address_state: 'NE',
        status: 'trial',
      },
    ]);
  });

  test('each company gets default settings and an approved texting registration', async () => {
    const s = await seedTwoCompanies(urls.owner);
    for (const c of [s.a, s.b]) {
      const settings = await ownerQuery(
        `select hourly_rate_cents, hail_threshold_in::float as hail, marketing_cap_per_7d from company_settings where company_id = $1`,
        [c.companyId],
      );
      expect(settings).toEqual([{ hourly_rate_cents: 2800, hail: 1, marketing_cap_per_7d: 2 }]);
      const reg = await ownerQuery(`select campaign_status from texting_registrations where company_id = $1`, [
        c.companyId,
      ]);
      expect(reg).toEqual([{ campaign_status: 'approved' }]);
    }
  });

  test('members: owner, office without spend approval, and two reps, all active', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const rows = await ownerQuery(
      `select u.email, m.role, m.can_approve_spend, m.status, u.email_verified_at is not null as verified
       from memberships m join users u on u.id = m.user_id
       where m.company_id = $1 order by u.email`,
      [s.a.companyId],
    );
    expect(rows).toEqual([
      { email: 'office@a.test', role: 'office', can_approve_spend: false, status: 'active', verified: true },
      { email: 'owner@a.test', role: 'owner', can_approve_spend: false, status: 'active', verified: true },
      { email: 'rep2@a.test', role: 'rep', can_approve_spend: false, status: 'active', verified: true },
      { email: 'rep@a.test', role: 'rep', can_approve_spend: false, status: 'active', verified: true },
    ]);
    expect([s.a.owner.email, s.a.office.email, s.a.rep.email, s.a.otherRep.email]).toEqual([
      'owner@a.test',
      'office@a.test',
      'rep@a.test',
      'rep2@a.test',
    ]);
    expect([s.b.owner.email, s.b.office.email, s.b.rep.email, s.b.otherRep.email]).toEqual([
      'owner@b.test',
      'office@b.test',
      'rep@b.test',
      'rep2@b.test',
    ]);
    expect(s.a.owner.password).toBe('correct-horse-battery');
  });

  test('seed users have a scrypt hash in the agreed format that verifies the shared password', async () => {
    const s = await seedTwoCompanies(urls.owner);
    const [row] = await ownerQuery<{ password_hash: string }>(`select password_hash from users where id = $1`, [
      s.a.rep.userId,
    ]);
    const parts = row!.password_hash.split('$');
    expect(parts).toHaveLength(6);
    const [scheme, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
    expect([scheme, n, r, p]).toEqual(['scrypt', '16384', '8', '1']);
    expect(Buffer.from(salt, 'base64')).toHaveLength(16);
    expect(Buffer.from(hash, 'base64')).toHaveLength(64);
    const derived = await scryptAsync('correct-horse-battery', Buffer.from(salt, 'base64'), 64, {
      N: 16384,
      r: 8,
      p: 1,
    });
    expect(timingSafeEqual(derived, Buffer.from(hash, 'base64'))).toBe(true);
  });

  test('seeding twice in a row after a reset works', async () => {
    await seedTwoCompanies(urls.owner);
    await resetDb(urls.owner);
    const s = await seedTwoCompanies(urls.owner);
    expect(await count('memberships', s.a.companyId)).toBe(4);
  });
});
