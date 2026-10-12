import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import { jobs } from '@roofline/db';
import { Actors, addressFor, inCompany, mustCreate, type Who } from './crm-helpers.ts';
import { makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

/** Monday 2026-10-12, 10:00 in Chicago (CDT). Chicago's day runs 05:00Z to 05:00Z. */
const MON = new Date('2026-10-12T15:00:00.000Z');

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(MON);
});

const A = () => t.seed.a.companyId;
const uid = (w: Who) => who.user(w).userId;

type Appt = { id: string; startsAt: string; endsAt: string; status: string };

/** Books an appointment (owner books for anyone) and returns the 201 body's appointment. */
async function book(owner: SuperAgent, body: Record<string, unknown>): Promise<Appt> {
  const created = await mustCreate(owner, '/api/appointments', body);
  return created.appointment as unknown as Appt;
}

/** Puts a job's next step date (the jobs API has no field for it). */
async function setNextStepOn(jobId: string, day: string): Promise<void> {
  await inCompany(t, A(), (tx) => tx.update(jobs).set({ nextStepOn: day }).where(eq(jobs.id, jobId)));
}

async function aJob(owner: SuperAgent, n: number, extra: Record<string, unknown>): Promise<string> {
  const customer = await mustCreate(owner, '/api/customers', { displayName: `Today Customer ${n}` });
  const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(n) });
  const job = await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id, ...extra });
  return job.id;
}

const ids = (list: { id: string }[]) => list.map((x) => x.id).sort();

describe("today's appointments", () => {
  test("the rep sees only their own non-canceled appointments for today in Chicago", async () => {
    const owner = await who.as('owner');
    const rep = uid('rep');
    const today = await book(owner, {
      kind: 'inspection',
      assignedUserId: rep,
      startsAt: '2026-10-12T17:00:00.000Z',
      endsAt: '2026-10-12T18:00:00.000Z',
    });
    await book(owner, {
      kind: 'inspection',
      assignedUserId: rep,
      startsAt: '2026-10-11T17:00:00.000Z',
      endsAt: '2026-10-11T18:00:00.000Z',
    });
    await book(owner, {
      kind: 'install',
      assignedUserId: rep,
      startsAt: '2026-10-13T17:00:00.000Z',
      endsAt: '2026-10-13T18:00:00.000Z',
      allDay: false,
    });
    const canceled = await book(owner, {
      kind: 'other',
      assignedUserId: rep,
      startsAt: '2026-10-12T19:00:00.000Z',
      endsAt: '2026-10-12T20:00:00.000Z',
    });
    await owner.post(`/api/appointments/${canceled.id}/cancel`).send({});
    await book(owner, {
      kind: 'inspection',
      assignedUserId: uid('otherRep'),
      startsAt: '2026-10-12T16:00:00.000Z',
      endsAt: '2026-10-12T17:00:00.000Z',
    });

    const rep1 = await who.as('rep');
    const res = await rep1.get('/api/today');
    expect(res.status).toBe(200);
    expect(res.body.appointments.map((a: Appt) => a.id)).toEqual([today.id]);
    expect(res.body.appointments[0]).toMatchObject({
      startsAt: '2026-10-12T17:00:00.000Z',
      endsAt: '2026-10-12T18:00:00.000Z',
      status: 'scheduled',
    });
  });

  test("a rep's follow-ups are their visible jobs due today or earlier, not later ones or another rep's", async () => {
    const owner = await who.as('owner');
    const dueToday = await aJob(owner, 1, { stage: 'inspection', assignedUserId: uid('rep') });
    const overdue = await aJob(owner, 2, { stage: 'proposal', assignedUserId: uid('rep') });
    const tomorrow = await aJob(owner, 3, { stage: 'inspection', assignedUserId: uid('rep') });
    const otherReps = await aJob(owner, 4, { stage: 'inspection', assignedUserId: uid('otherRep') });
    await setNextStepOn(dueToday, '2026-10-12');
    await setNextStepOn(overdue, '2026-10-09');
    await setNextStepOn(tomorrow, '2026-10-13');
    await setNextStepOn(otherReps, '2026-10-12');

    const rep = await who.as('rep');
    const res = await rep.get('/api/today');
    expect(res.status).toBe(200);
    expect(ids(res.body.followUps)).toEqual([dueToday, overdue].sort());
    const overdueCard = res.body.followUps.find((j: { id: string }) => j.id === overdue);
    expect(overdueCard).toMatchObject({ nextStepOn: '2026-10-09' });

    const other = await who.as('otherRep');
    const theirs = await other.get('/api/today');
    expect(ids(theirs.body.followUps)).toEqual([otherReps]);
  });

  test('a rep sees none of the other rep\'s appointments today', async () => {
    const owner = await who.as('owner');
    await book(owner, {
      kind: 'inspection',
      assignedUserId: uid('otherRep'),
      startsAt: '2026-10-12T17:00:00.000Z',
      endsAt: '2026-10-12T18:00:00.000Z',
    });
    const rep = await who.as('rep');
    const res = await rep.get('/api/today');
    expect(res.body.appointments).toEqual([]);
  });

  test('company B sees none of company A\'s appointments or follow-ups', async () => {
    const owner = await who.as('owner');
    const rep = uid('rep');
    await book(owner, { kind: 'inspection', assignedUserId: rep, startsAt: '2026-10-12T17:00:00.000Z', endsAt: '2026-10-12T18:00:00.000Z' });
    const job = await aJob(owner, 5, { stage: 'inspection', assignedUserId: rep });
    await setNextStepOn(job, '2026-10-12');

    const ownerB = await who.as('owner', 'b');
    const res = await ownerB.get('/api/today');
    expect(res.status).toBe(200);
    expect(res.body.appointments).toEqual([]);
    expect(res.body.followUps).toEqual([]);
  });

  test('a request with no session is refused', async () => {
    const res = await request(t.app).get('/api/today');
    expect(res.status).toBe(401);
  });
});

describe('daylight saving days', () => {
  /**
   * Chicago's day is the window from its local midnight to the next. For the March day, 00:30 is
   * 06:30Z (CST) and 23:30 is 04:30Z the next day (CDT); the 00:30 of the day after is not in it.
   */
  test('2026-03-08 (clocks go forward): 00:30 and 23:30 are today, the next day 00:30 is not', async () => {
    t.clock.set(new Date('2026-03-08T12:00:00.000Z'));
    const owner = await who.as('owner');
    const rep = uid('rep');
    const early = await book(owner, { kind: 'other', assignedUserId: rep, startsAt: '2026-03-08T06:30:00.000Z', endsAt: '2026-03-08T07:00:00.000Z' });
    const late = await book(owner, { kind: 'other', assignedUserId: rep, startsAt: '2026-03-09T04:30:00.000Z', endsAt: '2026-03-09T05:00:00.000Z' });
    await book(owner, { kind: 'other', assignedUserId: rep, startsAt: '2026-03-09T05:30:00.000Z', endsAt: '2026-03-09T06:00:00.000Z' });

    const res = await (await who.as('rep')).get('/api/today');
    expect(res.status).toBe(200);
    expect(ids(res.body.appointments)).toEqual([early.id, late.id].sort());
  });

  /**
   * On 2026-11-01 the clocks go back at 07:00Z. Chicago's day is 05:00Z to 06:00Z the next day: its
   * 00:30 is 05:30Z (CDT), its 23:30 is 05:30Z the next day (CST), and the next day's 00:30 is 06:30Z.
   */
  test('2026-11-01 (clocks go back): 00:30 and 23:30 are today, the next day 00:30 is not', async () => {
    t.clock.set(new Date('2026-11-01T12:00:00.000Z'));
    const owner = await who.as('owner');
    const rep = uid('rep');
    const early = await book(owner, { kind: 'other', assignedUserId: rep, startsAt: '2026-11-01T05:30:00.000Z', endsAt: '2026-11-01T06:00:00.000Z' });
    const late = await book(owner, { kind: 'other', assignedUserId: rep, startsAt: '2026-11-02T05:30:00.000Z', endsAt: '2026-11-02T05:59:00.000Z' });
    await book(owner, { kind: 'other', assignedUserId: rep, startsAt: '2026-11-02T06:30:00.000Z', endsAt: '2026-11-02T07:00:00.000Z' });

    const res = await (await who.as('rep')).get('/api/today');
    expect(res.status).toBe(200);
    expect(ids(res.body.appointments)).toEqual([early.id, late.id].sort());
  });
});
