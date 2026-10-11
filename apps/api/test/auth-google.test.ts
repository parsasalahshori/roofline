import request from 'supertest';
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type JWTPayload, SignJWT } from 'jose';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { companySettings, type Pools, withTenant } from '@roofline/db';
import * as system from '@roofline/db/system';
import { createApp } from '../src/app.ts';
import { type GoogleClaims, JoseGoogleVerifier } from '../src/auth/google.ts';
import { AppError } from '../src/errors.ts';
import { makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

// The three lookups behind Google sign-in are wrapped (they still run for real) so a test can make
// one of them miss, and so reproduce the moment two requests overlap.
vi.mock('@roofline/db/system', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roofline/db/system')>();
  return {
    ...actual,
    findUserByGoogleSub: vi.fn(actual.findUserByGoogleSub),
    findUserByEmail: vi.fn(actual.findUserByEmail),
    linkGoogleAccount: vi.fn(actual.linkGoogleAccount),
  };
});

const DAY = 24 * 60 * 60 * 1000;

const FAILED = "We couldn't sign you in with Google. Please try again.";
const NOT_SET_UP = "Google sign-in isn't set up yet.";
const UNVERIFIED = "Google hasn't confirmed this email address, so we can't use it to sign in.";
const OTHER_ACCOUNT = 'That email is already connected to a different Google account.';
const NO_ACCESS = 'Your access to this company is turned off. Ask the owner to turn it back on.';
const COMPANY_NAME = 'Please enter your company name.';
const BAD_LOGIN = "That email and password don't match.";
const TOO_MANY = { error: 'Too many sign-in attempts. Try again in a few minutes.' };

// ---------------------------------------------------------------------------------------------
// JoseGoogleVerifier: the real verifier, run against a key pair made here (no call to Google).
// ---------------------------------------------------------------------------------------------

describe('JoseGoogleVerifier', () => {
  const CLIENT_ID = 'roofline-test.apps.googleusercontent.com';
  const KID = 'test-key-1';

  type Signing = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let privateKey: Signing;
  let verifier: JoseGoogleVerifier;

  beforeEach(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
    verifier = new JoseGoogleVerifier(CLIENT_ID, { keys: createLocalJWKSet({ keys: [jwk] }) });
  });

  type TokenOptions = {
    claims?: JWTPayload;
    sub?: string | null;
    issuer?: string;
    audience?: string;
    /** Seconds from now; negative means already expired. */
    expiresIn?: number | null;
    key?: Signing;
  };

  /** A Google-shaped ID token. Unless told otherwise it is valid. */
  async function token(o: TokenOptions = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT({
      email: 'Pat.Roofer@Example.com',
      email_verified: true,
      name: 'Pat Roofer',
      ...o.claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(o.issuer ?? 'https://accounts.google.com')
      .setAudience(o.audience ?? CLIENT_ID)
      .setIssuedAt(now - 120);
    if (o.sub !== null) jwt.setSubject(o.sub ?? '110169484474386276334');
    if (o.expiresIn !== null) jwt.setExpirationTime(now + (o.expiresIn ?? 3600));
    return jwt.sign(o.key ?? privateKey);
  }

  async function refusal(promise: Promise<unknown>) {
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }

  test('a valid token → sub, email, emailVerified and name', async () => {
    await expect(verifier.verify(await token())).resolves.toEqual({
      sub: '110169484474386276334',
      email: 'Pat.Roofer@Example.com',
      emailVerified: true,
      name: 'Pat Roofer',
    });
  });

  test('both spellings of Google’s issuer are accepted', async () => {
    for (const issuer of ['accounts.google.com', 'https://accounts.google.com']) {
      await expect(verifier.verify(await token({ issuer }))).resolves.toMatchObject({ sub: '110169484474386276334' });
    }
  });

  test.each([
    { sent: 'the boolean true', value: true, expected: true },
    { sent: 'the string "true"', value: 'true', expected: true },
    { sent: 'the boolean false', value: false, expected: false },
    { sent: 'the string "false"', value: 'false', expected: false },
    { sent: 'a missing claim', value: undefined, expected: false },
    { sent: 'the number 1', value: 1, expected: false },
  ])('email_verified as $sent → emailVerified $expected', async ({ value, expected }) => {
    const result = await verifier.verify(await token({ claims: { email_verified: value } }));
    expect(result.emailVerified).toBe(expected);
  });

  test('a missing or blank name falls back to the part of the email before the @', async () => {
    expect((await verifier.verify(await token({ claims: { name: undefined } }))).name).toBe('Pat.Roofer');
    expect((await verifier.verify(await token({ claims: { name: '   ' } }))).name).toBe('Pat.Roofer');
  });

  test('wrong audience (a token made for another app) → 401 with the plain sentence', async () => {
    const err = await refusal(verifier.verify(await token({ audience: 'someone-elses-app.apps.googleusercontent.com' })));
    expect(err.status).toBe(401);
    expect(err.message).toBe(FAILED);
  });

  test('wrong issuer → 401', async () => {
    const err = await refusal(verifier.verify(await token({ issuer: 'https://accounts.evil.example' })));
    expect(err.status).toBe(401);
    expect(err.message).toBe(FAILED);
  });

  test('expired → 401', async () => {
    const err = await refusal(verifier.verify(await token({ expiresIn: -60 })));
    expect(err.status).toBe(401);
    expect(err.message).toBe(FAILED);
  });

  test('a token signed with some other key → 401', async () => {
    const other = await generateKeyPair('RS256');
    const err = await refusal(verifier.verify(await token({ key: other.privateKey })));
    expect(err.status).toBe(401);
  });

  test('a token with no expiry or no subject, or no email → 401', async () => {
    expect((await refusal(verifier.verify(await token({ expiresIn: null })))).status).toBe(401);
    expect((await refusal(verifier.verify(await token({ sub: null })))).status).toBe(401);
    expect((await refusal(verifier.verify(await token({ claims: { email: undefined } })))).status).toBe(401);
  });

  test.each(['', 'not-a-token', 'a.b.c'])('%j is not a token → 401', async (credential) => {
    const err = await refusal(verifier.verify(credential));
    expect(err.status).toBe(401);
    expect(err.message).toBe(FAILED);
  });

  test('with no client id configured, verifying is a 503 and nothing is trusted', async () => {
    const unset = new JoseGoogleVerifier(undefined, { keys: createLocalJWKSet({ keys: [] }) });
    const err = await refusal(unset.verify(await token()));
    expect(err.status).toBe(503);
    expect(err.message).toBe(NOT_SET_UP);
  });
});

// ---------------------------------------------------------------------------------------------
// POST /api/auth/google
// ---------------------------------------------------------------------------------------------

let t: TestApp;

beforeEach(async () => {
  vi.mocked(system.findUserByGoogleSub).mockReset();
  vi.mocked(system.findUserByEmail).mockReset();
  vi.mocked(system.linkGoogleAccount).mockReset();
  t = await makeTestApp();
});

/** A read-only look at the database through the system pool's raw client. */
async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await t.deps.pools.system.$client.query(text, params);
  return result.rows as T[];
}

function claims(overrides: Partial<GoogleClaims> = {}): GoogleClaims {
  return { sub: 'google-sub-new', email: 'nora@example.com', emailVerified: true, name: 'Nora Newcomer', ...overrides };
}

let credentialCount = 0;

/**
 * Posts a Google credential. `as` is what the fake verifier says it means; null → Google would
 * refuse it. `target` is the app, or an agent that carries cookies between requests.
 */
function googleSignIn(
  as: GoogleClaims | null,
  extra: Record<string, unknown> = {},
  target: TestApp['app'] | SuperAgent = t.app,
) {
  const credential = `credential-${++credentialCount}`;
  if (as) t.google.register(credential, as);
  const send = typeof target === 'function' ? request(target) : target;
  return send.post('/api/auth/google').send({ credential, ...extra });
}

function hasSessionCookie(res: { headers: Record<string, unknown> }): boolean {
  const raw = res.headers['set-cookie'];
  const lines = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
  return lines.some((c) => c.startsWith('rl_session='));
}

/** Row counts of the tables a sign-in can touch, for "nothing was created" checks. */
async function counts() {
  const [row] = await sql<{ users: string; companies: string; memberships: string; sessions: string }>(
    `select (select count(*) from users) as users, (select count(*) from companies) as companies,
            (select count(*) from memberships) as memberships, (select count(*) from sessions) as sessions`,
  );
  return row!;
}

/** Signs up a password user through the real route; returns who they are. */
async function signedUpUser(email = 'olive@example.com', companyName = 'Summit Roofing') {
  const res = await request(t.app)
    .post('/api/auth/signup')
    .send({ email, password: 'a long enough password', name: 'Olive Owner', companyName });
  expect(res.status).toBe(201);
  return res.body as { user: { id: string; email: string }; company: { id: string; slug: string } };
}

async function linkSub(userId: string, sub: string) {
  await sql('update users set google_sub = $2 where id = $1', [userId, sub]);
}

describe('branch 1: the Google account is already linked to a user', () => {
  test('signs in as that user, with the cookie, and the session works', async () => {
    const owner = t.seed.a.owner;
    await linkSub(owner.userId, 'google-sub-owner');
    const before = await counts();

    const agent = request.agent(t.app);
    const res = await googleSignIn(claims({ sub: 'google-sub-owner', email: owner.email }), {}, agent);
    expect(res.status).toBe(200);
    expect(hasSessionCookie(res)).toBe(true);
    expect(res.body).toEqual({
      user: { id: owner.userId, email: owner.email, name: expect.any(String), emailVerified: true },
      company: { id: t.seed.a.companyId, name: 'Acme Roofing', slug: 'acme-roofing', status: expect.any(String) },
    });

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(owner.userId);
    expect(me.body.role).toBe('owner');

    // Nothing was created: one more session and that is all.
    expect(await counts()).toEqual({ ...before, sessions: String(Number(before.sessions) + 1) });
  });

  test('the sub decides, not the email: a changed Google email signs in and the stored email is left alone', async () => {
    const owner = t.seed.a.owner;
    await linkSub(owner.userId, 'google-sub-owner');
    const res = await googleSignIn(claims({ sub: 'google-sub-owner', email: 'brand.new.address@example.com' }));
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: owner.userId, email: owner.email });
    expect(await sql('select email::text as email from users where id = $1', [owner.userId])).toEqual([
      { email: owner.email },
    ]);
    // And no user was made for the new address.
    expect(await sql('select 1 from users where email = $1', ['brand.new.address@example.com'])).toEqual([]);
  });

  test('a company name in the request is ignored', async () => {
    await linkSub(t.seed.a.owner.userId, 'google-sub-owner');
    const before = await counts();
    const res = await googleSignIn(claims({ sub: 'google-sub-owner' }), { companyName: 'Should Not Exist Roofing' });
    expect(res.status).toBe(200);
    expect((await counts()).companies).toBe(before.companies);
  });

  test('it still signs in when Google no longer reports the email as confirmed', async () => {
    await linkSub(t.seed.a.owner.userId, 'google-sub-owner');
    const res = await googleSignIn(claims({ sub: 'google-sub-owner', emailVerified: false }));
    expect(res.status).toBe(200);
  });

  test('the subs are compared exactly', async () => {
    await linkSub(t.seed.a.owner.userId, 'Google-Sub-Owner');
    const res = await googleSignIn(claims({ sub: 'google-sub-owner', email: 'someone.else@example.com' }), {
      companyName: 'Other Roofing',
    });
    // Not the same account, so this is a new person.
    expect(res.status).toBe(200);
    expect(res.body.user.id).not.toBe(t.seed.a.owner.userId);
  });
});

describe('branch 2: a confirmed Google email that an existing user already has → link', () => {
  test('links a password user (any capitalisation), confirms their email, and signs them in', async () => {
    const account = await signedUpUser('olive@example.com');
    expect(await sql('select email_verified_at from users where id = $1', [account.user.id])).toEqual([
      { email_verified_at: null },
    ]);
    t.clock.advance(3 * DAY);

    const agent = request.agent(t.app);
    const res = await googleSignIn(claims({ sub: 'google-sub-olive', email: '  Olive@EXAMPLE.com ' }), {}, agent);
    expect(res.status).toBe(200);
    expect(hasSessionCookie(res)).toBe(true);
    expect(res.body).toEqual({
      user: { id: account.user.id, email: 'olive@example.com', name: 'Olive Owner', emailVerified: true },
      company: { id: account.company.id, name: 'Summit Roofing', slug: 'summit-roofing', status: 'trial' },
    });

    const [row] = await sql<{ google_sub: string; email_verified_at: Date; has_password: boolean }>(
      'select google_sub, email_verified_at, password_hash is not null as has_password from users where id = $1',
      [account.user.id],
    );
    expect(row!.google_sub).toBe('google-sub-olive');
    expect(row!.email_verified_at.getTime()).toBe(t.clock.now().getTime());
    expect(row!.has_password).toBe(true);
    // No new account, and the next time it is the sub that matches.
    expect(await sql('select 1 from users where email = $1', ['olive@example.com'])).toHaveLength(1);
    expect((await agent.get('/api/auth/me')).body.user.emailVerified).toBe(true);
    expect((await googleSignIn(claims({ sub: 'google-sub-olive', email: 'olive@example.com' }))).status).toBe(200);
  });

  test('an email that was already confirmed keeps its original date', async () => {
    const owner = t.seed.a.owner;
    const [before] = await sql<{ email_verified_at: Date }>('select email_verified_at from users where id = $1', [
      owner.userId,
    ]);
    t.clock.advance(5 * DAY);
    const res = await googleSignIn(claims({ sub: 'google-sub-owner', email: owner.email.toUpperCase() }));
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(owner.userId);
    const [row] = await sql<{ google_sub: string; email_verified_at: Date }>(
      'select google_sub, email_verified_at from users where id = $1',
      [owner.userId],
    );
    expect(row!.google_sub).toBe('google-sub-owner');
    expect(row!.email_verified_at).toEqual(before!.email_verified_at);
  });

  test('an email already connected to a different Google account is refused, and nothing changes', async () => {
    const owner = t.seed.a.owner;
    await linkSub(owner.userId, 'google-sub-first-account');
    const before = await counts();
    const res = await googleSignIn(claims({ sub: 'google-sub-second-account', email: owner.email }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: OTHER_ACCOUNT, field: 'email' });
    expect(hasSessionCookie(res)).toBe(false);
    expect(await sql('select google_sub from users where id = $1', [owner.userId])).toEqual([
      { google_sub: 'google-sub-first-account' },
    ]);
    expect(await counts()).toEqual(before);
  });
});

describe('branch 3: a new person with a confirmed Google email → user and company', () => {
  test('creates the user (verified, no password), a trial company, an owner membership and default settings', async () => {
    const agent = request.agent(t.app);
    const res = await googleSignIn(
      claims({ email: '  Nora@Example.COM ', name: 'Nora Newcomer' }),
      { companyName: '  Summit Roofing ' },
      agent,
    );
    expect(res.status).toBe(200);
    expect(hasSessionCookie(res)).toBe(true);
    expect(res.body).toEqual({
      user: { id: expect.any(String), email: 'nora@example.com', name: 'Nora Newcomer', emailVerified: true },
      company: { id: expect.any(String), name: 'Summit Roofing', slug: 'summit-roofing', status: 'trial' },
    });

    const [user] = await sql<{
      email: string;
      google_sub: string;
      password_hash: string | null;
      email_verified_at: Date;
    }>('select email::text as email, google_sub, password_hash, email_verified_at from users where id = $1', [
      res.body.user.id,
    ]);
    expect(user).toMatchObject({ email: 'nora@example.com', google_sub: 'google-sub-new', password_hash: null });
    expect(user!.email_verified_at.getTime()).toBe(t.clock.now().getTime());

    const [company] = await sql<{ status: string; trial_ends_at: Date }>(
      'select status, trial_ends_at from companies where id = $1',
      [res.body.company.id],
    );
    expect(company!.status).toBe('trial');
    expect(company!.trial_ends_at.getTime()).toBe(t.clock.now().getTime() + 14 * DAY);

    expect(
      await sql('select role, status, user_id from memberships where company_id = $1', [res.body.company.id]),
    ).toEqual([{ role: 'owner', status: 'active', user_id: res.body.user.id }]);

    const settings = await withTenant(
      t.deps.pools,
      { companyId: res.body.company.id, userId: null, role: 'system', canApproveSpend: false },
      (tx) => tx.select().from(companySettings),
    );
    expect(settings).toHaveLength(1);

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ role: 'owner', company: { id: res.body.company.id } });
    // Google already vouched for the address, so there is nothing to confirm by email.
    await t.settle();
    expect(t.mailer.sent).toEqual([]);
    expect(await sql('select 1 from user_tokens')).toEqual([]);
  });

  test('uses the same slug rules as sign-up (taken names, reserved names)', async () => {
    const taken = await googleSignIn(claims({ sub: 's1', email: 'one@example.com' }), { companyName: 'Bolt Roofing' });
    expect(taken.body.company.slug).toBe('bolt-roofing-2');
    const reserved = await googleSignIn(claims({ sub: 's2', email: 'two@example.com' }), { companyName: 'API' });
    expect(reserved.body.company.slug).toBe('api-2');
    const same = await googleSignIn(claims({ sub: 's3', email: 'three@example.com' }), { companyName: 'bolt roofing' });
    expect(same.body.company.slug).toBe('bolt-roofing-3');
  });

  test.each([
    ['missing', {}, COMPANY_NAME],
    ['blank', { companyName: '   ' }, COMPANY_NAME],
    ['not text', { companyName: 42 }, COMPANY_NAME],
    ['too long', { companyName: 'x'.repeat(201) }, 'That company name is too long.'],
  ])('a company name that is %s → 400 with the field, and nothing is created', async (_name, extra, error) => {
    const before = await counts();
    const res = await googleSignIn(claims(), extra);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error, field: 'companyName' });
    expect(hasSessionCookie(res)).toBe(false);
    expect(await counts()).toEqual(before);
    // The same credential works once the company name is there.
    const again = await googleSignIn(claims(), { companyName: 'Summit Roofing' });
    expect(again.status).toBe(200);
  });

  test('the new user cannot use password login (no password): the same 401 as any wrong password', async () => {
    const created = await googleSignIn(claims(), { companyName: 'Summit Roofing' });
    expect(created.status).toBe(200);
    const res = await request(t.app)
      .post('/api/auth/login')
      .send({ email: 'nora@example.com', password: 'a long enough password' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: BAD_LOGIN });
  });

  test('a name is kept to 200 characters', async () => {
    const res = await googleSignIn(claims({ name: 'N'.repeat(500) }), { companyName: 'Summit Roofing' });
    expect(res.status).toBe(200);
    expect(res.body.user.name).toHaveLength(200);
  });

  test('if saving the company settings fails, nothing is left behind and the caller gets a 500', async () => {
    const logError = vi.fn();
    const brokenTenant = { transaction: () => Promise.reject(new Error('tenant pool down')) };
    const pools = { ...t.deps.pools, tenant: brokenTenant } as unknown as Pools;
    const app = createApp({ ...t.deps, pools }, { logError });

    const before = await counts();
    const res = await googleSignIn(claims(), { companyName: 'Summit Roofing' }, app);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Something went wrong on our side. Please try again.' });
    expect(hasSessionCookie(res)).toBe(false);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(await counts()).toEqual(before);

    // The same sign-in works once the problem is gone: neither the email nor the sub was left claimed.
    expect((await googleSignIn(claims(), { companyName: 'Summit Roofing' })).status).toBe(200);
  });

  test('the same sign-in sent twice at once makes one user and one company, and both requests are signed in', async () => {
    const credential = 'double-click';
    t.google.register(credential, claims());
    const before = await counts();
    const send = () => request(t.app).post('/api/auth/google').send({ credential, companyName: 'Summit Roofing' });
    const results = await Promise.all([send(), send(), send()]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(results.map((r) => r.body.user.id)).size).toBe(1);
    expect(results.every(hasSessionCookie)).toBe(true);
    const n = (key: keyof typeof before, by: number) => String(Number(before[key]) + by);
    expect(await counts()).toEqual({
      users: n('users', 1),
      companies: n('companies', 1),
      memberships: n('memberships', 1),
      sessions: n('sessions', 3),
    });
  });
});

describe('two requests overlapping (each lookup below is made to miss what the other request just made)', () => {
  async function signedUpWithGoogle() {
    const created = await googleSignIn(claims(), { companyName: 'Summit Roofing' });
    expect(created.status).toBe(200);
    return created.body as { user: { id: string }; company: { id: string } };
  }

  test('the email lookup finds the very Google account that is signing in → that user, nothing new', async () => {
    const first = await signedUpWithGoogle();
    const before = await counts();
    vi.mocked(system.findUserByGoogleSub).mockResolvedValueOnce(null);
    const res = await googleSignIn(claims());
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(first.user.id);
    expect(await counts()).toEqual({ ...before, sessions: String(Number(before.sessions) + 1) });
  });

  test('creating loses to the winner on the Google account → looks again and signs in as the winner', async () => {
    const first = await signedUpWithGoogle();
    const before = await counts();
    vi.mocked(system.findUserByGoogleSub).mockClear();
    vi.mocked(system.findUserByGoogleSub).mockResolvedValueOnce(null);
    vi.mocked(system.findUserByEmail).mockResolvedValueOnce(null);
    // A different email, so only the Google account collides: GoogleSubInUseError.
    const res = await googleSignIn(claims({ email: 'other.address@example.com' }), { companyName: 'Another Roofing' });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(first.user.id);
    expect(vi.mocked(system.findUserByGoogleSub)).toHaveBeenCalledTimes(2);
    expect(await counts()).toEqual({ ...before, sessions: String(Number(before.sessions) + 1) });
  });

  test('creating loses to the winner on the email → looks again and links the account that now exists', async () => {
    const account = await signedUpUser('olive@example.com');
    vi.mocked(system.findUserByEmail).mockResolvedValueOnce(null);
    const res = await googleSignIn(claims({ sub: 'google-sub-olive', email: 'olive@example.com' }), {
      companyName: 'Another Roofing',
    });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(account.user.id);
    expect(await sql('select google_sub from users where id = $1', [account.user.id])).toEqual([
      { google_sub: 'google-sub-olive' },
    ]);
    expect(await sql('select 1 from companies where name = $1', ['Another Roofing'])).toEqual([]);
  });

  test('linking loses to a request that connected the account first → looks again and signs in', async () => {
    const owner = t.seed.a.owner;
    vi.mocked(system.linkGoogleAccount).mockImplementationOnce(async () => {
      await linkSub(owner.userId, 'google-sub-owner'); // what the other request did, just before ours
      return null;
    });
    const res = await googleSignIn(claims({ sub: 'google-sub-owner', email: owner.email }));
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(owner.userId);
  });

  test('if it still collides on the second look, the caller gets a 500 and it is logged', async () => {
    await signedUpWithGoogle();
    vi.mocked(system.findUserByGoogleSub).mockResolvedValue(null);
    vi.mocked(system.findUserByEmail).mockResolvedValue(null);
    const logError = vi.fn();
    const app = createApp(t.deps, { logError });
    const res = await googleSignIn(claims({ email: 'other.address@example.com' }), { companyName: 'Another' }, app);
    expect(res.status).toBe(500);
    expect(hasSessionCookie(res)).toBe(false);
    expect(logError).toHaveBeenCalledTimes(1);
  });
});

describe('branch 4: Google has not confirmed the email', () => {
  test('a new person is refused with the exact sentence, and nothing is created', async () => {
    const before = await counts();
    const res = await googleSignIn(claims({ emailVerified: false }), { companyName: 'Summit Roofing' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: UNVERIFIED });
    expect(hasSessionCookie(res)).toBe(false);
    expect(await counts()).toEqual(before);
  });

  test('an existing password user with that email is NOT linked, and their google_sub stays null', async () => {
    const owner = t.seed.a.owner;
    const res = await googleSignIn(claims({ sub: 'attacker-sub', email: owner.email, emailVerified: false }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: UNVERIFIED });
    expect(hasSessionCookie(res)).toBe(false);
    expect(await sql('select google_sub from users where id = $1', [owner.userId])).toEqual([{ google_sub: null }]);
    expect(await sql('select 1 from sessions where user_id = $1', [owner.userId])).toEqual([]);
  });

  test('an unconfirmed address stays unconfirmed: nothing on the existing user changes', async () => {
    const account = await signedUpUser('olive@example.com');
    const [before] = await sql('select * from users where id = $1', [account.user.id]);
    const res = await googleSignIn(claims({ sub: 'attacker-sub', email: 'olive@example.com', emailVerified: false }));
    expect(res.status).toBe(400);
    expect(await sql('select * from users where id = $1', [account.user.id])).toEqual([before]);
  });
});

describe('a user with no active membership', () => {
  test('signing in by sub → the same 403 as password login, and no cookie', async () => {
    const rep = t.seed.a.rep;
    await linkSub(rep.userId, 'google-sub-rep');
    await sql("update memberships set status = 'disabled' where user_id = $1", [rep.userId]);
    const res = await googleSignIn(claims({ sub: 'google-sub-rep', email: rep.email }));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: NO_ACCESS });
    expect(hasSessionCookie(res)).toBe(false);
  });

  test('linking by email → 403 too, and the account is not linked', async () => {
    const rep = t.seed.a.rep;
    await sql("update memberships set status = 'disabled' where user_id = $1", [rep.userId]);
    const res = await googleSignIn(claims({ sub: 'google-sub-rep', email: rep.email }));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: NO_ACCESS });
    expect(hasSessionCookie(res)).toBe(false);
    expect(await sql('select google_sub from users where id = $1', [rep.userId])).toEqual([{ google_sub: null }]);
  });
});

describe('a credential Google would not accept, and a missing client id', () => {
  test('the verifier refusing it → 401 with the plain sentence, nothing created, no cookie', async () => {
    const before = await counts();
    const res = await googleSignIn(null, { companyName: 'Summit Roofing' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: FAILED });
    expect(hasSessionCookie(res)).toBe(false);
    expect(await counts()).toEqual(before);
  });

  test.each([
    ['no credential', {}],
    ['an empty credential', { credential: '' }],
    ['a credential that is not text', { credential: 12345 }],
  ])('%s → 400 on the credential field', async (_name, body) => {
    const res = await request(t.app).post('/api/auth/google').send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: FAILED, field: 'credential' });
  });

  test('no GOOGLE_CLIENT_ID → 503 "Google sign-in isn\'t set up yet.", and Google is never asked', async () => {
    const off = await makeTestApp({ GOOGLE_CLIENT_ID: undefined });
    const verify = vi.spyOn(off.google, 'verify');
    const res = await request(off.app).post('/api/auth/google').send({ credential: 'anything' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: NOT_SET_UP });
    expect(verify).not.toHaveBeenCalled();
    expect(hasSessionCookie(res)).toBe(false);
  });

  test('the route needs no session: the sign-in gate lets it through', async () => {
    const res = await request(t.app).post('/api/auth/google').send({ credential: 'nobody' });
    expect(res.body).toEqual({ error: FAILED });
  });
});

describe('Google sign-in rate limit', () => {
  test('20 attempts per 15 minutes per address, refused ones included; the 21st → 429', async () => {
    for (let i = 1; i <= 20; i++) {
      const res = await googleSignIn(null);
      expect(res.status, `attempt ${i}`).toBe(401);
    }
    // Even a good credential is refused now.
    const blocked = await googleSignIn(claims({ sub: 'google-sub-owner', email: t.seed.a.owner.email }));
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual(TOO_MANY);
    expect(hasSessionCookie(blocked)).toBe(false);
  });

  test('successful sign-ins count too', async () => {
    await linkSub(t.seed.a.owner.userId, 'google-sub-owner');
    for (let i = 1; i <= 20; i++) {
      expect((await googleSignIn(claims({ sub: 'google-sub-owner' }))).status, `attempt ${i}`).toBe(200);
    }
    expect((await googleSignIn(claims({ sub: 'google-sub-owner' }))).status).toBe(429);
  });

  test('another address has its own budget, and login is untouched', async () => {
    const proxied = await makeTestApp({ TRUST_PROXY: 1 });
    const from = (ip: string) =>
      request(proxied.app).post('/api/auth/google').set('X-Forwarded-For', ip).send({ credential: 'unknown' });
    for (let i = 1; i <= 20; i++) expect((await from('203.0.113.7')).status).toBe(401);
    expect((await from('203.0.113.7')).status).toBe(429);
    expect((await from('203.0.113.8')).status).toBe(401);

    const login = await request(proxied.app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '203.0.113.7')
      .send({ email: proxied.seed.a.owner.email, password: proxied.seed.a.owner.password });
    expect(login.status).toBe(200);
  });
});

describe('signing in with Google on a browser that is already signed in', () => {
  test('the old session is replaced, like any other sign-in', async () => {
    const agent = request.agent(t.app);
    const login = await agent
      .post('/api/auth/login')
      .send({ email: t.seed.a.owner.email, password: t.seed.a.owner.password });
    expect(login.status).toBe(200);
    expect(await sql('select 1 from sessions')).toHaveLength(1);

    await linkSub(t.seed.b.owner.userId, 'google-sub-b-owner');
    const res = await googleSignIn(claims({ sub: 'google-sub-b-owner' }), {}, agent);
    expect(res.status).toBe(200);
    expect(await sql('select user_id from sessions')).toEqual([{ user_id: t.seed.b.owner.userId }]);
    expect((await agent.get('/api/auth/me')).body.user.id).toBe(t.seed.b.owner.userId);
  });
});
