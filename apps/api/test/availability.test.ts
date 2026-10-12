import { beforeEach, describe, expect, test } from 'vitest';
import { appointments, calendarBusyBlocks, calendarConnections } from '@roofline/db';
import { DEFAULT_WORK_HOURS } from '@roofline/shared';
import { Actors, addressFor, inCompany, mustCreate, NOT_FOUND } from './crm-helpers.ts';
import { makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

const OWN_TIMES = 'You can only check your own times.';

/** Tuesday 2026-10-13 in Chicago (CDT): local midnight to local midnight. */
const TUE_FROM = '2026-10-13T05:00:00.000Z';
const TUE_TO = '2026-10-14T05:00:00.000Z';
/** The seeded visit: 10:00-11:00 Chicago on that Tuesday. */
const VISIT_START = '2026-10-13T15:00:00.000Z';
const VISIT_END = '2026-10-13T16:00:00.000Z';

/** The 60-minute starts that a 30-minute buffer around 10:00-11:00 rules out: 09:00, 09:30, 10:00, 10:30, 11:00. */
const BLOCKED_BY_BUFFER = ['14:00', '14:30', '15:00', '15:30', '16:00'].map((h) => `2026-10-13T${h}:00.000Z`);

type Slot = { start: string; end: string; userIds: string[] };

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(new Date('2026-10-12T15:00:00.000Z'));
});

const A = () => t.seed.a.companyId;

/** GET /api/calendar/availability with the given query; `undefined` values are left out. */
async function availability(agent: SuperAgent, query: Record<string, string | undefined>) {
  const params = Object.fromEntries(Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined));
  return agent.get('/api/calendar/availability').query(params);
}

function slotsOf(body: unknown): Slot[] {
  return (body as { slots: Slot[] }).slots;
}

/** Makes two homes in company A through the API (the owner's address book). */
async function twoHomes() {
  const owner = await who.as('owner');
  const home1 = await mustCreate(owner, '/api/properties', addressFor(1));
  const home2 = await mustCreate(owner, '/api/properties', addressFor(2));
  return { home1: home1.id as string, home2: home2.id as string };
}

/** The rep's 10:00-11:00 visit at `propertyId`, written straight into the table. */
async function seedRepVisit(propertyId: string) {
  const repId = t.seed.a.rep.userId;
  await inCompany(t, A(), async (tx) => {
    await tx.insert(appointments).values({
      companyId: A(),
      kind: 'inspection',
      propertyId,
      assignedUserId: repId,
      startsAt: new Date(VISIT_START),
      endsAt: new Date(VISIT_END),
      status: 'scheduled',
      source: 'manual',
    });
  });
}

/** A calendar block for the rep (one connection, one event), written straight into the table. */
async function seedRepBusyBlock(startsAt: string, endsAt: string, allDay = false) {
  const repId = t.seed.a.rep.userId;
  await inCompany(t, A(), async (tx) => {
    const [connection] = await tx
      .insert(calendarConnections)
      .values({
        companyId: A(),
        userId: repId,
        provider: 'google',
        accountEmail: 'rep@example.test',
        calendarId: 'primary',
        calendarName: 'Work',
        encryptedCredentials: Buffer.from('not-a-real-token'),
      })
      .returning({ id: calendarConnections.id });
    await tx.insert(calendarBusyBlocks).values({
      companyId: A(),
      connectionId: connection!.id,
      userId: repId,
      providerEventId: 'event-1',
      startsAt: new Date(startsAt),
      endsAt: new Date(endsAt),
      allDay,
    });
  });
}

describe('the travel buffer between homes', () => {
  test('a visit at another home: no start from 09:00 to 11:00 is offered, but 08:30 and 11:30 are', async () => {
    const { home1, home2 } = await twoHomes();
    await seedRepVisit(home1);
    const owner = await who.as('owner');
    const res = await availability(owner, {
      kind: 'inspection',
      userId: t.seed.a.rep.userId,
      propertyId: home2,
      from: TUE_FROM,
      to: TUE_TO,
    });
    expect(res.status).toBe(200);
    const starts = slotsOf(res.body).map((s) => s.start);
    expect(starts).toContain('2026-10-13T13:30:00.000Z'); // 08:30, ends exactly 30 minutes before the visit
    expect(starts).toContain('2026-10-13T16:30:00.000Z'); // 11:30, 30 minutes after the visit ends
    for (const start of BLOCKED_BY_BUFFER) expect(starts).not.toContain(start);
  });

  test('the same home has no buffer: 09:00 and 11:00 are offered, 10:00 and 10:30 are not', async () => {
    const { home1 } = await twoHomes();
    await seedRepVisit(home1);
    const owner = await who.as('owner');
    const res = await availability(owner, {
      kind: 'inspection',
      userId: t.seed.a.rep.userId,
      propertyId: home1,
      from: TUE_FROM,
      to: TUE_TO,
    });
    expect(res.status).toBe(200);
    const starts = slotsOf(res.body).map((s) => s.start);
    expect(starts).toContain('2026-10-13T14:00:00.000Z'); // 09:00, ends exactly at the visit
    expect(starts).toContain('2026-10-13T16:00:00.000Z'); // 11:00, starts exactly at its end
    expect(starts).not.toContain(VISIT_START);
    expect(starts).not.toContain('2026-10-13T15:30:00.000Z');
  });

  test('a calendar busy block blocks its time and the buffer the same way', async () => {
    await seedRepBusyBlock(VISIT_START, VISIT_END);
    const owner = await who.as('owner');
    const res = await availability(owner, {
      kind: 'inspection',
      userId: t.seed.a.rep.userId,
      from: TUE_FROM,
      to: TUE_TO,
    });
    expect(res.status).toBe(200);
    const starts = slotsOf(res.body).map((s) => s.start);
    expect(starts).toContain('2026-10-13T13:30:00.000Z');
    expect(starts).toContain('2026-10-13T16:30:00.000Z');
    for (const start of BLOCKED_BY_BUFFER) expect(starts).not.toContain(start);
  });

  test('an all-day calendar block takes the whole local day', async () => {
    await seedRepBusyBlock(TUE_FROM, TUE_TO, true);
    const owner = await who.as('owner');
    const res = await availability(owner, {
      kind: 'inspection',
      userId: t.seed.a.rep.userId,
      from: TUE_FROM,
      to: TUE_TO,
    });
    expect(res.status).toBe(200);
    expect(slotsOf(res.body)).toEqual([]);
  });
});

describe('whose times a caller may check', () => {
  test('a rep asking for another member is refused with 403', async () => {
    const rep = await who.as('rep');
    for (const other of [t.seed.a.owner.userId, t.seed.a.otherRep.userId]) {
      const res = await availability(rep, { kind: 'inspection', userId: other, from: TUE_FROM, to: TUE_TO });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: OWN_TIMES });
    }
  });

  test('a rep asking for themselves gets their own times', async () => {
    const rep = await who.as('rep');
    const res = await availability(rep, { kind: 'inspection', userId: t.seed.a.rep.userId, from: TUE_FROM, to: TUE_TO });
    expect(res.status).toBe(200);
    expect(slotsOf(res.body).length).toBeGreaterThan(0);
    for (const slot of slotsOf(res.body)) expect(slot.userIds).toEqual([t.seed.a.rep.userId]);
  });

  test('a rep who names no member sees only their own times', async () => {
    const rep = await who.as('rep');
    const res = await availability(rep, { kind: 'inspection', from: TUE_FROM, to: TUE_TO });
    expect(res.status).toBe(200);
    const slots = slotsOf(res.body);
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) expect(slot.userIds).toEqual([t.seed.a.rep.userId]);
  });
});

describe('several members at once', () => {
  test('without a member, each slot lists everyone free at that start, sorted by start', async () => {
    const { home1 } = await twoHomes();
    await seedRepVisit(home1);
    const owner = await who.as('owner');
    const res = await availability(owner, { kind: 'inspection', from: TUE_FROM, to: TUE_TO });
    expect(res.status).toBe(200);
    const slots = slotsOf(res.body);

    const starts = slots.map((s) => s.start);
    expect(starts).toEqual([...starts].sort());
    for (const slot of slots) expect(Object.keys(slot).sort()).toEqual(['end', 'start', 'userIds']);

    const byStart = new Map(slots.map((s) => [s.start, s]));
    const everyone = [t.seed.a.owner.userId, t.seed.a.rep.userId, t.seed.a.otherRep.userId].sort();
    const withoutRep = [t.seed.a.owner.userId, t.seed.a.otherRep.userId].sort();

    const eight = byStart.get('2026-10-13T13:00:00.000Z');
    expect(eight).toBeDefined();
    expect(eight!.end).toBe('2026-10-13T14:00:00.000Z');
    expect([...eight!.userIds].sort()).toEqual(everyone);

    const ten = byStart.get(VISIT_START);
    expect(ten).toBeDefined();
    expect([...ten!.userIds].sort()).toEqual(withoutRep);
  });
});

describe('days across the daylight-saving change in Chicago', () => {
  test('Sunday 2026-11-01 has no default hours; Monday 2026-11-02 starts at 08:00 CST (14:00Z)', async () => {
    const owner = await who.as('owner');
    const res = await availability(owner, {
      kind: 'inspection',
      userId: t.seed.a.owner.userId,
      from: '2026-11-01T05:00:00.000Z', // Sunday midnight, still CDT
      to: '2026-11-03T06:00:00.000Z', // Tuesday midnight, CST
    });
    expect(res.status).toBe(200);
    const starts = slotsOf(res.body).map((s) => s.start);
    expect(starts.filter((s) => s < '2026-11-02T06:00:00.000Z')).toEqual([]);
    expect(starts[0]).toBe('2026-11-02T14:00:00.000Z');
  });

  test('Saturday 2026-10-31 (CDT, 08:00-12:00) then Monday (CST): each day keeps its own offset', async () => {
    const owner = await who.as('owner');
    const res = await availability(owner, {
      kind: 'inspection',
      userId: t.seed.a.owner.userId,
      from: '2026-10-31T05:00:00.000Z', // Saturday midnight, CDT
      to: '2026-11-03T06:00:00.000Z', // Tuesday midnight, CST
    });
    expect(res.status).toBe(200);
    const starts = slotsOf(res.body).map((s) => s.start);
    expect(starts.slice(0, 7)).toEqual([
      '2026-10-31T13:00:00.000Z', // 08:00 CDT
      '2026-10-31T13:30:00.000Z',
      '2026-10-31T14:00:00.000Z',
      '2026-10-31T14:30:00.000Z',
      '2026-10-31T15:00:00.000Z',
      '2026-10-31T15:30:00.000Z',
      '2026-10-31T16:00:00.000Z', // 11:00 CDT; a 60-minute visit must end by noon
    ]);
    expect(starts[7]).toBe('2026-11-02T14:00:00.000Z'); // Monday 08:00 CST
    expect(starts.slice(7).every((s) => s >= '2026-11-02T14:00:00.000Z')).toBe(true);
  });
});

describe('minimum notice from the app clock', () => {
  test('at 09:00 with two hours of notice nothing before 11:00 is offered; after the owner allows zero notice, 09:00 is', async () => {
    t.clock.set(new Date('2026-10-13T14:00:00.000Z')); // Tuesday 09:00 CDT
    const owner = await who.as('owner');
    const before = await availability(owner, {
      kind: 'inspection',
      userId: t.seed.a.owner.userId,
      from: TUE_FROM,
      to: TUE_TO,
    });
    expect(before.status).toBe(200);
    const earlyStarts = slotsOf(before.body)
      .map((s) => s.start)
      .filter((s) => s < '2026-10-13T16:00:00.000Z');
    expect(earlyStarts).toEqual([]);
    expect(slotsOf(before.body).map((s) => s.start)).toContain('2026-10-13T16:00:00.000Z');

    const put = await owner
      .put('/api/calendar/settings')
      .send({ workHours: DEFAULT_WORK_HOURS, travelBufferMinutes: 30, minNoticeMinutes: 0, stuckAfterDays: 14 });
    expect(put.status).toBe(200);

    const after = await availability(owner, {
      kind: 'inspection',
      userId: t.seed.a.owner.userId,
      from: TUE_FROM,
      to: TUE_TO,
    });
    const starts = slotsOf(after.body).map((s) => s.start);
    expect(starts).toContain('2026-10-13T14:00:00.000Z'); // 09:00
    expect(starts).toContain('2026-10-13T14:30:00.000Z'); // 09:30
  });
});

describe('validation of the query', () => {
  test('installs are booked by the day', async () => {
    const owner = await who.as('owner');
    const res = await availability(owner, { kind: 'install', from: TUE_FROM, to: TUE_TO });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Installs are booked by the day.', field: 'kind' });
  });

  test('a window longer than 14 days is refused; exactly 14 days is allowed', async () => {
    const owner = await who.as('owner');
    const tooLong = await availability(owner, { kind: 'inspection', from: TUE_FROM, to: '2026-10-28T05:00:00.000Z' });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.field).toBe('to');

    const fourteen = await availability(owner, { kind: 'inspection', from: TUE_FROM, to: '2026-10-27T05:00:00.000Z' });
    expect(fourteen.status).toBe(200);
  });

  test('from and to are required', async () => {
    const owner = await who.as('owner');
    const noFrom = await availability(owner, { kind: 'inspection', to: TUE_TO });
    expect(noFrom.status).toBe(400);
    expect(noFrom.body.field).toBe('from');

    const noTo = await availability(owner, { kind: 'inspection', from: TUE_FROM });
    expect(noTo.status).toBe(400);
    expect(noTo.body.field).toBe('to');
  });
});

describe('company B', () => {
  test('a company A member is not found from company B, and company B never lists company A members', async () => {
    const bOwner = await who.as('owner', 'b');

    const other = await availability(bOwner, {
      kind: 'inspection',
      userId: t.seed.a.rep.userId,
      from: TUE_FROM,
      to: TUE_TO,
    });
    expect(other.status).toBe(404);
    expect(other.body).toEqual({ error: NOT_FOUND });

    const all = await availability(bOwner, { kind: 'inspection', from: TUE_FROM, to: TUE_TO });
    expect(all.status).toBe(200);
    const bIds = new Set([t.seed.b.owner.userId, t.seed.b.rep.userId, t.seed.b.otherRep.userId]);
    const slots = slotsOf(all.body);
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.userIds.length).toBeGreaterThan(0);
      for (const id of slot.userIds) expect(bIds.has(id)).toBe(true);
    }
  });
});
