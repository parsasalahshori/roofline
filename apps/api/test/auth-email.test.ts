import { createHash } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { SEED_PASSWORD } from '@roofline/db/testing';
import { createApp } from '../src/app.ts';
import { attachSession, requireVerifiedEmail } from '../src/auth/middleware.ts';
import { DEV_SESSION_COOKIE } from '../src/auth/sessions.ts';
import { consumeToken, issueToken } from '../src/auth/tokens.ts';
import { errorHandler } from '../src/errors.ts';
import type { Mailer } from '../src/mailer.ts';
import { loginAs, makeTestApp, SIGNUP_COMPANY, type SentMail, type SuperAgent, type TestApp } from './helpers.ts';

/*
 * Two seams for the "work after the response" tests, both wrapping the real thing:
 * - `lookupGate`: while set, the reset-request lookup (findUserByEmail) waits for it.
 * - `failIssue`: while set, issueToken throws it.
 * They are plain state read at call time, so a test that sets one must clear it (beforeEach does).
 */
const hooks = vi.hoisted(() => ({
  lookupGate: null as Promise<void> | null,
  failIssue: null as Error | null,
}));

vi.mock('@roofline/db/system', async (importOriginal) => {
  const actual = await importOriginal<{ findUserByEmail: (...args: unknown[]) => Promise<unknown> }>();
  return {
    ...actual,
    findUserByEmail: async (...args: unknown[]) => {
      if (hooks.lookupGate) await hooks.lookupGate;
      return actual.findUserByEmail(...args);
    },
  };
});

vi.mock('../src/auth/tokens.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth/tokens.ts')>();
  return {
    ...actual,
    issueToken: async (...args: Parameters<typeof actual.issueToken>) => {
      if (hooks.failIssue) throw hooks.failIssue;
      return actual.issueToken(...args);
    },
  };
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PASSWORD = 'a long enough password';
const NEW_PASSWORD = 'a brand new password';
const APP_ORIGIN = 'https://app.roofline.test';

const LINK_USED = 'That link has already been used or has expired.';
const LINK_INCOMPLETE = 'That link is incomplete. Please open it again from your email.';
const VERIFY_FIRST = 'Please confirm your email first. We sent you a link.';
const SIGN_IN = 'Please sign in.';
const BAD_LOGIN = "That email and password don't match.";
const PASSWORD_MESSAGE = 'Use at least 10 characters for your password.';
const EMAIL_MESSAGE = 'Please enter a valid email address.';
const TOO_MANY_EMAILS = "We've already sent you a few emails. Please check your inbox, or try again in an hour.";

let t: TestApp;

beforeEach(async () => {
  hooks.lookupGate = null;
  hooks.failIssue = null;
  t = await makeTestApp();
});

/** A read-only look at the database through the system pool's raw client. */
async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await t.deps.pools.system.$client.query(text, params);
  return result.rows as T[];
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function signupBody(overrides: Record<string, unknown> = {}) {
  return {
    email: 'owner@example.com',
    password: PASSWORD,
    name: 'Olive Owner',
    companyName: 'Summit Roofing',
    ...SIGNUP_COMPANY,
    ...overrides,
  };
}

/** Signs a new owner up on a fresh agent (so it carries the session cookie), and returns the cookie too. */
async function signUp(
  overrides: Record<string, unknown> = {},
): Promise<{ agent: SuperAgent; userId: string; cookie: string }> {
  const agent = request.agent(t.app);
  const res = await agent.post('/api/auth/signup').send(signupBody(overrides));
  expect(res.status).toBe(201);
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  return { agent, userId: res.body.user.id as string, cookie };
}

/** The 43-character token in the link of an email. */
function tokenFrom(mail: SentMail, page: 'verify' | 'reset'): string {
  const match = mail.text.match(new RegExp(`${APP_ORIGIN.replaceAll('.', '\\.')}/${page}\\?token=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])`));
  if (!match) throw new Error(`No ${page} link in: ${mail.text}`);
  return match[1]!;
}

const verify = (token: unknown) => request(t.app).post('/api/auth/verify-email').send({ token });
/** Asks for a reset link, then waits for the work the route does after answering (the lookup, the token, the email). */
async function requestReset(email: unknown) {
  const res = await request(t.app).post('/api/auth/reset-request').send({ email });
  await t.settle();
  return res;
}
const reset = (token: unknown, password: unknown = NEW_PASSWORD) =>
  request(t.app).post('/api/auth/reset').send({ token, password });
const login = (email: string, password: string) => request(t.app).post('/api/auth/login').send({ email, password });

/** Asks for a reset link for a seeded user and returns its token. */
async function resetTokenFor(email: string): Promise<string> {
  const before = t.mailer.sent.length;
  expect((await requestReset(email)).status).toBe(200);
  expect(t.mailer.sent).toHaveLength(before + 1);
  return tokenFrom(t.mailer.sent[before]!, 'reset');
}

describe('email verification', () => {
  test('sign-up sends exactly one email to the new address, and its link token verifies', async () => {
    const { agent } = await signUp({ email: '  New.Owner@Example.COM ' });
    expect(t.mailer.sent).toHaveLength(1);
    const mail = t.mailer.sent[0]!;
    expect(mail.to).toBe('new.owner@example.com');
    expect(mail.subject).toBe('Confirm your email for Roofline');
    const token = tokenFrom(mail, 'verify');
    expect(mail.text).toContain(`${APP_ORIGIN}/verify?token=${token}`);

    expect((await agent.get('/api/auth/me')).body.user.emailVerified).toBe(false);
    const res = await verify(token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect((await agent.get('/api/auth/me')).body.user.emailVerified).toBe(true);

    const [row] = await sql<{ email_verified_at: Date }>(
      "select email_verified_at from users where email = 'new.owner@example.com'",
    );
    expect(row!.email_verified_at.getTime()).toBe(t.clock.now().getTime());
  });

  test('using the token a second time → 400 "That link has already been used or has expired."', async () => {
    await signUp();
    const token = tokenFrom(t.mailer.sent[0]!, 'verify');
    expect((await verify(token)).status).toBe(200);
    const again = await verify(token);
    expect(again.status).toBe(400);
    expect(again.body).toEqual({ error: LINK_USED });
  });

  test('the database keeps only the sha256 of the token, valid for 7 days', async () => {
    const { userId } = await signUp();
    const token = tokenFrom(t.mailer.sent[0]!, 'verify');
    const rows = await sql<{ token_hash: string; kind: string; expires_at: Date; used_at: Date | null }>(
      'select token_hash, kind, expires_at, used_at from user_tokens where user_id = $1',
      [userId],
    );
    expect(rows).toEqual([
      {
        token_hash: sha256(token),
        kind: 'verify_email',
        expires_at: new Date(t.clock.now().getTime() + 7 * DAY),
        used_at: null,
      },
    ]);
    expect(JSON.stringify(await sql('select * from user_tokens'))).not.toContain(token);
  });

  test('the link works until 7 days after sign-up, and not a moment longer', async () => {
    await signUp();
    await signUp({ email: 'second@example.com', companyName: 'Second Roofing' });
    const [first, second] = t.mailer.sent.map((m) => tokenFrom(m, 'verify')) as [string, string];
    t.clock.advance(7 * DAY - 1000);
    expect((await verify(first)).status).toBe(200);
    t.clock.advance(1000);
    const late = await verify(second);
    expect(late.status).toBe(400);
    expect(late.body).toEqual({ error: LINK_USED });
  });

  test('verifying needs no session, and only verifies the user the token belongs to', async () => {
    const { userId } = await signUp();
    const other = await loginAs(t.app, t.seed.a.office);
    await sql('update users set email_verified_at = null where id = $1', [t.seed.a.office.userId]);
    const token = tokenFrom(t.mailer.sent[0]!, 'verify');
    // Signed in as someone else, the link still verifies its own owner.
    expect((await other.post('/api/auth/verify-email').send({ token })).status).toBe(200);
    const rows = await sql<{ id: string; verified: boolean }>(
      'select id, email_verified_at is not null as verified from users where id = any($1)',
      [[userId, t.seed.a.office.userId]],
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.verified]))).toEqual({
      [userId]: true,
      [t.seed.a.office.userId]: false,
    });
  });

  test.each([
    ['an unknown token', 'x'.repeat(43)],
    ['a malformed token', 'not a token!'],
    ['an empty token', ''],
    ['a huge token', 'a'.repeat(5000)],
  ])('%s → 400 with the same sentence', async (_name, token) => {
    const res = await verify(token);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(token === '' ? LINK_INCOMPLETE : LINK_USED);
  });

  test.each([
    ['no token', {}],
    ['a number', { token: 12345 }],
    ['null', { token: null }],
  ])('%s → 400 "link is incomplete" with the field', async (_name, body) => {
    const res = await request(t.app).post('/api/auth/verify-email').send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: LINK_INCOMPLETE, field: 'token' });
  });

  test('a password-reset token cannot verify an email, and a verification token cannot reset a password', async () => {
    await signUp();
    const verifyToken = tokenFrom(t.mailer.sent[0]!, 'verify');
    const resetToken = await resetTokenFor('owner@example.com');
    expect((await verify(resetToken)).status).toBe(400);
    expect((await reset(verifyToken)).status).toBe(400);
    // Neither attempt used the real token up.
    expect((await verify(verifyToken)).status).toBe(200);
    expect((await reset(resetToken)).status).toBe(200);
  });

  test('a refused sign-up sends no verification email; a duplicate only warns the account owner (Ruling SEC-1)', async () => {
    await signUp();
    expect(t.mailer.sent).toHaveLength(1);
    const dup = await request(t.app).post('/api/auth/signup').send(signupBody({ email: ' Owner@Example.com ' }));
    expect(dup.status).toBe(409);
    await t.settle();
    expect(t.mailer.sent).toHaveLength(2);
    const notice = t.mailer.sent[1]!;
    expect(notice).toMatchObject({ to: 'owner@example.com', subject: 'Someone tried to sign up with your email' });
    expect(notice.text).toContain(`${APP_ORIGIN}/sign-in`);
    expect(notice.text).toContain(`${APP_ORIGIN}/reset`);
    expect(notice.text).not.toMatch(/token=/);

    const bad = await request(t.app).post('/api/auth/signup').send(signupBody({ email: 'nope' }));
    expect(bad.status).toBe(400);
    await t.settle();
    expect(t.mailer.sent).toHaveLength(2);
  });

  test('the owner is warned at most once an hour per address', async () => {
    await signUp();
    await signUp({ email: 'second@example.com', companyName: 'Second Roofing' });
    expect((await request(t.app).post('/api/auth/signup').send(signupBody())).status).toBe(409);
    expect((await request(t.app).post('/api/auth/signup').send(signupBody())).status).toBe(409);
    expect((await request(t.app).post('/api/auth/signup').send(signupBody({ email: 'second@example.com' }))).status).toBe(409);
    await t.settle();
    const notices = t.mailer.sent.filter((m) => m.subject === 'Someone tried to sign up with your email');
    expect(notices.map((m) => m.to)).toEqual(['owner@example.com', 'second@example.com']);
  });

  test('a failing mailer for the warning is logged, and the answer is still the plain 409', async () => {
    await signUp();
    const logError = vi.fn();
    const broken: Mailer = { send: () => Promise.reject(new Error('postmark down')) };
    const app = createApp({ ...t.deps, mailer: broken }, { logError });
    const dup = await request(app).post('/api/auth/signup').send(signupBody());
    expect(dup.status).toBe(409);
    await t.settle();
    expect(logError).toHaveBeenCalledTimes(1);
    expect((logError.mock.calls[0]![0] as Error).message).toBe('postmark down');
  });

  test('if the email cannot be sent, sign-up still succeeds, the failure is logged, and resending recovers', async () => {
    const logError = vi.fn();
    const broken: Mailer = { send: () => Promise.reject(new Error('postmark down')) };
    const app = createApp({ ...t.deps, mailer: broken }, { logError });
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/signup').send(signupBody());
    expect(res.status).toBe(201);
    await t.settle();
    expect(logError).toHaveBeenCalledTimes(1);
    expect((logError.mock.calls[0]![0] as Error).message).toBe('postmark down');
    expect(res.body.user.emailVerified).toBe(false);

    // The same session asks for a fresh link on the working mailer.
    const cookie = res.headers['set-cookie'];
    const fresh = await request(t.app).post('/api/auth/resend-verification').set('Cookie', cookie!);
    expect(fresh.status).toBe(200);
    expect(t.mailer.sent).toHaveLength(1);
    expect((await verify(tokenFrom(t.mailer.sent[0]!, 'verify'))).status).toBe(200);
  });
});

describe('sign-up when the verification link cannot be made', () => {
  test('the account is still created and signed in, the failure is logged, and resending recovers', async () => {
    const logError = vi.fn();
    const app = createApp(t.deps, { logError });
    hooks.failIssue = new Error('database went away');
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/signup').send(signupBody());
    expect(res.status).toBe(201);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(t.mailer.sent).toHaveLength(0);
    expect((await agent.get('/api/auth/me')).status).toBe(200);

    hooks.failIssue = null;
    expect((await agent.post('/api/auth/resend-verification')).status).toBe(200);
    await t.settle();
    expect(t.mailer.sent).toHaveLength(1);
    expect((await verify(tokenFrom(t.mailer.sent[0]!, 'verify'))).status).toBe(200);
  });
});

describe('resend verification', () => {
  test('an unverified user gets a fresh link; the earlier link keeps working', async () => {
    const { agent } = await signUp();
    const res = await agent.post('/api/auth/resend-verification');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(t.mailer.sent).toHaveLength(2);
    const [first, second] = t.mailer.sent;
    expect(second!.to).toBe('owner@example.com');
    expect(second!.subject).toBe('Confirm your email for Roofline');
    const [oldToken, newToken] = [tokenFrom(first!, 'verify'), tokenFrom(second!, 'verify')];
    expect(newToken).not.toBe(oldToken);

    t.clock.advance(6 * DAY);
    expect((await verify(newToken)).status).toBe(200);
    expect((await verify(oldToken)).status).toBe(200);
  });

  test('the fresh link is valid 7 days from the resend, not from sign-up', async () => {
    const { agent, userId } = await signUp();
    t.clock.advance(3 * DAY);
    await agent.post('/api/auth/resend-verification');
    const rows = await sql<{ expires_at: Date }>(
      'select expires_at from user_tokens where user_id = $1 order by expires_at desc limit 1',
      [userId],
    );
    expect(rows[0]!.expires_at.getTime()).toBe(t.clock.now().getTime() + 7 * DAY);
  });

  test('an already verified user gets 200 and no email', async () => {
    const agent = await loginAs(t.app, t.seed.a.owner);
    const res = await agent.post('/api/auth/resend-verification');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(t.mailer.sent).toHaveLength(0);
    expect(await sql('select 1 from user_tokens')).toHaveLength(0);
  });

  test('it needs a session', async () => {
    const res = await request(t.app).post('/api/auth/resend-verification');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: SIGN_IN });
  });

  test('3 per hour per user across all of their sessions; the 4th → 429; other users are not affected', async () => {
    const { agent } = await signUp();
    const second = request.agent(t.app);
    expect((await second.post('/api/auth/login').send({ email: 'owner@example.com', password: PASSWORD })).status).toBe(
      200,
    );
    expect((await agent.post('/api/auth/resend-verification')).status).toBe(200);
    expect((await second.post('/api/auth/resend-verification')).status).toBe(200);
    expect((await agent.post('/api/auth/resend-verification')).status).toBe(200);
    const blocked = await second.post('/api/auth/resend-verification');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: TOO_MANY_EMAILS });
    expect(t.mailer.sent).toHaveLength(4); // sign-up plus three resends

    // Someone else, signed in, still has a budget. (An unverified one, so a mail really goes out.)
    await sql('update users set email_verified_at = null where id = $1', [t.seed.a.rep.userId]);
    const rep = await loginAs(t.app, t.seed.a.rep);
    expect((await rep.post('/api/auth/resend-verification')).status).toBe(200);
    expect(t.mailer.sent).toHaveLength(5);
  });
});

describe('reset request', () => {
  test('an unknown email → 200 {ok: true}, no email, and nothing stored', async () => {
    const res = await requestReset('nobody@example.com');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(t.mailer.sent).toHaveLength(0);
    expect(await sql('select 1 from user_tokens')).toHaveLength(0);
  });

  test('a known email → the very same response, and one email with a link valid for 1 hour', async () => {
    const unknown = await requestReset('nobody@example.com');
    const known = await requestReset(t.seed.a.owner.email);
    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
    expect(Object.keys(known.headers).sort()).toEqual(Object.keys(unknown.headers).sort());

    expect(t.mailer.sent).toHaveLength(1);
    const mail = t.mailer.sent[0]!;
    expect(mail.to).toBe(t.seed.a.owner.email);
    expect(mail.subject).toBe('Reset your Roofline password');
    const token = tokenFrom(mail, 'reset');
    expect(mail.text).toContain(`${APP_ORIGIN}/reset?token=${token}`);

    const rows = await sql<{ token_hash: string; kind: string; expires_at: Date }>(
      'select token_hash, kind, expires_at from user_tokens where user_id = $1',
      [t.seed.a.owner.userId],
    );
    expect(rows).toEqual([
      { token_hash: sha256(token), kind: 'reset_password', expires_at: new Date(t.clock.now().getTime() + HOUR) },
    ]);
  });

  test('the email is matched case-insensitively and trimmed', async () => {
    expect((await requestReset(`  ${t.seed.a.owner.email.toUpperCase()} `)).status).toBe(200);
    expect(t.mailer.sent).toHaveLength(1);
    expect(t.mailer.sent[0]!.to).toBe(t.seed.a.owner.email);
  });

  test('an unverified account can reset too', async () => {
    await signUp();
    expect(t.mailer.sent).toHaveLength(1);
    await resetTokenFor('owner@example.com');
    expect(t.mailer.sent).toHaveLength(2);
  });

  test('a newer reset link replaces the older one', async () => {
    const first = await resetTokenFor(t.seed.a.owner.email);
    const second = await resetTokenFor(t.seed.a.owner.email);
    expect(second).not.toBe(first);
    const stale = await reset(first);
    expect(stale.status).toBe(400);
    expect(stale.body).toEqual({ error: LINK_USED });
    expect((await reset(second)).status).toBe(200);
  });

  test("a newer reset link leaves other users' links and verification links alone", async () => {
    await signUp({ email: 'newbie@example.com', companyName: 'Newbie Roofing' });
    const verifyToken = tokenFrom(t.mailer.sent[0]!, 'verify');
    const otherUser = await resetTokenFor(t.seed.a.office.email);
    await resetTokenFor(t.seed.a.owner.email);
    await resetTokenFor(t.seed.a.owner.email);
    expect((await reset(otherUser)).status).toBe(200);
    expect((await verify(verifyToken)).status).toBe(200);
  });

  test('the 6th request for one email in an hour is answered the same but sends no email', async () => {
    for (let i = 1; i <= 5; i++) {
      expect((await requestReset(t.seed.a.owner.email)).status, `request ${i}`).toBe(200);
    }
    expect(t.mailer.sent).toHaveLength(5);
    const sixth = await requestReset(t.seed.a.owner.email);
    expect(sixth.status).toBe(200);
    expect(sixth.body).toEqual({ ok: true });
    expect(t.mailer.sent).toHaveLength(5);
    // Nothing in the answer says it was throttled.
    expect(sixth.headers['retry-after']).toBeUndefined();
  });

  test('spelling variants share the email budget; other emails have their own', async () => {
    for (let i = 0; i < 3; i++) await requestReset(t.seed.a.owner.email);
    for (let i = 0; i < 2; i++) await requestReset(` ${t.seed.a.owner.email.toUpperCase()} `);
    expect(t.mailer.sent).toHaveLength(5);
    await requestReset(t.seed.a.owner.email);
    expect(t.mailer.sent).toHaveLength(5);
    await requestReset(t.seed.a.office.email);
    expect(t.mailer.sent).toHaveLength(6);
  });

  test('20 requests an hour per IP address; after that nothing is sent, whatever the email', async () => {
    for (let i = 1; i <= 20; i++) {
      expect((await requestReset(`nobody${i}@example.com`)).status, `request ${i}`).toBe(200);
    }
    const res = await requestReset(t.seed.a.owner.email);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(t.mailer.sent).toHaveLength(0);
  });

  test('the 20-an-hour budget is per IP address: another address is not held back', async () => {
    const proxied = await makeTestApp({ TRUST_PROXY: 1 });
    const from = async (ip: string, email: string) => {
      const res = await request(proxied.app).post('/api/auth/reset-request').set('X-Forwarded-For', ip).send({ email });
      await proxied.settle();
      return res;
    };
    for (let i = 1; i <= 20; i++) await from('203.0.113.7', `nobody${i}@example.com`);
    await from('203.0.113.7', proxied.seed.a.owner.email);
    expect(proxied.mailer.sent).toHaveLength(0);
    await from('203.0.113.8', proxied.seed.a.owner.email);
    expect(proxied.mailer.sent).toHaveLength(1);
  });

  test.each([
    ['not an email', 'not-an-email'],
    ['a missing email', undefined],
    ['a number', 42],
    ['255 characters', `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(58)}.com`],
  ])('%s → 400 with the field', async (_name, email) => {
    const res = await requestReset(email);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: EMAIL_MESSAGE, field: 'email' });
    expect(t.mailer.sent).toHaveLength(0);
  });

  test('a mailer failure is logged, never shown: still 200', async () => {
    const logError = vi.fn();
    const broken: Mailer = { send: () => Promise.reject(new Error('postmark down')) };
    const app = createApp({ ...t.deps, mailer: broken }, { logError });
    const res = await request(app).post('/api/auth/reset-request').send({ email: t.seed.a.owner.email });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    await t.settle();
    expect(logError).toHaveBeenCalledTimes(1);
    expect((logError.mock.calls[0]![0] as Error).message).toBe('postmark down');
  });

  test('if making the link fails for a real account, the answer is still 200 {ok: true} and the failure is logged', async () => {
    const logError = vi.fn();
    const app = createApp(t.deps, { logError });
    hooks.failIssue = new Error('database went away');

    const known = await request(app).post('/api/auth/reset-request').send({ email: t.seed.a.owner.email });
    const unknown = await request(app).post('/api/auth/reset-request').send({ email: 'nobody@example.com' });
    await t.settle();

    // Same answer as for an address with no account: a failure here must not tell them apart.
    expect(known.status).toBe(200);
    expect(known.body).toEqual({ ok: true });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    expect(logError).toHaveBeenCalledTimes(1);
    expect((logError.mock.calls[0]![0] as Error).message).toBe('database went away');
    expect(logError.mock.calls[0]![1]).toBe('/reset-request');
    expect(t.mailer.sent).toHaveLength(0);
  });

  test('a logger that itself throws does not crash anything', async () => {
    const logError = vi.fn(() => {
      throw new Error('logger is broken');
    });
    const app = createApp(t.deps, { logError });
    hooks.failIssue = new Error('database went away');
    const res = await request(app).post('/api/auth/reset-request').send({ email: t.seed.a.owner.email });
    expect(res.status).toBe(200);
    await t.settle(); // settles instead of rejecting
    expect(logError).toHaveBeenCalledTimes(1);
  });

  test('the answer is sent before the lookup runs: it does not wait for the database work behind it', async () => {
    let release!: () => void;
    hooks.lookupGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      // If the route waited for the lookup, this request would hang until the test times out.
      const res = await request(t.app).post('/api/auth/reset-request').send({ email: t.seed.a.owner.email });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(t.mailer.sent).toHaveLength(0); // the work has not even looked the address up yet
      expect(await sql('select 1 from user_tokens')).toHaveLength(0);
    } finally {
      release();
    }
    await t.settle();
    expect(t.mailer.sent).toHaveLength(1);
    expect(await sql('select 1 from user_tokens')).toHaveLength(1);
  });

  test('a malformed email is still refused before anything else: 400, and no background work', async () => {
    hooks.lookupGate = new Promise<void>(() => undefined); // never released: any lookup would hang settle()
    const res = await request(t.app).post('/api/auth/reset-request').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: EMAIL_MESSAGE, field: 'email' });
    await t.settle();
  });
});

describe('reset', () => {
  test('a valid token sets the new password: the old one fails, the new one works, other sessions end', async () => {
    const phone = await loginAs(t.app, t.seed.a.owner);
    const laptop = await loginAs(t.app, t.seed.a.owner);
    const bystander = await loginAs(t.app, t.seed.a.office);

    const token = await resetTokenFor(t.seed.a.owner.email);
    const res = await reset(token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // Resetting does not sign anyone in.
    expect(res.headers['set-cookie']).toBeUndefined();

    const old = await login(t.seed.a.owner.email, SEED_PASSWORD);
    expect(old.status).toBe(401);
    expect(old.body).toEqual({ error: BAD_LOGIN });
    expect((await login(t.seed.a.owner.email, NEW_PASSWORD)).status).toBe(200);

    for (const agent of [phone, laptop]) {
      const me = await agent.get('/api/auth/me');
      expect(me.status).toBe(401);
      expect(me.body).toEqual({ error: SIGN_IN });
    }
    // Someone else's session is not touched.
    expect((await bystander.get('/api/auth/me')).status).toBe(200);
  });

  test('every session of the user is deleted, and the stored password is a fresh scrypt hash', async () => {
    await loginAs(t.app, t.seed.a.owner);
    await loginAs(t.app, t.seed.a.owner);
    const token = await resetTokenFor(t.seed.a.owner.email);
    await reset(token);
    expect(await sql('select 1 from sessions where user_id = $1', [t.seed.a.owner.userId])).toEqual([]);
    const [row] = await sql<{ password_hash: string }>('select password_hash from users where id = $1', [
      t.seed.a.owner.userId,
    ]);
    expect(row!.password_hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(row!.password_hash).not.toContain(NEW_PASSWORD);
  });

  test('a caller who is signed in as that user is signed out, and their cookie is cleared', async () => {
    const agent = await loginAs(t.app, t.seed.a.owner);
    const token = await resetTokenFor(t.seed.a.owner.email);
    const res = await agent.post('/api/auth/reset').send({ token, password: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(String(res.headers['set-cookie'])).toContain(`${DEV_SESSION_COOKIE}=;`);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  test("a caller signed in as someone else keeps their own session", async () => {
    const agent = await loginAs(t.app, t.seed.a.office);
    const token = await resetTokenFor(t.seed.a.owner.email);
    const res = await agent.post('/api/auth/reset').send({ token, password: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((await agent.get('/api/auth/me')).status).toBe(200);
  });

  test('a reset token older than 1 hour is rejected, and the password stays', async () => {
    const token = await resetTokenFor(t.seed.a.owner.email);
    t.clock.advance(HOUR);
    const res = await reset(token);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: LINK_USED });
    expect((await login(t.seed.a.owner.email, SEED_PASSWORD)).status).toBe(200);
  });

  test('a token is good until the last moment of its hour', async () => {
    const token = await resetTokenFor(t.seed.a.owner.email);
    t.clock.advance(HOUR - 1000);
    expect((await reset(token)).status).toBe(200);
  });

  test('a token is single use', async () => {
    const token = await resetTokenFor(t.seed.a.owner.email);
    expect((await reset(token)).status).toBe(200);
    const again = await reset(token, 'yet another password');
    expect(again.status).toBe(400);
    expect(again.body).toEqual({ error: LINK_USED });
    expect((await login(t.seed.a.owner.email, NEW_PASSWORD)).status).toBe(200);
  });

  test('two requests with one token at once: exactly one succeeds', async () => {
    const token = await resetTokenFor(t.seed.a.owner.email);
    const results = await Promise.all([reset(token, 'password number one'), reset(token, 'password number two')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const winner = results.find((r) => r.status === 200) === results[0] ? 'password number one' : 'password number two';
    expect((await login(t.seed.a.owner.email, winner)).status).toBe(200);
  });

  test('a short password → 400 with the password sentence, and the token is not used up', async () => {
    const token = await resetTokenFor(t.seed.a.owner.email);
    const short = await reset(token, 'too short');
    expect(short.status).toBe(400);
    expect(short.body).toEqual({ error: PASSWORD_MESSAGE, field: 'password' });
    const missing = await request(t.app).post('/api/auth/reset').send({ token });
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ error: PASSWORD_MESSAGE, field: 'password' });
    expect((await login(t.seed.a.owner.email, SEED_PASSWORD)).status).toBe(200);
    expect((await reset(token)).status).toBe(200);
  });

  test.each([
    ['an unknown token', 'x'.repeat(43)],
    ['a malformed token', 'nope'],
  ])('%s → 400, and no password is changed', async (_name, token) => {
    const res = await reset(token);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: LINK_USED });
    expect((await login(t.seed.a.owner.email, SEED_PASSWORD)).status).toBe(200);
  });

  test('a missing token → 400 "link is incomplete"', async () => {
    const res = await request(t.app).post('/api/auth/reset').send({ password: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: LINK_INCOMPLETE, field: 'token' });
  });

  test('a reset link proves inbox control: it verifies an unverified email, and leaves a verified one as it was', async () => {
    await signUp();
    const token = await resetTokenFor('owner@example.com');
    expect((await reset(token)).status).toBe(200);
    const signedIn = request.agent(t.app);
    expect((await signedIn.post('/api/auth/login').send({ email: 'owner@example.com', password: NEW_PASSWORD })).status).toBe(
      200,
    );
    expect((await signedIn.get('/api/auth/me')).body.user.emailVerified).toBe(true);

    const [before] = await sql<{ email_verified_at: Date }>('select email_verified_at from users where id = $1', [
      t.seed.a.rep.userId,
    ]);
    t.clock.advance(DAY);
    await reset(await resetTokenFor(t.seed.a.rep.email));
    const [after] = await sql<{ email_verified_at: Date }>('select email_verified_at from users where id = $1', [
      t.seed.a.rep.userId,
    ]);
    expect(after!.email_verified_at).toEqual(before!.email_verified_at);
  });

  test('an account with no password (Google-only) can set one this way', async () => {
    await sql('update users set password_hash = null where id = $1', [t.seed.a.rep.userId]);
    expect((await login(t.seed.a.rep.email, SEED_PASSWORD)).status).toBe(401);
    expect((await reset(await resetTokenFor(t.seed.a.rep.email))).status).toBe(200);
    expect((await login(t.seed.a.rep.email, NEW_PASSWORD)).status).toBe(200);
  });
});

describe('issueToken and consumeToken', () => {
  const system = () => t.deps.pools.system;

  test('issueToken returns a 43-character base64url token and stores only its sha256', async () => {
    const now = t.clock.now();
    const token = await issueToken(system(), t.seed.a.owner.userId, 'verify_email', 5 * HOUR, now);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await sql<{ token_hash: string; expires_at: Date }>('select token_hash, expires_at from user_tokens');
    expect(rows).toEqual([{ token_hash: sha256(token), expires_at: new Date(now.getTime() + 5 * HOUR) }]);
    expect(await issueToken(system(), t.seed.a.owner.userId, 'verify_email', HOUR, now)).not.toBe(token);
  });

  test('consumeToken returns the user once, then null; used_at is the clock time', async () => {
    const now = t.clock.now();
    const token = await issueToken(system(), t.seed.a.owner.userId, 'reset_password', HOUR, now);
    const later = new Date(now.getTime() + 1000);
    expect(await consumeToken(system(), token, 'reset_password', later)).toBe(t.seed.a.owner.userId);
    expect(await consumeToken(system(), token, 'reset_password', later)).toBeNull();
    const [row] = await sql<{ used_at: Date }>('select used_at from user_tokens');
    expect(row!.used_at).toEqual(later);
  });

  test('the wrong kind does not consume it', async () => {
    const now = t.clock.now();
    const token = await issueToken(system(), t.seed.a.owner.userId, 'verify_email', HOUR, now);
    expect(await consumeToken(system(), token, 'reset_password', now)).toBeNull();
    expect(await consumeToken(system(), token, 'verify_email', now)).toBe(t.seed.a.owner.userId);
  });

  test('expiry is exclusive: good one millisecond before expires_at, dead at expires_at', async () => {
    const now = t.clock.now();
    const a = await issueToken(system(), t.seed.a.owner.userId, 'verify_email', HOUR, now);
    const b = await issueToken(system(), t.seed.a.owner.userId, 'verify_email', HOUR, now);
    expect(await consumeToken(system(), a, 'verify_email', new Date(now.getTime() + HOUR - 1))).not.toBeNull();
    expect(await consumeToken(system(), b, 'verify_email', new Date(now.getTime() + HOUR))).toBeNull();
  });

  test.each([['empty', ''], ['short', 'abc'], ['wrong characters', `${'a'.repeat(42)}!`], ['unknown', 'z'.repeat(43)]])(
    'a %s token → null',
    async (_name, token) => {
      expect(await consumeToken(system(), token, 'verify_email', t.clock.now())).toBeNull();
    },
  );

  test('ten at once: exactly one wins', async () => {
    const now = t.clock.now();
    const token = await issueToken(system(), t.seed.a.owner.userId, 'reset_password', HOUR, now);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => consumeToken(system(), token, 'reset_password', now)),
    );
    expect(results.filter((r) => r !== null)).toEqual([t.seed.a.owner.userId]);
  });

  test('a new reset token retires the earlier ones of that user only', async () => {
    const now = t.clock.now();
    const ownerOld = await issueToken(system(), t.seed.a.owner.userId, 'reset_password', HOUR, now);
    const ownerVerify = await issueToken(system(), t.seed.a.owner.userId, 'verify_email', HOUR, now);
    const officeOld = await issueToken(system(), t.seed.a.office.userId, 'reset_password', HOUR, now);
    const ownerNew = await issueToken(system(), t.seed.a.owner.userId, 'reset_password', HOUR, now);
    expect(await consumeToken(system(), ownerOld, 'reset_password', now)).toBeNull();
    expect(await consumeToken(system(), ownerNew, 'reset_password', now)).toBe(t.seed.a.owner.userId);
    expect(await consumeToken(system(), ownerVerify, 'verify_email', now)).toBe(t.seed.a.owner.userId);
    expect(await consumeToken(system(), officeOld, 'reset_password', now)).toBe(t.seed.a.office.userId);
  });

  test('issuing reset tokens at the same moment leaves exactly one live', async () => {
    const now = t.clock.now();
    const tokens = await Promise.all(
      Array.from({ length: 6 }, () => issueToken(system(), t.seed.a.owner.userId, 'reset_password', HOUR, now)),
    );
    const live = await Promise.all(tokens.map((tok) => consumeToken(system(), tok, 'reset_password', now)));
    expect(live.filter((r) => r !== null)).toHaveLength(1);
  });
});

describe('requireVerifiedEmail', () => {
  /** A tiny app: the real session lookup, then the middleware under test, then an OK. */
  function gated() {
    const app = express();
    app.use(attachSession(t.deps));
    app.get('/needs-verified', requireVerifiedEmail, (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler(() => undefined));
    return app;
  }

  test('an unverified user → 403 "Please confirm your email first. We sent you a link."', async () => {
    const { cookie } = await signUp();
    const res = await request(gated()).get('/needs-verified').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: VERIFY_FIRST });
  });

  test('a verified user passes', async () => {
    const login = await request(t.app)
      .post('/api/auth/login')
      .send({ email: t.seed.a.owner.email, password: SEED_PASSWORD });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const res = await request(gated()).get('/needs-verified').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('verifying the email lifts the block on the same session', async () => {
    const { cookie } = await signUp();
    expect((await request(gated()).get('/needs-verified').set('Cookie', cookie)).status).toBe(403);
    expect((await verify(tokenFrom(t.mailer.sent[0]!, 'verify'))).status).toBe(200);
    expect((await request(gated()).get('/needs-verified').set('Cookie', cookie)).status).toBe(200);
  });

  test('no session at all → 401, not a misleading "confirm your email"', async () => {
    const res = await request(gated()).get('/needs-verified');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: SIGN_IN });
  });
});
