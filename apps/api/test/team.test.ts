import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import { auditLog, withTenant } from '@roofline/db';
import { SEED_PASSWORD } from '@roofline/db/testing';
import type { GoogleClaims } from '../src/auth/google.ts';
import { LastOwnerError, updateMember } from '../src/auth/team-store.ts';
import { generateToken, hashToken } from '../src/auth/sessions.ts';
import { loginAs, makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

const DAY = 24 * 60 * 60 * 1000;

const NOT_ALLOWED = "Your role can't do that. Ask the owner.";
const NOT_FOUND = "We couldn't find that.";
const CHECK_FIELD = 'Please check this field.';
const ALREADY_ON_TEAM = 'That person is already on your team.';
const ALREADY_MEMBER = "You're already on this team.";
const LAST_OWNER = 'Your company needs at least one owner.';
const INVITE_GONE = 'That invite link has expired or was already used. Ask for a new one.';
const GOOGLE_MISMATCH = "This Google account doesn't match the email that was invited.";
const SIGN_IN_TO_ACCEPT = 'Sign in to accept this invite.';
const CAP_MESSAGE = "You can lower this, but it can't go above 2 a week.";
const PHONE_MESSAGE = "That doesn't look like a US phone number.";
const TIMEZONE_MESSAGE = 'Please pick a valid time zone.';
const VERIFY_FIRST = 'Please confirm your email first. We sent you a link.';
const PASSWORD_MESSAGE = 'Use at least 10 characters for your password.';

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
});

/** A look at (or change to) the global tables through the system pool's raw client. */
async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await t.deps.pools.system.$client.query(text, params);
  return result.rows as T[];
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

async function count(text: string, params: unknown[] = []): Promise<number> {
  const [row] = await sql<{ count: string }>(text, params);
  return Number(row!.count);
}

async function membershipId(companyId: string, userId: string): Promise<string> {
  const [row] = await sql<{ id: string }>('select id from memberships where company_id = $1 and user_id = $2', [
    companyId,
    userId,
  ]);
  return row!.id;
}

/** Puts an existing user into a company directly, the way something other than an invite could. */
async function addMembership(companyId: string, userId: string, role: string, status = 'active') {
  await sql('insert into memberships (company_id, user_id, role, status) values ($1, $2, $3, $4)', [
    companyId,
    userId,
    role,
    status,
  ]);
}

/** A connection of our own, to hold a transaction open while a request runs. */
async function openClient() {
  return t.deps.pools.system.$client.connect();
}

/** Waits until at least `n` database connections are stuck waiting for a lock. */
async function untilBlocked(n: number) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [row] = await sql<{ n: string }>(
      "select count(*) as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()",
    );
    if (Number(row!.n) >= n) return;
    if (Date.now() > deadline) throw new Error(`Nothing was waiting for a lock (wanted ${n}).`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function lastMailToken(to: string): string {
  const mail = [...t.mailer.sent].reverse().find((m) => m.to === to);
  const match = /\/invite\?token=([A-Za-z0-9_-]{43})/.exec(mail?.text ?? '');
  if (!match) throw new Error(`No invite email to ${to}`);
  return match[1]!;
}

/** The owner of company A invites `email` and returns the token from the email. */
async function invite(agent: SuperAgent, email: string, role = 'rep'): Promise<string> {
  const res = await agent.post('/api/team/invites').send({ email, role });
  if (res.status !== 201) throw new Error(`invite failed: ${res.status} ${JSON.stringify(res.body)}`);
  await t.settle();
  return lastMailToken(email.trim().toLowerCase());
}

const accept = (body: Record<string, unknown>) => request(t.app).post('/api/auth/accept-invite').send(body);

const NEW_PERSON = { name: 'Nora Newhire', password: 'a long enough password' };

function claimsFor(email: string, overrides: Partial<GoogleClaims> = {}): GoogleClaims {
  return { sub: 'google-sub-1', email, emailVerified: true, name: 'Gina Google', ...overrides };
}

describe('who may do what', () => {
  test('an office user doing PATCH /api/company → 403', async () => {
    const office = await loginAs(t.app, t.seed.a.office);
    const res = await office.patch('/api/company').send({ name: 'Hijacked Roofing' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: NOT_ALLOWED });
    const [row] = await sql<{ name: string }>('select name from companies where id = $1', [t.seed.a.companyId]);
    expect(row!.name).toBe('Acme Roofing');
  });

  test('a rep is refused every company-admin route', async () => {
    const rep = await loginAs(t.app, t.seed.a.rep);
    const someMember = await membershipId(t.seed.a.companyId, t.seed.a.office.userId);
    const calls = [
      rep.patch('/api/company').send({ name: 'x' }),
      rep.get('/api/company/settings'),
      rep.patch('/api/company/settings').send({ marketingCapPer7d: 1 }),
      rep.post('/api/team/invites').send({ email: 'new@example.com', role: 'rep' }),
      rep.patch(`/api/team/members/${someMember}`).send({ role: 'rep' }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: NOT_ALLOWED });
    }
  });

  test('an office user is refused the settings and the team changes too', async () => {
    const office = await loginAs(t.app, t.seed.a.office);
    expect((await office.get('/api/company/settings')).status).toBe(403);
    expect((await office.post('/api/team/invites').send({ email: 'new@example.com', role: 'rep' })).status).toBe(403);
  });

  test('every member can read the company profile and the team list', async () => {
    for (const person of [t.seed.a.owner, t.seed.a.office, t.seed.a.rep]) {
      const agent = await loginAs(t.app, person);
      expect((await agent.get('/api/company')).status).toBe(200);
      expect((await agent.get('/api/team')).status).toBe(200);
    }
  });

  test('signed out → 401 on all of them', async () => {
    for (const res of [
      await request(t.app).get('/api/company'),
      await request(t.app).patch('/api/company').send({}),
      await request(t.app).get('/api/company/settings'),
      await request(t.app).get('/api/team'),
      await request(t.app).post('/api/team/invites').send({}),
      await request(t.app).post('/api/auth/switch-company').send({ companyId: t.seed.a.companyId }),
    ]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Please sign in.' });
    }
  });
});

describe('PATCH /api/company', () => {
  test('GET returns the profile, and nothing about billing', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const res = await owner.get('/api/company');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: t.seed.a.companyId,
      name: 'Acme Roofing',
      slug: 'acme-roofing',
      phone: t.seed.a.phoneE164,
      timezone: 'America/Chicago',
      addressState: 'NE',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/stripe|plan/i);
  });

  test('saves the profile, turns the phone into E.164, and writes an audit row with before and after', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    t.clock.advance(2 * DAY);
    const res = await owner.patch('/api/company').send({
      name: '  Acme Roofing & Siding ',
      phone: '(402) 555-0123',
      email: 'Office@Acme.example',
      website: 'acme.example',
      addressStreet: '12 Main St',
      addressCity: 'Omaha',
      addressState: 'ne',
      addressZip: '68102',
      timezone: 'America/Denver',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'Acme Roofing & Siding',
      phone: '+14025550123',
      email: 'office@acme.example',
      website: 'https://acme.example',
      addressStreet: '12 Main St',
      addressCity: 'Omaha',
      addressState: 'NE',
      addressZip: '68102',
      timezone: 'America/Denver',
    });
    const [row] = await sql<{ name: string; phone_e164: string; timezone: string; updated_at: Date }>(
      'select name, phone_e164, timezone, updated_at from companies where id = $1',
      [t.seed.a.companyId],
    );
    expect(row).toMatchObject({ name: 'Acme Roofing & Siding', phone_e164: '+14025550123', timezone: 'America/Denver' });
    expect(row!.updated_at.getTime()).toBe(t.clock.now().getTime());

    const rows = await auditRows(t.seed.a.companyId, 'company.update');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: t.seed.a.owner.userId,
      targetType: 'company',
      targetId: t.seed.a.companyId,
      before: { name: 'Acme Roofing', phone: t.seed.a.phoneE164, timezone: 'America/Chicago' },
      after: { name: 'Acme Roofing & Siding', phone: '+14025550123', timezone: 'America/Denver' },
    });
    // The audit row is stamped with the app clock, not the database clock.
    expect(rows[0]!.at.getTime()).toBe(t.clock.now().getTime());
    // Only what was sent is recorded.
    expect(Object.keys(rows[0]!.after as object).sort()).toEqual(
      ['addressCity', 'addressState', 'addressStreet', 'addressZip', 'email', 'name', 'phone', 'timezone', 'website'].sort(),
    );
  });

  test('leaves the other company alone', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    await owner.patch('/api/company').send({ name: 'Changed' });
    const [b] = await sql<{ name: string }>('select name from companies where id = $1', [t.seed.b.companyId]);
    expect(b!.name).toBe('Bolt Roofing');
    expect(await auditRows(t.seed.b.companyId)).toHaveLength(0);
  });

  test.each(['12345', 'not a phone', '(102) 555-0123', '+44 20 7946 0958', '402555'])(
    'phone %j → 400 on the phone field',
    async (phone) => {
      const owner = await loginAs(t.app, t.seed.a.owner);
      const res = await owner.patch('/api/company').send({ phone });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: PHONE_MESSAGE, field: 'phone' });
    },
  );

  test.each(['Mars/Phobos', 'Chicago', '', '+01:00', '-06:00', 'Etc/GMT+5', 'Central Time'])(
    'time zone %j → 400 on the timezone field',
    async (timezone) => {
      const owner = await loginAs(t.app, t.seed.a.owner);
      const res = await owner.patch('/api/company').send({ timezone });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: TIMEZONE_MESSAGE, field: 'timezone' });
    },
  );

  test('UTC and a zone from the IANA list are accepted', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    expect((await owner.patch('/api/company').send({ timezone: 'America/Phoenix' })).status).toBe(200);
    expect((await owner.patch('/api/company').send({ timezone: 'UTC' })).status).toBe(200);
  });

  // Intl.supportedValuesOf lists ICU's older spellings, so a check against that list alone turned
  // away real US zones. The shared isTimeZone also accepts the current IANA names and the aliases.
  test.each(['America/Indiana/Indianapolis', 'America/Kentucky/Louisville', 'US/Central'])(
    'the real US zone %s is accepted and saved',
    async (timezone) => {
      const owner = await loginAs(t.app, t.seed.a.owner);
      const res = await owner.patch('/api/company').send({ timezone });
      expect(res.status).toBe(200);
      expect(res.body.timezone).toBe(timezone);
      const [row] = await sql<{ timezone: string }>('select timezone from companies where id = $1', [t.seed.a.companyId]);
      expect(row!.timezone).toBe(timezone);
    },
  );

  test.each([
    'status',
    'slug',
    'planKey',
    'plan',
    'stripeCustomerId',
    'trialEndsAt',
    'id',
    'companyId',
    'createdAt',
    'serviceArea',
    'phone_e164',
    'legal_name',
  ])('%s is not editable → 400 on that field, and nothing is saved', async (field) => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const res = await owner.patch('/api/company').send({ name: 'Saved Anyway?', [field]: 'x' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: CHECK_FIELD, field });
    const [row] = await sql<{ name: string; status: string; slug: string }>(
      'select name, status, slug from companies where id = $1',
      [t.seed.a.companyId],
    );
    expect(row).toEqual({ name: 'Acme Roofing', status: 'trial', slug: 'acme-roofing' });
    expect(await auditRows(t.seed.a.companyId, 'company.update')).toHaveLength(0);
  });

  test('optional fields can be cleared; the name cannot', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const cleared = await owner.patch('/api/company').send({ phone: null, website: '', legalName: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ phone: null, website: null, legalName: null });
    const empty = await owner.patch('/api/company').send({ name: '   ' });
    expect(empty.status).toBe(400);
    expect(empty.body).toEqual({ error: 'Please enter your company name.', field: 'name' });
    const nullTz = await owner.patch('/api/company').send({ timezone: null });
    expect(nullTz.status).toBe(400);
    expect(nullTz.body.field).toBe('timezone');
  });

  test('an empty body, a non-object body and bad values are 400s in plain English', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const none = await owner.patch('/api/company').send({});
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/change/i);
    expect((await owner.patch('/api/company').send([1, 2])).status).toBe(400);
    const badEmail = await owner.patch('/api/company').send({ email: 'nope' });
    expect(badEmail.body).toEqual({ error: 'Please enter a valid email address.', field: 'email' });
    const badZip = await owner.patch('/api/company').send({ addressZip: 'ABCDE' });
    expect(badZip.status).toBe(400);
    expect(badZip.body.field).toBe('addressZip');
    const badSite = await owner.patch('/api/company').send({ website: 'javascript:alert(1)' });
    expect(badSite.status).toBe(400);
    expect(badSite.body.field).toBe('website');
  });
});

describe('/api/company/settings', () => {
  test('GET returns the settings the company started with', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const res = await owner.get('/api/company/settings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      hourlyRateCents: 2800,
      hailThresholdIn: 1,
      marketingCapPer7d: 2,
      financingAprBps: null,
      financingTermMonths: null,
    });
  });

  test('setting the cap to 3 → 400 with the exact field and message, and nothing changes', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const res = await owner.patch('/api/company/settings').send({ marketingCapPer7d: 3 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: CAP_MESSAGE, field: 'marketingCapPer7d' });
    expect((await owner.get('/api/company/settings')).body.marketingCapPer7d).toBe(2);
    expect(await auditRows(t.seed.a.companyId, 'settings.update')).toHaveLength(0);
  });

  test.each([3, 100, -1, 1.5, '2', null, true, { n: 2 }])('cap %j → 400 with the same message', async (value) => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const res = await owner.patch('/api/company/settings').send({ marketingCapPer7d: value });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: CAP_MESSAGE, field: 'marketingCapPer7d' });
  });

  test.each([0, 1, 2])('cap %i is accepted', async (value) => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const res = await owner.patch('/api/company/settings').send({ marketingCapPer7d: value });
    expect(res.status).toBe(200);
    expect(res.body.marketingCapPer7d).toBe(value);
  });

  const BAD: [string, unknown[], string][] = [
    ['hourlyRateCents', [-1, 100001, 28.5, '2800', null], 'Please enter an hourly rate between $0 and $1,000.'],
    [
      'hailThresholdIn',
      [0, 0.2, 5.25, 1.1, 6, '1', null],
      'Please pick a hail size from 0.25 to 5 inches, in quarter-inch steps.',
    ],
    ['financingAprBps', [-1, 4001, 9.5, '900'], 'Please enter an APR between 0% and 40%.'],
    ['financingTermMonths', [5, 241, 12.5, '60'], 'Please enter a term between 6 and 240 months.'],
  ];
  for (const [field, values, message] of BAD) {
    test.each(values)(`${field} ${'%j'} → 400 with its own message`, async (value) => {
      const owner = await loginAs(t.app, t.seed.a.owner);
      const res = await owner.patch('/api/company/settings').send({ [field]: value });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: message, field });
    });
  }

  test('the edges of each range are accepted', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    for (const body of [
      { hourlyRateCents: 0 },
      { hourlyRateCents: 100000 },
      { hailThresholdIn: 0.25 },
      { hailThresholdIn: 5 },
      { hailThresholdIn: 1.75 },
      { financingAprBps: 0 },
      { financingAprBps: 4000 },
      { financingTermMonths: 6 },
      { financingTermMonths: 240 },
    ]) {
      const res = await owner.patch('/api/company/settings').send(body);
      expect([body, res.status]).toEqual([body, 200]);
    }
    const res = await owner.get('/api/company/settings');
    expect(res.body).toMatchObject({ hourlyRateCents: 100000, hailThresholdIn: 1.75, financingAprBps: 4000, financingTermMonths: 240 });
  });

  test('financing can be switched off again with null', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    await owner.patch('/api/company/settings').send({ financingAprBps: 900, financingTermMonths: 60 });
    const res = await owner.patch('/api/company/settings').send({ financingAprBps: null, financingTermMonths: null });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ financingAprBps: null, financingTermMonths: null });
  });

  test('a saved change writes an audit row with the before and after values', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const res = await owner.patch('/api/company/settings').send({ marketingCapPer7d: 1, hourlyRateCents: 3500 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ marketingCapPer7d: 1, hourlyRateCents: 3500, hailThresholdIn: 1 });
    const rows = await auditRows(t.seed.a.companyId, 'settings.update');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: t.seed.a.owner.userId,
      targetType: 'company_settings',
      before: { marketingCapPer7d: 2, hourlyRateCents: 2800 },
      after: { marketingCapPer7d: 1, hourlyRateCents: 3500 },
    });
    expect(rows[0]!.at.getTime()).toBe(t.clock.now().getTime());
  });

  test('unknown fields, and an empty body, are 400s', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const unknown = await owner.patch('/api/company/settings').send({ marketingCapPer7d: 1, companyId: t.seed.b.companyId });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toEqual({ error: CHECK_FIELD, field: 'companyId' });
    expect((await owner.patch('/api/company/settings').send({})).status).toBe(400);
    expect((await owner.get('/api/company/settings')).body.marketingCapPer7d).toBe(2);
  });

  test("one company's settings are not the other's", async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    await owner.patch('/api/company/settings').send({ marketingCapPer7d: 0 });
    const b = await loginAs(t.app, t.seed.b.owner);
    expect((await b.get('/api/company/settings')).body.marketingCapPer7d).toBe(2);
  });
});

describe('GET /api/team', () => {
  test('lists the members from company_members, only this company, and no passwords', async () => {
    const rep = await loginAs(t.app, t.seed.a.rep);
    const res = await rep.get('/api/team');
    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(4);
    expect(res.body.members.map((m: { email: string }) => m.email).sort()).toEqual([
      'office@a.test',
      'owner@a.test',
      'rep2@a.test',
      'rep@a.test',
    ]);
    const owner = res.body.members.find((m: { email: string }) => m.email === 'owner@a.test');
    expect(owner).toEqual({
      id: await membershipId(t.seed.a.companyId, t.seed.a.owner.userId),
      userId: t.seed.a.owner.userId,
      name: 'Acme Owner',
      email: 'owner@a.test',
      role: 'owner',
      canApproveSpend: false,
      status: 'active',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/scrypt|password/i);
    expect(res.body.invites).toEqual([]);
  });

  test('pending invites are listed for the owner: id, email, role, expiry; not accepted or expired ones', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const acceptedToken = await invite(owner, 'accepted@example.com', 'office');
    await invite(owner, 'pending@example.com', 'rep');
    await invite(owner, 'expiring@example.com', 'rep');
    expect((await accept({ token: acceptedToken, ...NEW_PERSON })).status).toBe(200);
    await sql("update invites set expires_at = $1 where email = 'expiring@example.com'", [new Date(t.clock.now().getTime() - 1000)]);

    const res = await owner.get('/api/team');
    expect(res.body.invites).toEqual([
      {
        id: expect.any(String),
        email: 'pending@example.com',
        role: 'rep',
        expiresAt: new Date(t.clock.now().getTime() + 7 * DAY).toISOString(),
      },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);
  });

  test("another company's invites never show", async () => {
    const b = await loginAs(t.app, t.seed.b.owner);
    await b.post('/api/team/invites').send({ email: 'bolt-hire@example.com', role: 'rep' }).expect(201);
    const a = await loginAs(t.app, t.seed.a.owner);
    expect((await a.get('/api/team')).body.invites).toEqual([]);
  });

  test('a rep does not see who has been invited', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    await invite(owner, 'pending@example.com');
    const rep = await loginAs(t.app, t.seed.a.rep);
    expect((await rep.get('/api/team')).body.invites).toEqual([]);
  });
});

describe('POST /api/team/invites', () => {
  test('emails the link, valid 7 days, and writes an audit row with no token in it', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const res = await owner.post('/api/team/invites').send({ email: '  New.Hire@Example.com ', role: 'office' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      email: 'new.hire@example.com',
      role: 'office',
      expiresAt: new Date(t.clock.now().getTime() + 7 * DAY).toISOString(),
    });
    await t.settle();
    expect(t.mailer.sent).toHaveLength(1);
    const mail = t.mailer.sent[0]!;
    expect(mail.to).toBe('new.hire@example.com');
    expect(mail.subject).toBe("You're invited to join Acme Roofing on Roofline");
    expect(mail.text).toMatch(/https:\/\/app\.roofline\.test\/invite\?token=[A-Za-z0-9_-]{43}/);
    expect(mail.text).toMatch(/7 days/);

    const rows = await auditRows(t.seed.a.companyId, 'invite.create');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: t.seed.a.owner.userId,
      targetType: 'invite',
      targetId: res.body.id,
      after: { email: 'new.hire@example.com', role: 'office' },
    });
    const token = lastMailToken('new.hire@example.com');
    expect(JSON.stringify(rows[0])).not.toContain(token);
    // The database keeps only a hash, and no member row exists yet.
    const stored = await sql<{ token_hash: string }>('select token_hash from invites where email = $1', ['new.hire@example.com']);
    expect(stored[0]!.token_hash).not.toContain(token);
    expect(await sql('select 1 from users where email = $1', ['new.hire@example.com'])).toHaveLength(0);
  });

  test('a failing mailer does not undo the invite', async () => {
    t.deps.mailer.send = async () => {
      throw new Error('Postmark is down');
    };
    const owner = await loginAs(t.app, t.seed.a.owner);
    const res = await owner.post('/api/team/invites').send({ email: 'new@example.com', role: 'rep' });
    await t.settle();
    expect(res.status).toBe(201);
    expect((await owner.get('/api/team')).body.invites).toHaveLength(1);
  });

  test('an owner can be invited too', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const token = await invite(owner, 'cofounder@example.com', 'owner');
    const res = await accept({ token, ...NEW_PERSON });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('owner');
  });

  test('bad input → 400 on the right field', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const noEmail = await owner.post('/api/team/invites').send({ role: 'rep' });
    expect(noEmail.status).toBe(400);
    expect(noEmail.body.field).toBe('email');
    const badEmail = await owner.post('/api/team/invites').send({ email: 'nope', role: 'rep' });
    expect(badEmail.body).toEqual({ error: 'Please enter a valid email address.', field: 'email' });
    for (const role of ['admin', 'system', '', undefined, 3]) {
      const res = await owner.post('/api/team/invites').send({ email: 'ok@example.com', role });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('role');
    }
    await t.settle();
    expect(t.mailer.sent).toHaveLength(0);
  });

  test('someone who is already an active member → 409, whatever the capitals', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const res = await owner.post('/api/team/invites').send({ email: 'REP@a.test', role: 'office' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: ALREADY_ON_TEAM });
    await t.settle();
    expect(t.mailer.sent).toHaveLength(0);
  });

  test('a disabled member can be invited again; a member of another company too', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const repMembership = await membershipId(t.seed.a.companyId, t.seed.a.rep.userId);
    await owner.patch(`/api/team/members/${repMembership}`).send({ status: 'disabled' }).expect(200);
    expect((await owner.post('/api/team/invites').send({ email: 'rep@a.test', role: 'rep' })).status).toBe(201);
    expect((await owner.post('/api/team/invites').send({ email: 'owner@b.test', role: 'rep' })).status).toBe(201);
  });

  test('inviting again replaces the pending invite: the old link stops working', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const first = await invite(owner, 'new@example.com', 'rep');
    const second = await invite(owner, 'New@Example.com', 'office');
    expect(second).not.toBe(first);
    expect((await owner.get('/api/team')).body.invites).toEqual([
      expect.objectContaining({ email: 'new@example.com', role: 'office' }),
    ]);
    const old = await accept({ token: first, ...NEW_PERSON });
    expect(old.status).toBe(400);
    expect(old.body).toEqual({ error: INVITE_GONE });
    const fresh = await accept({ token: second, ...NEW_PERSON });
    expect(fresh.status).toBe(200);
    expect(fresh.body.role).toBe('office');
  });

  test('two invites for the same address at the same moment leave one pending invite', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const results = await Promise.all(
      [1, 2, 3].map(() => owner.post('/api/team/invites').send({ email: 'race@example.com', role: 'rep' })),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect((await owner.get('/api/team')).body.invites).toHaveLength(1);
  });

  test('an owner whose email is not confirmed yet → 403', async () => {
    await sql('update users set email_verified_at = null where id = $1', [t.seed.a.owner.userId]);
    const owner = await loginAs(t.app, t.seed.a.owner);
    const res = await owner.post('/api/team/invites').send({ email: 'new@example.com', role: 'rep' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: VERIFY_FIRST });
    // Confirming lifts the block on the very next request.
    await sql('update users set email_verified_at = now() where id = $1', [t.seed.a.owner.userId]);
    expect((await owner.post('/api/team/invites').send({ email: 'new@example.com', role: 'rep' })).status).toBe(201);
  });

  test('30 an hour per company; the 31st is refused, and the other company is not affected', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    for (let i = 0; i < 30; i++) {
      const res = await owner.post('/api/team/invites').send({ email: `hire${i}@example.com`, role: 'rep' });
      expect([i, res.status]).toEqual([i, 201]);
    }
    const over = await owner.post('/api/team/invites').send({ email: 'one-too-many@example.com', role: 'rep' });
    expect(over.status).toBe(429);
    expect(over.body.error).toMatch(/invites/i);
    const b = await loginAs(t.app, t.seed.b.owner);
    expect((await b.post('/api/team/invites').send({ email: 'bolt@example.com', role: 'rep' })).status).toBe(201);
  });
});

describe('POST /api/auth/accept-invite: a new person', () => {
  test('invite → accept → the new member appears with the invited role, signed in to that company', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const token = await invite(owner, 'nora@example.com', 'office');
    // Nobody exists yet, and no membership was made when the invite went out.
    expect(await sql("select 1 from users where email = 'nora@example.com'")).toHaveLength(0);
    const before = (await owner.get('/api/team')).body.members.length;

    const agent = request.agent(t.app);
    const res = await agent.post('/api/auth/accept-invite').send({ token, ...NEW_PERSON });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      user: { email: 'nora@example.com', name: 'Nora Newhire', emailVerified: true },
      company: { id: t.seed.a.companyId, name: 'Acme Roofing', slug: 'acme-roofing' },
      role: 'office',
      companies: [{ id: t.seed.a.companyId, name: 'Acme Roofing' }],
    });
    expect(String(res.headers['set-cookie'])).toMatch(/rl_session=/);

    const team = await owner.get('/api/team');
    expect(team.body.members).toHaveLength(before + 1);
    expect(team.body.members.find((m: { email: string }) => m.email === 'nora@example.com')).toMatchObject({
      name: 'Nora Newhire',
      role: 'office',
      status: 'active',
    });
    expect(team.body.invites).toEqual([]);

    // The cookie works, they can sign in with the password they chose, and the email counts as confirmed.
    expect((await agent.get('/api/auth/me')).body.user.email).toBe('nora@example.com');
    const login = await request(t.app).post('/api/auth/login').send({ email: 'nora@example.com', password: NEW_PERSON.password });
    expect(login.status).toBe(200);
    const [u] = await sql<{ email_verified_at: Date | null; password_hash: string }>(
      "select email_verified_at, password_hash from users where email = 'nora@example.com'",
    );
    expect(u!.email_verified_at?.getTime()).toBe(t.clock.now().getTime());
    expect(u!.password_hash).toMatch(/^scrypt\$/);
    const [m] = await sql<{ status: string; can_approve_spend: boolean }>(
      "select m.status, m.can_approve_spend from memberships m join users u on u.id = m.user_id where u.email = 'nora@example.com'",
    );
    expect(m).toEqual({ status: 'active', can_approve_spend: false });
  });

  test('writes an invite.accept audit row in the invited company', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const token = await invite(owner, 'nora@example.com', 'rep');
    const res = await accept({ token, ...NEW_PERSON });
    const rows = await auditRows(t.seed.a.companyId, 'invite.accept');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: res.body.user.id,
      targetType: 'invite',
      after: { email: 'nora@example.com', role: 'rep' },
    });
    expect(await auditRows(t.seed.b.companyId, 'invite.accept')).toHaveLength(0);
  });

  test('the link works once', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const token = await invite(owner, 'nora@example.com');
    expect((await accept({ token, ...NEW_PERSON })).status).toBe(200);
    const again = await accept({ token, ...NEW_PERSON });
    expect(again.status).toBe(400);
    expect(again.body).toEqual({ error: INVITE_GONE });
  });

  test('two requests with the same link at once: exactly one wins', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const token = await invite(owner, 'nora@example.com');
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => request(t.app).post('/api/auth/accept-invite').send({ token, ...NEW_PERSON })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400, 400]);
    for (const loser of results.filter((r) => r.status === 400)) expect(loser.body).toEqual({ error: INVITE_GONE });
    expect(await sql("select 1 from users where email = 'nora@example.com'")).toHaveLength(1);
    expect(await sql("select 1 from memberships m join users u on u.id = m.user_id where u.email = 'nora@example.com'")).toHaveLength(1);
    expect(await auditRows(t.seed.a.companyId, 'invite.accept')).toHaveLength(1);
  });

  test('works up to the last moment of the 7 days, and not after', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const early = await invite(owner, 'early@example.com');
    const late = await invite(owner, 'late@example.com');
    t.clock.advance(7 * DAY - 1000);
    expect((await accept({ token: early, ...NEW_PERSON })).status).toBe(200);
    t.clock.advance(1000);
    const res = await accept({ token: late, ...NEW_PERSON });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: INVITE_GONE });
    expect(await sql("select 1 from users where email = 'late@example.com'")).toHaveLength(0);
  });

  test.each(['', 'short', 'x'.repeat(43), 'x'.repeat(200), 'a/b']) ('token %j that was never issued → 400', async (token) => {
    const res = await accept({ token, ...NEW_PERSON });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(token === '' ? 'That link is incomplete. Please open it again from your email.' : INVITE_GONE);
  });

  test('a missing token is a 400 too', async () => {
    const res = await accept({ ...NEW_PERSON });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('token');
  });

  test('a short password or no name is a 400 and the link is not used up', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const token = await invite(owner, 'nora@example.com');
    const short = await accept({ token, name: 'Nora', password: 'short' });
    expect(short.status).toBe(400);
    expect(short.body).toEqual({ error: PASSWORD_MESSAGE, field: 'password' });
    const noName = await accept({ token, password: NEW_PERSON.password });
    expect(noName.status).toBe(400);
    expect(noName.body).toEqual({ error: 'Please enter a name.', field: 'name' });
    const noPassword = await accept({ token, name: 'Nora' });
    expect(noPassword.status).toBe(400);
    expect(noPassword.body.field).toBe('password');
    expect(await sql("select 1 from users where email = 'nora@example.com'")).toHaveLength(0);
    expect((await accept({ token, ...NEW_PERSON })).status).toBe(200);
  });

  test('a link from company B does not put anyone in company A', async () => {
    const b = await loginAs(t.app, t.seed.b.owner);
    const token = await invite(b, 'nora@example.com');
    const res = await accept({ token, ...NEW_PERSON });
    expect(res.body.company.id).toBe(t.seed.b.companyId);
    const owner = await loginAs(t.app, t.seed.a.owner);
    expect((await owner.get('/api/team')).body.members.map((m: { email: string }) => m.email)).not.toContain('nora@example.com');
  });
});

describe('POST /api/auth/accept-invite: with Google', () => {
  test('a new person whose Google email is the invited one: user made with the Google account, verified, no password', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const token = await invite(owner, 'gina@example.com', 'rep');
    t.google.register('cred-gina', claimsFor('Gina@Example.com'));
    const res = await accept({ token, googleCredential: 'cred-gina' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      user: { email: 'gina@example.com', name: 'Gina Google', emailVerified: true },
      company: { id: t.seed.a.companyId },
      role: 'rep',
    });
    const [u] = await sql<{ google_sub: string; password_hash: string | null; email_verified_at: Date }>(
      "select google_sub, password_hash, email_verified_at from users where email = 'gina@example.com'",
    );
    expect(u).toMatchObject({ google_sub: 'google-sub-1', password_hash: null });
    expect(u!.email_verified_at.getTime()).toBe(t.clock.now().getTime());
  });

  test("a different Google email → 400, no user is made, and the link still works", async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const token = await invite(owner, 'gina@example.com');
    t.google.register('cred-other', claimsFor('someone.else@example.com'));
    const res = await accept({ token, googleCredential: 'cred-other' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: GOOGLE_MISMATCH });
    expect(await sql("select 1 from users where google_sub = 'google-sub-1'")).toHaveLength(0);
    t.google.register('cred-gina', claimsFor('gina@example.com'));
    expect((await accept({ token, googleCredential: 'cred-gina' })).status).toBe(200);
  });

  test('the right address, but Google has not confirmed it → 400', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const token = await invite(owner, 'gina@example.com');
    t.google.register('cred-unverified', claimsFor('gina@example.com', { emailVerified: false }));
    const res = await accept({ token, googleCredential: 'cred-unverified' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hasn't confirmed/);
    expect(await sql("select 1 from users where email = 'gina@example.com'")).toHaveLength(0);
  });

  test('a credential Google does not accept → 401 and the link still works', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const token = await invite(owner, 'gina@example.com');
    const res = await accept({ token, googleCredential: 'nonsense' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Google/);
    t.google.register('cred-gina', claimsFor('gina@example.com'));
    expect((await accept({ token, googleCredential: 'cred-gina' })).status).toBe(200);
  });

  test("a Google account that already belongs to another user → 409, link not used up", async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const token = await invite(owner, 'gina@example.com');
    await sql('update users set google_sub = $1 where id = $2', ['google-sub-1', t.seed.b.rep.userId]);
    t.google.register('cred-gina', claimsFor('gina@example.com'));
    const res = await accept({ token, googleCredential: 'cred-gina' });
    expect(res.status).toBe(409);
    expect(await sql("select 1 from users where email = 'gina@example.com'")).toHaveLength(0);
    expect((await accept({ token, ...NEW_PERSON })).status).toBe(200);
  });

  test("Google sign-in not set up on this server → 503, like /api/auth/google", async () => {
    const off = await makeTestApp({ GOOGLE_CLIENT_ID: undefined });
    const owner = await loginAs(off.app, off.seed.a.owner);
    await owner.post('/api/team/invites').send({ email: 'gina@example.com', role: 'rep' }).expect(201);
    await off.settle();
    const token = /token=([A-Za-z0-9_-]{43})/.exec(off.mailer.sent[0]!.text)![1]!;
    const res = await request(off.app).post('/api/auth/accept-invite').send({ token, googleCredential: 'cred' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "Google sign-in isn't set up yet." });
  });
});

describe('POST /api/auth/accept-invite: someone who already has an account', () => {
  /** B's rep is invited to A. */
  async function inviteBRep(role = 'office') {
    const owner = await loginAs(t.app, t.seed.a.owner);
    return invite(owner, t.seed.b.rep.email, role);
  }

  test('no session, no password → 401 and nothing changes', async () => {
    const token = await inviteBRep();
    const res = await accept({ token });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: SIGN_IN_TO_ACCEPT });
    expect(await sql('select 1 from memberships where company_id = $1 and user_id = $2', [t.seed.a.companyId, t.seed.b.rep.userId])).toHaveLength(0);
  });

  test('a wrong password → 401, and the link is not used up', async () => {
    const token = await inviteBRep();
    const res = await accept({ token, name: 'Whoever', password: 'wrong password here' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: SIGN_IN_TO_ACCEPT });
    expect((await accept({ token, password: SEED_PASSWORD })).status).toBe(200);
  });

  test('the right password → the membership is added and they are signed in to the new company; the name is ignored', async () => {
    const token = await inviteBRep('office');
    const res = await accept({ token, name: 'A Different Name', password: SEED_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      user: { id: t.seed.b.rep.userId, email: 'rep@b.test', name: 'Bolt Rep' },
      company: { id: t.seed.a.companyId },
      role: 'office',
    });
    expect(res.body.companies.map((c: { id: string }) => c.id).sort()).toEqual([t.seed.a.companyId, t.seed.b.companyId].sort());
    const [m] = await sql<{ role: string; status: string }>('select role, status from memberships where company_id = $1 and user_id = $2', [
      t.seed.a.companyId,
      t.seed.b.rep.userId,
    ]);
    expect(m).toEqual({ role: 'office', status: 'active' });
    // Their B membership is untouched.
    const [b] = await sql<{ role: string }>('select role from memberships where company_id = $1 and user_id = $2', [t.seed.b.companyId, t.seed.b.rep.userId]);
    expect(b!.role).toBe('rep');
  });

  test('a live session of that same user is enough, and it is re-used with the new company', async () => {
    const token = await inviteBRep('office');
    const bRep = await loginAs(t.app, t.seed.b.rep);
    const before = await count('select count(*) from sessions where user_id = $1', [t.seed.b.rep.userId]);
    expect((await bRep.get('/api/auth/me')).body.company.id).toBe(t.seed.b.companyId);

    const res = await bRep.post('/api/auth/accept-invite').send({ token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ company: { id: t.seed.a.companyId }, role: 'office' });
    const after = await count('select count(*) from sessions where user_id = $1', [t.seed.b.rep.userId]);
    expect(after).toBe(before);
    // The same cookie now works in company A.
    const me = await bRep.get('/api/auth/me');
    expect(me.body.company.id).toBe(t.seed.a.companyId);
    expect(me.body.role).toBe('office');
  });

  test("another person's live session is not proof", async () => {
    const token = await inviteBRep();
    const aOffice = await loginAs(t.app, t.seed.a.office);
    const res = await aOffice.post('/api/auth/accept-invite').send({ token });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: SIGN_IN_TO_ACCEPT });
    // That session is still theirs.
    expect((await aOffice.get('/api/auth/me')).body.user.email).toBe('office@a.test');
  });

  test("with the right password while signed in as someone else: they get their own new session, the other one is not reused", async () => {
    const token = await inviteBRep();
    const aOffice = await loginAs(t.app, t.seed.a.office);
    const res = await aOffice.post('/api/auth/accept-invite').send({ token, password: SEED_PASSWORD });
    expect(res.status).toBe(200);
    expect((await aOffice.get('/api/auth/me')).body.user.email).toBe('rep@b.test');
  });

  test('a Google account already connected to them is enough', async () => {
    await sql('update users set google_sub = $1 where id = $2', ['sub-brep', t.seed.b.rep.userId]);
    const token = await inviteBRep('rep');
    t.google.register('cred-brep', claimsFor('totally.other@example.com', { sub: 'sub-brep' }));
    const res = await accept({ token, googleCredential: 'cred-brep' });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(t.seed.b.rep.userId);
  });

  test('a Google account with the right email that is not connected to them is not enough → 401', async () => {
    const token = await inviteBRep();
    t.google.register('cred-same-email', claimsFor('rep@b.test', { sub: 'unconnected-sub' }));
    const res = await accept({ token, googleCredential: 'cred-same-email' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: SIGN_IN_TO_ACCEPT });
    expect(await sql("select 1 from users where google_sub = 'unconnected-sub'")).toHaveLength(0);
  });

  test("a Google account with another email that is not connected to them → 400 (wrong address)", async () => {
    const token = await inviteBRep();
    t.google.register('cred-other', claimsFor('stranger@example.com', { sub: 'stranger-sub' }));
    const res = await accept({ token, googleCredential: 'cred-other' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: GOOGLE_MISMATCH });
  });

  test('already an active member → 409', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const token = await invite(owner, t.seed.b.rep.email, 'office');
    await addMembership(t.seed.a.companyId, t.seed.b.rep.userId, 'rep');
    const res = await accept({ token, password: SEED_PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: ALREADY_MEMBER });
    // Their role is not changed by the invite.
    const [m] = await sql<{ role: string }>('select role from memberships where company_id = $1 and user_id = $2', [t.seed.a.companyId, t.seed.b.rep.userId]);
    expect(m!.role).toBe('rep');
  });

  test('a wrong password is a 401 before it is ever a 409 (membership is not revealed)', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const token = await invite(owner, t.seed.b.rep.email);
    await addMembership(t.seed.a.companyId, t.seed.b.rep.userId, 'rep');
    const res = await accept({ token, password: 'not the password' });
    expect(res.status).toBe(401);
  });

  test('a disabled member who is invited again is switched back on with the invited role and no spend approval', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const repMembership = await membershipId(t.seed.a.companyId, t.seed.a.rep.userId);
    await owner.patch(`/api/team/members/${repMembership}`).send({ status: 'disabled', canApproveSpend: true }).expect(200);
    const token = await invite(owner, 'rep@a.test', 'office');
    const res = await accept({ token, password: SEED_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('office');
    const [m] = await sql<{ id: string; role: string; status: string; can_approve_spend: boolean }>(
      'select id, role, status, can_approve_spend from memberships where company_id = $1 and user_id = $2',
      [t.seed.a.companyId, t.seed.a.rep.userId],
    );
    expect(m).toEqual({ id: repMembership, role: 'office', status: 'active', can_approve_spend: false });
  });

  test('guessing passwords against a link is limited: 10 failures, then 429 even for the right one', async () => {
    const token = await inviteBRep();
    for (let i = 0; i < 10; i++) {
      expect((await accept({ token, password: `wrong guess ${i}` })).status).toBe(401);
    }
    const blocked = await accept({ token, password: SEED_PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'Too many sign-in attempts. Try again in a few minutes.' });
  });
});

describe('POST /api/auth/accept-invite: the session is made inside the acceptance transaction', () => {
  const BREP = () => t.seed.b.rep;

  async function inviteBRep() {
    const owner = await loginAs(t.app, t.seed.a.owner);
    return { owner, token: await invite(owner, BREP().email, 'office') };
  }

  async function sessionCount(userId: string) {
    return count('select count(*) from sessions where user_id = $1', [userId]);
  }

  async function nothingAccepted(owner: SuperAgent) {
    expect(await sql('select 1 from memberships where company_id = $1 and user_id = $2', [t.seed.a.companyId, BREP().userId])).toHaveLength(0);
    expect((await owner.get('/api/team')).body.invites).toHaveLength(1);
  }

  test('a password reset that commits right after the acceptance leaves no session made from the old password', async () => {
    const { token } = await inviteBRep();
    const blocker = await openClient(); // holds the membership the acceptance wants to insert
    const reset = await openClient();
    try {
      await blocker.query('begin');
      await blocker.query('insert into memberships (company_id, user_id, role) values ($1, $2, $3)', [t.seed.a.companyId, BREP().userId, 'rep']);
      const accepting = accept({ token, password: SEED_PASSWORD }).then((res) => res);
      await untilBlocked(1); // the acceptance holds the user's row (FOR SHARE) and waits for the membership key
      // A password reset starts now: its UPDATE of the user waits behind the acceptance, then runs
      // the way the real one does (change the password, delete ALL the user's sessions, commit).
      await reset.query('begin');
      const resetting = (async () => {
        await reset.query("update users set password_hash = 'scrypt$reset-after' where id = $1", [BREP().userId]);
        await reset.query('delete from sessions where user_id = $1', [BREP().userId]);
        await reset.query('commit');
      })();
      await untilBlocked(2);
      await blocker.query('rollback'); // the acceptance goes on
      const res = await accepting;
      await resetting;
      expect(res.status).toBe(200);
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      await reset.query('rollback').catch(() => undefined);
      blocker.release();
      reset.release();
    }
    // The acceptance's session was saved before the reset's DELETE could run, so the DELETE took it.
    expect(await sessionCount(BREP().userId)).toBe(0);
  });

  test('a password reset that commits first makes the acceptance a 401, with no session and the invite still pending', async () => {
    const { owner, token } = await inviteBRep();
    const reset = await openClient();
    try {
      await reset.query('begin');
      await reset.query("update users set password_hash = 'scrypt$reset-first' where id = $1", [BREP().userId]);
      const accepting = accept({ token, password: SEED_PASSWORD }).then((res) => res);
      await untilBlocked(1); // verified the old password, now waiting for the user's row
      await reset.query('delete from sessions where user_id = $1', [BREP().userId]);
      await reset.query('commit');
      const res = await accepting;
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: SIGN_IN_TO_ACCEPT });
      expect(res.headers['set-cookie']).toBeUndefined();
    } finally {
      await reset.query('rollback').catch(() => undefined);
      reset.release();
    }
    expect(await sessionCount(BREP().userId)).toBe(0);
    await nothingAccepted(owner);
  });

  test('a proving session that is deleted before the acceptance checks it → 401, and no new session is made', async () => {
    const { owner, token } = await inviteBRep();
    const bRep = await loginAs(t.app, BREP());
    const blocker = await openClient(); // holds the invite row, so the acceptance cannot start yet
    try {
      await blocker.query('begin');
      await blocker.query('update invites set role = role where email = $1', [BREP().email]);
      const accepting = bRep.post('/api/auth/accept-invite').send({ token }).then((res) => res);
      await untilBlocked(1);
      await sql('delete from sessions where user_id = $1', [BREP().userId]); // signed out elsewhere
      await blocker.query('rollback');
      const res = await accepting;
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: SIGN_IN_TO_ACCEPT });
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      blocker.release();
    }
    expect(await sessionCount(BREP().userId)).toBe(0);
    await nothingAccepted(owner);
  });

  test('a proving session that is deleted right after the acceptance checks it does not leave a fresh session behind', async () => {
    const { token } = await inviteBRep();
    const bRep = await loginAs(t.app, BREP());
    const blocker = await openClient(); // holds the membership the acceptance wants to insert
    try {
      await blocker.query('begin');
      await blocker.query('insert into memberships (company_id, user_id, role) values ($1, $2, $3)', [t.seed.a.companyId, BREP().userId, 'rep']);
      const accepting = bRep.post('/api/auth/accept-invite').send({ token }).then((res) => res);
      await untilBlocked(1); // the acceptance has checked (and share-locked) the proving session
      const loggingOut = sql('delete from sessions where user_id = $1', [BREP().userId]); // queued behind that lock
      await untilBlocked(2);
      await blocker.query('rollback');
      await accepting;
      await loggingOut;
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      blocker.release();
    }
    // Whatever the answer was, the session that was just revoked did not turn into a live one.
    expect(await sessionCount(BREP().userId)).toBe(0);
  });

  test('a new person and a password-proven user get their session from the acceptance itself (one cookie, works at once)', async () => {
    const { token } = await inviteBRep();
    const agent = request.agent(t.app);
    const res = await agent.post('/api/auth/accept-invite').send({ token, password: SEED_PASSWORD });
    expect(res.status).toBe(200);
    expect(String(res.headers['set-cookie'])).toMatch(/rl_session=/);
    expect(await sessionCount(BREP().userId)).toBe(1);
    const me = await agent.get('/api/auth/me');
    expect(me.body.company.id).toBe(t.seed.a.companyId);
    expect(me.body.role).toBe('office');
  });

  test("a live session of someone else that the request carried is deleted in the same step", async () => {
    const { token } = await inviteBRep();
    const aOffice = await loginAs(t.app, t.seed.a.office);
    expect(await sessionCount(t.seed.a.office.userId)).toBe(1);
    const res = await aOffice.post('/api/auth/accept-invite').send({ token, password: SEED_PASSWORD });
    expect(res.status).toBe(200);
    expect(await sessionCount(t.seed.a.office.userId)).toBe(0);
    expect(await sessionCount(BREP().userId)).toBe(1);
  });
});

describe('disabling a member voids their pending invites', () => {
  /** B's rep is invited to A, and then ends up an active member of A some other way. */
  async function pendingInviteForMember() {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const token = await invite(owner, t.seed.b.rep.email, 'office');
    await addMembership(t.seed.a.companyId, t.seed.b.rep.userId, 'rep');
    return { owner, token, id: await membershipId(t.seed.a.companyId, t.seed.b.rep.userId) };
  }

  test("a disabled member cannot switch themselves back on with an invite they still had", async () => {
    const { owner, token, id } = await pendingInviteForMember();
    expect((await owner.get('/api/team')).body.invites).toHaveLength(1);
    await owner.patch(`/api/team/members/${id}`).send({ status: 'disabled' }).expect(200);
    expect((await owner.get('/api/team')).body.invites).toEqual([]);

    const res = await accept({ token, password: SEED_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: INVITE_GONE });
    const [m] = await sql<{ status: string; role: string }>('select status, role from memberships where id = $1', [id]);
    expect(m).toEqual({ status: 'disabled', role: 'rep' });
    expect(await count('select count(*) from sessions where user_id = $1 and active_company_id = $2', [t.seed.b.rep.userId, t.seed.a.companyId])).toBe(0);
  });

  test("only that company's invites to that address go; other people's and other companies' stay", async () => {
    const { owner, id } = await pendingInviteForMember();
    await invite(owner, 'someone.else@example.com', 'rep');
    // Bolt's own invite to the same address (made directly: Bolt cannot invite its own member).
    await sql(
      "insert into invites (company_id, email, role, token_hash, expires_at) values ($1, $2, 'office', $3, $4)",
      [t.seed.b.companyId, t.seed.b.rep.email, hashToken(generateToken()), new Date(t.clock.now().getTime() + 7 * DAY)],
    );
    const b = await loginAs(t.app, t.seed.b.owner);
    await owner.patch(`/api/team/members/${id}`).send({ status: 'disabled' }).expect(200);
    expect((await owner.get('/api/team')).body.invites.map((i: { email: string }) => i.email)).toEqual(['someone.else@example.com']);
    expect((await b.get('/api/team')).body.invites).toHaveLength(1);
  });

  test('turning someone back on does not bring a voided invite back, and they can be invited afresh', async () => {
    const { owner, id } = await pendingInviteForMember();
    await owner.patch(`/api/team/members/${id}`).send({ status: 'disabled' }).expect(200);
    await owner.patch(`/api/team/members/${id}`).send({ status: 'active' }).expect(200);
    expect((await owner.get('/api/team')).body.invites).toEqual([]);
    // Inviting again is possible once they are disabled again.
    await owner.patch(`/api/team/members/${id}`).send({ status: 'disabled' }).expect(200);
    expect((await owner.post('/api/team/invites').send({ email: t.seed.b.rep.email, role: 'rep' })).status).toBe(201);
  });

  test('a disable that is refused (the last owner) keeps the invites too', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    await sql(
      "insert into invites (company_id, email, role, token_hash, expires_at) values ($1, 'owner@a.test', 'owner', $2, $3)",
      [t.seed.a.companyId, hashToken(generateToken()), new Date(t.clock.now().getTime() + 7 * DAY)],
    );
    const id = await membershipId(t.seed.a.companyId, t.seed.a.owner.userId);
    expect((await owner.patch(`/api/team/members/${id}`).send({ status: 'disabled' })).status).toBe(400);
    expect(await count("select count(*) from invites where email = 'owner@a.test'")).toBe(1);
  });

  test('a disable and an accept that both wait for the same membership do not deadlock (invites are locked first)', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    await addMembership(t.seed.a.companyId, t.seed.b.rep.userId, 'rep');
    const id = await membershipId(t.seed.a.companyId, t.seed.b.rep.userId);
    const token = generateToken();
    await sql(
      "insert into invites (company_id, email, role, token_hash, expires_at) values ($1, $2, 'office', $3, $4)",
      [t.seed.a.companyId, t.seed.b.rep.email, hashToken(token), new Date(t.clock.now().getTime() + 7 * DAY)],
    );
    const blocker = await openClient(); // holds the member's row, so both requests queue behind it
    try {
      await blocker.query('begin');
      await blocker.query('select id from memberships where id = $1 for update', [id]);
      const disabling = owner.patch(`/api/team/members/${id}`).send({ status: 'disabled' }).then((res) => res);
      await untilBlocked(1);
      const accepting = accept({ token, password: SEED_PASSWORD }).then((res) => res);
      await untilBlocked(2);
      await blocker.query('rollback');
      const [disabled, accepted] = await Promise.all([disabling, accepting]);
      // Taking the locks in different orders would be a deadlock here: one of the two would get a 500.
      expect(disabled.status).toBe(200);
      expect(accepted.status).toBe(400);
      expect(accepted.body).toEqual({ error: INVITE_GONE });
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      blocker.release();
    }
    const [m] = await sql<{ status: string }>('select status from memberships where id = $1', [id]);
    expect(m!.status).toBe('disabled');
  });

  test('disabling at the same moment as the person accepts (with their session) never deadlocks: never a 500', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    await addMembership(t.seed.a.companyId, t.seed.b.rep.userId, 'rep');
    const id = await membershipId(t.seed.a.companyId, t.seed.b.rep.userId);
    for (let round = 0; round < 8; round++) {
      await sql("update memberships set status = 'active', role = 'rep' where id = $1", [id]);
      const token = generateToken();
      await sql(
        "insert into invites (company_id, email, role, token_hash, expires_at) values ($1, $2, 'office', $3, $4)",
        [t.seed.a.companyId, t.seed.b.rep.email, hashToken(token), new Date(t.clock.now().getTime() + 7 * DAY)],
      );
      // Their session is working in company A, so it is both their proof and what the disable deletes.
      const member = await loginAs(t.app, t.seed.b.rep);
      await member.post('/api/auth/switch-company').send({ companyId: t.seed.a.companyId }).expect(200);
      const [accepting, disabling] = await Promise.all([
        member.post('/api/auth/accept-invite').send({ token }),
        owner.patch(`/api/team/members/${id}`).send({ status: 'disabled' }),
      ]);
      expect([round, disabling.status]).toEqual([round, 200]);
      // 409 (they were still active), 401 (their session was already gone) or 400 (the invite was voided).
      expect([round, [400, 401, 409].includes(accepting.status)]).toEqual([round, true]);
      const [m] = await sql<{ status: string }>('select status from memberships where id = $1', [id]);
      expect([round, m!.status]).toEqual([round, 'disabled']);
      await sql('delete from sessions where user_id = $1', [t.seed.b.rep.userId]);
      await sql('delete from invites where email = $1', [t.seed.b.rep.email]);
    }
  });
});

describe('PATCH /api/team/members/:membershipId', () => {
  test('changes a role and writes an audit row with before and after', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const id = await membershipId(t.seed.a.companyId, t.seed.a.rep.userId);
    t.clock.advance(DAY);
    const res = await owner.patch(`/api/team/members/${id}`).send({ role: 'office' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id,
      userId: t.seed.a.rep.userId,
      name: 'Acme Rep',
      email: 'rep@a.test',
      role: 'office',
      canApproveSpend: false,
      status: 'active',
    });
    const rows = await auditRows(t.seed.a.companyId, 'member.update');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: t.seed.a.owner.userId,
      targetType: 'membership',
      targetId: id,
      before: { role: 'rep', canApproveSpend: false, status: 'active' },
      after: { role: 'office', canApproveSpend: false, status: 'active' },
    });
    expect(rows[0]!.at.getTime()).toBe(t.clock.now().getTime());
    // The rep's own next request already sees the new role (it is read fresh).
    const rep = await loginAs(t.app, t.seed.a.rep);
    expect((await rep.get('/api/auth/me')).body.role).toBe('office');
  });

  test("the team list shows the office user's spend delegation before and after a PATCH", async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const id = await membershipId(t.seed.a.companyId, t.seed.a.office.userId);
    const flagOf = async () => {
      const team = await owner.get('/api/team');
      const office = team.body.members.find((m: { id: string }) => m.id === id);
      return office.canApproveSpend as boolean;
    };
    expect(await flagOf()).toBe(false);
    await owner.patch(`/api/team/members/${id}`).send({ canApproveSpend: true }).expect(200);
    expect(await flagOf()).toBe(true);
    await owner.patch(`/api/team/members/${id}`).send({ role: 'rep' }).expect(200);
    expect(await flagOf()).toBe(false);
    // Another member's flag is not touched by any of this, and a rep sees the list the same way.
    const rep = await loginAs(t.app, t.seed.a.rep);
    const seen = (await rep.get('/api/team')).body.members as { canApproveSpend: boolean }[];
    expect(seen.every((m) => m.canApproveSpend === false)).toBe(true);
  });

  test('delegates spend approval to an office user, and takes it back', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const id = await membershipId(t.seed.a.companyId, t.seed.a.office.userId);
    const on = await owner.patch(`/api/team/members/${id}`).send({ canApproveSpend: true });
    expect(on.body.canApproveSpend).toBe(true);
    const [row] = await sql<{ can_approve_spend: boolean }>('select can_approve_spend from memberships where id = $1', [id]);
    expect(row!.can_approve_spend).toBe(true);
    const off = await owner.patch(`/api/team/members/${id}`).send({ canApproveSpend: false });
    expect(off.body.canApproveSpend).toBe(false);
    const rows = await auditRows(t.seed.a.companyId, 'member.update');
    expect(rows.map((r) => (r.after as { canApproveSpend: boolean }).canApproveSpend)).toEqual([true, false]);
  });

  test('canApproveSpend on an owner or a rep is accepted (it just has no effect)', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const rep = await membershipId(t.seed.a.companyId, t.seed.a.rep.userId);
    const own = await membershipId(t.seed.a.companyId, t.seed.a.owner.userId);
    expect((await owner.patch(`/api/team/members/${rep}`).send({ canApproveSpend: true })).status).toBe(200);
    expect((await owner.patch(`/api/team/members/${own}`).send({ canApproveSpend: true })).status).toBe(200);
  });

  test('a role change takes spend approval back unless the same request says otherwise', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const id = await membershipId(t.seed.a.companyId, t.seed.a.office.userId);
    await owner.patch(`/api/team/members/${id}`).send({ canApproveSpend: true }).expect(200);
    const asRep = await owner.patch(`/api/team/members/${id}`).send({ role: 'rep' });
    expect(asRep.body).toMatchObject({ role: 'rep', canApproveSpend: false });
    const kept = await owner.patch(`/api/team/members/${id}`).send({ role: 'office', canApproveSpend: true });
    expect(kept.body).toMatchObject({ role: 'office', canApproveSpend: true });
  });

  test("disabling a member removes their sessions for this company only, and they are out on the next request", async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    // B's rep also works for A.
    await addMembership(t.seed.a.companyId, t.seed.b.rep.userId, 'rep');
    const inB = await loginAs(t.app, t.seed.b.rep);
    const inA = await loginAs(t.app, t.seed.b.rep);
    await inA.post('/api/auth/switch-company').send({ companyId: t.seed.a.companyId }).expect(200);
    expect((await inA.get('/api/auth/me')).body.company.id).toBe(t.seed.a.companyId);

    const id = await membershipId(t.seed.a.companyId, t.seed.b.rep.userId);
    const res = await owner.patch(`/api/team/members/${id}`).send({ status: 'disabled' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('disabled');

    expect(await sql('select 1 from sessions where user_id = $1 and active_company_id = $2', [t.seed.b.rep.userId, t.seed.a.companyId])).toHaveLength(0);
    expect((await inA.get('/api/auth/me')).status).toBe(401);
    // Their session in Bolt is untouched.
    const stillB = await inB.get('/api/auth/me');
    expect(stillB.status).toBe(200);
    expect(stillB.body.company.id).toBe(t.seed.b.companyId);
    // Company A no longer lists them as active; the audit row says what changed.
    const team = await owner.get('/api/team');
    expect(team.body.members.find((m: { email: string }) => m.email === 'rep@b.test').status).toBe('disabled');
    const rows = await auditRows(t.seed.a.companyId, 'member.update');
    expect(rows[0]).toMatchObject({ before: { status: 'active' }, after: { status: 'disabled' } });
  });

  test('turning a member back on does not bring their old sessions back', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const rep = await loginAs(t.app, t.seed.a.rep);
    const id = await membershipId(t.seed.a.companyId, t.seed.a.rep.userId);
    await owner.patch(`/api/team/members/${id}`).send({ status: 'disabled' }).expect(200);
    expect((await rep.get('/api/auth/me')).status).toBe(401);
    await owner.patch(`/api/team/members/${id}`).send({ status: 'active' }).expect(200);
    expect((await rep.get('/api/auth/me')).status).toBe(401);
    expect((await loginAs(t.app, t.seed.a.rep).then((a) => a.get('/api/auth/me'))).status).toBe(200);
  });

  describe('the last owner', () => {
    test('cannot be demoted', async () => {
      const owner = await loginAs(t.app, t.seed.a.owner);
      const id = await membershipId(t.seed.a.companyId, t.seed.a.owner.userId);
      const res = await owner.patch(`/api/team/members/${id}`).send({ role: 'office' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: LAST_OWNER });
      const [row] = await sql<{ role: string }>('select role from memberships where id = $1', [id]);
      expect(row!.role).toBe('owner');
      expect(await auditRows(t.seed.a.companyId, 'member.update')).toHaveLength(0);
    });

    test('cannot be disabled', async () => {
      const owner = await loginAs(t.app, t.seed.a.owner);
      const id = await membershipId(t.seed.a.companyId, t.seed.a.owner.userId);
      const res = await owner.patch(`/api/team/members/${id}`).send({ status: 'disabled' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: LAST_OWNER });
      // Even together with something harmless, and even by demoting and disabling at once.
      expect((await owner.patch(`/api/team/members/${id}`).send({ role: 'rep', status: 'disabled' })).status).toBe(400);
      expect((await owner.get('/api/auth/me')).status).toBe(200);
    });

    test('can have other changes made to it', async () => {
      const owner = await loginAs(t.app, t.seed.a.owner);
      const id = await membershipId(t.seed.a.companyId, t.seed.a.owner.userId);
      expect((await owner.patch(`/api/team/members/${id}`).send({ role: 'owner', status: 'active', canApproveSpend: true })).status).toBe(200);
    });

    test('with a second owner, one of them can step down, and then the other is the last', async () => {
      const owner = await loginAs(t.app, t.seed.a.owner);
      const first = await membershipId(t.seed.a.companyId, t.seed.a.owner.userId);
      const second = await membershipId(t.seed.a.companyId, t.seed.a.office.userId);
      await owner.patch(`/api/team/members/${second}`).send({ role: 'owner' }).expect(200);
      await owner.patch(`/api/team/members/${first}`).send({ role: 'office' }).expect(200);
      const newOwner = await loginAs(t.app, t.seed.a.office);
      const res = await newOwner.patch(`/api/team/members/${second}`).send({ role: 'rep' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: LAST_OWNER });
    });

    test('a disabled owner does not count', async () => {
      const owner = await loginAs(t.app, t.seed.a.owner);
      const first = await membershipId(t.seed.a.companyId, t.seed.a.owner.userId);
      const second = await membershipId(t.seed.a.companyId, t.seed.a.office.userId);
      await owner.patch(`/api/team/members/${second}`).send({ role: 'owner' }).expect(200);
      await owner.patch(`/api/team/members/${second}`).send({ status: 'disabled' }).expect(200);
      const res = await owner.patch(`/api/team/members/${first}`).send({ role: 'office' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: LAST_OWNER });
    });

    test('two owners stepping down at the same time (over HTTP): one succeeds, one is refused', async () => {
      const first = await membershipId(t.seed.a.companyId, t.seed.a.owner.userId);
      const second = await membershipId(t.seed.a.companyId, t.seed.a.office.userId);
      await sql("update memberships set role = 'owner' where id = $1", [second]);
      const o1 = await loginAs(t.app, t.seed.a.owner);
      const o2 = await loginAs(t.app, t.seed.a.office);
      for (let round = 0; round < 3; round++) {
        await sql("update memberships set role = 'owner', status = 'active' where id in ($1, $2)", [first, second]);
        // Each steps down from their own owner role at the same moment.
        const results = await Promise.all([
          o1.patch(`/api/team/members/${first}`).send({ role: 'rep' }),
          o2.patch(`/api/team/members/${second}`).send({ role: 'rep' }),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
        const owners = await sql("select 1 from memberships where company_id = $1 and role = 'owner' and status = 'active'", [t.seed.a.companyId]);
        expect(owners).toHaveLength(1);
      }
    });

    test('the lock holds the second change back until the first has committed (team-store level, deterministic)', async () => {
      const first = await membershipId(t.seed.a.companyId, t.seed.a.owner.userId);
      const second = await membershipId(t.seed.a.companyId, t.seed.a.office.userId);
      await sql("update memberships set role = 'owner' where id = $1", [second]);
      const system = t.deps.pools.system;

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const firstIsWriting = new Promise<void>((resolve) => (entered = resolve));

      // The first change has done its UPDATE but has not committed yet.
      const firstChange = updateMember(system, { companyId: t.seed.a.companyId, membershipId: first, changes: { role: 'rep' } }, async () => {
        entered();
        await gate;
      });
      await firstIsWriting;

      const secondChange = updateMember(system, { companyId: t.seed.a.companyId, membershipId: second, changes: { role: 'rep' } });
      const settled = secondChange.then(
        () => 'finished',
        () => 'finished',
      );
      let state: string;
      try {
        state = await Promise.race([settled, new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 400))]);
      } finally {
        // Whatever the answer, let the first change finish so no transaction is left open.
        release();
      }
      expect(state).toBe('waiting');
      const results = await Promise.allSettled([firstChange, secondChange]);
      expect(results[0]!.status).toBe('fulfilled');
      expect(results[1]!.status).toBe('rejected');
      expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(LastOwnerError);
      const owners = await sql("select id from memberships where company_id = $1 and role = 'owner' and status = 'active'", [t.seed.a.companyId]);
      expect(owners).toEqual([{ id: second }]);
    });
  });

  test("another company's membership id → 404, and nothing changes there", async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const bRep = await membershipId(t.seed.b.companyId, t.seed.b.rep.userId);
    for (const body of [{ role: 'owner' }, { status: 'disabled' }, { canApproveSpend: true }]) {
      const res = await owner.patch(`/api/team/members/${bRep}`).send(body);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: NOT_FOUND });
    }
    const [row] = await sql<{ role: string; status: string; can_approve_spend: boolean }>('select role, status, can_approve_spend from memberships where id = $1', [bRep]);
    expect(row).toEqual({ role: 'rep', status: 'active', can_approve_spend: false });
    expect(await auditRows(t.seed.a.companyId, 'member.update')).toHaveLength(0);
    expect(await auditRows(t.seed.b.companyId, 'member.update')).toHaveLength(0);
  });

  test.each(['not-a-uuid', '00000000-0000-0000-0000-000000000000', '1'])('membership id %j that does not exist → 404', async (id) => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const res = await owner.patch(`/api/team/members/${id}`).send({ role: 'rep' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_FOUND });
  });

  test('bad bodies → 400 on the right field, and nothing is saved', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const id = await membershipId(t.seed.a.companyId, t.seed.a.rep.userId);
    const cases: [Record<string, unknown>, string | undefined][] = [
      [{ role: 'admin' }, 'role'],
      [{ role: 'system' }, 'role'],
      [{ status: 'invited' }, 'status'],
      [{ status: 'gone' }, 'status'],
      [{ canApproveSpend: 'yes' }, 'canApproveSpend'],
      [{ userId: t.seed.b.rep.userId }, 'userId'],
      [{ companyId: t.seed.b.companyId, role: 'rep' }, 'companyId'],
      [{}, undefined],
    ];
    for (const [body, field] of cases) {
      const res = await owner.patch(`/api/team/members/${id}`).send(body);
      expect([body, res.status]).toEqual([body, 400]);
      if (field) expect(res.body.field).toBe(field);
    }
    expect(await auditRows(t.seed.a.companyId, 'member.update')).toHaveLength(0);
  });
});

describe('POST /api/auth/switch-company', () => {
  test('moves the session to another company the user belongs to and answers like /me', async () => {
    await addMembership(t.seed.a.companyId, t.seed.b.rep.userId, 'office');
    const agent = await loginAs(t.app, t.seed.b.rep);
    expect((await agent.get('/api/company')).body.id).toBe(t.seed.b.companyId);
    const res = await agent.post('/api/auth/switch-company').send({ companyId: t.seed.a.companyId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      user: { id: t.seed.b.rep.userId, email: 'rep@b.test' },
      company: { id: t.seed.a.companyId, name: 'Acme Roofing' },
      role: 'office',
    });
    expect(res.body.companies.map((c: { id: string }) => c.id).sort()).toEqual([t.seed.a.companyId, t.seed.b.companyId].sort());
    expect((await agent.get('/api/company')).body.id).toBe(t.seed.a.companyId);
    expect((await agent.get('/api/auth/me')).body.role).toBe('office');
    // And back again.
    await agent.post('/api/auth/switch-company').send({ companyId: t.seed.b.companyId }).expect(200);
    expect((await agent.get('/api/company')).body.id).toBe(t.seed.b.companyId);
  });

  test('switching to a company without membership → 404', async () => {
    const agent = await loginAs(t.app, t.seed.a.owner);
    const res = await agent.post('/api/auth/switch-company').send({ companyId: t.seed.b.companyId });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_FOUND });
    expect((await agent.get('/api/auth/me')).body.company.id).toBe(t.seed.a.companyId);
  });

  test('a disabled or not-yet-active membership is no membership', async () => {
    await addMembership(t.seed.a.companyId, t.seed.b.rep.userId, 'rep', 'disabled');
    const agent = await loginAs(t.app, t.seed.b.rep);
    expect((await agent.post('/api/auth/switch-company').send({ companyId: t.seed.a.companyId })).status).toBe(404);
    await sql("update memberships set status = 'invited' where company_id = $1 and user_id = $2", [t.seed.a.companyId, t.seed.b.rep.userId]);
    expect((await agent.post('/api/auth/switch-company').send({ companyId: t.seed.a.companyId })).status).toBe(404);
  });

  test.each(['not-a-uuid', '00000000-0000-0000-0000-000000000000'])('company id %j → 404', async (companyId) => {
    const agent = await loginAs(t.app, t.seed.a.owner);
    const res = await agent.post('/api/auth/switch-company').send({ companyId });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_FOUND });
  });

  test('no company id → 400', async () => {
    const agent = await loginAs(t.app, t.seed.a.owner);
    const res = await agent.post('/api/auth/switch-company').send({});
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('companyId');
  });

  test('switching to the company you are already in is fine', async () => {
    const agent = await loginAs(t.app, t.seed.a.owner);
    expect((await agent.post('/api/auth/switch-company').send({ companyId: t.seed.a.companyId })).status).toBe(200);
  });
});

describe('every PATCH leaves an audit row', () => {
  test('company, settings and member changes each record who, what, before and after, at the app clock time', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    t.clock.advance(3 * DAY);
    const id = await membershipId(t.seed.a.companyId, t.seed.a.rep.userId);
    await owner.patch('/api/company').send({ legalName: 'Acme Roofing LLC' }).expect(200);
    await owner.patch('/api/company/settings').send({ hailThresholdIn: 1.5 }).expect(200);
    await owner.patch(`/api/team/members/${id}`).send({ role: 'office' }).expect(200);

    const rows = await auditRows(t.seed.a.companyId);
    expect(rows.map((r) => r.action)).toEqual(['company.update', 'settings.update', 'member.update']);
    for (const row of rows) {
      expect(row.actorUserId).toBe(t.seed.a.owner.userId);
      expect(row.before).not.toBeNull();
      expect(row.after).not.toBeNull();
      expect(row.before).not.toEqual(row.after);
      expect(row.at.getTime()).toBe(t.clock.now().getTime());
    }
    expect(rows[0]).toMatchObject({ before: { legalName: null }, after: { legalName: 'Acme Roofing LLC' } });
    expect(rows[1]).toMatchObject({ before: { hailThresholdIn: 1 }, after: { hailThresholdIn: 1.5 } });
  });
});
