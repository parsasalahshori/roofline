import pg from 'pg';
import { beforeEach, expect, inject, test } from 'vitest';
import { auditLog, withTenant } from '@roofline/db';
import type { SetupView } from '@roofline/shared';
import { loginAs, makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

const CANNOT_SKIP = "This step can't be skipped.";
const NOT_ALLOWED = "Your role can't do that. Ask the owner.";
const NOT_FOUND = "We couldn't find that.";

const KEYS_IN_ORDER = [
  'company_basics',
  'import_customers',
  'texting_registration',
  'invite_team',
  'payment_method',
  'prices_and_tiers',
  'connect_calendar',
  'phone_number',
  'connect_ads',
];

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
});

/**
 * Raw SQL as the table owner. The app's pools cannot write the global tables or the status of a
 * membership, and the owner is what seeds use too. Every statement here names its company, so
 * row security does not change what it touches.
 */
async function ownerSql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: inject('dbUrls').owner });
  await client.connect();
  try {
    const result = await client.query(text, params);
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

/** The audit rows of one company, oldest first, optionally only one action. */
async function auditRows(companyId: string, action?: string) {
  const rows = await withTenant(
    t.deps.pools,
    { companyId, userId: null, role: 'system', canApproveSpend: false },
    (tx) => tx.select().from(auditLog),
  );
  return rows.filter((r) => action === undefined || r.action === action).sort((x, y) => x.at.getTime() - y.at.getTime());
}

async function getSetup(agent: SuperAgent): Promise<SetupView> {
  const res = await agent.get('/api/setup');
  expect(res.status).toBe(200);
  return res.body as SetupView;
}

function item(body: SetupView, key: string) {
  const found = body.items.find((i) => i.key === key);
  if (!found) throw new Error(`No setup item ${key}`);
  return found;
}

/**
 * Makes company A a brand-new one: only its owner is an active member, and it has no texting
 * registration. The seed gives A four active members and an approved registration, which would
 * otherwise count the team and texting steps as done.
 */
async function makeCompanyANew() {
  const a = t.seed.a;
  await ownerSql(
    "update memberships set status = 'disabled' where company_id = $1 and user_id <> $2",
    [a.companyId, a.owner.userId],
  );
  await ownerSql('delete from texting_registrations where company_id = $1', [a.companyId]);
}

test('a new company starts with nine items, five to do', async () => {
  await makeCompanyANew();
  const owner = await loginAs(t.app, t.seed.a.owner);
  const body = await getSetup(owner);

  expect(body.progress).toEqual({ done: 0, total: 5 });
  expect(body.items.map((i) => i.key)).toEqual(KEYS_IN_ORDER);

  const [row] = await ownerSql<{ count: number }>(
    'select count(*)::int as count from setup_items where company_id = $1',
    [t.seed.a.companyId],
  );
  expect(row!.count).toBe(9);
});

test('a located company has its basics done', async () => {
  await makeCompanyANew();
  await ownerSql(
    `update companies
        set location = ST_SetSRID(ST_MakePoint(-96.8, 32.8), 4326),
            service_area = ST_Multi(ST_GeomFromText('POLYGON((-97 32,-96 32,-96 33,-97 33,-97 32))', 4326))
      where id = $1`,
    [t.seed.a.companyId],
  );
  const owner = await loginAs(t.app, t.seed.a.owner);
  const body = await getSetup(owner);

  expect(item(body, 'company_basics').status).toBe('done');
  expect(body.progress.done).toBe(1);
});

test('skipping the import counts toward progress, and unskip undoes it', async () => {
  await makeCompanyANew();
  const owner = await loginAs(t.app, t.seed.a.owner);

  const skipped = await owner.post('/api/setup/import_customers/skip');
  expect(skipped.status).toBe(200);
  expect(item(skipped.body as SetupView, 'import_customers').status).toBe('skipped');
  expect((skipped.body as SetupView).progress.done).toBe(1);

  const unskipped = await owner.post('/api/setup/import_customers/unskip');
  expect(unskipped.status).toBe(200);
  expect(item(unskipped.body as SetupView, 'import_customers').status).toBe('todo');
  expect((unskipped.body as SetupView).progress.done).toBe(0);
});

test('texting cannot be skipped', async () => {
  const owner = await loginAs(t.app, t.seed.a.owner);
  const res = await owner.post('/api/setup/texting_registration/skip');
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: CANNOT_SKIP });
});

test('a pending invite shows the team step as started', async () => {
  await makeCompanyANew();
  const owner = await loginAs(t.app, t.seed.a.owner);

  const invite = await owner.post('/api/team/invites').send({ email: 'new@example.com', role: 'rep' });
  expect(invite.status).toBe(201);

  const body = await getSetup(owner);
  expect(item(body, 'invite_team').status).toBe('in_progress');
});

test('a pending registration is waiting', async () => {
  await ownerSql(
    `insert into texting_registrations (company_id, campaign_status)
     values ($1, 'pending')
     on conflict (company_id) do update set campaign_status = 'pending'`,
    [t.seed.a.companyId],
  );
  const owner = await loginAs(t.app, t.seed.a.owner);
  const body = await getSetup(owner);

  expect(item(body, 'texting_registration').status).toBe('waiting');
});

test('connect_ads turns done once an ad account is active', async () => {
  await ownerSql(
    `insert into ad_accounts (company_id, platform, external_account_id, status) values ($1, 'google', '1234567890', 'pending')`,
    [t.seed.a.companyId],
  );
  const owner = await loginAs(t.app, t.seed.a.owner);
  expect(item(await getSetup(owner), 'connect_ads').status).toBe('waiting');

  await ownerSql(`update ad_accounts set status = 'active' where company_id = $1`, [t.seed.a.companyId]);
  expect(item(await getSetup(owner), 'connect_ads').status).toBe('done');
});

test('a rejection lists only real brand fields', async () => {
  await ownerSql(
    `insert into texting_registrations (company_id, campaign_status, rejection_reason_plain, rejected_fields)
     values ($1, 'rejected', 'R', $2)
     on conflict (company_id) do update
       set campaign_status = 'rejected', rejection_reason_plain = 'R', rejected_fields = $2`,
    [t.seed.a.companyId, ['ein', 'bogus']],
  );
  const owner = await loginAs(t.app, t.seed.a.owner);
  const body = await getSetup(owner);

  expect(item(body, 'texting_registration').data).toEqual({ rejected: true, reason: 'R', fields: ['ein'] });
});

test('office can read but not skip; reps can read', async () => {
  const office = await loginAs(t.app, t.seed.a.office);
  await getSetup(office);

  const refused = await office.post('/api/setup/import_customers/skip');
  expect(refused.status).toBe(403);
  expect(refused.body).toEqual({ error: NOT_ALLOWED });

  const rep = await loginAs(t.app, t.seed.a.rep);
  await getSetup(rep);
});

test("company B never sees A's checklist", async () => {
  const owner = await loginAs(t.app, t.seed.a.owner);
  const skipped = await owner.post('/api/setup/import_customers/skip');
  expect(skipped.status).toBe(200);

  const bOwner = await loginAs(t.app, t.seed.b.owner);
  const body = await getSetup(bOwner);
  expect(item(body, 'import_customers').status).toBe('todo');
});

test('a skip writes an audit row naming the item', async () => {
  const owner = await loginAs(t.app, t.seed.a.owner);
  const res = await owner.post('/api/setup/import_customers/skip');
  expect(res.status).toBe(200);

  const rows = await auditRows(t.seed.a.companyId, 'setup.skip');
  expect(rows).toHaveLength(1);
  expect(rows[0]!.after).toEqual({ key: 'import_customers' });
});

test('an unknown setup key is not found', async () => {
  const owner = await loginAs(t.app, t.seed.a.owner);
  const res = await owner.post('/api/setup/bogus/skip');
  expect(res.status).toBe(404);
  expect(res.body).toEqual({ error: NOT_FOUND });
});
