import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  errors,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTPayload,
  SignJWT,
} from 'jose';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { companySettings, type Pools, withTenant } from '@roofline/db';
import * as system from '@roofline/db/system';
import { createApp } from '../src/app.ts';
import {
  type GoogleClaims,
  GoogleUnavailableError,
  isGoogleAuthoritative,
  JoseGoogleVerifier,
} from '../src/auth/google.ts';
import * as passwordModule from '../src/auth/password.ts';
import { AppError } from '../src/errors.ts';
import { loginAs, makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

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

// verifyPassword is wrapped (it still runs for real) so a test can run something right after a
// password check succeeds and before the login saves its session.
vi.mock('../src/auth/password.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth/password.ts')>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

const DAY = 24 * 60 * 60 * 1000;

const FAILED = "We couldn't sign you in with Google. Please try again.";
const NOT_SET_UP = "Google sign-in isn't set up yet.";
const UNAVAILABLE = 'Google sign-in is having trouble right now. Please try again in a minute.';
const UNVERIFIED = "Google hasn't confirmed this email address, so we can't use it to sign in.";
const OTHER_ACCOUNT = 'That email is already connected to a different Google account.';
const EMAIL_IN_USE = 'This email already has a Roofline account. Please sign in with your password.';
const NO_ACCESS = 'Your access to this company is turned off. Ask the owner to turn it back on.';
const COMPANY_NAME = 'Please enter your company name.';
const BAD_LOGIN = "That email and password don't match.";
const LINK_USED = 'That link has already been used or has expired.';
const TOO_MANY = { error: 'Too many sign-in attempts. Try again in a few minutes.' };

// ---------------------------------------------------------------------------------------------
// JoseGoogleVerifier: the real verifier, run against a key pair made here (no call to Google).
// ---------------------------------------------------------------------------------------------

const CLIENT_ID = 'roofline-test.apps.googleusercontent.com';
const KID = 'test-key-1';

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

/** A signing key and the public key set that goes with it. */
async function newKeys() {
  const pair = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
  return { privateKey: pair.privateKey, jwk, local: createLocalJWKSet({ keys: [jwk] }) };
}

type TokenOptions = {
  claims?: JWTPayload;
  sub?: string | null;
  issuer?: string;
  audience?: string;
  /** Seconds from now; negative means already expired. */
  expiresIn?: number | null;
  key?: SigningKey;
};

/** A Google-shaped ID token signed with `key`. Unless told otherwise it is valid. */
async function signToken(key: SigningKey, o: TokenOptions = {}): Promise<string> {
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
  return jwt.sign(o.key ?? key);
}

describe('JoseGoogleVerifier', () => {
  let privateKey: SigningKey;
  let verifier: JoseGoogleVerifier;

  beforeEach(async () => {
    const keys = await newKeys();
    privateKey = keys.privateKey;
    verifier = new JoseGoogleVerifier(CLIENT_ID, { keys: keys.local });
  });

  const token = (o: TokenOptions = {}) => signToken(privateKey, o);

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

  test('the Workspace domain (hd) comes through as hostedDomain; without one the property is absent', async () => {
    expect(await verifier.verify(await token({ claims: { hd: 'acme-roofing.test' } }))).toMatchObject({
      hostedDomain: 'acme-roofing.test',
    });
    for (const hd of [undefined, '', '   ', 42, true]) {
      const result = await verifier.verify(await token({ claims: { hd: hd as never } }));
      expect(result, `hd ${JSON.stringify(hd)}`).not.toHaveProperty('hostedDomain');
    }
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

  describe("when Google's keys cannot be fetched", () => {
    /** A key server on this machine, so jose's real fetching runs without any call to Google. */
    const running: { stop(): Promise<void> }[] = [];
    async function keyServer(handler: RequestListener) {
      const server = createServer(handler);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      const stop = () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        });
      running.push({ stop });
      return { url: new URL(`http://127.0.0.1:${port}/certs`), stop };
    }
    afterEach(async () => {
      await Promise.all(running.splice(0).map((r) => r.stop()));
    });

    const fetching = (url: URL) =>
      new JoseGoogleVerifier(CLIENT_ID, { keys: createRemoteJWKSet(url, { timeoutDuration: 300 }) });

    async function outage(promise: Promise<unknown>) {
      const err = await refusal(promise);
      expect(err).toBeInstanceOf(GoogleUnavailableError);
      expect(err.status).toBe(503);
      expect(err.message).toBe(UNAVAILABLE);
      return err as GoogleUnavailableError;
    }

    test('control: keys served over HTTP verify a good token (so the failures below are about the keys)', async () => {
      const keys = await newKeys();
      const server = await keyServer((_req, res) => {
        res.setHeader('content-type', 'application/json').end(JSON.stringify({ keys: [keys.jwk] }));
      });
      await expect(fetching(server.url).verify(await signToken(keys.privateKey))).resolves.toMatchObject({
        email: 'Pat.Roofer@Example.com',
      });
    });

    test.each([
      ['a key server that times out', () => new errors.JWKSTimeout()],
      ['a network error', () => new TypeError('fetch failed')],
      ['a bad answer from the key server', () => new errors.JOSEError('Failed to parse the JSON Web Key Set HTTP response as JSON')],
      ['a key set that is malformed', () => new errors.JWKSInvalid('JSON Web Key Set malformed')],
      ['something nobody expected', () => new RangeError('boom')],
    ])('%s (from a key getter that throws it) → 503 with its own sentence, and the cause is kept', async (_name, make) => {
      const cause = make();
      const down = new JoseGoogleVerifier(CLIENT_ID, {
        keys: async () => {
          throw cause;
        },
      });
      const err = await outage(down.verify(await token()));
      expect(err.cause).toBe(cause);
    });

    test('a key server that answers with something that is not JSON → 503', async () => {
      const server = await keyServer((_req, res) => void res.end('<html>Bad gateway</html>'));
      const err = await outage(fetching(server.url).verify(await token()));
      expect(String((err.cause as Error).message)).toMatch(/JSON/);
    });

    test('a key server that answers 500 → 503', async () => {
      const server = await keyServer((_req, res) => void res.writeHead(500).end('oops'));
      await outage(fetching(server.url).verify(await token()));
    });

    test('a key server that answers JSON that is not a key set → 503', async () => {
      const server = await keyServer((_req, res) => void res.end('{"nope":true}'));
      const err = await outage(fetching(server.url).verify(await token()));
      expect(err.cause).toBeInstanceOf(errors.JWKSInvalid);
    });

    test('a key server that never answers → jose times out → 503', async () => {
      const server = await keyServer(() => {});
      const err = await outage(fetching(server.url).verify(await token()));
      expect(err.cause).toBeInstanceOf(errors.JWKSTimeout);
    });

    test('nothing listening at the key server → 503', async () => {
      const server = await keyServer((_req, res) => void res.end('{}'));
      await server.stop();
      await outage(fetching(server.url).verify(await token()));
    });

    test('a key set that simply does not have this token’s key is the token’s fault → 401, not 503', async () => {
      const server = await keyServer((_req, res) => void res.end('{"keys":[]}'));
      const err = await refusal(fetching(server.url).verify(await token()));
      expect(err).not.toBeInstanceOf(GoogleUnavailableError);
      expect(err.status).toBe(401);
      expect(err.message).toBe(FAILED);
    });

    test('a token that is not even a token is a 401 while Google is down (the keys are never needed)', async () => {
      const down = new JoseGoogleVerifier(CLIENT_ID, {
        keys: async () => {
          throw new errors.JWKSTimeout();
        },
      });
      const err = await refusal(down.verify('not-a-token'));
      expect(err).not.toBeInstanceOf(GoogleUnavailableError);
      expect(err.status).toBe(401);
    });
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
  vi.mocked(passwordModule.verifyPassword).mockReset();
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

/** The 43-character token in the link of an email. */
function tokenFrom(mail: { text: string }, page: 'reset' | 'verify'): string {
  return mail.text.match(new RegExp(`/${page}\\?token=([A-Za-z0-9_-]{43})`))![1]!;
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
  test('links an unconfirmed password user (any capitalisation), confirms their email, hands the account over, and signs them in', async () => {
    const account = await signedUpUser('olive@example.com');
    expect(await sql('select email_verified_at from users where id = $1', [account.user.id])).toEqual([
      { email_verified_at: null },
    ]);
    t.clock.advance(3 * DAY);

    const agent = request.agent(t.app);
    const res = await googleSignIn(claims({ sub: 'google-sub-olive', email: '  Olive@EXAMPLE.com ', hostedDomain: 'example.com' }), {}, agent);
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
    // The email was never confirmed, so whoever made the account is cut off: no password any more.
    expect(row!.has_password).toBe(false);
    // No new account, and the next time it is the sub that matches.
    expect(await sql('select 1 from users where email = $1', ['olive@example.com'])).toHaveLength(1);
    expect((await agent.get('/api/auth/me')).body.user.emailVerified).toBe(true);
    expect((await googleSignIn(claims({ sub: 'google-sub-olive', email: 'olive@example.com' }))).status).toBe(200);
  });

  test('an attacker who pre-registered the owner’s address loses the account when the owner signs in with Google', async () => {
    // The attacker signs up with the victim's address and a password of their own. The address is
    // never confirmed, so the account stays "unverified" and the attacker stays signed in.
    const attacker = request.agent(t.app);
    const made = await attacker
      .post('/api/auth/signup')
      .send({ email: 'victim@x.test', password: 'the attackers password', name: 'Mallory', companyName: 'Mallory Roofing' });
    expect(made.status).toBe(201);
    expect((await attacker.get('/api/auth/me')).status).toBe(200);

    // They also ask for a password-reset link, and hold on to it along with the confirmation link.
    expect((await request(t.app).post('/api/auth/reset-request').send({ email: 'victim@x.test' })).status).toBe(200);
    await t.settle();
    const resetToken = tokenFrom(t.mailer.sent.find((m) => /Reset/.test(m.subject))!, 'reset');
    const verifyToken = tokenFrom(t.mailer.sent.find((m) => /Confirm/.test(m.subject))!, 'verify');
    expect(await sql('select kind from user_tokens where used_at is null order by kind')).toEqual([
      { kind: 'reset_password' },
      { kind: 'verify_email' },
    ]);

    // The real owner of victim@x.test signs in with Google.
    t.clock.advance(DAY);
    const victim = request.agent(t.app);
    const res = await googleSignIn(claims({ sub: 'victim-sub', email: 'victim@x.test', hostedDomain: 'x.test' }), {}, victim);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: made.body.user.id, email: 'victim@x.test', emailVerified: true });
    expect(hasSessionCookie(res)).toBe(true);

    // Nothing the attacker kept works any more.
    expect((await attacker.get('/api/auth/me')).status).toBe(401);
    const password = await request(t.app)
      .post('/api/auth/login')
      .send({ email: 'victim@x.test', password: 'the attackers password' });
    expect(password.status).toBe(401);
    expect(password.body).toEqual({ error: BAD_LOGIN });
    const reset = await request(t.app).post('/api/auth/reset').send({ token: resetToken, password: 'another password' });
    expect(reset.status).toBe(400);
    expect(reset.body).toEqual({ error: LINK_USED });
    expect((await request(t.app).post('/api/auth/verify-email').send({ token: verifyToken })).status).toBe(400);

    // The account itself is now the owner's, with the Google sign-in and the new session only.
    expect(
      await sql<{ google_sub: string; has_password: boolean }>(
        'select google_sub, password_hash is not null as has_password from users where id = $1',
        [made.body.user.id],
      ),
    ).toEqual([{ google_sub: 'victim-sub', has_password: false }]);
    const [verified] = await sql<{ email_verified_at: Date }>('select email_verified_at from users where id = $1', [
      made.body.user.id,
    ]);
    expect(verified!.email_verified_at.getTime()).toBe(t.clock.now().getTime());
    expect(await sql('select 1 from user_tokens where user_id = $1', [made.body.user.id])).toEqual([]);
    expect(await sql('select 1 from sessions where user_id = $1', [made.body.user.id])).toHaveLength(1);
    expect((await victim.get('/api/auth/me')).status).toBe(200);
  });

  test('an account whose email was already confirmed keeps its password, its sessions and its links', async () => {
    const owner = t.seed.a.owner;
    const device = await loginAs(t.app, owner);
    expect((await request(t.app).post('/api/auth/reset-request').send({ email: owner.email })).status).toBe(200);
    await t.settle();
    const unusedLinks = () =>
      sql('select 1 from user_tokens where user_id = $1 and used_at is null', [owner.userId]);
    expect(await unusedLinks()).toHaveLength(1);

    const res = await googleSignIn(claims({ sub: 'google-sub-owner', email: owner.email, hostedDomain: 'a.test' }));
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(owner.userId);

    expect((await device.get('/api/auth/me')).status).toBe(200); // the other device is still signed in
    expect(await unusedLinks()).toHaveLength(1);
    const password = await request(t.app).post('/api/auth/login').send({ email: owner.email, password: owner.password });
    expect(password.status).toBe(200); // and the password still works
  });

  test('an email that was already confirmed keeps its original date', async () => {
    const owner = t.seed.a.owner;
    const [before] = await sql<{ email_verified_at: Date }>('select email_verified_at from users where id = $1', [
      owner.userId,
    ]);
    t.clock.advance(5 * DAY);
    const res = await googleSignIn(claims({ sub: 'google-sub-owner', email: owner.email.toUpperCase(), hostedDomain: 'A.test' }));
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
    const res = await googleSignIn(
      claims({ sub: 'google-sub-second-account', email: owner.email, hostedDomain: 'a.test' }),
    );
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: OTHER_ACCOUNT });
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
    const res = await googleSignIn(
      claims({ sub: 'google-sub-olive', email: 'olive@example.com', hostedDomain: 'example.com' }),
      { companyName: 'Another Roofing' },
    );
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
    const res = await googleSignIn(claims({ sub: 'google-sub-owner', email: owner.email, hostedDomain: 'a.test' }));
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

describe('isGoogleAuthoritative: when "email_verified" is enough to prove the caller owns the address', () => {
  test.each([
    { email: 'sam@gmail.com', hostedDomain: undefined, expected: true, why: 'Gmail' },
    { email: 'sam@googlemail.com', hostedDomain: undefined, expected: true, why: 'Googlemail' },
    { email: '  Sam@GMail.COM ', hostedDomain: undefined, expected: true, why: 'Gmail in any case, with spaces' },
    { email: 'sam@gmail.com', hostedDomain: 'unrelated.test', expected: true, why: 'Gmail whatever hd says' },
    { email: 'pat@acme.test', hostedDomain: 'acme.test', expected: true, why: 'Workspace domain equals the email domain' },
    { email: 'Pat@Acme.TEST', hostedDomain: 'ACME.test', expected: true, why: 'same, compared case-insensitively' },
    { email: 'pat@acme.test', hostedDomain: undefined, expected: false, why: 'some other domain, no Workspace' },
    { email: 'pat@acme.test', hostedDomain: 'other.test', expected: false, why: 'Workspace of a different domain' },
    { email: 'pat@mail.acme.test', hostedDomain: 'acme.test', expected: false, why: 'a subdomain is not the domain' },
    { email: 'pat@acme.test', hostedDomain: 'mail.acme.test', expected: false, why: 'a parent is not the subdomain' },
    { email: 'sam@evilgmail.com', hostedDomain: undefined, expected: false, why: 'looks like Gmail, is not' },
    { email: 'sam@gmail.com.evil.test', hostedDomain: undefined, expected: false, why: 'Gmail as a prefix only' },
    { email: 'sam@sub.gmail.com', hostedDomain: undefined, expected: false, why: 'a Gmail subdomain' },
    { email: 'pat@acme.test', hostedDomain: '', expected: false, why: 'an empty hd' },
    { email: 'not-an-email', hostedDomain: 'not-an-email', expected: false, why: 'no @ at all' },
    { email: 'pat@', hostedDomain: '', expected: false, why: 'nothing after the @' },
  ])('$email with hd $hostedDomain → $expected ($why)', ({ email, hostedDomain, expected }) => {
    expect(isGoogleAuthoritative({ email, hostedDomain })).toBe(expected);
  });
});

describe('branch 2 only when Google is the authority for the address', () => {
  /** Everything about a user an attacker or the owner could still use: the row, sessions and links. */
  async function accountState(userId: string) {
    return {
      user: (await sql('select * from users where id = $1', [userId]))[0],
      sessions: await sql('select id, token_hash from sessions where user_id = $1 order by id', [userId]),
      links: await sql('select id, used_at from user_tokens where user_id = $1 order by id', [userId]),
    };
  }

  test.each(['gmail.com', 'googlemail.com'])('an @%s address links (Google is the authority, no hd needed)', async (domain) => {
    const account = await signedUpUser(`sam.roofer@${domain}`, 'Sam Roofing');
    const res = await googleSignIn(claims({ sub: 'google-sub-sam', email: `Sam.Roofer@${domain.toUpperCase()}` }));
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(account.user.id);
    expect(await sql('select google_sub from users where id = $1', [account.user.id])).toEqual([
      { google_sub: 'google-sub-sam' },
    ]);
  });

  test('a Workspace address whose hd is the email’s own domain links (hd compared case-insensitively)', async () => {
    const account = await signedUpUser('pat@acme-roofing.test', 'Acme Roofing');
    const res = await googleSignIn(
      claims({ sub: 'google-sub-pat', email: 'pat@acme-roofing.test', hostedDomain: 'ACME-Roofing.test' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(account.user.id);
    expect(await sql('select google_sub from users where id = $1', [account.user.id])).toEqual([
      { google_sub: 'google-sub-pat' },
    ]);
  });

  describe.each([
    {
      name: 'an unconfirmed password account (the case the hand-over is for)',
      setup: async () => {
        const account = await signedUpUser('pat@acme-roofing.test', 'Acme Roofing');
        // The attacker is signed in and holds a reset link.
        await request(t.app).post('/api/auth/reset-request').send({ email: 'pat@acme-roofing.test' });
        await t.settle();
        return { userId: account.user.id, email: 'pat@acme-roofing.test', password: 'a long enough password' };
      },
    },
    {
      name: 'a confirmed account with a live session',
      setup: async () => {
        const owner = t.seed.a.owner;
        await loginAs(t.app, owner);
        return { userId: owner.userId, email: owner.email, password: owner.password };
      },
    },
  ])('a verified Google email on a domain Google is not the authority for, against $name', ({ setup }) => {
    test.each([
      { why: 'no hd at all', hostedDomain: undefined },
      { why: 'an hd of some other domain', hostedDomain: 'other-company.test' },
      { why: 'an hd that is only the parent of a subdomain address', hostedDomain: 'parent.test' },
    ])('$why → 409, and nothing about the account changes', async ({ hostedDomain }) => {
      const victim = await setup();
      const email = hostedDomain === 'parent.test' ? `x@mail.parent.test` : victim.email;
      if (email !== victim.email) await sql('update users set email = $2 where id = $1', [victim.userId, email]);
      const before = await accountState(victim.userId);
      expect(before.sessions.length).toBeGreaterThan(0);

      const res = await googleSignIn(claims({ sub: 'google-sub-intruder', email, hostedDomain }));
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: EMAIL_IN_USE }); // and no `field`
      expect(hasSessionCookie(res)).toBe(false);

      expect(await accountState(victim.userId)).toEqual(before);
      expect(before.user.google_sub).toBeNull();
      // The password still works, and a company was not made for the intruder.
      const login = await request(t.app).post('/api/auth/login').send({ email, password: victim.password });
      expect(login.status).toBe(200);
      expect(await sql('select 1 from users where google_sub = $1', ['google-sub-intruder'])).toEqual([]);
    });
  });

  test('an account connected to another Google account is also just "already has an account" for such an address', async () => {
    const account = await signedUpUser('pat@acme-roofing.test', 'Acme Roofing');
    await linkSub(account.user.id, 'google-sub-first');
    const res = await googleSignIn(claims({ sub: 'google-sub-second', email: 'pat@acme-roofing.test' }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: EMAIL_IN_USE });
    expect(await sql('select google_sub from users where id = $1', [account.user.id])).toEqual([
      { google_sub: 'google-sub-first' },
    ]);
  });

  test.each([
    { why: 'no hd', hostedDomain: undefined },
    { why: 'an hd of another domain', hostedDomain: 'other-company.test' },
  ])('a NEW account for such an address is still created on email_verified alone ($why)', async ({ hostedDomain }) => {
    const before = await counts();
    const res = await googleSignIn(
      claims({ sub: 'google-sub-new-person', email: 'new.person@acme-roofing.test', hostedDomain }),
      { companyName: 'New Person Roofing' },
    );
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: 'new.person@acme-roofing.test', emailVerified: true });
    expect(await counts()).toMatchObject({ users: String(Number(before.users) + 1), companies: String(Number(before.companies) + 1) });
  });
});

describe('a password login that is still in flight when the account changes hands', () => {
  const VICTIM = 'victim@x.test';
  const ATTACKER_PASSWORD = 'a long enough password';

  /** Runs `between` right after the next password check succeeds, before the login saves its session. */
  async function afterNextPasswordCheck(between: () => Promise<void>) {
    const real = await vi.importActual<typeof import('../src/auth/password.ts')>('../src/auth/password.ts');
    vi.mocked(passwordModule.verifyPassword).mockImplementationOnce(async (password, hash) => {
      const matches = await real.verifyPassword(password, hash);
      expect(matches).toBe(true);
      await between();
      return matches;
    });
  }

  const sessionsOf = (userId: string) => sql('select id from sessions where user_id = $1', [userId]);

  test('a Google hand-over committed between the password check and the session insert → 401, and no session exists', async () => {
    const attacker = await signedUpUser(VICTIM, 'Mallory Roofing'); // leaves the attacker one session
    expect(await sessionsOf(attacker.user.id)).toHaveLength(1);
    await afterNextPasswordCheck(async () => {
      const handOver = await googleSignIn(claims({ sub: 'victim-sub', email: VICTIM, hostedDomain: 'x.test' }));
      expect(handOver.status).toBe(200);
    });

    const res = await request(t.app).post('/api/auth/login').send({ email: VICTIM, password: ATTACKER_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: BAD_LOGIN });
    expect(hasSessionCookie(res)).toBe(false);
    // The attacker's own session went with the hand-over; the only session left is the Google caller's.
    expect(await sessionsOf(attacker.user.id)).toHaveLength(1);
    expect(await sql('select password_hash is null as no_password from users where id = $1', [attacker.user.id])).toEqual([
      { no_password: true },
    ]);
  });

  test('a password reset committed in that window → 401, and no session exists', async () => {
    const owner = t.seed.a.owner;
    expect((await request(t.app).post('/api/auth/reset-request').send({ email: owner.email })).status).toBe(200);
    await t.settle();
    const token = tokenFrom(t.mailer.sent.find((m) => /Reset/.test(m.subject))!, 'reset');
    await afterNextPasswordCheck(async () => {
      const reset = await request(t.app).post('/api/auth/reset').send({ token, password: 'a brand new password' });
      expect(reset.status).toBe(200);
    });

    const res = await request(t.app).post('/api/auth/login').send({ email: owner.email, password: owner.password });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: BAD_LOGIN });
    expect(hasSessionCookie(res)).toBe(false);
    expect(await sessionsOf(owner.userId)).toEqual([]);
    // The new password is the one that works.
    const again = await request(t.app).post('/api/auth/login').send({ email: owner.email, password: 'a brand new password' });
    expect(again.status).toBe(200);
  });

  test('a refused login leaves the session the browser already had', async () => {
    const browser = await loginAs(t.app, t.seed.b.owner);
    await signedUpUser(VICTIM, 'Mallory Roofing');
    await afterNextPasswordCheck(async () => {
      await googleSignIn(claims({ sub: 'victim-sub', email: VICTIM, hostedDomain: 'x.test' }));
    });
    const res = await browser.post('/api/auth/login').send({ email: VICTIM, password: ATTACKER_PASSWORD });
    expect(res.status).toBe(401);
    const me = await browser.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(t.seed.b.owner.userId);
  });

  test('a normal login is unaffected: 200, the cookie, one new session, and it works', async () => {
    const owner = t.seed.a.owner;
    const agent = request.agent(t.app);
    const res = await agent.post('/api/auth/login').send({ email: owner.email, password: owner.password });
    expect(res.status).toBe(200);
    expect(hasSessionCookie(res)).toBe(true);
    expect(res.body.user.id).toBe(owner.userId);
    expect(await sessionsOf(owner.userId)).toHaveLength(1);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
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
    const res = await googleSignIn(claims({ sub: 'google-sub-rep', email: rep.email, hostedDomain: 'a.test' }));
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

  test('Google unreachable → 503 with its own sentence, the cause is logged, no cookie, nothing created', async () => {
    const cause = new errors.JWKSTimeout();
    const keys = await newKeys();
    const logError = vi.fn();
    const app = createApp(
      {
        ...t.deps,
        google: new JoseGoogleVerifier(CLIENT_ID, {
          keys: async () => {
            throw cause;
          },
        }),
      },
      { logError },
    );
    const before = await counts();

    const credential = await signToken(keys.privateKey);
    const down = await request(app).post('/api/auth/google').send({ credential, companyName: 'Summit Roofing' });
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ error: UNAVAILABLE });
    expect(hasSessionCookie(down)).toBe(false);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(cause, '/google');
    expect(JSON.stringify(down.body)).not.toContain(credential);
    expect(await counts()).toEqual(before);

    // A bad credential is not an outage: it is not logged as one.
    logError.mockClear();
    const garbage = await request(app).post('/api/auth/google').send({ credential: 'not-a-token' });
    expect(garbage.status).toBe(401);
    expect(garbage.body).toEqual({ error: FAILED });
    expect(logError).not.toHaveBeenCalled();
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
