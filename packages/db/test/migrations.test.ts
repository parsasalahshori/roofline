import { scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { eq, getTableName, is } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgTable } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { migrate } from '../src/migrate.ts';
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
      { f_table_name: 'companies', f_geometry_column: 'service_area', srid: 4326, type: 'MULTIPOLYGON' },
      { f_table_name: 'properties', f_geometry_column: 'geom', srid: 4326, type: 'POINT' },
    ]);
  });

  test('running migrate a second time changes nothing', async () => {
    const before = await ownerQuery<{ n: number }>(`select count(*)::int as n from drizzle.__drizzle_migrations`);
    await migrate(urls.owner);
    const after = await ownerQuery<{ n: number }>(`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(after).toEqual(before);
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
});

describe('same-company foreign keys', () => {
  type Ids = { customerId: string; propertyId: string; taskId: string; stepId: string };

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
