import { beforeEach, describe, expect, test } from 'vitest';
import { calendarBusyBlocks, calendarConnections } from '@roofline/db';
import {
  Actors,
  addressFor,
  type CompanyKey,
  dbActivities,
  dbAudit,
  dbJob,
  inCompany,
  mustCreate,
  NO_UUID,
  NOT_FOUND,
  type Who,
} from './crm-helpers.ts';
import { makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

const NOT_ALLOWED = "Your role can't do that. Ask the owner.";
const HOME_MISMATCH = "That home isn't this customer's.";
const ORDER = 'The end must be after the start.';
const WINDOW = 'Please pick a window of 62 days or less.';
const INSPECTION_LINE = 'Moved to Inspection — inspection booked';

const NOW = new Date('2026-10-12T15:00:00.000Z');
/** Tuesday 2026-10-13, 2:00 PM to 3:00 PM in Chicago (CDT). */
const TUE_START = '2026-10-13T19:00:00.000Z';
const TUE_END = '2026-10-13T20:00:00.000Z';

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(NOW);
});

const A = () => t.seed.a.companyId;
const uid = (w: Who, company: CompanyKey = 'a') => who.user(w, company).userId;
const pushes = () => t.jobs.sent.filter((s) => s.name === 'calendar-push');

/** A customer with a house, and a job for that house. */
async function aJob(extra: Record<string, unknown> = {}, n = 0) {
  const owner = await who.as('owner');
  const customer = await mustCreate(owner, '/api/customers', { displayName: `Molly ${n}` });
  const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(n) });
  const job = await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id, ...extra });
  return { customer, property, job };
}

type Appt = { id: string };

/** Books an appointment and returns the 201 body's appointment (the POST answers { appointment, warnings, jobMoved }). */
async function book(agent: SuperAgent, body: Record<string, unknown>): Promise<Appt> {
  const created = await mustCreate(agent, '/api/appointments', body);
  return created.appointment as unknown as Appt;
}

/** Puts a busy block from an outside calendar on a user's connection (times only, as the pull writes it). */
async function addBusy(userId: string, startsAt: string, endsAt: string, allDay = false): Promise<void> {
  await inCompany(t, A(), async (tx) => {
    const [connection] = await tx
      .insert(calendarConnections)
      .values({
        companyId: A(),
        userId,
        provider: 'google',
        encryptedCredentials: Buffer.from('not-a-real-token'),
      })
      .returning({ id: calendarConnections.id });
    await tx.insert(calendarBusyBlocks).values({
      companyId: A(),
      connectionId: connection!.id,
      userId,
      providerEventId: `event-${startsAt}`,
      startsAt: new Date(startsAt),
      endsAt: new Date(endsAt),
      allDay,
    });
  });
}

describe('booking', () => {
  test('an inspection on a lead job books it, moves the job to Inspection and logs both lines', async () => {
    const owner = await who.as('owner');
    const { customer, property, job } = await aJob();
    const res = await owner.post('/api/appointments').send({
      kind: 'inspection',
      jobId: job.id,
      assignedUserId: uid('rep'),
      startsAt: TUE_START,
      endsAt: TUE_END,
    });
    expect(res.status).toBe(201);
    expect(res.body.jobMoved).toBe(true);
    expect(res.body.warnings).toEqual([]);
    expect(res.body.appointment).toMatchObject({
      kind: 'inspection',
      status: 'scheduled',
      jobId: job.id,
      customerId: customer.id,
      propertyId: property.id,
      startsAt: TUE_START,
      endsAt: TUE_END,
      allDay: false,
    });

    expect((await dbJob(t, A(), job.id)).stage).toBe('inspection');
    const summaries = (await dbActivities(t, A(), job.id)).map((a) => a.summary);
    expect(summaries).toContain(INSPECTION_LINE);
    expect(summaries).toContainEqual(expect.stringMatching(/^Inspection booked for /));

    const created = await dbAudit(t, A(), 'appointment.created');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ targetType: 'appointment', targetId: res.body.appointment.id });
  });

  test('an inspection on a job already in proposal books it but does not move the job', async () => {
    const owner = await who.as('owner');
    const { job } = await aJob({ stage: 'proposal' }, 1);
    const res = await owner.post('/api/appointments').send({ kind: 'inspection', jobId: job.id, startsAt: TUE_START, endsAt: TUE_END });
    expect(res.status).toBe(201);
    expect(res.body.jobMoved).toBe(false);
    expect((await dbJob(t, A(), job.id)).stage).toBe('proposal');
    const summaries = (await dbActivities(t, A(), job.id)).map((a) => a.summary);
    expect(summaries).not.toContain(INSPECTION_LINE);
    expect(summaries).toContainEqual(expect.stringMatching(/^Inspection booked for /));
  });

  test('a property that belongs to another customer is refused on propertyId', async () => {
    const owner = await who.as('owner');
    const molly = await mustCreate(owner, '/api/customers', { displayName: 'Molly Lindgren' });
    const bob = await mustCreate(owner, '/api/customers', { displayName: 'Bob Other' });
    const bobHouse = await mustCreate(owner, '/api/properties', { customerId: bob.id, ...addressFor(2) });
    const res = await owner.post('/api/appointments').send({
      kind: 'inspection',
      customerId: molly.id,
      propertyId: bobHouse.id,
      startsAt: TUE_START,
      endsAt: TUE_END,
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: HOME_MISMATCH, field: 'propertyId' });
  });

  test('a job of another customer is refused on jobId', async () => {
    const owner = await who.as('owner');
    const { job } = await aJob({}, 3);
    const bob = await mustCreate(owner, '/api/customers', { displayName: 'Bob Other' });
    const res = await owner.post('/api/appointments').send({
      kind: 'inspection',
      jobId: job.id,
      customerId: bob.id,
      startsAt: TUE_START,
      endsAt: TUE_END,
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: HOME_MISMATCH, field: 'jobId' });
  });

  test('an assignee who is not on the team is refused on assignedUserId', async () => {
    const owner = await who.as('owner');
    const res = await owner.post('/api/appointments').send({
      kind: 'inspection',
      assignedUserId: NO_UUID,
      startsAt: TUE_START,
      endsAt: TUE_END,
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Pick someone on your team.', field: 'assignedUserId' });
  });

  test('a customer who is not in this company is refused on customerId', async () => {
    const owner = await who.as('owner');
    const res = await owner.post('/api/appointments').send({
      kind: 'inspection',
      customerId: NO_UUID,
      startsAt: TUE_START,
      endsAt: TUE_END,
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('customerId');
  });

  test('an end that is not after the start is refused on endsAt', async () => {
    const owner = await who.as('owner');
    const equal = await owner.post('/api/appointments').send({ kind: 'inspection', startsAt: TUE_START, endsAt: TUE_START });
    expect(equal.status).toBe(400);
    expect(equal.body).toMatchObject({ error: ORDER, field: 'endsAt' });

    const before = await owner.post('/api/appointments').send({ kind: 'inspection', startsAt: TUE_START, endsAt: '2026-10-13T18:00:00.000Z' });
    expect(before.status).toBe(400);
    expect(before.body).toMatchObject({ error: ORDER, field: 'endsAt' });
  });

  test('an install with no allDay is all day and starts at the Chicago midnight', async () => {
    const owner = await who.as('owner');
    const res = await owner.post('/api/appointments').send({ kind: 'install', startsAt: '2026-10-13T15:00:00.000Z' });
    expect(res.status).toBe(201);
    expect(res.body.appointment).toMatchObject({ kind: 'install', allDay: true, startsAt: '2026-10-13T05:00:00.000Z' });
    expect(res.body.appointment.endsAt).toBe('2026-10-14T05:00:00.000Z');
  });

  test('an install with no end on the March DST day spans exactly that day', async () => {
    const owner = await who.as('owner');
    const res = await owner.post('/api/appointments').send({ kind: 'install', startsAt: '2026-03-08T15:00:00.000Z' });
    expect(res.status).toBe(201);
    expect(res.body.appointment).toMatchObject({
      allDay: true,
      startsAt: '2026-03-08T06:00:00.000Z',
      endsAt: '2026-03-09T05:00:00.000Z',
    });
  });

  test('an all-day install across the November DST change snaps to Chicago midnights', async () => {
    const owner = await who.as('owner');
    const res = await owner.post('/api/appointments').send({
      kind: 'install',
      startsAt: '2026-11-01T15:00:00.000Z',
      endsAt: '2026-11-01T23:00:00.000Z',
    });
    expect(res.status).toBe(201);
    expect(res.body.appointment).toMatchObject({
      allDay: true,
      startsAt: '2026-11-01T05:00:00.000Z',
      endsAt: '2026-11-02T06:00:00.000Z',
    });
  });

  test('an overlapping appointment for the same assignee is booked with a warning', async () => {
    const owner = await who.as('owner');
    const rep = uid('rep');
    const first = await owner.post('/api/appointments').send({ kind: 'inspection', assignedUserId: rep, startsAt: TUE_START, endsAt: TUE_END });
    expect(first.status).toBe(201);
    expect(first.body.warnings).toEqual([]);

    const second = await owner.post('/api/appointments').send({
      kind: 'inspection',
      assignedUserId: rep,
      startsAt: '2026-10-13T19:30:00.000Z',
      endsAt: '2026-10-13T20:30:00.000Z',
    });
    expect(second.status).toBe(201);
    expect(second.body.warnings).toHaveLength(1);
    expect(second.body.warnings[0]).toMatch(/already has an inspection/);
  });

  test('a busy block on the assignee calendar is a warning, and the appointment is still booked', async () => {
    const owner = await who.as('owner');
    const rep = uid('rep');
    await addBusy(rep, TUE_START, TUE_END);
    const res = await owner.post('/api/appointments').send({
      kind: 'inspection',
      assignedUserId: rep,
      startsAt: '2026-10-13T19:15:00.000Z',
      endsAt: '2026-10-13T19:45:00.000Z',
    });
    expect(res.status).toBe(201);
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0]).toMatch(/calendar shows busy/);
  });

  test('a PATCH that moves the times adds a "moved to" line and an audit row', async () => {
    const owner = await who.as('owner');
    const { job } = await aJob({ stage: 'proposal' }, 4);
    const created = await book(owner, { kind: 'inspection', jobId: job.id, startsAt: TUE_START, endsAt: TUE_END });
    const res = await owner.patch(`/api/appointments/${created.id}`).send({
      startsAt: '2026-10-14T15:00:00.000Z',
      endsAt: '2026-10-14T16:00:00.000Z',
    });
    expect(res.status).toBe(200);
    expect(res.body.appointment).toMatchObject({ startsAt: '2026-10-14T15:00:00.000Z', endsAt: '2026-10-14T16:00:00.000Z' });
    const summaries = (await dbActivities(t, A(), job.id)).map((a) => a.summary);
    expect(summaries).toContainEqual(expect.stringMatching(/moved to/));
    expect(await dbAudit(t, A(), 'appointment.updated')).toHaveLength(1);
  });
});

describe('status changes', () => {
  test('cancel, complete and no-show each set the status, add a line and write an audit row', async () => {
    const owner = await who.as('owner');
    const { job } = await aJob({ stage: 'proposal' }, 5);
    const link = { jobId: job.id, startsAt: TUE_START, endsAt: TUE_END };
    const canceled = await book(owner, { kind: 'inspection', ...link });
    const done = await book(owner, { kind: 'install', ...link, startsAt: '2026-10-14T19:00:00.000Z', endsAt: '2026-10-14T20:00:00.000Z', allDay: false });
    const missed = await book(owner, { kind: 'adjuster', ...link, startsAt: '2026-10-15T19:00:00.000Z', endsAt: '2026-10-15T20:00:00.000Z' });

    const c = await owner.post(`/api/appointments/${canceled.id}/cancel`).send({});
    expect(c.status).toBe(200);
    expect(c.body.status).toBe('canceled');
    const d = await owner.post(`/api/appointments/${done.id}/complete`).send({});
    expect(d.status).toBe(200);
    expect(d.body.status).toBe('completed');
    const n = await owner.post(`/api/appointments/${missed.id}/no-show`).send({});
    expect(n.status).toBe(200);
    expect(n.body.status).toBe('no_show');

    const summaries = (await dbActivities(t, A(), job.id)).map((a) => a.summary);
    expect(summaries).toContainEqual(expect.stringMatching(/canceled$/));
    expect(summaries).toContainEqual(expect.stringMatching(/marked done$/));
    expect(summaries).toContainEqual(expect.stringMatching(/no-show$/));

    expect(await dbAudit(t, A(), 'appointment.canceled')).toHaveLength(1);
    expect(await dbAudit(t, A(), 'appointment.completed')).toHaveLength(1);
    expect(await dbAudit(t, A(), 'appointment.no_show')).toHaveLength(1);
  });

  test('a canceled appointment leaves the list unless includeCanceled is set', async () => {
    const owner = await who.as('owner');
    const created = await book(owner, { kind: 'other', startsAt: TUE_START, endsAt: TUE_END });
    await owner.post(`/api/appointments/${created.id}/cancel`).send({});
    const query = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z' };

    const without = await owner.get('/api/appointments').query(query);
    expect(without.status).toBe(200);
    expect(without.body.appointments.map((a: { id: string }) => a.id)).not.toContain(created.id);

    const withCanceled = await owner.get('/api/appointments').query({ ...query, includeCanceled: 'true' });
    expect(withCanceled.body.appointments.map((a: { id: string }) => a.id)).toContain(created.id);
  });
});

describe('rep visibility', () => {
  /**
   * Hidden: an appointment on a job assigned to the other rep, and one assigned to the other rep with no job.
   * Visible to the rep: an appointment on an unassigned lead, and one assigned to the rep.
   */
  async function world() {
    const owner = await who.as('owner');
    const hiddenJob = await aJob({ assignedUserId: uid('otherRep'), stage: 'inspection' }, 6);
    const leadJob = await aJob({}, 7);
    const hidden = await book(owner, {
      kind: 'inspection',
      jobId: hiddenJob.job.id,
      startsAt: TUE_START,
      endsAt: TUE_END,
    });
    const hiddenPlain = await book(owner, {
      kind: 'other',
      assignedUserId: uid('otherRep'),
      startsAt: '2026-10-13T21:00:00.000Z',
      endsAt: '2026-10-13T22:00:00.000Z',
    });
    const onLead = await book(owner, {
      kind: 'other',
      jobId: leadJob.job.id,
      startsAt: '2026-10-13T16:00:00.000Z',
      endsAt: '2026-10-13T17:00:00.000Z',
    });
    const assignedToRep = await book(owner, {
      kind: 'other',
      assignedUserId: uid('rep'),
      startsAt: '2026-10-13T17:00:00.000Z',
      endsAt: '2026-10-13T18:00:00.000Z',
    });
    return { hidden, hiddenPlain, onLead, assignedToRep };
  }

  test('a rep sees their own appointments and those on jobs they can see, not the other rep\'s on a hidden job', async () => {
    const { hidden, hiddenPlain, onLead, assignedToRep } = await world();
    const rep = await who.as('rep');
    const list = await rep.get('/api/appointments').query({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z' });
    expect(list.status).toBe(200);
    const ids = list.body.appointments.map((a: { id: string }) => a.id);
    expect(ids).toContain(onLead.id);
    expect(ids).toContain(assignedToRep.id);
    expect(ids).not.toContain(hidden.id);
    expect(ids).not.toContain(hiddenPlain.id);

    const one = await rep.get(`/api/appointments/${hidden.id}`);
    expect(one.status).toBe(404);
    expect(one.body).toEqual({ error: NOT_FOUND });
    const other = await rep.get(`/api/appointments/${hiddenPlain.id}`);
    expect(other.status).toBe(404);
    expect(other.body).toEqual({ error: NOT_FOUND });
  });

  test('a rep may book an appointment for themselves', async () => {
    const rep = await who.as('rep');
    const res = await rep.post('/api/appointments').send({
      kind: 'other',
      assignedUserId: uid('rep'),
      startsAt: TUE_START,
      endsAt: TUE_END,
    });
    expect(res.status).toBe(201);
    expect(res.body.appointment).toMatchObject({ assigned: { userId: uid('rep') } });
  });

  test('a rep cannot assign an appointment to another member', async () => {
    const rep = await who.as('rep');
    const res = await rep.post('/api/appointments').send({
      kind: 'other',
      assignedUserId: uid('otherRep'),
      startsAt: TUE_START,
      endsAt: TUE_END,
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: NOT_ALLOWED });
  });

  test('a rep cannot read, change or cancel an appointment they cannot see (404)', async () => {
    const { hidden } = await world();
    const rep = await who.as('rep');
    expect((await rep.patch(`/api/appointments/${hidden.id}`).send({ notes: 'x' })).status).toBe(404);
    const cancel = await rep.post(`/api/appointments/${hidden.id}/cancel`).send({});
    expect(cancel.status).toBe(404);
    expect(cancel.body).toEqual({ error: NOT_FOUND });
  });

  test('a rep who booked an inspection on a lead job keeps editing it after the job moves out of their view', async () => {
    const { job } = await aJob({ stage: 'lead' }, 8);
    const rep = await who.as('rep');
    const booked = await rep.post('/api/appointments').send({
      kind: 'inspection',
      jobId: job.id,
      startsAt: TUE_START,
      endsAt: TUE_END,
    });
    expect(booked.status).toBe(201);
    expect(booked.body.jobMoved).toBe(true);
    const apptId = booked.body.appointment.id;

    const noted = await rep.patch(`/api/appointments/${apptId}`).send({ notes: 'x' });
    expect(noted.status).toBe(200);
    expect(noted.body.appointment).toMatchObject({ notes: 'x', jobId: job.id });

    const again = await rep.patch(`/api/appointments/${apptId}`).send({ jobId: job.id, notes: 'y' });
    expect(again.status).toBe(200);
    expect(again.body.appointment).toMatchObject({ notes: 'y', jobId: job.id });
  });
});

describe('calendar push', () => {
  test('an assigned appointment queues one calendar-push per create, PATCH and cancel', async () => {
    const owner = await who.as('owner');
    const rep = uid('rep');
    const created = await book(owner, { kind: 'other', assignedUserId: rep, startsAt: TUE_START, endsAt: TUE_END });
    expect(pushes()).toEqual([{ name: 'calendar-push', data: { companyId: A(), appointmentId: created.id }, singletonKey: created.id }]);

    await owner.patch(`/api/appointments/${created.id}`).send({ notes: 'Gate code on the door' });
    expect(pushes()).toHaveLength(2);

    await owner.post(`/api/appointments/${created.id}/cancel`).send({});
    expect(pushes()).toHaveLength(3);
    for (const push of pushes()) {
      expect(push).toMatchObject({ name: 'calendar-push', data: { companyId: A(), appointmentId: created.id }, singletonKey: created.id });
    }
  });

  test('an unassigned appointment queues no calendar-push', async () => {
    const owner = await who.as('owner');
    const created = await book(owner, { kind: 'other', startsAt: TUE_START, endsAt: TUE_END });
    await owner.patch(`/api/appointments/${created.id}`).send({ notes: 'No one yet' });
    await owner.post(`/api/appointments/${created.id}/complete`).send({});
    expect(pushes()).toHaveLength(0);
  });
});

describe('the list window and busy time', () => {
  test('a window longer than 62 days is refused', async () => {
    const owner = await who.as('owner');
    const res = await owner.get('/api/appointments').query({ from: '2026-10-01T00:00:00.000Z', to: '2026-12-15T00:00:00.000Z' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: WINDOW, field: 'to' });
  });

  test('withBusy=true returns the busy blocks in the same response', async () => {
    const rep = uid('rep');
    await addBusy(rep, TUE_START, TUE_END);
    const owner = await who.as('owner');
    const res = await owner.get('/api/appointments').query({
      from: '2026-10-13T00:00:00.000Z',
      to: '2026-10-14T00:00:00.000Z',
      userIds: rep,
      withBusy: 'true',
    });
    expect(res.status).toBe(200);
    expect(res.body.appointments).toEqual([]);
    expect(res.body.busy).toEqual([{ userId: rep, start: TUE_START, end: TUE_END, allDay: false }]);
  });
});

describe('company B', () => {
  test('company B gets 404 for another company\'s appointment and does not list it', async () => {
    const owner = await who.as('owner');
    const created = await book(owner, { kind: 'other', startsAt: TUE_START, endsAt: TUE_END });
    const ownerB = await who.as('owner', 'b');

    const got = await ownerB.get(`/api/appointments/${created.id}`);
    expect(got.status).toBe(404);
    expect(got.body).toEqual({ error: NOT_FOUND });
    expect((await ownerB.patch(`/api/appointments/${created.id}`).send({ notes: 'x' })).status).toBe(404);
    expect((await ownerB.post(`/api/appointments/${created.id}/cancel`).send({})).status).toBe(404);
    expect((await ownerB.get(`/api/appointments/${NO_UUID}`)).status).toBe(404);

    const list = await ownerB.get('/api/appointments').query({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z' });
    expect(list.body.appointments).toEqual([]);

    const stillThere = await owner.get(`/api/appointments/${created.id}`);
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.status).toBe('scheduled');
  });
});
