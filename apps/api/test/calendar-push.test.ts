import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  calendarBusyBlocks,
  calendarEventLinks,
  encrypt,
  getConnection,
  saveConnection,
  withTenant,
  type CalendarConnectionRow,
  type TenantContext,
} from '@roofline/db';
import { clearTokenCache } from '../src/calendar/tokens.ts';
import { CalendarUnavailableError, type ExternalEventInput } from '../src/providers/calendar.ts';
import { Actors, addressFor, inCompany, mustCreate } from './crm-helpers.ts';
import { makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

const NOW = new Date('2026-10-12T15:00:00.000Z');
const START = '2026-10-13T19:00:00.000Z';
const END = '2026-10-13T20:00:00.000Z';
const MOVED_START = '2026-10-14T19:00:00.000Z';
const MOVED_END = '2026-10-14T20:00:00.000Z';
/** The phone as the customer was given it, and its digits; the event must carry neither. */
const PHONE = '(402) 555-0142';
const PHONE_DIGITS = '4025550142';
const EMAIL = 'molly.lindgren@example.test';
/** A job gets 5 attempts: its first run and 4 retries (JOB_QUEUE_OPTIONS.retryLimit in jobs/queue.ts). */
const ATTEMPTS = 5;

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  clearTokenCache();
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(NOW);
});

const A = () => t.seed.a.companyId;
const sam = () => who.user('rep').userId;
const pat = () => who.user('office').userId;

/** Saves a Google connection for a member, the way the callback route does. */
async function connect(userId: string, refreshToken: string): Promise<CalendarConnectionRow> {
  const ctx: TenantContext = { companyId: A(), userId, role: 'owner', canApproveSpend: true };
  return withTenant(t.deps.pools, ctx, (tx) =>
    saveConnection(
      tx,
      ctx,
      {
        userId,
        provider: 'google',
        accountEmail: `${refreshToken}@example.test`,
        encryptedCredentials: encrypt(JSON.stringify({ refreshToken }), t.deps.config.ENCRYPTION_KEY),
        scopes: ['calendar'],
        calendarId: 'primary',
        calendarName: 'Primary',
      },
      t.clock.now(),
    ),
  );
}

const connectSam = () => connect(sam(), 'refresh-sam');
const connectPat = () => connect(pat(), 'refresh-pat');

/** A customer (with a phone and an email) with a house and a job. */
async function aJob(agent: SuperAgent) {
  const customer = await mustCreate(agent, '/api/customers', {
    displayName: 'Molly Lindgren',
    phones: [{ number: PHONE, label: 'mobile' }],
    emails: [EMAIL],
  });
  const property = await mustCreate(agent, '/api/properties', { customerId: customer.id, ...addressFor(1) });
  const job = await mustCreate(agent, '/api/jobs', { customerId: customer.id, propertyId: property.id });
  return { customer, property, job };
}

/** Books an inspection on the job for `assignedUserId`, and returns the appointment's id. */
async function book(assignedUserId: string): Promise<string> {
  const owner = await who.as('owner');
  const { job } = await aJob(owner);
  const created = await mustCreate(owner, '/api/appointments', {
    kind: 'inspection',
    jobId: job.id,
    assignedUserId,
    startsAt: START,
    endsAt: END,
  });
  return (created.appointment as unknown as { id: string }).id;
}

async function patch(id: string, body: Record<string, unknown>): Promise<void> {
  const owner = await who.as('owner');
  const res = await owner.patch(`/api/appointments/${id}`).send(body);
  expect(res.status).toBe(200);
}

async function viewOf(id: string): Promise<{ sync: string }> {
  const owner = await who.as('owner');
  const res = await owner.get(`/api/appointments/${id}`);
  expect(res.status).toBe(200);
  return res.body as { sync: string };
}

const drain = () => t.jobs.drain(t.deps);
const calls = (method: string) => t.calendars.google.calls.filter((c) => c.method === method);

const links = (appointmentId: string) =>
  inCompany(t, A(), (tx) => tx.select().from(calendarEventLinks).where(eq(calendarEventLinks.appointmentId, appointmentId)));

/** The one link row of an appointment. */
async function theLink(appointmentId: string) {
  const rows = await links(appointmentId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe('pushing an appointment to the assignee calendar', () => {
  test('create pushes one event with the expected text and no phone or email', async () => {
    await connectSam();
    const id = await book(sam());
    await drain();

    const creates = calls('createEvent');
    expect(creates).toHaveLength(1);
    const [accessToken, calendarId, input] = creates[0]!.args as [string, string, ExternalEventInput];
    expect(accessToken).toBe('access-sam');
    expect(calendarId).toBe('primary');
    expect(input.title).toBe('Inspection — Molly Lindgren');
    expect(input.location).toBe(addressFor(1).addressLine);
    expect(input.description).toMatch(/^Open in Roofline: /);
    expect(input.description).toContain(`${t.deps.config.APP_ORIGIN}/jobs/`);
    const text = JSON.stringify(input);
    expect(text).not.toContain(PHONE_DIGITS);
    expect(text).not.toContain(EMAIL);

    const link = await theLink(id);
    expect(link.etag).not.toBeNull();
    expect((await viewOf(id)).sync).toBe('synced');
    expect(t.jobs.errors).toEqual([]);
  });

  test('moving the appointment updates the same event', async () => {
    await connectSam();
    const id = await book(sam());
    await drain();
    const before = await theLink(id);

    await patch(id, { startsAt: MOVED_START, endsAt: MOVED_END });
    await drain();

    expect(calls('createEvent')).toHaveLength(1);
    const updates = calls('updateEvent');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.args[2]).toBe(before.providerEventId);
    const after = await theLink(id);
    expect(after.providerEventId).toBe(before.providerEventId);
    expect(after.etag).not.toBe(before.etag);
    const live = await t.calendars.google.getEvent('access-sam', 'primary', before.providerEventId);
    expect(live?.start.toISOString()).toBe(MOVED_START);
  });

  test('canceling deletes the event and the link', async () => {
    await connectSam();
    const id = await book(sam());
    await drain();
    const before = await theLink(id);

    const owner = await who.as('owner');
    const res = await owner.post(`/api/appointments/${id}/cancel`).send({});
    expect(res.status).toBe(200);
    await drain();

    const deletes = calls('deleteEvent');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.args[2]).toBe(before.providerEventId);
    expect(await links(id)).toHaveLength(0);
  });

  test('reassigning from Sam to Pat moves the event', async () => {
    await connectSam();
    const patConnection = await connectPat();
    const id = await book(sam());
    await drain();
    const before = await theLink(id);

    await patch(id, { assignedUserId: pat() });
    await drain();

    const deletes = calls('deleteEvent');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.args[0]).toBe('access-sam');
    expect(deletes[0]!.args[2]).toBe(before.providerEventId);
    const creates = calls('createEvent');
    expect(creates).toHaveLength(2);
    expect(creates[1]!.args[0]).toBe('access-pat');
    expect((await theLink(id)).connectionId).toBe(patConnection.id);
    expect(t.jobs.errors).toEqual([]);
  });

  test('an assignee without a connection gets nothing', async () => {
    const id = await book(pat());
    await drain();

    expect(calls('createEvent')).toHaveLength(0);
    expect(await links(id)).toHaveLength(0);
    expect((await viewOf(id)).sync).toBe('none');
    expect(t.jobs.errors).toEqual([]);
  });
});

describe('races with the pull', () => {
  test('a busy block stored for the new event before its link existed is gone once the push finishes', async () => {
    const samConnection = await connectSam();
    const api = t.calendars.google;
    const realCreate = api.createEvent.bind(api);
    const seen: string[] = [];
    // The pull lands between the provider create and the link save: it sees an unlinked busy event and stores a block.
    vi.spyOn(api, 'createEvent').mockImplementation(async (token, calendarId, input) => {
      const r = await realCreate(token, calendarId, input);
      seen.push(r.id);
      await inCompany(t, A(), (tx) =>
        tx.insert(calendarBusyBlocks).values({
          companyId: A(),
          connectionId: samConnection.id,
          userId: sam(),
          providerEventId: r.id,
          startsAt: new Date(START),
          endsAt: new Date(END),
        }),
      );
      return r;
    });
    const id = await book(sam());
    await drain();

    expect(seen).toHaveLength(1);
    expect((await theLink(id)).providerEventId).toBe(seen[0]);
    const blocks = await inCompany(t, A(), (tx) => tx.select().from(calendarBusyBlocks).where(eq(calendarBusyBlocks.connectionId, samConnection.id)));
    expect(blocks).toHaveLength(0);
    expect(t.jobs.errors).toEqual([]);
  });

  test('on reassignment the link is gone before the remote delete runs, and a failed delete keeps the appointment scheduled', async () => {
    await connectSam();
    const patConnection = await connectPat();
    const id = await book(sam());
    await drain();
    const before = await theLink(id);

    const api = t.calendars.google;
    const linkCountAtDelete: number[] = [];
    vi.spyOn(api, 'deleteEvent').mockImplementationOnce(async () => {
      linkCountAtDelete.push((await links(id)).length);
      throw new CalendarUnavailableError('unavailable');
    });
    await patch(id, { assignedUserId: pat() });
    await drain();

    // The pull of Sam's calendar would have found no link for the event at the moment it was deleted.
    expect(linkCountAtDelete).toEqual([0]);
    expect(t.jobs.errors).toEqual([]);
    const link = await theLink(id);
    expect(link.connectionId).toBe(patConnection.id);
    expect(link.providerEventId).not.toBe(before.providerEventId);
    const owner = await who.as('owner');
    const res = await owner.get(`/api/appointments/${id}`);
    expect((res.body as { status: string }).status).toBe('scheduled');
  });
});

describe('when the calendar cannot be reached', () => {
  test('a revoked token marks the connection error and the appointment failed, without throwing', async () => {
    await connectSam();
    const id = await book(sam());
    await drain();
    expect((await viewOf(id)).sync).toBe('synced');

    t.calendars.google.revoke('refresh-sam');
    await patch(id, { startsAt: MOVED_START, endsAt: MOVED_END });
    await expect(drain()).resolves.toBeUndefined();

    expect(t.jobs.errors).toEqual([]);
    const ctx: TenantContext = { companyId: A(), userId: sam(), role: 'owner', canApproveSpend: true };
    const connection = await withTenant(t.deps.pools, ctx, (tx) => getConnection(tx, ctx, sam()));
    expect(connection?.status).toBe('error');
    expect((await theLink(id)).pushErrorPlain).toBe('reconnect');
    // The view only counts connected calendars as pending, but a link with an error is 'failed'.
    expect((await viewOf(id)).sync).toBe('failed');
  });

  test('moving an appointment whose assignee connection is already in error keeps the link with reconnect', async () => {
    const samConnection = await connectSam();
    const id = await book(sam());
    await drain();
    const original = await theLink(id);

    t.calendars.google.revoke('refresh-sam');
    await patch(id, { startsAt: MOVED_START, endsAt: MOVED_END });
    await drain();
    const ctx: TenantContext = { companyId: A(), userId: sam(), role: 'owner', canApproveSpend: true };
    expect((await withTenant(t.deps.pools, ctx, (tx) => getConnection(tx, ctx, sam())))?.status).toBe('error');

    // The connection is now 'error'. A second move must not treat Sam as having no calendar.
    await patch(id, { startsAt: START, endsAt: END });
    await expect(drain()).resolves.toBeUndefined();

    expect(t.jobs.errors).toEqual([]);
    const link = await theLink(id);
    expect(link.connectionId).toBe(samConnection.id);
    expect(link.providerEventId).toBe(original.providerEventId);
    expect(link.pushErrorPlain).toBe('reconnect');
    expect((await viewOf(id)).sync).toBe('failed');
    expect(calls('deleteEvent')).toHaveLength(0);
    expect(calls('createEvent')).toHaveLength(1);
  });

  test('a revoked old calendar does not block the move to the new assignee', async () => {
    const samConnection = await connectSam();
    const patConnection = await connectPat();
    const id = await book(sam());
    await drain();

    t.calendars.google.revoke('refresh-sam');
    await patch(id, { assignedUserId: pat() });
    await drain();

    expect(t.jobs.errors).toEqual([]);
    const creates = calls('createEvent');
    expect(creates).toHaveLength(2);
    expect(creates[1]!.args[0]).toBe('access-pat');
    const link = await theLink(id);
    expect(link.connectionId).toBe(patConnection.id);
    expect(link.pushErrorPlain).toBeNull();
    const ctx: TenantContext = { companyId: A(), userId: sam(), role: 'owner', canApproveSpend: true };
    const connection = await withTenant(t.deps.pools, ctx, (tx) => getConnection(tx, ctx, sam()));
    expect(connection?.id).toBe(samConnection.id);
    expect(connection?.status).toBe('error');
  });

  test('five unavailable attempts fail the job with the reason stored', async () => {
    await connectSam();
    const id = await book(sam());
    await drain();
    const before = await theLink(id);

    t.calendars.google.failNext(ATTEMPTS);
    await patch(id, { startsAt: MOVED_START, endsAt: MOVED_END });
    await drain();

    expect(t.jobs.errors).toHaveLength(ATTEMPTS);
    expect((await theLink(id)).pushErrorPlain).toBe('unavailable');
    // Every failure was used up, so this read works; the event was never moved.
    const live = await t.calendars.google.getEvent('access-sam', 'primary', before.providerEventId);
    expect(live?.start.toISOString()).toBe(START);
    expect(live?.etag).toBe(before.etag);
  });

  test('a newer external change is not overwritten on a 412 conflict', async () => {
    await connectSam();
    const id = await book(sam());
    await drain();
    const before = await theLink(id);

    // The fake stamps external changes in 2030, later than the appointment's updated_at (2026).
    const externalStart = new Date('2026-10-15T14:00:00.000Z');
    const externalEnd = new Date('2026-10-15T15:00:00.000Z');
    t.calendars.google.externalMove(before.providerEventId, externalStart, externalEnd);
    const getsBefore = calls('getEvent').length;

    await patch(id, { startsAt: MOVED_START, endsAt: MOVED_END });
    await drain();

    expect(t.jobs.errors).toEqual([]);
    expect(calls('getEvent').length).toBeGreaterThan(getsBefore);
    // No update goes out without the etag it was based on.
    for (const u of calls('updateEvent')) expect(u.args[3]).not.toBeNull();
    const live = await t.calendars.google.getEvent('access-sam', 'primary', before.providerEventId);
    expect(live?.start.toISOString()).toBe(externalStart.toISOString());
    expect(live?.end.toISOString()).toBe(externalEnd.toISOString());
  });
});
