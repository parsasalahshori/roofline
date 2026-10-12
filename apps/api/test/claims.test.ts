import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { appointments, auditLog, claimIntakes, claims } from '@roofline/db';
import { Actors, addressFor, inCompany, mustCreate, NO_UUID } from './crm-helpers.ts';
import { makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

const NO_JOB = "We couldn't find that job.";

let t: TestApp;
let who: Actors;
let houses = 0;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  houses = 0;
});

const A = () => t.seed.a.companyId;

/** A customer, a house and a job made by `agent`, with optional job fields (for example assignedUserId). */
async function aJob(agent: SuperAgent, extra: Record<string, unknown> = {}) {
  houses += 1;
  const customer = await mustCreate(agent, '/api/customers', { displayName: `Customer ${houses}` });
  const property = await mustCreate(agent, '/api/properties', { customerId: customer.id, ...addressFor(houses) });
  return mustCreate(agent, '/api/jobs', { customerId: customer.id, propertyId: property.id, ...extra });
}

/** An owner's job, the usual case in these tests. */
async function ownerJob(extra: Record<string, unknown> = {}) {
  return aJob(await who.as('owner'), extra);
}

/** A claim's row as stored, read directly. */
const dbClaims = (companyId: string, jobId: string) =>
  inCompany(t, companyId, (tx) => tx.select().from(claims).where(eq(claims.jobId, jobId)));

describe('GET /api/jobs/:jobId/claim', () => {
  test('GET with an intake and no claim returns { claim: null, intake }', async () => {
    const job = await ownerJob();
    await inCompany(t, A(), (tx) =>
      tx.insert(claimIntakes).values({
        companyId: A(),
        jobId: job.id,
        insurer: 'Acme Mutual',
        claimNumber: 'C-1',
        dateOfLoss: '2026-09-30',
        description: 'Hail on the north slope',
        takenBy: 'front_desk',
      }),
    );

    const res = await (await who.as('owner')).get(`/api/jobs/${job.id}/claim`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      claim: null,
      intake: {
        insurer: 'Acme Mutual',
        claimNumber: 'C-1',
        dateOfLoss: '2026-09-30',
        description: 'Hail on the north slope',
        adjusterVisitAt: null,
      },
      packet: null,
    });
  });

  test('a job with nothing filed returns { claim: null, intake: null }', async () => {
    const job = await ownerJob();
    const res = await (await who.as('owner')).get(`/api/jobs/${job.id}/claim`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ claim: null, intake: null, packet: null });
  });
});

describe('PUT /api/jobs/:jobId/claim', () => {
  test('PUT creates the claim and returns its events', async () => {
    const job = await ownerJob();
    const owner = await who.as('owner');

    const res = await owner.put(`/api/jobs/${job.id}/claim`).send({ insurer: 'Acme Mutual', status: 'filed' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ jobId: job.id, insurer: 'Acme Mutual', status: 'filed' });
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({ from: null, to: 'filed', by: 'user' });

    expect(await dbClaims(A(), job.id)).toHaveLength(1);
    const audit = await inCompany(t, A(), (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'claim.created')));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.after)).not.toContain('Acme Mutual');
  });

  test('a status change adds history', async () => {
    const job = await ownerJob();
    const owner = await who.as('owner');
    await owner.put(`/api/jobs/${job.id}/claim`).send({ status: 'filed' }).expect(200);
    const res = await owner.put(`/api/jobs/${job.id}/claim`).send({ status: 'adjuster_scheduled' });

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    // Both events can share one clock instant, so look them up by status, not by position.
    const events = res.body.events as { from: string | null; to: string; by: string }[];
    expect(events.find((e) => e.to === 'filed')).toMatchObject({ from: null, by: 'user' });
    expect(events.find((e) => e.to === 'adjuster_scheduled')).toMatchObject({ from: 'filed', by: 'user' });
  });

  test("a rep cannot see another rep's job's claim (404)", async () => {
    const job = await ownerJob({ assignedUserId: who.user('otherRep').userId });
    const owner = await who.as('owner');
    await owner.put(`/api/jobs/${job.id}/claim`).send({ insurer: 'Acme Mutual' }).expect(200);

    const rep = await who.as('rep');
    const read = await rep.get(`/api/jobs/${job.id}/claim`);
    expect(read.status).toBe(404);
    expect(read.body.error).toBe(NO_JOB);

    const write = await rep.put(`/api/jobs/${job.id}/claim`).send({ notes: 'changed by the rep' });
    expect(write.status).toBe(404);
    expect(write.body.error).toBe(NO_JOB);

    expect((await dbClaims(A(), job.id))[0]).toMatchObject({ insurer: 'Acme Mutual', notes: null });
  });

  test('a rep sees and edits claims on their own job', async () => {
    const rep = await who.as('rep');
    const created = await aJob(rep);
    const assigned = await ownerJob({ assignedUserId: who.user('rep').userId });

    const put = await rep.put(`/api/jobs/${created.id}/claim`).send({ insurer: 'Acme Mutual', status: 'filed' });
    expect(put.status).toBe(200);
    expect(put.body.insurer).toBe('Acme Mutual');

    const read = await rep.get(`/api/jobs/${created.id}/claim`);
    expect(read.status).toBe(200);
    expect(read.body.claim).toMatchObject({ insurer: 'Acme Mutual', status: 'filed' });

    const assignedRead = await rep.get(`/api/jobs/${assigned.id}/claim`);
    expect(assignedRead.status).toBe(200);
    const assignedPut = await rep.put(`/api/jobs/${assigned.id}/claim`).send({ notes: 'Roof tarped' });
    expect(assignedPut.status).toBe(200);
    expect(assignedPut.body.notes).toBe('Roof tarped');
  });

  test('adjuster phone is stored in E.164', async () => {
    const job = await ownerJob();
    const owner = await who.as('owner');
    const res = await owner.put(`/api/jobs/${job.id}/claim`).send({ adjusterPhone: '(402) 555-0123' });
    expect(res.status).toBe(200);
    expect(res.body.adjusterPhone).toBe('+14025550123');
    expect((await dbClaims(A(), job.id))[0]!.adjusterPhone).toBe('+14025550123');
  });

  test('validation errors name the field', async () => {
    const job = await ownerJob();
    const otherJob = await ownerJob();
    const appointment = await inCompany(t, A(), (tx) =>
      tx
        .insert(appointments)
        .values({
          companyId: A(),
          kind: 'adjuster',
          jobId: otherJob.id,
          startsAt: new Date('2026-10-20T15:00:00.000Z'),
          endsAt: new Date('2026-10-20T16:00:00.000Z'),
        })
        .returning({ id: appointments.id }),
    );
    const owner = await who.as('owner');
    const cases: { name: string; body: Record<string, unknown>; field: string }[] = [
      { name: 'dateOfLoss 2026-13-40', body: { dateOfLoss: '2026-13-40' }, field: 'dateOfLoss' },
      { name: 'adjusterPhone abc', body: { adjusterPhone: 'abc' }, field: 'adjusterPhone' },
      { name: 'adjusterEmail nope', body: { adjusterEmail: 'nope' }, field: 'adjusterEmail' },
      { name: 'deductibleCents -1', body: { deductibleCents: -1 }, field: 'deductibleCents' },
      { name: 'deductibleCents 1.5', body: { deductibleCents: 1.5 }, field: 'deductibleCents' },
      { name: 'status bogus', body: { status: 'bogus' }, field: 'status' },
      { name: 'notes of 2001 characters', body: { notes: 'x'.repeat(2001) }, field: 'notes' },
      { name: 'insurer of 201 characters', body: { insurer: 'x'.repeat(201) }, field: 'insurer' },
      { name: 'claimNumber of 201 characters', body: { claimNumber: 'x'.repeat(201) }, field: 'claimNumber' },
      {
        name: 'adjusterAppointmentId of another job',
        body: { adjusterAppointmentId: appointment[0]!.id },
        field: 'adjusterAppointmentId',
      },
    ];

    const failures: unknown[] = [];
    for (const c of cases) {
      const res = await owner.put(`/api/jobs/${job.id}/claim`).send(c.body);
      if (res.status !== 400 || res.body.field !== c.field) failures.push({ case: c.name, status: res.status, body: res.body });
    }
    expect(failures).toEqual([]);
    expect(await dbClaims(A(), job.id)).toEqual([]);
  });

  test('unknown fields are refused', async () => {
    const job = await ownerJob();
    const owner = await who.as('owner');
    const bogus = await owner.put(`/api/jobs/${job.id}/claim`).send({ bogus: 1, notes: 'x' });
    expect(bogus.status).toBe(400);
    expect(bogus.body.field).toBe('bogus');

    const id = await owner.put(`/api/jobs/${job.id}/claim`).send({ id: NO_UUID, notes: 'x' });
    expect(id.status).toBe(400);
    expect(id.body.field).toBe('id');

    expect(await dbClaims(A(), job.id)).toEqual([]);
  });
});

describe('GET /api/claims (the board)', () => {
  test('board filters by status', async () => {
    const filedJob = await ownerJob();
    const closedJob = await ownerJob();
    const owner = await who.as('owner');
    await owner.put(`/api/jobs/${filedJob.id}/claim`).send({ status: 'filed' }).expect(200);
    await owner.put(`/api/jobs/${closedJob.id}/claim`).send({ status: 'closed' }).expect(200);

    const all = await owner.get('/api/claims');
    expect(all.status).toBe(200);
    expect(all.body.claims.map((c: { jobId: string }) => c.jobId).sort()).toEqual([filedJob.id, closedJob.id].sort());

    const res = await owner.get('/api/claims?status=filed');
    expect(res.status).toBe(200);
    expect(res.body.claims).toHaveLength(1);
    expect(res.body.claims[0]).toMatchObject({ jobId: filedJob.id, status: 'filed' });
  });

  test('board rejects an unknown status', async () => {
    const owner = await who.as('owner');
    const res = await owner.get('/api/claims?status=bogus');
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('status');
  });
});

describe('claims stay inside the company', () => {
  test('another company cannot see or edit the claim (404)', async () => {
    const job = await ownerJob();
    const owner = await who.as('owner');
    await owner.put(`/api/jobs/${job.id}/claim`).send({ insurer: 'Acme Mutual' }).expect(200);

    const other = await who.as('owner', 'b');
    const read = await other.get(`/api/jobs/${job.id}/claim`);
    expect(read.status).toBe(404);
    expect(read.body.error).toBe(NO_JOB);

    const write = await other.put(`/api/jobs/${job.id}/claim`).send({ notes: 'from company b' });
    expect(write.status).toBe(404);
    expect(write.body.error).toBe(NO_JOB);

    const board = await other.get('/api/claims');
    expect(board.body.claims).toEqual([]);

    expect((await dbClaims(A(), job.id))[0]).toMatchObject({ insurer: 'Acme Mutual', notes: null });
  });

  test('a claim on a job that does not exist is a 404 with the job message', async () => {
    const owner = await who.as('owner');
    const res = await owner.get(`/api/jobs/${NO_UUID}/claim`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe(NO_JOB);
  });
});
