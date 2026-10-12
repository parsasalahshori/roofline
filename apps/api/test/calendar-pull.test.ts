import { eq } from 'drizzle-orm';
import pg from 'pg';
import { beforeEach, describe, expect, inject, test } from 'vitest';
import {
  activities,
  appointments,
  calendarBusyBlocks,
  calendarConnections,
  calendarEventLinks,
  createAppointment,
  encrypt,
  getConnection,
  saveConnection,
  withTenant,
  type CalendarConnectionRow,
  type TenantContext,
} from '@roofline/db';
import type { SeedUser } from '@roofline/db/testing';
import { pullConnection } from '../src/calendar/pull.ts';
import { clearTokenCache } from '../src/calendar/tokens.ts';
import { pullCalendars } from '../src/jobs/scheduler/calendar-pull.ts';
import { mustCreate } from './crm-helpers.ts';
import { loginAs, makeTestApp, type TestApp } from './helpers.ts';

const NOW = new Date('2026-10-12T15:00:00.000Z');
/** Tuesday 2026-10-13 in Chicago (CDT): local midnight to local midnight. */
const TUE_FROM = '2026-10-13T05:00:00.000Z';
const TUE_TO = '2026-10-14T05:00:00.000Z';
/** 10:00-11:00 Chicago on that Tuesday. */
const VISIT_START = new Date('2026-10-13T15:00:00.000Z');
const VISIT_END = new Date('2026-10-13T16:00:00.000Z');
const MOVED_START = new Date('2026-10-13T17:00:00.000Z');
const MOVED_END = new Date('2026-10-13T18:00:00.000Z');
const MINUTE = 60_000;

let t: TestApp;
let ctx: TenantContext;

beforeEach(async () => {
  clearTokenCache();
  t = await makeTestApp();
  t.clock.set(NOW);
  ctx = ctxOf('a', 'owner');
});

function ctxOf(company: 'a' | 'b', who: 'owner' | 'rep'): TenantContext {
  const seeded = t.seed[company];
  const user = seeded[who];
  return { companyId: seeded.companyId, userId: user.userId, role: who, canApproveSpend: who === 'owner' };
}

/** Raw SQL as the table owner, for states the app itself cannot write and for catalog reads. */
async function ownerSql(text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const client = new pg.Client({ connectionString: inject('dbUrls').owner });
  await client.connect();
  try {
    const result = await client.query(text, params);
    return result.rows as Record<string, unknown>[];
  } finally {
    await client.end();
  }
}

/** Saves `user`'s Google connection with refresh token `refresh-<name>`, as the callback route does. */
async function seedConnection(
  c: TenantContext,
  user: SeedUser,
  name: string,
): Promise<CalendarConnectionRow> {
  return withTenant(t.deps.pools, c, (tx) =>
    saveConnection(
      tx,
      c,
      {
        userId: user.userId,
        provider: 'google',
        accountEmail: `${name}@example.test`,
        encryptedCredentials: encrypt(JSON.stringify({ refreshToken: `refresh-${name}` }), t.deps.config.ENCRYPTION_KEY),
        scopes: ['calendar'],
        calendarId: 'primary',
        calendarName: 'Primary',
      },
      t.clock.now(),
    ),
  );
}

async function freshConnection(c: TenantContext, userId: string): Promise<CalendarConnectionRow> {
  const conn = await withTenant(t.deps.pools, c, (tx) => getConnection(tx, c, userId));
  if (!conn) throw new Error('Expected a connection.');
  return conn;
}

/** Pulls with the connection as currently stored (so the saved cursor is used). */
async function pull(c: TenantContext, userId: string) {
  return pullConnection(t.deps, c, await freshConnection(c, userId));
}

type Linked = { appointmentId: string; eventId: string; etag: string | null };

/**
 * A scheduled inspection assigned to the owner of company `company`, with a fake event linked to
 * it. The appointment's updated_at is set to `updatedAt` so tests control which side is newer.
 */
async function linkedAppointment(
  company: 'a' | 'b',
  conn: CalendarConnectionRow,
  name: string,
  updatedAt: Date,
): Promise<Linked> {
  const c = ctxOf(company, 'owner');
  const agent = await loginAs(t.app, t.seed[company].owner);
  const customer = await mustCreate(agent, '/api/customers', { displayName: `Customer ${name}` });
  const created = await withTenant(t.deps.pools, c, (tx) =>
    createAppointment(
      tx,
      c,
      {
        kind: 'inspection',
        customerId: customer.id,
        assignedUserId: t.seed[company].owner.userId,
        startsAt: VISIT_START,
        endsAt: VISIT_END,
      },
      NOW,
    ),
  );
  const fake = t.calendars.google;
  const event = await fake.createEvent(`access-${name}`, 'primary', {
    title: 'Inspection',
    location: null,
    description: '',
    start: VISIT_START,
    end: VISIT_END,
    allDay: false,
    timeZone: 'America/Chicago',
  });
  await withTenant(t.deps.pools, c, (tx) =>
    tx.insert(calendarEventLinks).values({
      companyId: c.companyId,
      appointmentId: created.row.id,
      connectionId: conn.id,
      providerEventId: event.id,
      etag: event.etag,
    }),
  );
  await ownerSql('update appointments set updated_at = $1 where id = $2', [updatedAt, created.row.id]);
  return { appointmentId: created.row.id, eventId: event.id, etag: event.etag };
}

async function appointmentRow(c: TenantContext, id: string) {
  const [row] = await withTenant(t.deps.pools, c, (tx) => tx.select().from(appointments).where(eq(appointments.id, id)));
  if (!row) throw new Error('Expected an appointment.');
  return row;
}

async function activitiesSaying(c: TenantContext, summary: string) {
  return withTenant(t.deps.pools, c, (tx) => tx.select().from(activities).where(eq(activities.summary, summary)));
}

async function allActivities(c: TenantContext) {
  return withTenant(t.deps.pools, c, (tx) => tx.select().from(activities));
}

async function blocksOf(c: TenantContext) {
  return withTenant(t.deps.pools, c, (tx) => tx.select().from(calendarBusyBlocks));
}

async function linkCount(c: TenantContext, appointmentId: string): Promise<number> {
  const rows = await withTenant(t.deps.pools, c, (tx) =>
    tx.select().from(calendarEventLinks).where(eq(calendarEventLinks.appointmentId, appointmentId)),
  );
  return rows.length;
}

function syncCalls(): number {
  return t.calendars.google.calls.filter((call) => call.method === 'syncEvents').length;
}

const OLD = new Date('2026-10-01T00:00:00.000Z');

describe('pulling linked events', () => {
  test('an external move of a linked event moves the appointment and writes an activity', async () => {
    const conn = await seedConnection(ctx, t.seed.a.owner, 'abc');
    const linked = await linkedAppointment('a', conn, 'abc', OLD);
    await pull(ctx, t.seed.a.owner.userId);

    t.calendars.google.externalMove(linked.eventId, MOVED_START, MOVED_END);
    const result = await pull(ctx, t.seed.a.owner.userId);

    const row = await appointmentRow(ctx, linked.appointmentId);
    expect(row.startsAt.toISOString()).toBe(MOVED_START.toISOString());
    expect(row.endsAt.toISOString()).toBe(MOVED_END.toISOString());
    expect(result.moved).toBe(1);
    expect(await activitiesSaying(ctx, 'Moved in Google Calendar')).toHaveLength(1);
    expect(t.jobs.sent.filter((j) => j.name === 'calendar-push')).toHaveLength(0);
  });

  test('an external delete cancels the appointment and removes the link', async () => {
    const conn = await seedConnection(ctx, t.seed.a.owner, 'abc');
    const linked = await linkedAppointment('a', conn, 'abc', OLD);
    await pull(ctx, t.seed.a.owner.userId);

    t.calendars.google.externalDelete(linked.eventId);
    const result = await pull(ctx, t.seed.a.owner.userId);

    expect((await appointmentRow(ctx, linked.appointmentId)).status).toBe('canceled');
    expect(await activitiesSaying(ctx, 'Canceled in Google Calendar')).toHaveLength(1);
    expect(await linkCount(ctx, linked.appointmentId)).toBe(0);
    expect(result.canceled).toBe(1);
    expect(t.jobs.sent.filter((j) => j.name === 'calendar-push')).toHaveLength(0);
  });

  test('our own push echo is skipped', async () => {
    const conn = await seedConnection(ctx, t.seed.a.owner, 'abc');
    const linked = await linkedAppointment('a', conn, 'abc', OLD);
    const before = (await allActivities(ctx)).length;

    // The link's etag equals the event's etag, so the event in the page is our own write coming back.
    const result = await pull(ctx, t.seed.a.owner.userId);

    expect(result.moved).toBe(0);
    expect(result.canceled).toBe(0);
    expect((await allActivities(ctx)).length).toBe(before);
    const row = await appointmentRow(ctx, linked.appointmentId);
    expect(row.startsAt.toISOString()).toBe(VISIT_START.toISOString());
  });

  test('an older external change is ignored', async () => {
    const conn = await seedConnection(ctx, t.seed.a.owner, 'abc');
    // The appointment was last changed in 2031; the fake stamps its events from 2030.
    const linked = await linkedAppointment('a', conn, 'abc', new Date('2031-01-01T00:00:00.000Z'));
    await pull(ctx, t.seed.a.owner.userId);
    const before = (await allActivities(ctx)).length;

    t.calendars.google.externalMove(linked.eventId, MOVED_START, MOVED_END);
    const result = await pull(ctx, t.seed.a.owner.userId);

    const row = await appointmentRow(ctx, linked.appointmentId);
    expect(row.startsAt.toISOString()).toBe(VISIT_START.toISOString());
    expect(row.endsAt.toISOString()).toBe(VISIT_END.toISOString());
    expect(result.moved).toBe(0);
    expect((await allActivities(ctx)).length).toBe(before);
  });
});

describe('outside events', () => {
  test('an outside event becomes one busy block with times only', async () => {
    const conn = await seedConnection(ctx, t.seed.a.owner, 'abc');
    const owner = await loginAs(t.app, t.seed.a.owner);
    const query = { kind: 'inspection', from: TUE_FROM, to: TUE_TO, userId: t.seed.a.owner.userId };
    const startsOf = (body: unknown) => (body as { slots: { start: string }[] }).slots.map((s) => s.start);

    const freeBefore = await owner.get('/api/calendar/availability').query(query);
    expect(freeBefore.status).toBe(200);
    expect(startsOf(freeBefore.body)).toContain(VISIT_START.toISOString());

    t.calendars.google.addOutsideEvent({ start: VISIT_START, end: VISIT_END });
    await pull(ctx, t.seed.a.owner.userId);

    const blocks = await blocksOf(ctx);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.connectionId).toBe(conn.id);
    expect(blocks[0]!.userId).toBe(t.seed.a.owner.userId);
    expect(blocks[0]!.startsAt.toISOString()).toBe(VISIT_START.toISOString());
    expect(blocks[0]!.endsAt.toISOString()).toBe(VISIT_END.toISOString());

    const columns = await ownerSql(
      "select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'calendar_busy_blocks'",
    );
    const textColumns = columns.filter((c) => c.data_type === 'text' || c.data_type === 'character varying').map((c) => c.column_name);
    expect(textColumns).toEqual(['provider_event_id']);

    const freeAfter = await owner.get('/api/calendar/availability').query(query);
    expect(freeAfter.status).toBe(200);
    expect(startsOf(freeAfter.body)).not.toContain(VISIT_START.toISOString());
  });

  test('a transparent event creates no block', async () => {
    await seedConnection(ctx, t.seed.a.owner, 'abc');
    t.calendars.google.addOutsideEvent({ start: VISIT_START, end: VISIT_END, busy: false });

    await pull(ctx, t.seed.a.owner.userId);

    expect(await blocksOf(ctx)).toHaveLength(0);
  });

  test('cursor expiry replaces the busy blocks with the full set', async () => {
    const conn = await seedConnection(ctx, t.seed.a.owner, 'abc');
    const fake = t.calendars.google;
    const first = fake.addOutsideEvent({ start: VISIT_START, end: VISIT_END });
    await pull(ctx, t.seed.a.owner.userId);
    expect((await freshConnection(ctx, t.seed.a.owner.userId)).syncCursor).not.toBeNull();
    expect((await blocksOf(ctx)).map((b) => b.providerEventId)).toEqual([first]);

    // A stale row the provider no longer has.
    await withTenant(t.deps.pools, ctx, (tx) =>
      tx.insert(calendarBusyBlocks).values({
        companyId: ctx.companyId,
        connectionId: conn.id,
        userId: t.seed.a.owner.userId,
        providerEventId: 'evt-stale',
        startsAt: new Date('2026-10-14T15:00:00.000Z'),
        endsAt: new Date('2026-10-14T16:00:00.000Z'),
      }),
    );
    fake.expireCursor();
    const second = fake.addOutsideEvent({ start: MOVED_START, end: MOVED_END });
    await pull(ctx, t.seed.a.owner.userId);

    const ids = (await blocksOf(ctx)).map((b) => b.providerEventId).sort();
    expect(ids).toEqual([first, second].sort());
  });
});

describe('the pull tick', () => {
  test('a revoked token marks the connection error and the tick continues', async () => {
    const repCtx = ctxOf('a', 'rep');
    await seedConnection(ctx, t.seed.a.owner, 'owner');
    await seedConnection(repCtx, t.seed.a.rep, 'rep');
    const fake = t.calendars.google;
    // The fake puts outside events on the first account it has seen: make that the healthy one.
    await fake.refresh('refresh-rep');
    fake.addOutsideEvent({ start: VISIT_START, end: VISIT_END });
    fake.revoke('refresh-owner');

    await expect(pullCalendars(t.deps, NOW)).resolves.toBeUndefined();

    const owner = await freshConnection(ctx, t.seed.a.owner.userId);
    expect(owner.status).toBe('error');
    const rep = await freshConnection(repCtx, t.seed.a.rep.userId);
    expect(rep.status).toBe('connected');
    expect(rep.lastSyncedAt).not.toBeNull();
    const blocks = await blocksOf(ctx);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.userId).toBe(t.seed.a.rep.userId);
  });

  test('a connection is due after five minutes', async () => {
    const repCtx = ctxOf('a', 'rep');
    await seedConnection(ctx, t.seed.a.owner, 'owner');
    await pull(ctx, t.seed.a.owner.userId);
    expect((await freshConnection(ctx, t.seed.a.owner.userId)).lastSyncedAt?.toISOString()).toBe(NOW.toISOString());
    expect(syncCalls()).toBe(1);

    // A connection never synced is due at once; the synced one is not.
    await seedConnection(repCtx, t.seed.a.rep, 'rep');
    await pullCalendars(t.deps, new Date(NOW.getTime() + 4 * MINUTE));
    expect(syncCalls()).toBe(2);
    expect((await freshConnection(repCtx, t.seed.a.rep.userId)).lastSyncedAt).not.toBeNull();

    await pullCalendars(t.deps, new Date(NOW.getTime() + 4 * MINUTE));
    expect(syncCalls()).toBe(2);

    await pullCalendars(t.deps, new Date(NOW.getTime() + 5 * MINUTE));
    expect(syncCalls()).toBe(4);
  });

  test('the fan-out never crosses companies', async () => {
    const ctxB = ctxOf('b', 'owner');
    const connA = await seedConnection(ctx, t.seed.a.owner, 'acme');
    const connB = await seedConnection(ctxB, t.seed.b.owner, 'bolt');
    const fake = t.calendars.google;
    const linkedA = await linkedAppointment('a', connA, 'acme', OLD);
    const linkedB = await linkedAppointment('b', connB, 'bolt', OLD);
    // The fake puts outside events on the first account it has seen, which is company A's.
    fake.addOutsideEvent({ start: VISIT_START, end: VISIT_END });
    await pullCalendars(t.deps, NOW);

    fake.externalMove(linkedA.eventId, MOVED_START, MOVED_END);
    fake.externalDelete(linkedB.eventId);
    await pullCalendars(t.deps, new Date(NOW.getTime() + 5 * MINUTE));

    expect((await appointmentRow(ctx, linkedA.appointmentId)).startsAt.toISOString()).toBe(MOVED_START.toISOString());
    expect((await appointmentRow(ctx, linkedA.appointmentId)).status).toBe('scheduled');
    expect((await appointmentRow(ctxB, linkedB.appointmentId)).status).toBe('canceled');
    expect((await appointmentRow(ctxB, linkedB.appointmentId)).startsAt.toISOString()).toBe(VISIT_START.toISOString());

    expect(await activitiesSaying(ctx, 'Moved in Google Calendar')).toHaveLength(1);
    expect(await activitiesSaying(ctx, 'Canceled in Google Calendar')).toHaveLength(0);
    expect(await activitiesSaying(ctxB, 'Canceled in Google Calendar')).toHaveLength(1);
    expect(await activitiesSaying(ctxB, 'Moved in Google Calendar')).toHaveLength(0);

    const blocksA = await blocksOf(ctx);
    expect(blocksA).toHaveLength(1);
    expect(blocksA.every((b) => b.companyId === ctx.companyId && b.connectionId === connA.id)).toBe(true);
    expect(await blocksOf(ctxB)).toHaveLength(0);

    const connections = await withTenant(t.deps.pools, ctxB, (tx) => tx.select().from(calendarConnections));
    expect(connections.map((c) => c.id)).toEqual([connB.id]);
  });
});

describe('POST /api/calendar/sync', () => {
  test('pulls once then returns 202 without pulling inside 30 seconds', async () => {
    await seedConnection(ctx, t.seed.a.owner, 'abc');
    const owner = await loginAs(t.app, t.seed.a.owner);

    const first = await owner.post('/api/calendar/sync').send({});
    const second = await owner.post('/api/calendar/sync').send({});

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(syncCalls()).toBe(1);

    t.clock.advance(31_000);
    const third = await owner.post('/api/calendar/sync').send({});
    expect(third.status).toBe(202);
    expect(syncCalls()).toBe(2);
  });
});
