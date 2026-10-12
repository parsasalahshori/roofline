import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, inject, test, vi } from 'vitest';
import { companySettings, createPools, type Pools, withTenant } from '@roofline/db';
import { hashPassword as seedHashPassword, resetDb, SEED_PASSWORD } from '@roofline/db/testing';
import { createApp } from '../src/app.ts';
import {
  COST,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  passwordWork,
  SCRYPT_MAX_ACTIVE,
  SCRYPT_MAX_QUEUED,
  verifyPassword,
} from '../src/auth/password.ts';
import * as passwordModule from '../src/auth/password.ts';
import { DEV_SESSION_COOKIE, resolveSession, SESSION_COOKIE } from '../src/auth/sessions.ts';
import { BUSY_MESSAGE } from '../src/auth/work-limit.ts';
import { loginAs, makeTestApp, SIGNUP_COMPANY, type SuperAgent, type TestApp } from './helpers.ts';

// verifyPassword is wrapped (it still runs for real) so a test can see what it was called with.
vi.mock('../src/auth/password.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth/password.ts')>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

const DAY = 24 * 60 * 60 * 1000;
const PASSWORD = 'a long enough password';
const BAD_LOGIN = "That email and password don't match.";
const SIGN_IN = 'Please sign in.';

let t: TestApp;

beforeEach(async () => {
  vi.mocked(passwordModule.verifyPassword).mockClear();
  t = await makeTestApp();
});

/** A read-only look at the database through the system pool's raw client. */
async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await t.deps.pools.system.$client.query(text, params);
  return result.rows as T[];
}

type SignupBody = { email: string; password: string; name: string; companyName: string; companyPhone: string; companyAddress: string };

function signupBody(overrides: Partial<SignupBody> = {}): SignupBody {
  return {
    email: 'owner@example.com',
    password: PASSWORD,
    name: 'Olive Owner',
    companyName: 'Summit Roofing',
    ...SIGNUP_COMPANY,
    ...overrides,
  };
}

function signup(app: TestApp['app'] | SuperAgent, overrides: Partial<SignupBody> = {}) {
  const target = typeof app === 'function' ? request(app) : app;
  return target.post('/api/auth/signup').send(signupBody(overrides));
}

function setCookies(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
}

/**
 * The session Set-Cookie header of a response, split into its value and attributes. Tests talk
 * plain http outside production, so the cookie is `DEV_SESSION_COOKIE` unless `name` says otherwise.
 */
function sessionCookie(res: { headers: Record<string, unknown> }, name: string = DEV_SESSION_COOKIE) {
  const line = setCookies(res).find((c) => c.startsWith(`${name}=`));
  if (!line) return null;
  const [pair, ...attrs] = line.split('; ');
  return { value: pair!.slice(name.length + 1), attrs, line };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('password hashing', () => {
  test('hashPassword writes scrypt$16384$8$1$<16-byte salt>$<64-byte hash>', async () => {
    const stored = await hashPassword(PASSWORD);
    const parts = stored.split('$');
    expect(parts.slice(0, 4)).toEqual(['scrypt', '16384', '8', '1']);
    expect(Buffer.from(parts[4]!, 'base64')).toHaveLength(16);
    expect(Buffer.from(parts[5]!, 'base64')).toHaveLength(64);
    expect(stored).not.toContain(PASSWORD);
  });

  test('two hashes of the same password differ (random salt)', async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  test('verifyPassword accepts the right password and refuses a wrong one', async () => {
    const stored = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword(`${PASSWORD}!`, stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  test('verifyPassword accepts a hash written by the seed helper (the two formats agree)', async () => {
    const seeded = await seedHashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, seeded)).toBe(true);
    expect(await verifyPassword('wrong password here', seeded)).toBe(false);
    // And the other way round: the app's hash has the seed helper's exact shape.
    expect((await hashPassword(PASSWORD)).split('$').slice(0, 4)).toEqual(seeded.split('$').slice(0, 4));
  });

  test.each([
    ['empty', ''],
    ['not scrypt', 'bcrypt$16384$8$1$AAAA$BBBB'],
    ['too few parts', 'scrypt$16384$8$1$AAAA'],
    ['non-numeric cost', 'scrypt$lots$8$1$AAAA$BBBB'],
    ['cost far beyond what we ever write', `scrypt$${2 ** 30}$8$1$AAAA$BBBB`],
    ['empty salt', 'scrypt$16384$8$1$$BBBB'],
    ['empty hash', 'scrypt$16384$8$1$AAAA$'],
  ])('verifyPassword returns false (never throws) for a malformed stored hash: %s', async (_name, stored) => {
    expect(await verifyPassword(PASSWORD, stored)).toBe(false);
  });

  test('DUMMY_PASSWORD_HASH is a real hash, so checking against it costs a real scrypt', () => {
    const parts = DUMMY_PASSWORD_HASH.split('$');
    expect(parts.slice(0, 4)).toEqual(['scrypt', '16384', '8', '1']);
    expect(Buffer.from(parts[4]!, 'base64')).toHaveLength(16);
    expect(Buffer.from(parts[5]!, 'base64')).toHaveLength(64);
  });

  test('DUMMY_PASSWORD_HASH has the same cost parameters as every real hash (it follows COST, not a copy of it)', async () => {
    const dummy = DUMMY_PASSWORD_HASH.split('$');
    const real = (await hashPassword(PASSWORD)).split('$');
    expect(dummy.slice(0, 4)).toEqual(['scrypt', String(COST.N), String(COST.r), String(COST.p)]);
    expect(dummy.slice(0, 4)).toEqual(real.slice(0, 4));
    expect(Buffer.from(dummy[4]!, 'base64')).toHaveLength(Buffer.from(real[4]!, 'base64').length);
    expect(Buffer.from(dummy[5]!, 'base64')).toHaveLength(Buffer.from(real[5]!, 'base64').length);
    // And it is a hash the verifier accepts as well-formed: a wrong password is a clean "no".
    expect(await verifyPassword(PASSWORD, DUMMY_PASSWORD_HASH)).toBe(false);
  });
});

describe('sign-up', () => {
  test('creates the user, a trial company, an owner membership and default settings, and signs in', async () => {
    const res = await signup(t.app);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      user: { id: expect.any(String), email: 'owner@example.com', name: 'Olive Owner', emailVerified: false },
      company: { id: expect.any(String), name: 'Summit Roofing', slug: 'summit-roofing', status: 'trial' },
    });

    const [company] = await sql<{ status: string; trial_ends_at: Date; timezone: string }>(
      'select status, trial_ends_at, timezone from companies where id = $1',
      [res.body.company.id],
    );
    expect(company!.status).toBe('trial');
    // trial_ends_at = now + 14 days, on the app's clock (TestClock does not move on its own).
    expect(company!.trial_ends_at.getTime()).toBe(t.clock.now().getTime() + 14 * DAY);
    // Sign-up does not ask for a time zone in F1; the column default stays until F3 sets it.
    expect(company!.timezone).toBe('America/Chicago');

    const members = await sql<{ role: string; status: string; user_id: string }>(
      'select role, status, user_id from memberships where company_id = $1',
      [res.body.company.id],
    );
    expect(members).toEqual([{ role: 'owner', status: 'active', user_id: res.body.user.id }]);

    const settings = await withTenant(
      t.deps.pools,
      { companyId: res.body.company.id, userId: null, role: 'system', canApproveSpend: false },
      (tx) => tx.select().from(companySettings),
    );
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({ hourlyRateCents: 2800, marketingCapPer7d: 2, hailThresholdIn: 1 });

    const [user] = await sql<{ password_hash: string; email_verified_at: Date | null }>(
      'select password_hash, email_verified_at from users where id = $1',
      [res.body.user.id],
    );
    expect(user!.email_verified_at).toBeNull();
    expect(user!.password_hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(await verifyPassword(PASSWORD, user!.password_hash)).toBe(true);
  });

  test('sets the session cookie (rl_session over plain http outside production), and the database holds only its sha256', async () => {
    const res = await signup(t.app);
    const cookie = sessionCookie(res);
    expect(cookie).not.toBeNull();
    // 32 random bytes as base64url is 43 characters.
    expect(cookie!.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie!.attrs).toEqual(
      expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${(30 * DAY) / 1000}`]),
    );
    expect(cookie!.attrs).not.toContain('Secure');

    const rows = await sql<{ token_hash: string; user_id: string; active_company_id: string }>(
      'select token_hash, user_id, active_company_id from sessions',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(sha256(cookie!.value));
    expect(rows[0]!.token_hash).not.toBe(cookie!.value);
    expect(rows[0]).toMatchObject({ user_id: res.body.user.id, active_company_id: res.body.company.id });
  });

  test('in production the cookie is __Host-rl_session: Secure, Path=/, no Domain', async () => {
    const prod = await makeTestApp({ NODE_ENV: 'production' });
    const res = await request(prod.app).post('/api/auth/signup').send(signupBody());
    expect(res.status).toBe(201);
    expect(SESSION_COOKIE).toBe('__Host-rl_session');
    expect(sessionCookie(res)).toBeNull();
    const cookie = sessionCookie(res, SESSION_COOKIE)!;
    expect(cookie.attrs).toEqual(expect.arrayContaining(['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']));
    expect(cookie.line).not.toMatch(/domain=/i);

    // It is the cookie production reads; the plain name is ignored there.
    const me = await request(prod.app).get('/api/auth/me').set('Cookie', `${SESSION_COOKIE}=${cookie.value}`);
    expect(me.status).toBe(200);
    const plain = await request(prod.app).get('/api/auth/me').set('Cookie', `${DEV_SESSION_COOKIE}=${cookie.value}`);
    expect(plain.status).toBe(401);
  });

  test('outside production, a request over https (behind a trusted proxy) also gets the Secure __Host- cookie', async () => {
    const proxied = await makeTestApp({ TRUST_PROXY: 1 });
    const res = await request(proxied.app)
      .post('/api/auth/signup')
      .set('X-Forwarded-Proto', 'https')
      .send(signupBody());
    expect(res.status).toBe(201);
    expect(sessionCookie(res)).toBeNull();
    const cookie = sessionCookie(res, SESSION_COOKIE)!;
    expect(cookie.attrs).toEqual(expect.arrayContaining(['Secure', 'HttpOnly', 'Path=/']));
    const me = await request(proxied.app)
      .get('/api/auth/me')
      .set('X-Forwarded-Proto', 'https')
      .set('Cookie', `${SESSION_COOKIE}=${cookie.value}`);
    expect(me.status).toBe(200);
  });

  test('the new user is signed in: GET /api/auth/me works with the cookie', async () => {
    const agent = request.agent(t.app);
    const res = await signup(agent);
    expect(res.status).toBe(201);
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body).toEqual({
      user: { id: res.body.user.id, email: 'owner@example.com', name: 'Olive Owner', emailVerified: false },
      company: { id: res.body.company.id, name: 'Summit Roofing', slug: 'summit-roofing', status: 'trial' },
      role: 'owner',
      companies: [{ id: res.body.company.id, name: 'Summit Roofing' }],
    });
  });

  test('the slug comes from the name; a second company with the same name gets -2, then -3', async () => {
    await resetDb(inject('dbUrls').owner); // no seeded "Acme Roofing", so the first one gets the plain slug
    const first = await signup(t.app, { email: 'one@example.com', companyName: 'Acme Roofing' });
    const second = await signup(t.app, { email: 'two@example.com', companyName: 'Acme Roofing' });
    const third = await signup(t.app, { email: 'three@example.com', companyName: '  ACME   roofing!! ' });
    expect(first.body.company.slug).toBe('acme-roofing');
    expect(second.body.company.slug).toBe('acme-roofing-2');
    expect(third.body.company.slug).toBe('acme-roofing-3');
    expect(second.body.company.name).toBe('Acme Roofing');
  });

  test('a slug already used by a seeded company is skipped', async () => {
    const res = await signup(t.app, { companyName: 'Bolt Roofing' });
    expect(res.body.company.slug).toBe('bolt-roofing-2');
  });

  test.each([
    ['accents and punctuation', "Café Düsseldorf Roofing & Sons, Inc.", 'cafe-dusseldorf-roofing-sons-inc'],
    ['nothing usable', '!!! ???', 'company'],
    ['a reserved subdomain name', 'API', 'api-2'],
  ])('slug rules: %s', async (_name, companyName, slug) => {
    const res = await signup(t.app, { companyName });
    expect(res.status).toBe(201);
    expect(res.body.company.slug).toBe(slug);
  });

  test('several sign-ups for the same company name at once all get distinct slugs', async () => {
    await resetDb(inject('dbUrls').owner);
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => signup(t.app, { email: `p${n}@example.com`, companyName: 'Acme Roofing' })),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(results.map((r) => r.body.company.slug).sort()).toEqual([
      'acme-roofing',
      'acme-roofing-2',
      'acme-roofing-3',
      'acme-roofing-4',
    ]);
  });

  test('email is stored lowercased and trimmed', async () => {
    const res = await signup(t.app, { email: '  New.Owner@Example.COM ' });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('new.owner@example.com');
    const [row] = await sql<{ email: string }>('select email::text as email from users where id = $1', [
      res.body.user.id,
    ]);
    expect(row!.email).toBe('new.owner@example.com');
  });

  test('Review Focus #3: " Owner@Example.COM " logs in to owner@example.com, and a second sign-up with it is refused', async () => {
    expect((await signup(t.app)).status).toBe(201);
    const login = await request(t.app)
      .post('/api/auth/login')
      .send({ email: ' Owner@Example.COM ', password: PASSWORD });
    expect(login.status).toBe(200);

    const before = await sql<{ n: string }>('select (select count(*) from companies) as n');
    const again = await signup(t.app, { email: ' Owner@Example.COM ', companyName: 'Another Roofing' });
    expect(again.status).toBe(409);
    // Ruling SEC-1: the answer does not say outright that the email has an account.
    expect(again.body).toEqual({
      error: "We couldn't create an account with that email. If you already use Roofline, sign in or reset your password.",
      field: 'email',
    });
    expect(again.body.error).not.toMatch(/already (exists|has)/i);
    expect(sessionCookie(again)).toBeNull();
    // The refused sign-up left nothing behind: no extra company, no extra membership.
    expect(await sql<{ n: string }>('select (select count(*) from companies) as n')).toEqual(before);
    expect(await sql('select 1 from companies where name = $1', ['Another Roofing'])).toEqual([]);
  });

  test.each([
    ['a short password', { password: 'short' }, 'password', 'Use at least 10 characters for your password.'],
    ['a missing password', { password: undefined }, 'password', 'Use at least 10 characters for your password.'],
    ['a bad email', { email: 'not-an-email' }, 'email', 'Please enter a valid email address.'],
    ['a missing email', { email: undefined }, 'email', 'Please enter a valid email address.'],
    ['a blank name', { name: '   ' }, 'name', 'Please enter a name.'],
    ['a missing name', { name: undefined }, 'name', 'Please enter a name.'],
    ['a blank company name', { companyName: ' ' }, 'companyName', 'Please enter your company name.'],
    ['a missing company name', { companyName: undefined }, 'companyName', 'Please enter your company name.'],
    ['a bad business phone', { companyPhone: '12' }, 'companyPhone', "That doesn't look like a US phone number."],
    ['a missing business phone', { companyPhone: undefined }, 'companyPhone', "That doesn't look like a US phone number."],
    ['a blank business address', { companyAddress: '   ' }, 'companyAddress', "Please enter your business address."],
    ['a missing business address', { companyAddress: undefined }, 'companyAddress', "Please enter your business address."],
  ])('%s → 400 with the field and a plain sentence', async (_name, overrides, field, error) => {
    const res = await request(t.app)
      .post('/api/auth/signup')
      .send({ ...signupBody(), ...overrides });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error, field });
    expect(await sql('select 1 from users where name = $1', ['Olive Owner'])).toEqual([]);
  });

  test('"short" is refused, and a 10-character password is accepted', async () => {
    expect((await signup(t.app, { password: '123456789' })).status).toBe(400);
    expect((await signup(t.app, { password: '1234567890' })).status).toBe(201);
  });

  test('if saving the company settings fails, nothing is left behind and the caller gets a 500', async () => {
    const logError = vi.fn();
    const brokenTenant = { transaction: () => Promise.reject(new Error('tenant pool down')) };
    const pools = { ...t.deps.pools, tenant: brokenTenant } as unknown as Pools;
    const app = createApp({ ...t.deps, pools }, { logError });

    const before = await sql(
      `select (select count(*) from users) as users, (select count(*) from companies) as companies,
              (select count(*) from memberships) as memberships, (select count(*) from sessions) as sessions`,
    );
    const res = await request(app).post('/api/auth/signup').send(signupBody());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Something went wrong on our side. Please try again.' });
    expect(sessionCookie(res)).toBeNull();
    expect(logError).toHaveBeenCalledTimes(1);

    const after = await sql(
      `select (select count(*) from users) as users, (select count(*) from companies) as companies,
              (select count(*) from memberships) as memberships, (select count(*) from sessions) as sessions`,
    );
    expect(after).toEqual(before);
    // The same sign-up works once the problem is gone: the email was not left claimed.
    expect((await signup(t.app)).status).toBe(201);
  });
});

describe('login', () => {
  beforeEach(async () => {
    expect((await signup(t.app)).status).toBe(201);
    vi.mocked(passwordModule.verifyPassword).mockClear();
  });

  test('right password → 200, the cookie, and who you are', async () => {
    const res = await request(t.app).post('/api/auth/login').send({ email: 'owner@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: { id: expect.any(String), email: 'owner@example.com', name: 'Olive Owner', emailVerified: false },
      company: { id: expect.any(String), name: 'Summit Roofing', slug: 'summit-roofing', status: 'trial' },
    });
    expect(sessionCookie(res)!.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('each login is its own session', async () => {
    const body = { email: 'owner@example.com', password: PASSWORD };
    const a = await request(t.app).post('/api/auth/login').send(body);
    const b = await request(t.app).post('/api/auth/login').send(body);
    expect(sessionCookie(a)!.value).not.toBe(sessionCookie(b)!.value);
    expect(await sql('select 1 from sessions')).toHaveLength(3); // sign-up's session plus these two
  });

  test('wrong password → 401 with the exact sentence, and no cookie', async () => {
    const res = await request(t.app).post('/api/auth/login').send({ email: 'owner@example.com', password: 'nope nope nope' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: BAD_LOGIN });
    expect(sessionCookie(res)).toBeNull();
  });

  test('an unknown email gets the very same 401, and still pays for a password check', async () => {
    const unknown = await request(t.app).post('/api/auth/login').send({ email: 'nobody@example.com', password: PASSWORD });
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual({ error: BAD_LOGIN });
    const verify = vi.mocked(passwordModule.verifyPassword);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(PASSWORD, DUMMY_PASSWORD_HASH);

    verify.mockClear();
    const wrong = await request(t.app).post('/api/auth/login').send({ email: 'owner@example.com', password: 'wrong password' });
    expect(wrong.body).toEqual(unknown.body);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]![1]).not.toBe(DUMMY_PASSWORD_HASH);
  });

  test('a user with no password (Google-only) gets the same 401 and the same dummy check', async () => {
    await sql("update users set password_hash = null where email = 'owner@example.com'");
    vi.mocked(passwordModule.verifyPassword).mockClear();
    const res = await request(t.app).post('/api/auth/login').send({ email: 'owner@example.com', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: BAD_LOGIN });
    expect(vi.mocked(passwordModule.verifyPassword)).toHaveBeenCalledWith(PASSWORD, DUMMY_PASSWORD_HASH);
  });

  test.each([
    ['no email', { password: PASSWORD }, 'email'],
    ['no password', { email: 'owner@example.com' }, 'password'],
    ['an email that is not text', { email: 42, password: PASSWORD }, 'email'],
  ])('%s → 400 with the field', async (_name, body, field) => {
    const res = await request(t.app).post('/api/auth/login').send(body);
    expect(res.status).toBe(400);
    expect(res.body.field).toBe(field);
  });

  test('M9: a seeded user logs in through the real login route (the seed and app hash formats agree)', async () => {
    const agent = await loginAs(t.app, t.seed.a.owner);
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(t.seed.a.owner.email);
    expect(me.body.user.emailVerified).toBe(true);
    expect(me.body.company).toMatchObject({ id: t.seed.a.companyId, slug: 'acme-roofing' });
    expect(me.body.role).toBe('owner');
    // And every other seeded role, in the other company.
    for (const user of [t.seed.b.office, t.seed.b.rep]) {
      const other = await loginAs(t.app, user);
      expect((await other.get('/api/auth/me')).body.company.id).toBe(t.seed.b.companyId);
    }
  });

  test('a user whose only membership is disabled cannot sign in', async () => {
    await sql("update memberships set status = 'disabled' where user_id = $1", [t.seed.a.rep.userId]);
    const res = await request(t.app)
      .post('/api/auth/login')
      .send({ email: t.seed.a.rep.email, password: t.seed.a.rep.password });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/turned off/);
    expect(sessionCookie(res)).toBeNull();
  });
});

describe('login rate limit', () => {
  const TOO_MANY = { error: 'Too many sign-in attempts. Try again in a few minutes.' };

  async function wrongPassword(email: string) {
    return request(t.app).post('/api/auth/login').send({ email, password: 'definitely wrong' });
  }

  test('the 11th failed attempt in 15 minutes for the same email → 429', async () => {
    for (let i = 1; i <= 10; i++) {
      const res = await wrongPassword(t.seed.a.owner.email);
      expect(res.status, `attempt ${i}`).toBe(401);
    }
    const blocked = await wrongPassword(t.seed.a.owner.email);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual(TOO_MANY);
  });

  test('once blocked, even the right password is refused (no free guesses after the limit)', async () => {
    for (let i = 0; i < 10; i++) await wrongPassword(t.seed.a.owner.email);
    const res = await request(t.app)
      .post('/api/auth/login')
      .send({ email: t.seed.a.owner.email, password: SEED_PASSWORD });
    expect(res.status).toBe(429);
    expect(res.body).toEqual(TOO_MANY);
  });

  test('the key is the lowercased, trimmed email, so spelling variants share one budget', async () => {
    for (let i = 0; i < 5; i++) await wrongPassword('Owner@A.test');
    for (let i = 0; i < 5; i++) await wrongPassword(' owner@a.TEST ');
    expect((await wrongPassword('owner@a.test')).status).toBe(429);
  });

  test('a different email from the same address has its own budget', async () => {
    for (let i = 0; i < 10; i++) await wrongPassword(t.seed.a.owner.email);
    expect((await wrongPassword(t.seed.a.owner.email)).status).toBe(429);
    const other = await request(t.app)
      .post('/api/auth/login')
      .send({ email: t.seed.a.office.email, password: SEED_PASSWORD });
    expect(other.status).toBe(200);
  });

  test('successful sign-ins do not use up the budget', async () => {
    for (let i = 0; i < 12; i++) {
      const res = await request(t.app)
        .post('/api/auth/login')
        .send({ email: t.seed.a.owner.email, password: SEED_PASSWORD });
      expect(res.status, `login ${i + 1}`).toBe(200);
    }
  });

  test('the limit does not touch other routes', async () => {
    for (let i = 0; i < 11; i++) await wrongPassword(t.seed.a.owner.email);
    expect((await request(t.app).get('/health')).status).toBe(200);
  });

  describe('across addresses', () => {
    let proxied: TestApp;
    beforeEach(async () => {
      proxied = await makeTestApp({ TRUST_PROXY: 1 });
    });
    const from = (ip: string, email: string, password: string) =>
      request(proxied.app).post('/api/auth/login').set('X-Forwarded-For', ip).send({ email, password });

    test('one email: 20 failures an hour from any number of addresses, then even the right password is refused', async () => {
      for (let i = 1; i <= 20; i++) {
        expect((await from(`198.51.100.${i}`, proxied.seed.a.owner.email, 'wrong guess')).status, `attempt ${i}`).toBe(401);
      }
      const blocked = await from('198.51.100.200', proxied.seed.a.owner.email, SEED_PASSWORD);
      expect(blocked.status).toBe(429);
      expect(blocked.body).toEqual(TOO_MANY);
      // Another account is untouched.
      expect((await from('198.51.100.201', proxied.seed.a.office.email, SEED_PASSWORD)).status).toBe(200);
    });

    test('an email with no account gets the very same lock and answer', async () => {
      for (let i = 1; i <= 20; i++) await from(`198.51.100.${i}`, 'nobody@example.com', 'wrong guess');
      const blocked = await from('198.51.100.200', 'nobody@example.com', 'wrong guess');
      expect(blocked.status).toBe(429);
      expect(blocked.body).toEqual(TOO_MANY);
    });

    test('one address: 30 failures across any emails in 15 minutes, then every login from it is refused', async () => {
      for (let i = 1; i <= 30; i++) {
        expect((await from('203.0.113.50', `person${i}@example.com`, 'wrong guess')).status, `attempt ${i}`).toBe(401);
      }
      const blocked = await from('203.0.113.50', proxied.seed.a.owner.email, SEED_PASSWORD);
      expect(blocked.status).toBe(429);
      expect(blocked.body).toEqual(TOO_MANY);
      expect((await from('203.0.113.51', proxied.seed.a.owner.email, SEED_PASSWORD)).status).toBe(200);
    });
  });

  test('when password checking is saturated, login answers 503 with Retry-After and the attempt is not a failure', async () => {
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const holders = Array.from({ length: SCRYPT_MAX_ACTIVE + SCRYPT_MAX_QUEUED }, () => passwordWork.run(() => held));
    try {
      const res = await request(t.app).post('/api/auth/login').send({ email: t.seed.a.owner.email, password: SEED_PASSWORD });
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: BUSY_MESSAGE });
      expect(res.headers['retry-after']).toBe('5');
    } finally {
      open();
      await Promise.all(holders);
    }
    expect((await request(t.app).post('/api/auth/login').send({ email: t.seed.a.owner.email, password: SEED_PASSWORD })).status).toBe(200);
  });
});

describe('API rate limit', () => {
  const TOO_FAST = { error: "You're going a little fast. Try again in a minute." };

  test('with API_RATE_LIMIT_PER_MIN=5, the 6th request in a minute on one session → 429; /health is never limited', async () => {
    const limited = await makeTestApp({ API_RATE_LIMIT_PER_MIN: 5 });
    const agent = await loginAs(limited.app, limited.seed.a.owner);
    for (let i = 1; i <= 5; i++) {
      expect((await agent.get('/api/auth/me')).status, `request ${i}`).toBe(200);
    }
    const res = await agent.get('/api/auth/me');
    expect(res.status).toBe(429);
    expect(res.body).toEqual(TOO_FAST);
    for (let i = 0; i < 20; i++) {
      expect((await request(limited.app).get('/health')).status).toBe(200);
    }
  });

  test('each session has its own budget', async () => {
    const limited = await makeTestApp({ API_RATE_LIMIT_PER_MIN: 5 });
    const first = await loginAs(limited.app, limited.seed.a.owner);
    const second = await loginAs(limited.app, limited.seed.a.owner);
    for (let i = 0; i < 5; i++) await first.get('/api/auth/me');
    expect((await first.get('/api/auth/me')).status).toBe(429);
    expect((await second.get('/api/auth/me')).status).toBe(200);
  });

  test('requests with no session share one budget per IP, and new cookie values do not reset it', async () => {
    const limited = await makeTestApp({ API_RATE_LIMIT_PER_MIN: 5 });
    for (let i = 1; i <= 5; i++) {
      const res = await request(limited.app).get('/api/auth/me').set('Cookie', `${DEV_SESSION_COOKIE}=${'x'.repeat(42)}${i}`);
      expect(res.status, `request ${i}`).toBe(401);
    }
    const res = await request(limited.app).get('/api/auth/me').set('Cookie', `${DEV_SESSION_COOKIE}=${'y'.repeat(43)}`);
    expect(res.status).toBe(429);
    expect(res.body).toEqual(TOO_FAST);
  });

  test('/hooks/* is never limited', async () => {
    const limited = await makeTestApp({ API_RATE_LIMIT_PER_MIN: 2 });
    const app = createApp(limited.deps, {
      extraRoutes: (a) => {
        a.post('/hooks/ping', (_req, res) => {
          res.json({ ok: true });
        });
      },
    });
    for (let i = 0; i < 10; i++) {
      expect((await request(app).post('/hooks/ping').send({})).status).toBe(200);
    }
  });
});

describe('requireSession', () => {
  test('no cookie → 401 "Please sign in." on any /api route, known or not', async () => {
    for (const path of ['/api/auth/me', '/api/auth/sessions', '/api/customers', '/api/nope']) {
      const res = await request(t.app).get(path);
      expect(res.status, path).toBe(401);
      expect(res.body, path).toEqual({ error: SIGN_IN });
    }
    expect((await request(t.app).post('/api/auth/logout')).status).toBe(401);
    expect((await request(t.app).delete('/api/auth/sessions/4a2f4f5e-1111-4222-8333-444455556666')).status).toBe(401);
  });

  test('the public auth routes are reachable without a session', async () => {
    // These get past the gate; each answers for itself (google and accept-invite do not exist yet: 404).
    expect((await request(t.app).post('/api/auth/signup').send({})).status).toBe(400);
    expect((await request(t.app).post('/api/auth/login').send({})).status).toBe(400);
    for (const route of ['verify-email', 'reset-request', 'reset', 'google', 'accept-invite']) {
      const res = await request(t.app).post(`/api/auth/${route}`).send({});
      expect(res.status, route).not.toBe(401);
    }
  });

  test('a garbage cookie, a made-up token and a token for a deleted session are all 401', async () => {
    const bogus = ['garbage', 'x'.repeat(43), '%00', '', 'a'.repeat(5000)];
    for (const value of bogus) {
      const res = await request(t.app).get('/api/auth/me').set('Cookie', `${DEV_SESSION_COOKIE}=${value}`);
      expect(res.status, value.slice(0, 10)).toBe(401);
    }
    const agent = await loginAs(t.app, t.seed.a.owner);
    await agent.post('/api/auth/logout');
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  test('the cookie is found among other cookies', async () => {
    const login = await request(t.app)
      .post('/api/auth/login')
      .send({ email: t.seed.a.owner.email, password: SEED_PASSWORD });
    const token = sessionCookie(login)!.value;
    const res = await request(t.app).get('/api/auth/me').set('Cookie', `theme=dark; ${DEV_SESSION_COOKIE}=${token}; other=1`);
    expect(res.status).toBe(200);
  });

  test('Origin and sign-in are separate checks: a foreign origin is still 403 first', async () => {
    const res = await request(t.app).post('/api/auth/login').set('Origin', 'https://evil.example').send({});
    expect(res.status).toBe(403);
  });
});

describe('sessions', () => {
  async function sessionRow(userId: string) {
    const rows = await sql<{ expires_at: Date; last_seen_at: Date; token_hash: string }>(
      'select expires_at, last_seen_at, token_hash from sessions where user_id = $1 order by created_at desc limit 1',
      [userId],
    );
    return rows[0]!;
  }

  test('sliding expiry: a request every day for 29 days keeps you in; 31 quiet days sign you out', async () => {
    const agent = await loginAs(t.app, t.seed.a.owner);
    for (let day = 1; day <= 29; day++) {
      t.clock.advance(DAY);
      const res = await agent.get('/api/auth/me');
      expect(res.status, `day ${day}`).toBe(200);
    }
    t.clock.advance(31 * DAY);
    const res = await agent.get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: SIGN_IN });
  });

  test('without any requests the session still ends 30 days after the last one', async () => {
    const agent = await loginAs(t.app, t.seed.a.owner);
    t.clock.advance(29 * DAY);
    expect((await agent.get('/api/auth/me')).status).toBe(200); // renews to day 59
    t.clock.advance(29 * DAY);
    expect((await agent.get('/api/auth/me')).status).toBe(200); // renews to day 88
    t.clock.advance(30 * DAY + 1);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  test('a session that is never used again lasts exactly 30 days from login', async () => {
    const agent = await loginAs(t.app, t.seed.a.owner);
    t.clock.advance(30 * DAY - 1000);
    // Not renewed yet by anything, so this is the last second it is good for.
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    const quiet = await loginAs(t.app, t.seed.a.office);
    t.clock.advance(30 * DAY);
    expect((await quiet.get('/api/auth/me')).status).toBe(401);
  });

  test('the expiry only moves when last_seen_at is more than an hour old, and the cookie is refreshed with it', async () => {
    const login = await request(t.app)
      .post('/api/auth/login')
      .send({ email: t.seed.a.owner.email, password: SEED_PASSWORD });
    const token = sessionCookie(login)!.value;
    const cookie = `${DEV_SESSION_COOKIE}=${token}`;
    const start = t.clock.now().getTime();
    const before = await sessionRow(t.seed.a.owner.userId);
    expect(before.expires_at.getTime()).toBe(start + 30 * DAY);

    t.clock.advance(59 * 60 * 1000);
    const soon = await request(t.app).get('/api/auth/me').set('Cookie', cookie);
    expect(soon.status).toBe(200);
    expect(sessionCookie(soon)).toBeNull();
    expect((await sessionRow(t.seed.a.owner.userId)).expires_at.getTime()).toBe(start + 30 * DAY);

    t.clock.advance(2 * 60 * 1000); // 61 minutes after the last time it was seen
    const later = await request(t.app).get('/api/auth/me').set('Cookie', cookie);
    expect(later.status).toBe(200);
    const refreshed = sessionCookie(later);
    expect(refreshed).not.toBeNull();
    expect(refreshed!.value).toBe(token);
    expect(refreshed!.attrs).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000']));
    const after = await sessionRow(t.seed.a.owner.userId);
    expect(after.last_seen_at.getTime()).toBe(start + 61 * 60 * 1000);
    expect(after.expires_at.getTime()).toBe(start + 61 * 60 * 1000 + 30 * DAY);
  });

  test('disabling the membership signs the user out on their next request', async () => {
    const agent = await loginAs(t.app, t.seed.a.rep);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    await sql("update memberships set status = 'disabled' where user_id = $1", [t.seed.a.rep.userId]);
    const res = await agent.get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: SIGN_IN });
  });

  test('a disabled member is refused by the gate itself, on routes that never look at the membership', async () => {
    const agent = await loginAs(t.app, t.seed.a.rep);
    await sql("update memberships set status = 'disabled' where user_id = $1", [t.seed.a.rep.userId]);
    for (const res of [await agent.get('/api/auth/sessions'), await agent.post('/api/auth/logout')]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: SIGN_IN });
    }
    // Nothing happened on their behalf: the session row was not touched by the refused logout.
    expect(await sql('select 1 from sessions where user_id = $1', [t.seed.a.rep.userId])).toHaveLength(1);
  });

  test('re-enabling the membership brings the same session back', async () => {
    const agent = await loginAs(t.app, t.seed.a.rep);
    await sql("update memberships set status = 'disabled' where user_id = $1", [t.seed.a.rep.userId]);
    expect((await agent.get('/api/auth/sessions')).status).toBe(401);
    await sql("update memberships set status = 'active' where user_id = $1", [t.seed.a.rep.userId]);
    expect((await agent.get('/api/auth/sessions')).status).toBe(200);
  });

  test('an invited (not yet active) membership is not a sign-in either', async () => {
    const agent = await loginAs(t.app, t.seed.a.rep);
    await sql("update memberships set status = 'invited' where user_id = $1", [t.seed.a.rep.userId]);
    expect((await agent.get('/api/auth/sessions')).status).toBe(401);
  });

  test('logout deletes the session and clears the cookie', async () => {
    const agent = await loginAs(t.app, t.seed.a.owner);
    const before = await sql('select 1 from sessions where user_id = $1', [t.seed.a.owner.userId]);
    expect(before).toHaveLength(1);
    const res = await agent.post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const cleared = sessionCookie(res);
    expect(cleared).not.toBeNull();
    expect(cleared!.value).toBe('');
    expect(cleared!.line).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(await sql('select 1 from sessions where user_id = $1', [t.seed.a.owner.userId])).toEqual([]);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  test('logging out one device leaves the others signed in', async () => {
    const laptop = await loginAs(t.app, t.seed.a.owner);
    const phone = await loginAs(t.app, t.seed.a.owner);
    await laptop.post('/api/auth/logout');
    expect((await phone.get('/api/auth/me')).status).toBe(200);
  });

  test('GET /api/auth/sessions lists this user’s sessions and marks the current one', async () => {
    const laptop = await loginAs(t.app, t.seed.a.owner);
    const phone = request.agent(t.app);
    await phone
      .post('/api/auth/login')
      .set('User-Agent', 'RooflinePhone/1.0')
      .send({ email: t.seed.a.owner.email, password: SEED_PASSWORD });
    await loginAs(t.app, t.seed.a.office); // someone else's session must not show up

    const res = await laptop.get('/api/auth/sessions');
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    for (const s of res.body.sessions) {
      expect(Object.keys(s).sort()).toEqual(['createdAt', 'current', 'expiresAt', 'id', 'ip', 'lastSeenAt', 'userAgent']);
      expect(s).not.toHaveProperty('tokenHash');
    }
    expect(res.body.sessions.map((s: { userAgent: string }) => s.userAgent)).toContain('RooflinePhone/1.0');

    const fromPhone = await phone.get('/api/auth/sessions');
    const currentOnPhone = fromPhone.body.sessions.find((s: { current: boolean }) => s.current);
    expect(currentOnPhone.userAgent).toBe('RooflinePhone/1.0');
  });

  test('expired sessions are not listed', async () => {
    await loginAs(t.app, t.seed.a.owner);
    t.clock.advance(40 * DAY);
    const fresh = await loginAs(t.app, t.seed.a.owner);
    const res = await fresh.get('/api/auth/sessions');
    expect(res.body.sessions).toHaveLength(1);
  });

  test('DELETE /api/auth/sessions/:id signs out that device; its next request is 401', async () => {
    const laptop = await loginAs(t.app, t.seed.a.owner);
    const phone = await loginAs(t.app, t.seed.a.owner);
    const list = await laptop.get('/api/auth/sessions');
    const other = list.body.sessions.find((s: { current: boolean }) => !s.current);

    const res = await laptop.delete(`/api/auth/sessions/${other.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect((await phone.get('/api/auth/me')).status).toBe(401);
    expect((await laptop.get('/api/auth/me')).status).toBe(200);
    expect((await laptop.get('/api/auth/sessions')).body.sessions).toHaveLength(1);
  });

  test('deleting your own current session signs you out and clears the cookie', async () => {
    const laptop = await loginAs(t.app, t.seed.a.owner);
    const current = (await laptop.get('/api/auth/sessions')).body.sessions[0];
    const res = await laptop.delete(`/api/auth/sessions/${current.id}`);
    expect(res.status).toBe(200);
    expect(sessionCookie(res)?.value).toBe('');
    expect((await laptop.get('/api/auth/me')).status).toBe(401);
  });

  test('another user’s session, an unknown id and a malformed id are all 404', async () => {
    const mine = await loginAs(t.app, t.seed.a.owner);
    const theirs = await loginAs(t.app, t.seed.b.owner);
    const theirId = (await theirs.get('/api/auth/sessions')).body.sessions[0].id as string;

    for (const id of [theirId, '4a2f4f5e-1111-4222-8333-444455556666', 'not-a-uuid', '1; drop table sessions']) {
      const res = await mine.delete(`/api/auth/sessions/${encodeURIComponent(id)}`);
      expect(res.status, id).toBe(404);
      expect(res.body, id).toEqual({ error: "We couldn't find that." });
    }
    // Their session survived.
    expect((await theirs.get('/api/auth/me')).status).toBe(200);
  });
});

describe('GET /api/auth/me', () => {
  test('lists every active company the user belongs to; the active one is first-created', async () => {
    await sql(
      "insert into memberships (company_id, user_id, role, status) values ($1, $2, 'office', 'active')",
      [t.seed.b.companyId, t.seed.a.owner.userId],
    );
    const agent = await loginAs(t.app, t.seed.a.owner);
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.company.id).toBe(t.seed.a.companyId);
    expect(me.body.role).toBe('owner');
    expect(me.body.companies).toEqual([
      { id: t.seed.a.companyId, name: 'Acme Roofing' },
      { id: t.seed.b.companyId, name: 'Bolt Roofing' },
    ]);
  });

  test('companies leaves out memberships that are not active', async () => {
    await sql(
      "insert into memberships (company_id, user_id, role, status) values ($1, $2, 'office', 'disabled')",
      [t.seed.b.companyId, t.seed.a.owner.userId],
    );
    const agent = await loginAs(t.app, t.seed.a.owner);
    const me = await agent.get('/api/auth/me');
    expect(me.body.companies).toEqual([{ id: t.seed.a.companyId, name: 'Acme Roofing' }]);
  });

  test('never exposes password hashes or tokens', async () => {
    const agent = await loginAs(t.app, t.seed.a.owner);
    const me = await agent.get('/api/auth/me');
    expect(JSON.stringify(me.body)).not.toMatch(/scrypt|password|token|hash/i);
  });
});

describe('sign-up rate limit', () => {
  const TOO_MANY = { error: 'Too many sign-ups from here. Try again later.' };

  test('10 sign-ups an hour from one address; the 11th → 429 with the exact sentence', async () => {
    for (let i = 1; i <= 10; i++) {
      const res = await signup(t.app, { email: `owner${i}@example.com`, companyName: `Company ${i}` });
      expect(res.status, `sign-up ${i}`).toBe(201);
    }
    const blocked = await signup(t.app, { email: 'owner11@example.com', companyName: 'Company 11' });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual(TOO_MANY);
    expect(sessionCookie(blocked)).toBeNull();
    expect(await sql('select 1 from users where email = $1', ['owner11@example.com'])).toEqual([]);
  });

  test('refused attempts count too', async () => {
    for (let i = 1; i <= 10; i++) {
      expect((await signup(t.app, { password: 'short' })).status, `attempt ${i}`).toBe(400);
    }
    const blocked = await signup(t.app);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual(TOO_MANY);
  });

  test('Ruling SEC-1: only 3 "that email can\'t be used" answers an hour per address, then the plain sign-up 429', async () => {
    const proxied = await makeTestApp({ TRUST_PROXY: 1 });
    const from = (ip: string, email: string) =>
      request(proxied.app).post('/api/auth/signup').set('X-Forwarded-For', ip).send(signupBody({ email }));
    for (let i = 1; i <= 3; i++) {
      expect((await from('203.0.113.7', proxied.seed.a.owner.email)).status, `attempt ${i}`).toBe(409);
    }
    const blocked = await from('203.0.113.7', proxied.seed.b.owner.email);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual(TOO_MANY);
    // Even a new email from that address waits; other addresses are not affected.
    expect((await from('203.0.113.7', 'brand-new@example.com')).status).toBe(429);
    expect((await from('203.0.113.8', proxied.seed.b.owner.email)).status).toBe(409);
    expect((await from('203.0.113.8', 'brand-new@example.com')).status).toBe(201);
  });

  test('sign-ups in flight at the same moment do not use up the "email can\'t be used" budget', async () => {
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => signup(t.app, { email: `burst${n}@example.com`, companyName: `Burst ${n}` })),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
  });

  test('sign-ups that succeed do not use up the "email can\'t be used" budget', async () => {
    for (let i = 1; i <= 5; i++) {
      expect((await signup(t.app, { email: `owner${i}@example.com`, companyName: `Company ${i}` })).status).toBe(201);
    }
    for (let i = 1; i <= 3; i++) expect((await signup(t.app, { email: `owner${i}@example.com` })).status).toBe(409);
  });

  test('another address has its own budget', async () => {
    const proxied = await makeTestApp({ TRUST_PROXY: 1 });
    const from = (ip: string, n: number) =>
      request(proxied.app)
        .post('/api/auth/signup')
        .set('X-Forwarded-For', ip)
        .send(signupBody({ email: `owner${n}@example.com`, companyName: `Company ${n}` }));
    for (let i = 1; i <= 10; i++) expect((await from('203.0.113.7', i)).status).toBe(201);
    expect((await from('203.0.113.7', 11)).status).toBe(429);
    expect((await from('203.0.113.8', 12)).status).toBe(201);
  });

  test('it does not touch login or the other routes', async () => {
    for (let i = 1; i <= 10; i++) await signup(t.app, { email: `owner${i}@example.com`, companyName: `Company ${i}` });
    expect((await signup(t.app, { email: 'owner11@example.com' })).status).toBe(429);
    const res = await request(t.app)
      .post('/api/auth/login')
      .send({ email: t.seed.a.owner.email, password: SEED_PASSWORD });
    expect(res.status).toBe(200);
    expect((await request(t.app).get('/health')).status).toBe(200);
  });
});

describe('email length', () => {
  /** A syntactically valid address of exactly `length` characters (64-character local part, then labels of at most 63). */
  function emailOfLength(length: number): string {
    const head = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.`;
    const tail = '.com';
    const email = `${head}${'d'.repeat(length - head.length - tail.length)}${tail}`;
    expect(email).toHaveLength(length);
    return email;
  }
  const EMAIL_MESSAGE = 'Please enter a valid email address.';

  test('sign-up: 254 characters is accepted, 255 → 400 with the email sentence', async () => {
    const tooLong = await signup(t.app, { email: emailOfLength(255) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body).toEqual({ error: EMAIL_MESSAGE, field: 'email' });
    const ok = await signup(t.app, { email: emailOfLength(254) });
    expect(ok.status).toBe(201);
    expect(ok.body.user.email).toBe(emailOfLength(254));
  });

  test('login: 255 characters → 400 with the email sentence, without a lookup or a password check', async () => {
    const res = await request(t.app)
      .post('/api/auth/login')
      .send({ email: emailOfLength(255), password: 'whatever it is' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: EMAIL_MESSAGE, field: 'email' });
    expect(vi.mocked(passwordModule.verifyPassword)).not.toHaveBeenCalled();
  });

  test('login: 254 characters still reaches the normal "doesn\'t match" answer', async () => {
    const res = await request(t.app)
      .post('/api/auth/login')
      .send({ email: emailOfLength(254), password: 'whatever it is' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: BAD_LOGIN });
  });
});

describe('signing in on a browser that is already signed in', () => {
  async function sessionIds(agent: SuperAgent): Promise<string[]> {
    const res = await agent.get('/api/auth/sessions');
    expect(res.status).toBe(200);
    return (res.body.sessions as { id: string }[]).map((s) => s.id);
  }

  test('logging in twice with the same agent leaves one session, and it is the new one', async () => {
    const agent = await loginAs(t.app, t.seed.a.owner);
    const [first] = await sessionIds(agent);
    expect(await sessionIds(agent)).toHaveLength(1);

    const again = await agent.post('/api/auth/login').send({ email: t.seed.a.owner.email, password: SEED_PASSWORD });
    expect(again.status).toBe(200);
    const after = await sessionIds(agent);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(first);
    expect(await sql('select 1 from sessions where user_id = $1', [t.seed.a.owner.userId])).toHaveLength(1);
  });

  test('the cookie that was replaced no longer works anywhere', async () => {
    const first = await request(t.app)
      .post('/api/auth/login')
      .send({ email: t.seed.a.owner.email, password: SEED_PASSWORD });
    const oldCookie = `${DEV_SESSION_COOKIE}=${sessionCookie(first)!.value}`;
    const second = await request(t.app)
      .post('/api/auth/login')
      .set('Cookie', oldCookie)
      .send({ email: t.seed.a.owner.email, password: SEED_PASSWORD });
    expect(second.status).toBe(200);
    expect((await request(t.app).get('/api/auth/me').set('Cookie', oldCookie)).status).toBe(401);
    const newCookie = `${DEV_SESSION_COOKIE}=${sessionCookie(second)!.value}`;
    expect((await request(t.app).get('/api/auth/me').set('Cookie', newCookie)).status).toBe(200);
  });

  test('signing in as someone else on the same browser leaves no session behind for the first user', async () => {
    const agent = await loginAs(t.app, t.seed.a.owner);
    await agent.post('/api/auth/login').send({ email: t.seed.a.office.email, password: SEED_PASSWORD });
    expect(await sql('select 1 from sessions where user_id = $1', [t.seed.a.owner.userId])).toEqual([]);
    expect((await agent.get('/api/auth/me')).body.user.email).toBe(t.seed.a.office.email);
  });

  test("other devices of the same user are not touched", async () => {
    const phone = await loginAs(t.app, t.seed.a.owner);
    const laptop = await loginAs(t.app, t.seed.a.owner);
    await laptop.post('/api/auth/login').send({ email: t.seed.a.owner.email, password: SEED_PASSWORD });
    expect((await phone.get('/api/auth/me')).status).toBe(200);
    expect(await sql('select 1 from sessions where user_id = $1', [t.seed.a.owner.userId])).toHaveLength(2);
  });

  test('a failed login leaves the current session as it was', async () => {
    const agent = await loginAs(t.app, t.seed.a.owner);
    const [id] = await sessionIds(agent);
    const bad = await agent.post('/api/auth/login').send({ email: t.seed.a.owner.email, password: 'wrong password' });
    expect(bad.status).toBe(401);
    expect(await sessionIds(agent)).toEqual([id]);
  });

  test('a login with a dead cookie just starts one session', async () => {
    const res = await request(t.app)
      .post('/api/auth/login')
      .set('Cookie', `${DEV_SESSION_COOKIE}=${'x'.repeat(43)}`)
      .send({ email: t.seed.a.owner.email, password: SEED_PASSWORD });
    expect(res.status).toBe(200);
    expect(await sql('select 1 from sessions where user_id = $1', [t.seed.a.owner.userId])).toHaveLength(1);
  });

  test('signing up while signed in replaces the session too', async () => {
    const agent = await loginAs(t.app, t.seed.a.owner);
    const res = await agent.post('/api/auth/signup').send(signupBody());
    expect(res.status).toBe(201);
    expect(await sql('select 1 from sessions where user_id = $1', [t.seed.a.owner.userId])).toEqual([]);
    expect((await agent.get('/api/auth/me')).body.user.email).toBe('owner@example.com');
  });
});

describe('role and spend approval are read fresh on every request', () => {
  // The change is made on a separate connection as the table owner, the way an admin would outside the app.
  let ownerPools: Pools | undefined;
  async function asOwner(text: string, params: unknown[] = []): Promise<void> {
    const urls = inject('dbUrls');
    ownerPools ??= createPools({ tenant: urls.owner, system: urls.owner });
    await ownerPools.system.$client.query(text, params);
  }
  afterAll(async () => {
    await ownerPools?.end();
  });

  test('promoting an office user to owner with spend approval shows on the next /me, with no re-login', async () => {
    const login = await request(t.app)
      .post('/api/auth/login')
      .send({ email: t.seed.a.office.email, password: SEED_PASSWORD });
    const token = sessionCookie(login)!.value;
    const cookie = `${DEV_SESSION_COOKIE}=${token}`;

    const before = await request(t.app).get('/api/auth/me').set('Cookie', cookie);
    expect(before.body.role).toBe('office');
    expect(await resolveSession(t.deps.pools.system, token, t.clock.now())).toMatchObject({
      role: 'office',
      canApproveSpend: false,
    });

    await asOwner("update memberships set role = 'owner', can_approve_spend = true where user_id = $1 and company_id = $2", [
      t.seed.a.office.userId,
      t.seed.a.companyId,
    ]);

    const after = await request(t.app).get('/api/auth/me').set('Cookie', cookie);
    expect(after.status).toBe(200);
    expect(after.body.role).toBe('owner');
    expect(await resolveSession(t.deps.pools.system, token, t.clock.now())).toMatchObject({
      role: 'owner',
      canApproveSpend: true,
    });

    // And back down again the same way.
    await asOwner("update memberships set role = 'rep', can_approve_spend = false where user_id = $1 and company_id = $2", [
      t.seed.a.office.userId,
      t.seed.a.companyId,
    ]);
    expect((await request(t.app).get('/api/auth/me').set('Cookie', cookie)).body.role).toBe('rep');
    expect(await resolveSession(t.deps.pools.system, token, t.clock.now())).toMatchObject({
      role: 'rep',
      canApproveSpend: false,
    });
  });
});
