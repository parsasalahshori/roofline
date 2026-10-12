import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  createJob,
  ForbiddenError,
  JobLinkError,
  jobLinkErrorFromPg,
  jobs,
  listJobs,
  memberships,
  type TenantContext,
  updateJob,
  withTenant,
} from '@roofline/db';
import { JOB_STAGES } from '@roofline/shared';
import {
  Actors,
  addressFor,
  dbActivities,
  dbAudit,
  dbJob,
  dbProperty,
  inCompany,
  mustCreate,
  NO_UUID,
  NOT_FOUND,
  timeline,
} from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import type { AppDeps } from '../src/app.ts';
import { InlineJobs, JOB_NAMES, type JobData, type JobHandlers, type JobMeta } from '../src/jobs/queue.ts';
import { SCHEDULES } from '../src/jobs/worker.ts';

const NO_CUSTOMER = "We couldn't find that customer.";
const NO_ADDRESS = "We couldn't find that address.";
const WRONG_CUSTOMER = 'That address belongs to a different customer.';
const PICK_CUSTOMER = 'Please pick a customer.';
const PICK_ADDRESS = 'Please pick an address.';
const NOT_ON_TEAM = 'Pick someone on your team.';
const BAD_STAGE = 'Please pick a valid stage.';
const BAD_SOURCE = 'Please pick a valid source.';
const BAD_VALUE = 'Please enter the job value in cents, as a whole number.';
const REASON_TOO_LONG = 'Please keep the reason to 500 characters or fewer.';
const NOTHING = "There's nothing to change.";
const CHECK_FIELD = 'Please check this field.';

const NOW = new Date('2026-10-12T15:00:00.000Z');

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(NOW);
});

const A = () => t.seed.a.companyId;

/** Molly, and her house on 100 Oak St. */
async function mollyAndHouse() {
  const owner = await who.as('owner');
  const customer = await mustCreate(owner, '/api/customers', { displayName: 'Molly Lindgren' });
  const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(0) });
  return { customer, property };
}

/** A job for Molly's house, made by the owner. */
async function aJob(extra: Record<string, unknown> = {}) {
  const { customer, property } = await mollyAndHouse();
  const job = await mustCreate(await who.as('owner'), '/api/jobs', {
    customerId: customer.id,
    propertyId: property.id,
    ...extra,
  });
  return { customer, property, job };
}

describe('creating a job', () => {
  test('a new job is a manual lead with nobody assigned, and the answer has the documented shape', async () => {
    const { customer, property } = await mollyAndHouse();
    const res = await (await who.as('owner')).post('/api/jobs').send({ customerId: customer.id, propertyId: property.id });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      customerId: customer.id,
      propertyId: property.id,
      stage: 'lead',
      stageLabel: 'Lead',
      stageChangedAt: '2026-10-12T15:00:00.000Z',
      source: 'manual',
      valueCents: null,
      assignedUserId: null,
      createdByUserId: who.user('owner').userId,
      lostReason: null,
      nextStep: null,
      nextStepOn: null,
      archivedAt: null,
      createdAt: '2026-10-12T15:00:00.000Z',
      updatedAt: '2026-10-12T15:00:00.000Z',
    });
    const stored = await dbJob(t, A(), res.body.id);
    expect(stored).toMatchObject({ stage: 'lead', source: 'manual', valueCents: null, stormId: null });
  });

  test('every field can be given at once', async () => {
    const { customer, property } = await mollyAndHouse();
    const res = await (await who.as('office')).post('/api/jobs').send({
      customerId: customer.id,
      propertyId: property.id,
      stage: 'proposal',
      source: 'referral',
      valueCents: 1_234_500,
      assignedUserId: who.user('rep').userId,
      lostReason: '  not this one  ',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      stage: 'proposal',
      stageLabel: 'Proposal',
      source: 'referral',
      valueCents: 1_234_500,
      assignedUserId: who.user('rep').userId,
      createdByUserId: who.user('office').userId,
      lostReason: 'not this one',
    });
  });

  test('the job and its customer both get a timeline line, and the audit log has the new job', async () => {
    const { customer, property, job } = await aJob();
    expect(await timeline(t, A(), job.id)).toEqual([['job.created', 'Job created']]);
    const customerLines = await timeline(t, A(), customer.id as string);
    expect(customerLines).toContainEqual(['job.created', 'New job: 100 Oak St']);
    const [line] = (await dbActivities(t, A(), customer.id as string)).filter((a) => a.kind === 'job.created');
    expect(line).toMatchObject({ subjectType: 'customer', data: { jobId: job.id, propertyId: property.id }, actorType: 'user' });
    expect(line!.at).toEqual(NOW);

    const [row] = await dbAudit(t, A(), 'job.create');
    expect(row).toMatchObject({ targetType: 'job', targetId: job.id, actorUserId: who.user('owner').userId, before: null });
    expect(row!.after).toMatchObject({ stage: 'lead', customerId: customer.id, propertyId: property.id });
    expect(row!.at).toEqual(NOW);
  });

  test('a job given someone to work it also gets an "Assigned to" line', async () => {
    const { job } = await aJob({ assignedUserId: who.user('rep').userId });
    expect(await timeline(t, A(), job.id)).toEqual([
      ['job.assigned', 'Assigned to Acme Rep'],
      ['job.created', 'Job created'],
    ]);
  });

  test('a job can start in a later stage; that is where it starts, not a move', async () => {
    const { job } = await aJob({ stage: 'won', valueCents: 500_000 });
    expect(job).toMatchObject({ stage: 'won', stageLabel: 'Won', stageChangedAt: '2026-10-12T15:00:00.000Z' });
    expect(await timeline(t, A(), job.id as string)).toEqual([['job.created', 'Job created']]);
  });

  test('a job cannot start lost without a reason', async () => {
    const { customer, property } = await mollyAndHouse();
    const res = await (await who.as('owner'))
      .post('/api/jobs')
      .send({ customerId: customer.id, propertyId: property.id, stage: 'lost' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Pick why the job was lost.', field: 'lostReason' });
  });

  test('uses the app clock for every time it records', async () => {
    t.clock.set(new Date('2026-11-01T08:15:00.000Z'));
    const { job } = await aJob();
    expect(job.createdAt).toBe('2026-11-01T08:15:00.000Z');
    const stored = await dbJob(t, A(), job.id as string);
    expect([stored.stageChangedAt, stored.createdAt, stored.updatedAt]).toEqual(Array(3).fill(new Date('2026-11-01T08:15:00.000Z')));
  });

  test('a house with no customer yet can take a job for any customer, and becomes that customer\'s', async () => {
    const owner = await who.as('owner');
    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Molly' });
    const property = await mustCreate(owner, '/api/properties', addressFor(1));
    const res = await owner.post('/api/jobs').send({ customerId: customer.id, propertyId: property.id });
    expect(res.status).toBe(201);
    expect((await dbProperty(t, A(), property.id)).customerId).toBe(customer.id);
  });

  test.each<[string, Record<string, unknown>, string, string]>([
    ['no customer', { customerId: undefined }, 'customerId', PICK_CUSTOMER],
    ['a customer that is not an id', { customerId: 'molly' }, 'customerId', NO_CUSTOMER],
    ['a number for a customer', { customerId: 5 }, 'customerId', PICK_CUSTOMER],
    ['no address', { propertyId: undefined }, 'propertyId', PICK_ADDRESS],
    ['an address that is not an id', { propertyId: '12 Oak' }, 'propertyId', NO_ADDRESS],
    ['an unknown stage', { stage: 'closed' }, 'stage', BAD_STAGE],
    ['a stage in capitals', { stage: 'LEAD' }, 'stage', BAD_STAGE],
    ['a null stage', { stage: null }, 'stage', BAD_STAGE],
    ['an unknown source', { source: 'fax' }, 'source', BAD_SOURCE],
    ['a negative value', { valueCents: -1 }, 'valueCents', BAD_VALUE],
    ['a fractional value', { valueCents: 10.5 }, 'valueCents', BAD_VALUE],
    ['a value in text', { valueCents: '5000' }, 'valueCents', BAD_VALUE],
    ['a value too big to store', { valueCents: 2_147_483_648 }, 'valueCents', BAD_VALUE],
    ['a reason that is too long', { lostReason: 'x'.repeat(501) }, 'lostReason', REASON_TOO_LONG],
    ['an assignee that is not an id', { assignedUserId: 'rep' }, 'assignedUserId', NOT_ON_TEAM],
    ['a field nobody knows', { colour: 'red' }, 'colour', CHECK_FIELD],
    ['a field that is only set by the system', { stormId: NO_UUID }, 'stormId', CHECK_FIELD],
  ])('%s → 400', async (_name, change, field, message) => {
    const { customer, property } = await mollyAndHouse();
    const res = await (await who.as('owner'))
      .post('/api/jobs')
      .send({ customerId: customer.id, propertyId: property.id, ...change });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: message, field });
    expect(await inCompany(t, A(), (tx) => tx.select().from(jobs))).toEqual([]);
  });

  test('a reason of exactly 500 characters is fine', async () => {
    const { job } = await aJob({ stage: 'lost', lostReason: 'x'.repeat(500) });
    expect((job.lostReason as string).length).toBe(500);
  });

  test('an empty body names the first thing that is missing', async () => {
    const res = await (await who.as('owner')).post('/api/jobs').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: PICK_CUSTOMER, field: 'customerId' });
  });

  describe('what the job points at', () => {
    test('a customer that does not exist → 400 on customerId', async () => {
      const { property } = await mollyAndHouse();
      const res = await (await who.as('owner')).post('/api/jobs').send({ customerId: NO_UUID, propertyId: property.id });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: NO_CUSTOMER, field: 'customerId' });
    });

    test('an address that does not exist → 400 on propertyId', async () => {
      const { customer } = await mollyAndHouse();
      const res = await (await who.as('owner')).post('/api/jobs').send({ customerId: customer.id, propertyId: NO_UUID });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: NO_ADDRESS, field: 'propertyId' });
    });

    test('an address that belongs to a different customer → 400 on propertyId', async () => {
      const { property } = await mollyAndHouse();
      const owner = await who.as('owner');
      const other = await mustCreate(owner, '/api/customers', { displayName: 'Someone else' });
      const res = await owner.post('/api/jobs').send({ customerId: other.id, propertyId: property.id });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: WRONG_CUSTOMER, field: 'propertyId' });
    });

    test("another company's customer and address look like ones that do not exist", async () => {
      const bOwner = await who.as('owner', 'b');
      const bCustomer = await mustCreate(bOwner, '/api/customers', { displayName: 'Their Molly' });
      const bHouse = await mustCreate(bOwner, '/api/properties', { customerId: bCustomer.id, ...addressFor(0) });
      const { customer, property } = await mollyAndHouse();
      const owner = await who.as('owner');
      const wrongCustomer = await owner.post('/api/jobs').send({ customerId: bCustomer.id, propertyId: property.id });
      expect(wrongCustomer.body).toEqual({ error: NO_CUSTOMER, field: 'customerId' });
      const wrongHouse = await owner.post('/api/jobs').send({ customerId: customer.id, propertyId: bHouse.id });
      expect(wrongHouse.body).toEqual({ error: NO_ADDRESS, field: 'propertyId' });
    });

    test.each<[string, () => string]>([
      ['someone who is not in the company', () => NO_UUID],
      ["another company's rep", () => who.user('rep', 'b').userId],
    ])('an assignee that is %s → 400 on assignedUserId', async (_name, pick) => {
      const { customer, property } = await mollyAndHouse();
      const res = await (await who.as('owner'))
        .post('/api/jobs')
        .send({ customerId: customer.id, propertyId: property.id, assignedUserId: pick() });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: NOT_ON_TEAM, field: 'assignedUserId' });
    });

    test('an assignee whose access is turned off is not on the team any more', async () => {
      const { customer, property } = await mollyAndHouse();
      await t.deps.pools.system
        .update(memberships)
        .set({ status: 'disabled' })
        .where(eq(memberships.userId, who.user('otherRep').userId));
      const res = await (await who.as('owner'))
        .post('/api/jobs')
        .send({ customerId: customer.id, propertyId: property.id, assignedUserId: who.user('otherRep').userId });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: NOT_ON_TEAM, field: 'assignedUserId' });
    });

    test('the owner, the office and the reps can all be assigned', async () => {
      const { customer, property } = await mollyAndHouse();
      const owner = await who.as('owner');
      for (const member of ['owner', 'office', 'rep', 'otherRep'] as const) {
        const res = await owner
          .post('/api/jobs')
          .send({ customerId: customer.id, propertyId: property.id, assignedUserId: who.user(member).userId });
        expect(res.status, member).toBe(201);
      }
    });
  });
});

describe('a job claims an address nobody owns yet', () => {
  const LINKED = 'Address linked to Rep customer';

  /** An address the owner saved with no customer, and a customer the rep made. */
  async function unowned() {
    const owner = await who.as('owner');
    const rep = await who.as('rep');
    const customer = await mustCreate(rep, '/api/customers', { displayName: 'Rep customer' });
    const property = await mustCreate(owner, '/api/properties', addressFor(0));
    return { owner, rep, customer, property };
  }

  test("a rep who sees the customer can open the address of the customer's job, and the timeline names nothing they can't open", async () => {
    const { owner, rep, customer, property } = await unowned();
    // Before the job, the rep can see neither the address nor anything about it.
    expect((await rep.get(`/api/properties/${property.id}`)).status).toBe(404);

    const job = await mustCreate(owner, '/api/jobs', {
      customerId: customer.id,
      propertyId: property.id,
      assignedUserId: who.user('otherRep').userId,
    });
    expect((await dbProperty(t, A(), property.id)).customerId).toBe(customer.id);
    expect((await rep.get(`/api/jobs/${job.id}`)).status).toBe(404); // someone else's job

    const address = await rep.get(`/api/properties/${property.id}`);
    expect(address.status).toBe(200);
    expect(address.body).toMatchObject({ customerId: customer.id, addressLine: '100 Oak St' });

    const lines = await rep.get(`/api/activities?subjectType=customer&subjectId=${customer.id}`);
    expect(lines.status).toBe(200);
    const newJob = lines.body.activities.find((a: { kind: string }) => a.kind === 'job.created');
    expect(newJob).toMatchObject({ summary: 'New job: 100 Oak St', data: { jobId: job.id, propertyId: property.id } });
    // ... and that address is one the rep can open, with its own timeline.
    const timelineOfAddress = await rep.get(`/api/activities?subjectType=property&subjectId=${newJob.data.propertyId}`);
    expect(timelineOfAddress.status).toBe(200);
  });

  test('the change is audited and on the address timeline, in the same time as the job', async () => {
    const { owner, customer, property } = await unowned();
    t.clock.set(new Date('2026-10-14T09:30:00.000Z'));
    await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id });
    const [row] = await dbAudit(t, A(), 'property.update');
    expect(row).toMatchObject({ targetType: 'property', targetId: property.id, actorUserId: who.user('owner').userId });
    expect(row!.before).toEqual({ customerId: null });
    expect(row!.after).toEqual({ customerId: customer.id });
    expect(row!.at).toEqual(new Date('2026-10-14T09:30:00.000Z'));
    expect(await timeline(t, A(), property.id)).toEqual([
      ['property.created', 'Address added'],
      ['property.updated', LINKED],
    ]);
    const stored = await dbProperty(t, A(), property.id);
    expect(stored.updatedAt).toEqual(new Date('2026-10-14T09:30:00.000Z'));
  });

  test('an address the customer already owns is left alone: no change, no audit row, no timeline line', async () => {
    const { owner, customer } = await unowned();
    const owned = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(1) });
    t.clock.set(new Date('2026-10-14T09:30:00.000Z'));
    await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: owned.id });
    await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: owned.id });
    const stored = await dbProperty(t, A(), owned.id);
    expect(stored.updatedAt).toEqual(new Date('2026-10-12T15:00:00.000Z'));
    expect(await dbAudit(t, A(), 'property.update')).toEqual([]);
    expect(await timeline(t, A(), owned.id)).toEqual([['property.created', 'Address added']]);
  });

  test('a second job for the same customer does not link it again', async () => {
    const { owner, customer, property } = await unowned();
    await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id });
    await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id });
    expect(await dbAudit(t, A(), 'property.update')).toHaveLength(1);
    expect((await timeline(t, A(), property.id)).filter(([kind]) => kind === 'property.updated')).toHaveLength(1);
  });

  test('an address that belongs to a different customer is still the 400 on propertyId, and is not changed', async () => {
    const { owner, customer } = await unowned();
    const sam = await mustCreate(owner, '/api/customers', { displayName: 'Sam' });
    const samsHouse = await mustCreate(owner, '/api/properties', { customerId: sam.id, ...addressFor(2) });
    const res = await owner.post('/api/jobs').send({ customerId: customer.id, propertyId: samsHouse.id });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: WRONG_CUSTOMER, field: 'propertyId' });
    expect((await dbProperty(t, A(), samsHouse.id)).customerId).toBe(sam.id);
    expect(await dbAudit(t, A(), 'property.update')).toEqual([]);
  });

  test('a job that fails for another reason leaves the address as it was', async () => {
    const { owner, customer, property } = await unowned();
    const res = await owner
      .post('/api/jobs')
      .send({ customerId: customer.id, propertyId: property.id, assignedUserId: NO_UUID });
    expect(res.status).toBe(400);
    expect((await dbProperty(t, A(), property.id)).customerId).toBeNull();
    expect(await dbAudit(t, A(), 'property.update')).toEqual([]);
  });

  test('moving a job to an address nobody owns claims that address for the job\'s customer', async () => {
    const { owner, customer, property } = await unowned();
    const first = await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id });
    const second = await mustCreate(owner, '/api/properties', addressFor(3));
    const res = await owner.patch(`/api/jobs/${first.id}`).send({ propertyId: second.id });
    expect(res.status).toBe(200);
    expect((await dbProperty(t, A(), second.id)).customerId).toBe(customer.id);
    expect((await dbAudit(t, A(), 'property.update')).map((r) => r.targetId).sort()).toEqual([property.id, second.id].sort());

    // A failed move claims nothing.
    const third = await mustCreate(owner, '/api/properties', addressFor(4));
    const bad = await owner.patch(`/api/jobs/${first.id}`).send({ propertyId: third.id, assignedUserId: NO_UUID });
    expect(bad.status).toBe(400);
    expect((await dbProperty(t, A(), third.id)).customerId).toBeNull();
  });

  test('two jobs for different customers made at the same moment at one unowned address: one wins, the other is a 400, never a 500', async () => {
    const { owner, customer, property } = await unowned();
    const other = await mustCreate(owner, '/api/customers', { displayName: 'Other' });
    const office = await who.as('office');
    const results = await Promise.all([
      owner.post('/api/jobs').send({ customerId: customer.id, propertyId: property.id }),
      office.post('/api/jobs').send({ customerId: other.id, propertyId: property.id }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    const [winner] = results.filter((r) => r.status === 201);
    const [loser] = results.filter((r) => r.status === 400);
    expect(loser!.body).toEqual({ error: WRONG_CUSTOMER, field: 'propertyId' });
    expect((await dbProperty(t, A(), property.id)).customerId).toBe(winner!.body.customerId);
    expect(await inCompany(t, A(), (tx) => tx.select().from(jobs))).toHaveLength(1);
    expect(await dbAudit(t, A(), 'property.update')).toHaveLength(1);
  });

  test('two jobs for the same customer made at the same moment: both are saved, the address is linked once', async () => {
    const { owner, customer, property } = await unowned();
    const office = await who.as('office');
    const results = await Promise.all([
      owner.post('/api/jobs').send({ customerId: customer.id, propertyId: property.id }),
      office.post('/api/jobs').send({ customerId: customer.id, propertyId: property.id }),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(await dbAudit(t, A(), 'property.update')).toHaveLength(1);
  });
});

describe('changing a job', () => {
  test('moving lead → inspection stamps the stage time from the app clock and adds "Moved to Inspection"', async () => {
    const { job } = await aJob();
    t.clock.set(new Date('2026-10-14T09:30:00.000Z'));
    const res = await (await who.as('office')).patch(`/api/jobs/${job.id}`).send({ stage: 'inspection' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      stage: 'inspection',
      stageLabel: 'Inspection',
      stageChangedAt: '2026-10-14T09:30:00.000Z',
      updatedAt: '2026-10-14T09:30:00.000Z',
      createdAt: '2026-10-12T15:00:00.000Z',
    });
    expect((await dbJob(t, A(), job.id as string)).stageChangedAt).toEqual(new Date('2026-10-14T09:30:00.000Z'));

    const lines = (await dbActivities(t, A(), job.id as string)).filter((a) => a.kind === 'job.stage_changed');
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({
      subjectType: 'job',
      summary: 'Moved to Inspection',
      data: { from: 'lead', to: 'inspection' },
      actorType: 'user',
      actorUserId: who.user('office').userId,
    });
    expect(lines[0]!.at).toEqual(new Date('2026-10-14T09:30:00.000Z'));
  });

  test.each([
    ['lead', 'Lead'],
    ['inspection', 'Inspection'],
    ['proposal', 'Proposal'],
    ['won', 'Won'],
    ['installed', 'Installed'],
    ['lost', 'Lost'],
  ] as const)('moving to %s says "Moved to %s"', async (stage, label) => {
    // Start from a different stage than the one moved to, so the move is real (Installed comes from Won).
    // Every job carries a value, and Lost a reason, as the stage rules require.
    const start = stage === 'proposal' || stage === 'installed' ? 'won' : 'proposal';
    const { job } = await aJob({ stage: start, valueCents: 500_000 });
    const res = await (await who.as('owner'))
      .patch(`/api/jobs/${job.id}`)
      .send({ stage, ...(stage === 'lost' ? { lostReason: 'Went elsewhere' } : {}) });
    expect(res.status).toBe(200);
    expect(res.body.stageLabel).toBe(label);
    expect(await timeline(t, A(), job.id as string)).toContainEqual(['job.stage_changed', `Moved to ${label}`]);
  });

  test('every stage in the shared list has a label', async () => {
    // In list order (lead, inspection, proposal, won, installed, lost), which the stage rules allow
    // when the job has a value and Lost gets a reason.
    const { job } = await aJob({ valueCents: 500_000 });
    const owner = await who.as('owner');
    for (const stage of JOB_STAGES) {
      const res = await owner
        .patch(`/api/jobs/${job.id}`)
        .send({ stage, ...(stage === 'lost' ? { lostReason: 'Went elsewhere' } : {}) });
      expect(res.status, stage).toBe(200);
      expect(res.body.stageLabel).toMatch(/^[A-Z][a-z]+$/);
    }
  });

  test('an invalid stage → 400 on stage, and nothing changes', async () => {
    const { job } = await aJob();
    const res = await (await who.as('owner')).patch(`/api/jobs/${job.id}`).send({ stage: 'closed' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: BAD_STAGE, field: 'stage' });
    expect((await dbJob(t, A(), job.id as string)).stage).toBe('lead');
    expect(await dbAudit(t, A(), 'job.update')).toEqual([]);
  });

  test('sending the stage it already has changes nothing: same stage time, no "Moved to" line', async () => {
    const { job } = await aJob({ stage: 'proposal' });
    t.clock.set(new Date('2026-10-14T09:30:00.000Z'));
    const res = await (await who.as('owner')).patch(`/api/jobs/${job.id}`).send({ stage: 'proposal' });
    expect(res.status).toBe(200);
    expect(res.body.stageChangedAt).toBe('2026-10-12T15:00:00.000Z');
    expect(await timeline(t, A(), job.id as string)).toEqual([['job.created', 'Job created']]);
  });

  test('every PATCH is audited with the fields it named, before and after', async () => {
    const { job } = await aJob({ valueCents: 500_000 });
    t.clock.set(new Date('2026-10-14T09:30:00.000Z'));
    await (await who.as('owner')).patch(`/api/jobs/${job.id}`).send({ stage: 'won', valueCents: 750_000 });
    const [row] = await dbAudit(t, A(), 'job.update');
    expect(row).toMatchObject({ targetType: 'job', targetId: job.id, actorUserId: who.user('owner').userId });
    expect(row!.before).toEqual({ stage: 'lead', stageChangedAt: '2026-10-12T15:00:00.000Z', valueCents: 500_000 });
    expect(row!.after).toEqual({ stage: 'won', stageChangedAt: '2026-10-14T09:30:00.000Z', valueCents: 750_000 });
    expect(row!.at).toEqual(new Date('2026-10-14T09:30:00.000Z'));

    // Even a PATCH that changes nothing leaves a row.
    await (await who.as('owner')).patch(`/api/jobs/${job.id}`).send({ valueCents: 750_000 });
    expect((await dbAudit(t, A(), 'job.update')).length).toBe(2);
  });

  test('changing the value, source or reason writes no timeline line', async () => {
    const { job } = await aJob();
    const res = await (await who.as('owner'))
      .patch(`/api/jobs/${job.id}`)
      .send({ valueCents: 1_000_000, source: 'web', lostReason: 'changed my mind' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valueCents: 1_000_000, source: 'web', lostReason: 'changed my mind' });
    expect(await timeline(t, A(), job.id as string)).toEqual([['job.created', 'Job created']]);
  });

  test('a lost reason can be set, cleared with null, and is limited to 500 characters', async () => {
    const { job } = await aJob();
    const owner = await who.as('owner');
    const lost = await owner.patch(`/api/jobs/${job.id}`).send({ stage: 'lost', lostReason: 'Went with a cheaper roofer' });
    expect(lost.body).toMatchObject({ stage: 'lost', lostReason: 'Went with a cheaper roofer' });
    expect((await owner.patch(`/api/jobs/${job.id}`).send({ lostReason: null })).body.lostReason).toBeNull();
    expect((await owner.patch(`/api/jobs/${job.id}`).send({ lostReason: '   ' })).body.lostReason).toBeNull();
    const tooLong = await owner.patch(`/api/jobs/${job.id}`).send({ lostReason: 'x'.repeat(501) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body).toEqual({ error: REASON_TOO_LONG, field: 'lostReason' });
  });

  test('moving a job away from lost clears its reason in the same update, and the audit shows it', async () => {
    const { job } = await aJob({ stage: 'lost', lostReason: 'Went with a cheaper roofer' });
    t.clock.set(new Date('2026-10-14T09:30:00.000Z'));
    const res = await (await who.as('owner')).patch(`/api/jobs/${job.id}`).send({ stage: 'inspection' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stage: 'inspection', lostReason: null });
    expect((await dbJob(t, A(), job.id as string)).lostReason).toBeNull();
    const [row] = await dbAudit(t, A(), 'job.update');
    expect(row!.before).toEqual({ stage: 'lost', stageChangedAt: '2026-10-12T15:00:00.000Z', lostReason: 'Went with a cheaper roofer' });
    expect(row!.after).toEqual({ stage: 'inspection', stageChangedAt: '2026-10-14T09:30:00.000Z', lostReason: null });
  });

  test('a reason sent along with the move away from lost is cleared as well', async () => {
    const { job } = await aJob({ stage: 'lost', lostReason: 'Went elsewhere' });
    const res = await (await who.as('owner')).patch(`/api/jobs/${job.id}`).send({ stage: 'lead', lostReason: 'Still here' });
    expect(res.status).toBe(200);
    expect(res.body.lostReason).toBeNull();
  });

  test('the reason is kept when the job moves into lost, stays lost, or never was lost', async () => {
    const { job } = await aJob({ lostReason: 'A note on a lead' });
    const owner = await who.as('owner');
    // Never lost: moving it on leaves the note alone.
    expect((await owner.patch(`/api/jobs/${job.id}`).send({ stage: 'proposal' })).body.lostReason).toBe('A note on a lead');
    // Into lost with a new reason.
    const lost = await owner.patch(`/api/jobs/${job.id}`).send({ stage: 'lost', lostReason: 'Too expensive' });
    expect(lost.body.lostReason).toBe('Too expensive');
    // Staying lost (stage sent again, or only the reason edited) keeps it.
    expect((await owner.patch(`/api/jobs/${job.id}`).send({ stage: 'lost' })).body.lostReason).toBe('Too expensive');
    expect((await owner.patch(`/api/jobs/${job.id}`).send({ lostReason: 'Too expensive for now' })).body.lostReason).toBe(
      'Too expensive for now',
    );
    // Leaving Lost clears the reason.
    const other = await mustCreate(owner, '/api/jobs', {
      customerId: job.customerId,
      propertyId: job.propertyId,
      stage: 'lost',
      lostReason: 'Went elsewhere',
    });
    expect((await owner.patch(`/api/jobs/${other.id}`).send({ stage: 'won', valueCents: 1 })).body).toMatchObject({
      stage: 'won',
      lostReason: null,
    });
  });

  test('the value can be cleared with null', async () => {
    const { job } = await aJob({ valueCents: 500_000 });
    const res = await (await who.as('owner')).patch(`/api/jobs/${job.id}`).send({ valueCents: null });
    expect(res.status).toBe(200);
    expect(res.body.valueCents).toBeNull();
  });

  test('assigning, reassigning and unassigning each leave a line that names the person', async () => {
    const { job } = await aJob();
    const owner = await who.as('owner');
    t.clock.set(new Date('2026-10-13T10:00:00.000Z'));
    expect((await owner.patch(`/api/jobs/${job.id}`).send({ assignedUserId: who.user('rep').userId })).body.assignedUserId).toBe(
      who.user('rep').userId,
    );
    t.clock.set(new Date('2026-10-13T11:00:00.000Z'));
    await owner.patch(`/api/jobs/${job.id}`).send({ assignedUserId: who.user('otherRep').userId });
    t.clock.set(new Date('2026-10-13T12:00:00.000Z'));
    const cleared = await owner.patch(`/api/jobs/${job.id}`).send({ assignedUserId: null });
    expect(cleared.body.assignedUserId).toBeNull();

    const lines = (await dbActivities(t, A(), job.id as string))
      .filter((a) => a.kind === 'job.assigned')
      .sort((x, y) => x.at.getTime() - y.at.getTime());
    expect(lines.map((l) => l.summary)).toEqual(['Assigned to Acme Rep', 'Assigned to Acme Rep Two', 'Unassigned']);
    expect(lines[0]!.data).toEqual({ from: null, to: who.user('rep').userId });
    expect(lines[2]!.data).toEqual({ from: who.user('otherRep').userId, to: null });
  });

  test('sending the assignee it already has writes no "Assigned" line', async () => {
    const { customer, property, job } = await aJob({ assignedUserId: who.user('rep').userId });
    const owner = await who.as('owner');
    await owner.patch(`/api/jobs/${job.id}`).send({ assignedUserId: who.user('rep').userId });
    const unassigned = await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id });
    await owner.patch(`/api/jobs/${unassigned.id}`).send({ assignedUserId: null });
    expect((await timeline(t, A(), job.id as string)).filter(([k]) => k === 'job.assigned').length).toBe(1);
    expect((await timeline(t, A(), unassigned.id as string)).filter(([k]) => k === 'job.assigned').length).toBe(0);
  });

  test('assigning someone who is not on the team → 400 on assignedUserId, and nothing changes', async () => {
    const { job } = await aJob();
    const res = await (await who.as('owner')).patch(`/api/jobs/${job.id}`).send({ assignedUserId: who.user('rep', 'b').userId });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: NOT_ON_TEAM, field: 'assignedUserId' });
    expect((await dbJob(t, A(), job.id as string)).assignedUserId).toBeNull();
  });

  test('a job can be moved to another customer and address, under the same rules as creating one', async () => {
    const { job } = await aJob();
    const owner = await who.as('owner');
    const sam = await mustCreate(owner, '/api/customers', { displayName: 'Sam' });
    const samsHouse = await mustCreate(owner, '/api/properties', { customerId: sam.id, ...addressFor(5) });

    const mismatch = await owner.patch(`/api/jobs/${job.id}`).send({ propertyId: samsHouse.id });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body).toEqual({ error: WRONG_CUSTOMER, field: 'propertyId' });
    const gone = await owner.patch(`/api/jobs/${job.id}`).send({ customerId: NO_UUID });
    expect(gone.body).toEqual({ error: NO_CUSTOMER, field: 'customerId' });
    const noHouse = await owner.patch(`/api/jobs/${job.id}`).send({ propertyId: NO_UUID });
    expect(noHouse.body).toEqual({ error: NO_ADDRESS, field: 'propertyId' });

    const moved = await owner.patch(`/api/jobs/${job.id}`).send({ customerId: sam.id, propertyId: samsHouse.id });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ customerId: sam.id, propertyId: samsHouse.id });
    // Changing only the customer is checked against the address the job already has.
    const half = await owner.patch(`/api/jobs/${job.id}`).send({ customerId: job.customerId });
    expect(half.body).toEqual({ error: WRONG_CUSTOMER, field: 'propertyId' });
  });

  test('an empty body, an unknown field and a system-only field are refused', async () => {
    const { job } = await aJob();
    const owner = await who.as('owner');
    expect((await owner.patch(`/api/jobs/${job.id}`).send({})).body).toEqual({ error: NOTHING });
    expect((await owner.patch(`/api/jobs/${job.id}`).send({ colour: 'red' })).body).toEqual({ error: CHECK_FIELD, field: 'colour' });
    for (const field of ['id', 'createdByUserId', 'stageChangedAt', 'archivedAt', 'stormId']) {
      const res = await owner.patch(`/api/jobs/${job.id}`).send({ [field]: NO_UUID });
      expect(res.status, field).toBe(400);
      expect(res.body, field).toEqual({ error: CHECK_FIELD, field });
    }
  });

  test('a job that does not exist, or an id that is not one, is a 404', async () => {
    const owner = await who.as('owner');
    for (const id of [NO_UUID, 'not-an-id']) {
      for (const res of [
        await owner.get(`/api/jobs/${id}`),
        await owner.patch(`/api/jobs/${id}`).send({ stage: 'won' }),
        await owner.post(`/api/jobs/${id}/archive`),
        await owner.post(`/api/jobs/${id}/unarchive`),
      ]) {
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: NOT_FOUND });
      }
    }
  });
});

describe('the foreign-key backstop', () => {
  const pgError = (constraint: string) => Object.assign(new Error('Failed query'), { cause: { code: '23503', constraint } });

  test.each([
    ['jobs_company_customer_fk', 'customer'],
    ['jobs_company_property_fk', 'property'],
    ['jobs_assigned_user_id_users_id_fk', 'assignee'],
  ] as const)('a foreign-key failure on %s becomes a "%s" problem', (constraint, problem) => {
    const mapped = jobLinkErrorFromPg(pgError(constraint));
    expect(mapped).toBeInstanceOf(JobLinkError);
    expect(mapped?.problem).toBe(problem);
  });

  test("the constraint names above are the database's own: real failures map to the right link", async () => {
    const { customer, property } = await mollyAndHouse();
    const insert = (values: Partial<typeof jobs.$inferInsert>) =>
      inCompany(t, A(), (tx) =>
        tx.insert(jobs).values({ companyId: A(), customerId: customer.id as string, propertyId: property.id as string, ...values }),
      ).then(
        () => undefined,
        (err: unknown) => jobLinkErrorFromPg(err)?.problem,
      );
    expect(await insert({ customerId: NO_UUID })).toBe('customer');
    expect(await insert({ propertyId: NO_UUID })).toBe('property');
    expect(await insert({ assignedUserId: NO_UUID })).toBe('assignee');
    // A company-B customer is a foreign-key failure too: the same-company key does not find it.
    const bCustomer = await mustCreate(await who.as('owner', 'b'), '/api/customers', { displayName: 'Theirs' });
    expect(await insert({ customerId: bCustomer.id })).toBe('customer');
  });

  test('anything else is left alone', () => {
    expect(jobLinkErrorFromPg(pgError('jobs_created_by_user_id_users_id_fk'))).toBeUndefined();
    expect(jobLinkErrorFromPg(new Error('boom'))).toBeUndefined();
    expect(jobLinkErrorFromPg({ cause: { code: '23505', constraint: 'jobs_company_customer_fk' } })).toBeUndefined();
  });
});

describe('opening and listing jobs', () => {
  test('GET /:id answers with the same shape as the create', async () => {
    const { job } = await aJob({ valueCents: 42_00 });
    const res = await (await who.as('office')).get(`/api/jobs/${job.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(job);
  });

  /** Four jobs, a minute apart, oldest first: lead, inspection (rep's), lead (rep's), won (unassigned). */
  async function fourJobs() {
    const owner = await who.as('owner');
    const { customer, property } = await mollyAndHouse();
    const second = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(1) });
    const make = async (extra: Record<string, unknown>, house = property.id) => {
      t.clock.advance(60_000);
      return mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: house, ...extra });
    };
    const j1 = await make({});
    const j2 = await make({ stage: 'inspection', assignedUserId: who.user('rep').userId });
    const j3 = await make({ assignedUserId: who.user('rep').userId }, second.id as string);
    const j4 = await make({ stage: 'won', valueCents: 500_000 }, second.id as string);
    return { customer, property, second, j1, j2, j3, j4 };
  }
  const idsOf = (res: { body: { jobs: { id: string }[] } }) => res.body.jobs.map((j) => j.id);

  test('lists the newest job first, with the count before paging', async () => {
    const { j1, j2, j3, j4 } = await fourJobs();
    const res = await (await who.as('owner')).get('/api/jobs');
    expect(res.status).toBe(200);
    expect(idsOf(res)).toEqual([j4.id, j3.id, j2.id, j1.id]);
    expect(res.body.total).toBe(4);

    const page = await (await who.as('owner')).get('/api/jobs?limit=2&offset=1');
    expect(idsOf(page)).toEqual([j3.id, j2.id]);
    expect(page.body.total).toBe(4);
  });

  test('?stage= narrows to one stage; a stage that does not exist is a 400 on stage', async () => {
    const { j2 } = await fourJobs();
    const owner = await who.as('owner');
    expect(idsOf(await owner.get('/api/jobs?stage=inspection'))).toEqual([j2.id]);
    expect((await owner.get('/api/jobs?stage=installed')).body).toEqual({ jobs: [], total: 0 });
    const bad = await owner.get('/api/jobs?stage=closed');
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: BAD_STAGE, field: 'stage' });
  });

  test('?assigned=me, ?assigned=unassigned', async () => {
    const { j1, j2, j3, j4 } = await fourJobs();
    const rep = await who.as('rep');
    // The rep sees what is theirs and the unassigned leads (j1); j4 is unassigned but already won.
    expect(idsOf(await rep.get('/api/jobs?assigned=me')).sort()).toEqual([j2.id, j3.id].sort());
    expect(idsOf(await rep.get('/api/jobs?assigned=unassigned'))).toEqual([j1.id]);
    const owner = await who.as('owner');
    expect(idsOf(await owner.get('/api/jobs?assigned=unassigned'))).toEqual([j4.id, j1.id]);
    expect(idsOf(await owner.get('/api/jobs?assigned=me'))).toEqual([]);
    const both = await owner.get('/api/jobs?assigned=unassigned&stage=won');
    expect(idsOf(both)).toEqual([j4.id]);
    const bad = await owner.get('/api/jobs?assigned=everyone');
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'Please use me or unassigned.', field: 'assigned' });
  });

  test('?customerId= and ?propertyId= narrow to one customer or address', async () => {
    const { customer, property, second, j1, j2, j3, j4 } = await fourJobs();
    const owner = await who.as('owner');
    const other = await mustCreate(owner, '/api/customers', { displayName: 'Sam' });
    expect((await owner.get(`/api/jobs?customerId=${other.id}`)).body).toEqual({ jobs: [], total: 0 });
    expect((await owner.get(`/api/jobs?customerId=${customer.id}`)).body.total).toBe(4);
    expect(idsOf(await owner.get(`/api/jobs?propertyId=${property.id}`))).toEqual([j2.id, j1.id]);
    expect(idsOf(await owner.get(`/api/jobs?propertyId=${second.id}`))).toEqual([j4.id, j3.id]);
    const bad = await owner.get('/api/jobs?customerId=molly');
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe('customerId');
  });

  test('archived jobs are left out unless ?includeArchived=true', async () => {
    const { j1, j2, j3, j4 } = await fourJobs();
    const owner = await who.as('owner');
    await owner.post(`/api/jobs/${j2.id}/archive`);
    expect(idsOf(await owner.get('/api/jobs'))).toEqual([j4.id, j3.id, j1.id]);
    const all = await owner.get('/api/jobs?includeArchived=true');
    expect(idsOf(all)).toEqual([j4.id, j3.id, j2.id, j1.id]);
    expect((await owner.get('/api/jobs?includeArchived=yes')).status).toBe(400);
  });

  test('a bad limit or offset is a 400', async () => {
    const owner = await who.as('owner');
    expect((await owner.get('/api/jobs?limit=0')).body).toEqual({ error: 'Please use a whole number from 1 to 200.', field: 'limit' });
    expect((await owner.get('/api/jobs?offset=-1')).body).toEqual({ error: 'Please use a whole number, 0 or higher.', field: 'offset' });
    expect((await owner.get('/api/jobs?limit=5000')).status).toBe(200);
  });
});

describe('archiving a job', () => {
  test('archive sets archivedAt to the app clock, audits it and adds a timeline line; unarchive reverses it', async () => {
    const { job } = await aJob();
    const owner = await who.as('owner');
    t.clock.set(new Date('2026-10-15T08:00:00.000Z'));
    const archived = await owner.post(`/api/jobs/${job.id}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAt).toBe('2026-10-15T08:00:00.000Z');
    const [audited] = await dbAudit(t, A(), 'job.archive');
    expect(audited).toMatchObject({ targetType: 'job', targetId: job.id, before: { archivedAt: null }, after: { archivedAt: '2026-10-15T08:00:00.000Z' } });

    t.clock.set(new Date('2026-10-16T08:00:00.000Z'));
    const restored = await owner.post(`/api/jobs/${job.id}/unarchive`);
    expect(restored.body.archivedAt).toBeNull();
    expect(await dbAudit(t, A(), 'job.unarchive')).toHaveLength(1);
    expect(await timeline(t, A(), job.id as string)).toEqual([
      ['job.archived', 'Job archived'],
      ['job.created', 'Job created'],
      ['job.unarchived', 'Job restored'],
    ]);
  });

  test('doing it twice changes nothing and writes nothing more', async () => {
    const { job } = await aJob();
    const owner = await who.as('owner');
    await owner.post(`/api/jobs/${job.id}/archive`);
    t.clock.advance(3_600_000);
    const again = await owner.post(`/api/jobs/${job.id}/archive`);
    expect(again.status).toBe(200);
    expect(again.body.archivedAt).toBe('2026-10-12T15:00:00.000Z');
    expect(await dbAudit(t, A(), 'job.archive')).toHaveLength(1);
    const fresh = await mustCreate(owner, '/api/jobs', { customerId: job.customerId, propertyId: job.propertyId });
    await owner.post(`/api/jobs/${fresh.id}/unarchive`);
    expect(await dbAudit(t, A(), 'job.unarchive')).toHaveLength(0);
  });
});

describe('the repository guards assignment on its own (defense in depth)', () => {
  const repCtx = (): TenantContext => ({ companyId: A(), userId: who.user('rep').userId, role: 'rep', canApproveSpend: false });
  const writeOptions = () => ({ now: t.clock.now() });

  test('createJob: a rep naming someone else is refused and nothing is saved; themselves and nobody are fine', async () => {
    const { customer, property } = await mollyAndHouse();
    // The rep needs to be able to see them (the address belongs to a customer who has an unassigned lead).
    const owner = await who.as('owner');
    await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id });
    const base = { customerId: customer.id as string, propertyId: property.id as string };
    await expect(
      withTenant(t.deps.pools, repCtx(), (tx) => createJob(tx, repCtx(), { ...base, assignedUserId: who.user('otherRep').userId }, writeOptions())),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await inCompany(t, A(), (tx) => tx.select().from(jobs))).toHaveLength(1);
    const own = await withTenant(t.deps.pools, repCtx(), (tx) =>
      createJob(tx, repCtx(), { ...base, assignedUserId: who.user('rep').userId }, writeOptions()),
    );
    expect(own.assignedUserId).toBe(who.user('rep').userId);
    const none = await withTenant(t.deps.pools, repCtx(), (tx) => createJob(tx, repCtx(), { ...base, assignedUserId: null }, writeOptions()));
    expect(none.assignedUserId).toBeNull();
  });

  test('updateJob: a rep naming someone else is refused and nothing changes', async () => {
    const { job } = await aJob();
    await expect(
      withTenant(t.deps.pools, repCtx(), (tx) =>
        updateJob(tx, repCtx(), job.id as string, { assignedUserId: who.user('otherRep').userId }, writeOptions()),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await dbJob(t, A(), job.id as string)).assignedUserId).toBeNull();
    expect(await dbAudit(t, A(), 'job.update')).toEqual([]);
  });

  test('the system role (no signed-in user) can assign anyone, and "assigned to me" matches nothing for it', async () => {
    const { job } = await aJob();
    const systemCtx: TenantContext = { companyId: A(), userId: null, role: 'system', canApproveSpend: false };
    const updated = await withTenant(t.deps.pools, systemCtx, (tx) =>
      updateJob(tx, systemCtx, job.id as string, { assignedUserId: who.user('otherRep').userId }, writeOptions()),
    );
    expect(updated?.assignedUserId).toBe(who.user('otherRep').userId);
    const mine = await withTenant(t.deps.pools, systemCtx, (tx) => listJobs(tx, systemCtx, { assigned: 'me' }));
    expect(mine).toEqual({ jobs: [], total: 0 });
    const [line] = await dbActivities(t, A(), job.id as string).then((rows) => rows.filter((r) => r.kind === 'job.assigned'));
    expect(line).toMatchObject({ actorType: 'system', actorUserId: null });
  });
});

/*
 * The job queue (jobs/queue.ts) and the worker's schedules (jobs/worker.ts). InlineJobs is pure;
 * this file's beforeEach above still applies to these blocks too.
 */
const QUEUE_DEPS = {} as AppDeps;
const QUEUE_COMPANY = '5b1f2c3e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const QUEUE_IMPORT = '7c2d3e4f-5a6b-4c7d-9e8f-0a1b2c3d4e5f';

/** A full handler map: every job does nothing unless a test overrides it. */
function queueHandlers(over: Partial<JobHandlers> = {}): JobHandlers {
  return {
    'import-customers': async () => {},
    'texting-registration': async () => {},
    'calendar-push': async () => {},
    'footprints-load': async () => {},
    'signed-pdf': async () => {},
    // D1 Front Desk
    'fd-after-call': async () => {},
    'fd-recording-store': async () => {},
    'fd-text': async () => {},
    'fd-forwarding-test': async () => {},
    // G1 Agents
    'claims-daily': async () => {},
    'scheduler-reminders': async () => {},
    'scheduler-agenda': async () => {},
    'scheduler-weather': async () => {},
    'followup-daily': async () => {},
    // G1 Task 8
    'claims-reply': async () => {},
    ...over,
  };
}

describe('InlineJobs', () => {
  test('a second send with the same pending singletonKey is recorded but queued once', async () => {
    const jobs = new InlineJobs();
    let runs = 0;
    const data: JobData = { companyId: QUEUE_COMPANY, importId: QUEUE_IMPORT };
    await jobs.send('import-customers', data, { singletonKey: 'import:1' });
    await jobs.send('import-customers', data, { singletonKey: 'import:1' });

    expect(jobs.sent).toHaveLength(2);
    expect(jobs.sent[0]).toEqual({ name: 'import-customers', data, singletonKey: 'import:1' });
    await jobs.drain(QUEUE_DEPS, queueHandlers({ 'import-customers': async () => { runs++; } }));
    expect(runs).toBe(1);
    expect(jobs.errors).toEqual([]);
  });

  test('the same singletonKey on two queues runs both', async () => {
    const jobs = new InlineJobs();
    const runs: string[] = [];
    await jobs.send('import-customers', { companyId: QUEUE_COMPANY, importId: QUEUE_IMPORT }, { singletonKey: 'k' });
    await jobs.send('texting-registration', { companyId: QUEUE_COMPANY }, { singletonKey: 'k' });

    expect(jobs.sent).toHaveLength(2);
    await jobs.drain(
      QUEUE_DEPS,
      queueHandlers({
        'import-customers': async () => { runs.push('import-customers'); },
        'texting-registration': async () => { runs.push('texting-registration'); },
      }),
    );
    expect(runs.sort()).toEqual(['import-customers', 'texting-registration']);
    expect(jobs.errors).toEqual([]);
  });

  test('a send without a singletonKey is never dropped, and sent records no key', async () => {
    const jobs = new InlineJobs();
    let runs = 0;
    await jobs.send('texting-registration', { companyId: QUEUE_COMPANY });
    await jobs.send('texting-registration', { companyId: QUEUE_COMPANY });
    await jobs.drain(QUEUE_DEPS, queueHandlers({ 'texting-registration': async () => { runs++; } }));

    expect(runs).toBe(2);
    expect(jobs.sent[0]).toEqual({ name: 'texting-registration', data: { companyId: QUEUE_COMPANY } });
    expect(jobs.sent[0]).not.toHaveProperty('singletonKey');
  });

  test('a handler that throws twice then succeeds runs three times, attempts 1 to 3, and keeps both errors', async () => {
    const jobs = new InlineJobs();
    const metas: JobMeta[] = [];
    await jobs.send('import-customers', { companyId: QUEUE_COMPANY, importId: QUEUE_IMPORT });
    await jobs.drain(
      QUEUE_DEPS,
      queueHandlers({
        'import-customers': async (_deps, _data, meta) => {
          metas.push(meta);
          if (metas.length <= 2) throw new Error(`boom ${metas.length}`);
        },
      }),
    );

    expect(metas).toEqual([
      { attempt: 1, lastAttempt: false },
      { attempt: 2, lastAttempt: false },
      { attempt: 3, lastAttempt: false },
    ]);
    expect(jobs.errors).toEqual([new Error('boom 1'), new Error('boom 2')]);
  });

  test('a handler that always throws runs five times, lastAttempt only on the fifth, and keeps five errors', async () => {
    const jobs = new InlineJobs();
    const metas: JobMeta[] = [];
    await jobs.send('texting-registration', { companyId: QUEUE_COMPANY });
    await jobs.drain(
      QUEUE_DEPS,
      queueHandlers({
        'texting-registration': async (_deps, _data, meta) => {
          metas.push(meta);
          throw new Error('still broken');
        },
      }),
    );

    expect(metas.map((m) => m.attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(metas.map((m) => m.lastAttempt)).toEqual([false, false, false, false, true]);
    expect(jobs.errors).toHaveLength(5);
    expect(jobs.errors[4]).toEqual(new Error('still broken'));
  });

  test('a job sent while draining runs in the same drain', async () => {
    const jobs = new InlineJobs();
    const ran: string[] = [];
    await jobs.send('import-customers', { companyId: QUEUE_COMPANY, importId: QUEUE_IMPORT });
    await jobs.drain(
      QUEUE_DEPS,
      queueHandlers({
        'import-customers': async (_deps, data) => {
          ran.push('import-customers');
          await jobs.send('texting-registration', { companyId: data.companyId });
        },
        'texting-registration': async () => {
          ran.push('texting-registration');
        },
      }),
    );

    expect(ran).toEqual(['import-customers', 'texting-registration']);
    expect(jobs.sent.map((s) => s.name)).toEqual(['import-customers', 'texting-registration']);
  });

  test('drain stops with an error after maxRuns runs', async () => {
    const jobs = new InlineJobs();
    await jobs.send('texting-registration', { companyId: QUEUE_COMPANY });
    const forever = queueHandlers({
      'texting-registration': async (_deps, data) => {
        await jobs.send('texting-registration', data);
      },
    });
    await expect(jobs.drain(QUEUE_DEPS, forever, 3)).rejects.toThrow(/stopped after 3 runs/);
  });

  // Both default handlers are real now (import-customers: T24, covered by import-run.test.ts;
  // texting-registration: T27, covered by texting-submit.test.ts); both need a database, so the old
  // 'default handler map runs the stub job' test has no stub left to run.
});

describe('SCHEDULES', () => {
  test('the later schedules follow the first three, with their exact crons', () => {
    expect(SCHEDULES.map((s) => [s.name, s.cron])).toEqual([
      ['expire-drafts', '*/5 * * * *'],
      ['sweep-queued', '* * * * *'],
      ['sweep-imports', '* * * * *'],
      ['dispatch-messages', '* * * * *'],
      ['end-trials', '*/5 * * * *'],
      ['report-usage', '* * * * *'],
      ['provision-texting', '* * * * *'],
      ['poll-texting', '0 * * * *'],
      ['bill-monthly-fees', '0 9 1 * *'],
      ['prune-early-reports', '17 3 * * *'],
      ['calendar-pull', '*/5 * * * *'],
      ['footprints-ensure', '*/15 * * * *'],
      ['exact-report-poll', '*/10 * * * *'],
      ['fd-retention', '17 3 * * *'],
      ['fd-health', '*/2 * * * *'],
      ['claims-daily-schedule', '*/15 * * * *'],
      ['scheduler-reminders-schedule', '*/15 * * * *'],
      ['scheduler-agenda-schedule', '*/15 * * * *'],
      ['scheduler-weather-schedule', '*/15 * * * *'],
      ['followup-daily-schedule', '*/15 * * * *'],
    ]);
  });

  test('the calendar-push job queue is registered', () => {
    expect(JOB_NAMES).toContain('calendar-push');
  });

  test('the footprints-load and signed-pdf job queues are registered', () => {
    expect(JOB_NAMES).toContain('footprints-load');
    expect(JOB_NAMES).toContain('signed-pdf');
  });
});
