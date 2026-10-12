import pg from 'pg';
import { beforeEach, describe, expect, inject, test } from 'vitest';
import {
  calendarBusyBlocks,
  connectedMemberCount,
  deleteConnection,
  encrypt,
  getConnection,
  markConnectionError,
  saveConnection,
  setConnectionCalendar,
  decrypt,
  withTenant,
  type CalendarConnectionRow,
  type TenantContext,
} from '@roofline/db';
import { accessTokenFor, clearTokenCache } from '../src/calendar/tokens.ts';
import { CalendarAuthError } from '../src/providers/calendar.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const RECONNECT = 'Reconnect your calendar.';

let t: TestApp;
let ctx: TenantContext;

beforeEach(async () => {
  clearTokenCache();
  t = await makeTestApp();
  ctx = { companyId: t.seed.a.companyId, userId: t.seed.a.owner.userId, role: 'owner', canApproveSpend: true };
});

/** Raw SQL as the table owner, for setting states the app itself cannot write (a membership's status). */
async function ownerSql(text: string, params: unknown[] = []): Promise<void> {
  const client = new pg.Client({ connectionString: inject('dbUrls').owner });
  await client.connect();
  try {
    await client.query(text, params);
  } finally {
    await client.end();
  }
}

/** Saves the owner's Google connection with a refresh token `refreshToken`, as the callback route does. */
async function seedConnection(refreshToken = 'refresh-abc'): Promise<CalendarConnectionRow> {
  return withTenant(t.deps.pools, ctx, (tx) =>
    saveConnection(
      tx,
      ctx,
      {
        userId: t.seed.a.owner.userId,
        provider: 'google',
        accountEmail: 'o@example.test',
        encryptedCredentials: encrypt(JSON.stringify({ refreshToken }), t.deps.config.ENCRYPTION_KEY),
        scopes: ['calendar'],
        calendarId: 'primary',
        calendarName: 'Primary',
      },
      t.clock.now(),
    ),
  );
}

function refreshCalls(): number {
  return t.calendars.google.calls.filter((c) => c.method === 'refresh').length;
}

async function readConnection(): Promise<CalendarConnectionRow | null> {
  return withTenant(t.deps.pools, ctx, (tx) => getConnection(tx, ctx, t.seed.a.owner.userId));
}

describe('accessTokenFor', () => {
  test('returns the access token and reuses it until near expiry', async () => {
    const conn = await seedConnection();

    expect(await accessTokenFor(t.deps, ctx, conn)).toBe('access-abc');
    expect(await accessTokenFor(t.deps, ctx, conn)).toBe('access-abc');
    expect(refreshCalls()).toBe(1);
  });

  test('refreshes again once the token is within a minute of its expiry', async () => {
    const conn = await seedConnection();
    await accessTokenFor(t.deps, ctx, conn);

    // The fake token expires at 2030-01-01T00:00:00Z; 30 seconds before that is inside the margin.
    t.clock.set(new Date('2029-12-31T23:59:30Z'));
    expect(await accessTokenFor(t.deps, ctx, conn)).toBe('access-abc');
    expect(refreshCalls()).toBe(2);
  });

  test('a revoked grant throws CalendarAuthError and marks the connection for reconnecting', async () => {
    const conn = await seedConnection();
    t.calendars.google.revoke('refresh-abc');

    await expect(accessTokenFor(t.deps, ctx, conn)).rejects.toBeInstanceOf(CalendarAuthError);

    const after = await readConnection();
    expect(after?.status).toBe('error');
    expect(after?.lastErrorPlain).toBe(RECONNECT);
  });
});

describe('rotated refresh tokens', () => {
  test('a refresh token returned by the provider is stored encrypted, and used next time', async () => {
    const conn = await seedConnection();
    t.calendars.google.rotateNext('refresh-rotated');

    expect(await accessTokenFor(t.deps, ctx, conn)).toBe('access-rotated');

    const stored = await readConnection();
    const creds = JSON.parse(decrypt(stored!.encryptedCredentials, t.deps.config.ENCRYPTION_KEY)) as { refreshToken: string };
    expect(creds.refreshToken).toBe('refresh-rotated');

    // Once the cached token is stale, the next refresh uses the rotated token.
    clearTokenCache();
    await accessTokenFor(t.deps, ctx, stored!);
    const refreshArgs = t.calendars.google.calls.filter((c) => c.method === 'refresh').map((c) => c.args[0]);
    expect(refreshArgs).toEqual(['refresh-abc', 'refresh-rotated']);
  });

  test('an unchanged refresh token leaves the stored credentials alone', async () => {
    const conn = await seedConnection();
    await accessTokenFor(t.deps, ctx, conn);
    const stored = await readConnection();
    expect(stored!.encryptedCredentials.equals(conn.encryptedCredentials)).toBe(true);
  });
});

describe('connection repo', () => {
  test('saving twice for the same person keeps one row and resets the cursor and status', async () => {
    const first = await seedConnection();
    await withTenant(t.deps.pools, ctx, (tx) => markConnectionError(tx, ctx, first.id, RECONNECT, t.clock.now()));
    await ownerSql("update calendar_connections set sync_cursor = 'cursor-1' where id = $1", [first.id]);

    const second = await seedConnection('refresh-new');
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('connected');
    expect(second.syncCursor).toBeNull();
    expect(second.lastErrorPlain).toBeNull();

    const rows = await withTenant(t.deps.pools, ctx, (tx) => tx.select().from(calendarBusyBlocks));
    expect(rows).toHaveLength(0);
  });

  test('saving again drops the busy blocks of the old connection', async () => {
    const conn = await seedConnection();
    await withTenant(t.deps.pools, ctx, (tx) =>
      tx.insert(calendarBusyBlocks).values({
        companyId: ctx.companyId,
        connectionId: conn.id,
        userId: t.seed.a.owner.userId,
        providerEventId: 'evt-1',
        startsAt: new Date('2030-01-02T15:00:00Z'),
        endsAt: new Date('2030-01-02T16:00:00Z'),
      }),
    );

    await seedConnection('refresh-new');
    const rows = await withTenant(t.deps.pools, ctx, (tx) => tx.select().from(calendarBusyBlocks));
    expect(rows).toHaveLength(0);
  });

  test('setConnectionCalendar changes the calendar, clears the cursor and drops busy blocks', async () => {
    const conn = await seedConnection();
    await ownerSql("update calendar_connections set sync_cursor = 'cursor-1' where id = $1", [conn.id]);
    await withTenant(t.deps.pools, ctx, (tx) =>
      tx.insert(calendarBusyBlocks).values({
        companyId: ctx.companyId,
        connectionId: conn.id,
        userId: t.seed.a.owner.userId,
        providerEventId: 'evt-1',
        startsAt: new Date('2030-01-02T15:00:00Z'),
        endsAt: new Date('2030-01-02T16:00:00Z'),
      }),
    );

    await withTenant(t.deps.pools, ctx, (tx) =>
      setConnectionCalendar(tx, ctx, t.seed.a.owner.userId, 'cal-work', 'Work', t.clock.now()),
    );

    const after = await readConnection();
    expect(after?.calendarId).toBe('cal-work');
    expect(after?.calendarName).toBe('Work');
    expect(after?.syncCursor).toBeNull();
    const rows = await withTenant(t.deps.pools, ctx, (tx) => tx.select().from(calendarBusyBlocks));
    expect(rows).toHaveLength(0);
  });

  test('deleteConnection returns true once, then false', async () => {
    await seedConnection();

    expect(await withTenant(t.deps.pools, ctx, (tx) => deleteConnection(tx, ctx, t.seed.a.owner.userId))).toBe(true);
    expect(await withTenant(t.deps.pools, ctx, (tx) => deleteConnection(tx, ctx, t.seed.a.owner.userId))).toBe(false);
    expect(await readConnection()).toBeNull();
  });

  test('connectedMemberCount counts only connected connections of active members', async () => {
    const count = () => withTenant(t.deps.pools, ctx, (tx) => connectedMemberCount(tx, ctx));
    expect(await count()).toBe(0);

    const conn = await seedConnection();
    expect(await count()).toBe(1);

    await withTenant(t.deps.pools, ctx, (tx) => markConnectionError(tx, ctx, conn.id, RECONNECT, t.clock.now()));
    expect(await count()).toBe(0);

    await withTenant(t.deps.pools, ctx, (tx) =>
      saveConnection(
        tx,
        ctx,
        {
          userId: t.seed.a.owner.userId,
          provider: 'google',
          accountEmail: 'o@example.test',
          encryptedCredentials: encrypt(JSON.stringify({ refreshToken: 'refresh-abc' }), t.deps.config.ENCRYPTION_KEY),
          scopes: ['calendar'],
          calendarId: 'primary',
          calendarName: 'Primary',
        },
        t.clock.now(),
      ),
    );
    expect(await count()).toBe(1);

    await ownerSql("update memberships set status = 'disabled' where company_id = $1 and user_id = $2", [
      t.seed.a.companyId,
      t.seed.a.owner.userId,
    ]);
    expect(await count()).toBe(0);
  });
});
