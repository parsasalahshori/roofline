import pg from 'pg';
import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { findPgError, isUniqueViolation } from '../src/errors.ts';
import { createPools } from '../src/pools.ts';
import { pickFreeSlug, slugify } from '../src/repos/companies.ts';
import {
  createAccount,
  EmailInUseError,
  findLiveSession,
  findUserByEmail,
  findUserByGoogleSub,
  GoogleSubInUseError,
  consumeUserToken,
  insertSession,
  insertSessionIfPasswordUnchanged,
  insertUserToken,
  linkGoogleAccount,
  removeAccount,
  renewSession,
} from '../src/system/auth.ts';
import { resetDb } from '../src/testing/reset.ts';

const urls = inject('dbUrls');
const pools = createPools({ tenant: urls.tenant, system: urls.system });
const { system } = pools;

afterAll(async () => {
  await pools.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
});

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

function account(n: number, companyName = 'Acme Roofing') {
  return {
    email: `user${n}@example.com`,
    name: `User ${n}`,
    passwordHash: 'scrypt$16384$8$1$AAAA$BBBB',
    companyName,
    trialEndsAt: new Date(Date.now() + 14 * DAY),
  };
}

async function count(table: 'users' | 'companies' | 'memberships'): Promise<number> {
  const { rows } = await system.$client.query(`select count(*)::int as n from ${table}`);
  return (rows[0] as { n: number }).n;
}

describe('slugify and pickFreeSlug', () => {
  test.each([
    ['Acme Roofing', 'acme-roofing'],
    ['  ACME   roofing!! ', 'acme-roofing'],
    ["Joe's Roofing & Sons, LLC", 'joe-s-roofing-sons-llc'],
    ['Café Düsseldorf', 'cafe-dusseldorf'],
    ['屋根', 'company'],
    ['---', 'company'],
    ['', 'company'],
    ['a'.repeat(100), 'a'.repeat(48)],
    ['word '.repeat(20), `${'word-'.repeat(9)}wor`],
  ])('slugify(%j) → %j', (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });

  test('a slug never ends with a hyphen, even when it is cut to length', () => {
    const slug = slugify(`${'a'.repeat(47)} bbbb`);
    expect(slug).toBe('a'.repeat(47));
    expect(slug).not.toMatch(/-$/);
  });

  test('pickFreeSlug: the base when free, then -2, -3, skipping any that are taken', () => {
    expect(pickFreeSlug('acme', [])).toBe('acme');
    expect(pickFreeSlug('acme', ['acme'])).toBe('acme-2');
    expect(pickFreeSlug('acme', ['acme', 'acme-2', 'acme-3'])).toBe('acme-4');
    expect(pickFreeSlug('acme', ['acme', 'acme-3'])).toBe('acme-2');
    expect(pickFreeSlug('acme', ['acme-roofing', 'acme-2x'])).toBe('acme');
  });

  test('pickFreeSlug: reserved subdomain names are never handed out', () => {
    for (const reserved of ['api', 'app', 'www', 'admin']) {
      expect(pickFreeSlug(reserved, [])).toBe(`${reserved}-2`);
    }
  });
});

describe('findPgError / isUniqueViolation', () => {
  const pgErr = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'users_email_unique' });

  test('reads the code off a raw pg error and off a Drizzle-style wrapper', () => {
    expect(findPgError(pgErr)).toEqual({ code: '23505', constraint: 'users_email_unique' });
    expect(findPgError(new Error('Failed query', { cause: pgErr }))).toEqual({
      code: '23505',
      constraint: 'users_email_unique',
    });
    expect(findPgError(Object.assign(new Error('x'), { code: '40001' }))).toEqual({ code: '40001' });
  });

  test.each([
    ['a plain error', new Error('nope')],
    ['a Node system error', Object.assign(new Error('x'), { code: 'ECONNRESET' })],
    ['a string', 'boom'],
    ['null', null],
    ['an error whose cause loops', (() => {
      const loop: { cause?: unknown } = {};
      loop.cause = loop;
      return loop;
    })()],
  ])('finds nothing in %s', (_name, err) => {
    expect(findPgError(err)).toBeUndefined();
  });

  test('isUniqueViolation can be limited to one constraint', () => {
    const wrapped = new Error('Failed query', { cause: pgErr });
    expect(isUniqueViolation(wrapped)).toBe(true);
    expect(isUniqueViolation(wrapped, 'users_email_unique')).toBe(true);
    expect(isUniqueViolation(wrapped, 'companies_slug_unique')).toBe(false);
    expect(isUniqueViolation(new Error('x', { cause: { code: '23503' } }))).toBe(false);
  });
});

describe('createAccount / removeAccount', () => {
  test('creates the user, a trial company and an active owner membership together', async () => {
    const created = await createAccount(system, account(1));
    expect(created.company).toMatchObject({ name: 'Acme Roofing', slug: 'acme-roofing', status: 'trial' });
    expect(created.user).toMatchObject({ email: 'user1@example.com', emailVerifiedAt: null });
    const { rows } = await system.$client.query(
      'select role, status, can_approve_spend, user_id, company_id from memberships where id = $1',
      [created.membershipId],
    );
    expect(rows).toEqual([
      { role: 'owner', status: 'active', can_approve_spend: false, user_id: created.user.id, company_id: created.company.id },
    ]);
  });

  test('a taken email throws EmailInUseError and leaves nothing behind', async () => {
    await createAccount(system, account(1, 'First Co'));
    await expect(createAccount(system, { ...account(2, 'Second Co'), email: 'USER1@example.com' })).rejects.toBeInstanceOf(
      EmailInUseError,
    );
    expect([await count('users'), await count('companies'), await count('memberships')]).toEqual([1, 1, 1]);
  });

  test('companies with the same name get -2, -3 in order', async () => {
    const slugs: string[] = [];
    for (let n = 1; n <= 3; n++) slugs.push((await createAccount(system, account(n))).company.slug);
    expect(slugs).toEqual(['acme-roofing', 'acme-roofing-2', 'acme-roofing-3']);
  });

  test('sign-ups racing for the same name all succeed with distinct slugs', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => createAccount(system, account(i + 1))));
    const slugs = results.map((r) => r.company.slug).sort();
    expect(new Set(slugs).size).toBe(8);
    expect(slugs).toContain('acme-roofing');
    expect(slugs).toContain('acme-roofing-8');
  });

  test('a slug taken by a transaction that commits mid-flight is retried with the next suffix', async () => {
    // Another sign-up has inserted "race-co" but not committed, so our slug lookup cannot see it:
    // our insert then waits on the unique index and fails with 23505 once the other one commits.
    const other = new pg.Client({ connectionString: urls.owner });
    await other.connect();
    try {
      await other.query('begin');
      await other.query("insert into companies (name, slug) values ('Race Co', 'race-co')");

      const pending = createAccount(system, account(1, 'Race Co'));
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rows } = await other.query(
          "select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()",
        );
        if (rows.length > 0) break;
        if (Date.now() > deadline) throw new Error('createAccount never reached the unique-index wait');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await other.query('commit');

      const created = await pending;
      expect(created.company.slug).toBe('race-co-2');
    } finally {
      await other.end();
    }
    expect([await count('users'), await count('companies'), await count('memberships')]).toEqual([1, 2, 1]);
  });

  test('removeAccount deletes exactly what createAccount made', async () => {
    const keep = await createAccount(system, account(1, 'Keeper'));
    const gone = await createAccount(system, account(2, 'Goner'));
    await removeAccount(system, gone);
    expect(await findUserByEmail(system, 'user2@example.com')).toBeNull();
    expect(await findUserByEmail(system, 'user1@example.com')).toMatchObject({ id: keep.user.id });
    expect([await count('users'), await count('companies'), await count('memberships')]).toEqual([1, 1, 1]);
    // And the email and name can be used again.
    await expect(createAccount(system, account(2, 'Goner'))).resolves.toMatchObject({ company: { slug: 'goner' } });
  });
});

describe('Google accounts', () => {
  const NOW = new Date('2026-03-01T12:00:00Z');

  test('createAccount can make a Google user: no password, the Google account set, email already confirmed', async () => {
    const created = await createAccount(system, {
      ...account(1),
      passwordHash: null,
      googleSub: 'google-sub-1',
      emailVerifiedAt: NOW,
    });
    expect(created.user).toMatchObject({
      email: 'user1@example.com',
      passwordHash: null,
      googleSub: 'google-sub-1',
      emailVerifiedAt: NOW,
    });
    expect(await findUserByGoogleSub(system, 'google-sub-1')).toMatchObject({ id: created.user.id });
  });

  test('a password user has no Google account and an unconfirmed email until told otherwise', async () => {
    const created = await createAccount(system, account(1));
    expect(created.user).toMatchObject({ googleSub: null, emailVerifiedAt: null });
  });

  test('a taken Google account throws GoogleSubInUseError and leaves nothing behind', async () => {
    await createAccount(system, { ...account(1, 'First Co'), passwordHash: null, googleSub: 'google-sub-1' });
    await expect(
      createAccount(system, { ...account(2, 'Second Co'), passwordHash: null, googleSub: 'google-sub-1' }),
    ).rejects.toBeInstanceOf(GoogleSubInUseError);
    expect([await count('users'), await count('companies'), await count('memberships')]).toEqual([1, 1, 1]);
  });

  test('findUserByGoogleSub compares the sub exactly, and finds nobody for an unknown one', async () => {
    await createAccount(system, { ...account(1), googleSub: 'Google-Sub-1' });
    expect(await findUserByGoogleSub(system, 'Google-Sub-1')).toMatchObject({ email: 'user1@example.com' });
    expect(await findUserByGoogleSub(system, 'google-sub-1')).toBeNull();
    expect(await findUserByGoogleSub(system, '')).toBeNull();
  });

  test('linkGoogleAccount connects the account and confirms an unconfirmed email at `now`', async () => {
    const { user } = await createAccount(system, account(1));
    const linked = await linkGoogleAccount(system, user.id, 'google-sub-1', NOW);
    expect(linked).toMatchObject({ id: user.id, googleSub: 'google-sub-1', emailVerifiedAt: NOW });
    expect(await findUserByGoogleSub(system, 'google-sub-1')).toMatchObject({ id: user.id, emailVerifiedAt: NOW });
  });

  /** A user with a live session and one unused link of each kind (plus a verify link that was already used). */
  async function holder(n: number, emailVerifiedAt?: Date) {
    const created = await createAccount(system, { ...account(n, `Holder ${n}`), emailVerifiedAt });
    await insertSession(system, {
      tokenHash: `session-${n}`,
      userId: created.user.id,
      companyId: created.company.id,
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 30 * DAY),
      userAgent: 'test',
      ip: '203.0.113.5',
    });
    const link = (kind: 'verify_email' | 'reset_password', name: string) =>
      insertUserToken(system, {
        userId: created.user.id,
        kind,
        tokenHash: `${name}-${n}`,
        now: NOW,
        expiresAt: new Date(NOW.getTime() + DAY),
      });
    await link('verify_email', 'verify');
    await link('reset_password', 'reset');
    await link('verify_email', 'verify-used');
    await consumeUserToken(system, `verify-used-${n}`, 'verify_email', NOW);
    return created;
  }

  const remaining = async (userId: string) => ({
    sessions: (await system.$client.query('select 1 from sessions where user_id = $1', [userId])).rowCount,
    unusedLinks: (
      await system.$client.query('select token_hash from user_tokens where user_id = $1 and used_at is null order by 1', [
        userId,
      ])
    ).rows.map((r: { token_hash: string }) => r.token_hash),
    usedLinks: (
      await system.$client.query('select token_hash from user_tokens where user_id = $1 and used_at is not null', [userId])
    ).rows.map((r: { token_hash: string }) => r.token_hash),
  });

  test('linking an UNCONFIRMED account hands it over: password gone, every session and unused link deleted, email confirmed', async () => {
    const target = await holder(1);
    const bystander = await holder(2);
    expect(await remaining(target.user.id)).toEqual({
      sessions: 1,
      unusedLinks: ['reset-1', 'verify-1'],
      usedLinks: ['verify-used-1'],
    });

    const linked = await linkGoogleAccount(system, target.user.id, 'google-sub-1', NOW);
    expect(linked).toMatchObject({ id: target.user.id, googleSub: 'google-sub-1', passwordHash: null, emailVerifiedAt: NOW });
    expect(await findUserByGoogleSub(system, 'google-sub-1')).toMatchObject({ passwordHash: null, emailVerifiedAt: NOW });
    expect(await findLiveSession(system, 'session-1', NOW)).toBeNull();
    // Used links are history, not something anyone can use; the unused ones are gone.
    expect(await remaining(target.user.id)).toEqual({ sessions: 0, unusedLinks: [], usedLinks: ['verify-used-1'] });
    // Nobody else is touched.
    expect(await remaining(bystander.user.id)).toEqual({
      sessions: 1,
      unusedLinks: ['reset-2', 'verify-2'],
      usedLinks: ['verify-used-2'],
    });
    expect(await findUserByEmail(system, 'user2@example.com')).toMatchObject({ passwordHash: expect.any(String) });
  });

  test('linking a CONFIRMED account keeps its password, sessions and links', async () => {
    const target = await holder(1, new Date('2026-01-01T00:00:00Z'));
    const linked = await linkGoogleAccount(system, target.user.id, 'google-sub-1', NOW);
    expect(linked).toMatchObject({
      googleSub: 'google-sub-1',
      passwordHash: 'scrypt$16384$8$1$AAAA$BBBB',
      emailVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(await findLiveSession(system, 'session-1', NOW)).toMatchObject({ userId: target.user.id });
    expect(await remaining(target.user.id)).toEqual({
      sessions: 1,
      unusedLinks: ['reset-1', 'verify-1'],
      usedLinks: ['verify-used-1'],
    });
  });

  test('a link that does not apply (already has a Google account) clears nothing', async () => {
    const target = await holder(1);
    await system.$client.query('update users set google_sub = $2 where id = $1', [target.user.id, 'google-sub-x']);
    expect(await linkGoogleAccount(system, target.user.id, 'google-sub-y', NOW)).toBeNull();
    expect(await remaining(target.user.id)).toEqual({
      sessions: 1,
      unusedLinks: ['reset-1', 'verify-1'],
      usedLinks: ['verify-used-1'],
    });
    expect(await findUserByEmail(system, 'user1@example.com')).toMatchObject({ passwordHash: expect.any(String) });
  });

  test('linkGoogleAccount leaves an email that was already confirmed with its original date', async () => {
    const earlier = new Date('2026-01-01T00:00:00Z');
    const { user } = await createAccount(system, { ...account(1), emailVerifiedAt: earlier });
    const linked = await linkGoogleAccount(system, user.id, 'google-sub-1', NOW);
    expect(linked?.emailVerifiedAt).toEqual(earlier);
    expect((await findUserByGoogleSub(system, 'google-sub-1'))?.emailVerifiedAt).toEqual(earlier);
  });

  test('linkGoogleAccount never overwrites a Google account that is already there (null, nothing changed)', async () => {
    const { user } = await createAccount(system, { ...account(1), googleSub: 'google-sub-first' });
    expect(await linkGoogleAccount(system, user.id, 'google-sub-second', NOW)).toBeNull();
    expect(await linkGoogleAccount(system, user.id, 'google-sub-first', NOW)).toBeNull();
    expect(await findUserByGoogleSub(system, 'google-sub-first')).toMatchObject({ id: user.id, emailVerifiedAt: null });
    expect(await findUserByGoogleSub(system, 'google-sub-second')).toBeNull();
  });

  test('linkGoogleAccount: a Google account that belongs to someone else throws GoogleSubInUseError', async () => {
    await createAccount(system, { ...account(1, 'First Co'), googleSub: 'google-sub-1' });
    const { user } = await createAccount(system, account(2, 'Second Co'));
    await expect(linkGoogleAccount(system, user.id, 'google-sub-1', NOW)).rejects.toBeInstanceOf(GoogleSubInUseError);
    // The failed link did not half-confirm the email.
    expect(await findUserByEmail(system, 'user2@example.com')).toMatchObject({ googleSub: null, emailVerifiedAt: null });
  });

  test('linkGoogleAccount: an unknown user id links nothing', async () => {
    expect(await linkGoogleAccount(system, '00000000-0000-4000-8000-000000000000', 'google-sub-1', NOW)).toBeNull();
    expect(await findUserByGoogleSub(system, 'google-sub-1')).toBeNull();
  });
});

describe('insertSessionIfPasswordUnchanged', () => {
  const NOW = new Date('2026-03-01T12:00:00Z');
  const HASH = 'scrypt$16384$8$1$AAAA$BBBB';

  const sessionFor = (created: { user: { id: string }; company: { id: string } }, tokenHash = 'hash-1') => ({
    tokenHash,
    userId: created.user.id,
    companyId: created.company.id,
    now: NOW,
    expiresAt: new Date(NOW.getTime() + 30 * DAY),
    userAgent: 'test browser',
    ip: '203.0.113.5',
  });

  const rows = async (userId: string) =>
    (await system.$client.query('select * from sessions where user_id = $1', [userId])).rows as Record<string, unknown>[];

  test('saves the session, with every field, while the hash is still the one that was checked', async () => {
    const created = await createAccount(system, account(1));
    expect(await insertSessionIfPasswordUnchanged(system, sessionFor(created), HASH)).toBe(true);
    const [row] = await rows(created.user.id);
    expect(row).toMatchObject({
      token_hash: 'hash-1',
      user_id: created.user.id,
      active_company_id: created.company.id,
      expires_at: new Date(NOW.getTime() + 30 * DAY),
      last_seen_at: NOW,
      user_agent: 'test browser',
      ip: '203.0.113.5',
    });
    expect(await findLiveSession(system, 'hash-1', new Date(NOW.getTime() + DAY))).toMatchObject({
      userId: created.user.id,
      companyId: created.company.id,
    });
  });

  test('a missing user agent and address are saved as null', async () => {
    const created = await createAccount(system, account(1));
    await insertSessionIfPasswordUnchanged(system, { ...sessionFor(created), userAgent: null, ip: null }, HASH);
    expect((await rows(created.user.id))[0]).toMatchObject({ user_agent: null, ip: null });
  });

  test('saves nothing once the password has been changed (a reset) or removed (a Google hand-over)', async () => {
    const created = await createAccount(system, account(1));
    await system.$client.query('update users set password_hash = $2 where id = $1', [created.user.id, 'scrypt$new']);
    expect(await insertSessionIfPasswordUnchanged(system, sessionFor(created), HASH)).toBe(false);
    await system.$client.query('update users set password_hash = null where id = $1', [created.user.id]);
    expect(await insertSessionIfPasswordUnchanged(system, sessionFor(created, 'hash-2'), HASH)).toBe(false);
    expect(await rows(created.user.id)).toEqual([]);
  });

  test('saves nothing for a user who no longer exists', async () => {
    const created = await createAccount(system, account(1));
    expect(
      await insertSessionIfPasswordUnchanged(
        system,
        { ...sessionFor(created), userId: '00000000-0000-4000-8000-000000000000' },
        HASH,
      ),
    ).toBe(false);
    expect(await rows(created.user.id)).toEqual([]);
  });

  test('a token hash that is already taken is still a unique-violation error, not a quiet false', async () => {
    const created = await createAccount(system, account(1));
    await insertSessionIfPasswordUnchanged(system, sessionFor(created), HASH);
    await expect(insertSessionIfPasswordUnchanged(system, sessionFor(created), HASH)).rejects.toThrow();
  });
});

describe('sessions', () => {
  const NOW = new Date('2026-03-01T12:00:00Z');

  async function liveSession(tokenHash = 'hash-1') {
    const created = await createAccount(system, account(1));
    await insertSession(system, {
      tokenHash,
      userId: created.user.id,
      companyId: created.company.id,
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 30 * DAY),
      userAgent: 'test',
      ip: '203.0.113.5',
    });
    return created;
  }

  test('findLiveSession: found while unexpired with an active membership, with the live role and flags', async () => {
    const created = await liveSession();
    const found = await findLiveSession(system, 'hash-1', new Date(NOW.getTime() + DAY));
    expect(found).toMatchObject({
      userId: created.user.id,
      companyId: created.company.id,
      role: 'owner',
      canApproveSpend: false,
      emailVerified: false,
    });
    expect(found!.lastSeenAt.getTime()).toBe(NOW.getTime());
  });

  test('findLiveSession: null for an unknown hash, at/after expiry, or without an active membership', async () => {
    const created = await liveSession();
    expect(await findLiveSession(system, 'nope', NOW)).toBeNull();
    expect(await findLiveSession(system, 'hash-1', new Date(NOW.getTime() + 30 * DAY - 1))).not.toBeNull();
    expect(await findLiveSession(system, 'hash-1', new Date(NOW.getTime() + 30 * DAY))).toBeNull();
    await system.$client.query("update memberships set status = 'disabled' where id = $1", [created.membershipId]);
    expect(await findLiveSession(system, 'hash-1', NOW)).toBeNull();
  });

  test('findLiveSession: a verified email shows as emailVerified', async () => {
    const created = await liveSession();
    await system.$client.query('update users set email_verified_at = $1 where id = $2', [NOW, created.user.id]);
    expect((await findLiveSession(system, 'hash-1', NOW))!.emailVerified).toBe(true);
  });

  test('renewSession moves both timestamps only while last_seen_at is older than staleBefore, and only once', async () => {
    await liveSession();
    const sessionId = (await findLiveSession(system, 'hash-1', NOW))!.sessionId;
    const later = new Date(NOW.getTime() + 2 * 60 * MINUTE);
    const renewal = { now: later, expiresAt: new Date(later.getTime() + 30 * DAY), staleBefore: new Date(later.getTime() - 60 * MINUTE) };

    // Not stale yet (seen at NOW; staleBefore is before NOW): nothing changes.
    expect(await renewSession(system, sessionId, { ...renewal, staleBefore: new Date(NOW.getTime() - 1) })).toBe(false);
    // Stale: renewed once, and a second racing renewal finds it already fresh.
    expect(await renewSession(system, sessionId, renewal)).toBe(true);
    expect(await renewSession(system, sessionId, renewal)).toBe(false);

    const found = await findLiveSession(system, 'hash-1', later);
    expect(found!.lastSeenAt.getTime()).toBe(later.getTime());
    const { rows } = await system.$client.query('select expires_at from sessions where id = $1', [sessionId]);
    expect((rows[0] as { expires_at: Date }).expires_at.getTime()).toBe(later.getTime() + 30 * DAY);
  });
});
