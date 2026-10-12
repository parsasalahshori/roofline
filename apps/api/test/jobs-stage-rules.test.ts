import { beforeEach, describe, expect, test } from 'vitest';
import { Actors, addressFor, dbActivities, dbAudit, dbJob, mustCreate } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const INSTALLED_NEEDS_WON = 'Mark the job Won first.';
const LOST_NEEDS_REASON = 'Pick why the job was lost.';
const WON_NEEDS_VALUE = 'Enter the job value to mark it Won.';
const NEXT_STEP_TOO_LONG = 'Keep the next step under 120 characters.';
const BAD_DATE = 'Please pick a date.';

const NOW = new Date('2026-10-12T15:00:00.000Z');

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(NOW);
});

const A = () => t.seed.a.companyId;

/** A lead for a new customer at a new house, made by the owner. */
async function aLead(extra: Record<string, unknown> = {}) {
  const owner = await who.as('owner');
  const customer = await mustCreate(owner, '/api/customers', { displayName: 'Molly Lindgren' });
  const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(0) });
  return mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id, ...extra });
}

describe('the stage rules on PATCH', () => {
  test.each([
    ['lead to installed', { stage: 'installed' }, INSTALLED_NEEDS_WON, 'stage'],
    ['lead to lost without a reason', { stage: 'lost' }, LOST_NEEDS_REASON, 'lostReason'],
    ['lead to won without a value', { stage: 'won' }, WON_NEEDS_VALUE, 'valueCents'],
    ['lead to won with a value of 0', { stage: 'won', valueCents: 0 }, WON_NEEDS_VALUE, 'valueCents'],
    ['a next step of 121 characters', { nextStep: 'x'.repeat(121) }, NEXT_STEP_TOO_LONG, 'nextStep'],
    ['a next step date that is not a date', { nextStepOn: 'nope' }, BAD_DATE, 'nextStepOn'],
    ['a next step date that is not a real day', { nextStepOn: '2026-13-45' }, BAD_DATE, 'nextStepOn'],
  ])('%s is refused with its message and field', async (_name, change, error, field) => {
    const job = await aLead();
    const res = await (await who.as('owner')).patch(`/api/jobs/${job.id}`).send(change);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error, field });
  });

  test('a new job cannot start Installed', async () => {
    const owner = await who.as('owner');
    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Starts Installed' });
    const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(1) });
    const res = await owner.post('/api/jobs').send({ customerId: customer.id, propertyId: property.id, stage: 'installed' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: INSTALLED_NEEDS_WON, field: 'stage' });
  });

  test('lead to won with a value succeeds, and won can then be installed', async () => {
    const job = await aLead();
    const owner = await who.as('owner');

    const won = await owner.patch(`/api/jobs/${job.id}`).send({ stage: 'won', valueCents: 1_500_000 });
    expect(won.status).toBe(200);
    expect(won.body.stage).toBe('won');

    const installed = await owner.patch(`/api/jobs/${job.id}`).send({ stage: 'installed' });
    expect(installed.status).toBe(200);
    expect(installed.body.stage).toBe('installed');
  });

  test('reopening a lost job clears the reason', async () => {
    const job = await aLead();
    const owner = await who.as('owner');

    const lost = await owner.patch(`/api/jobs/${job.id}`).send({ stage: 'lost', lostReason: 'Went with another roofer' });
    expect(lost.status).toBe(200);
    expect(lost.body.lostReason).toBe('Went with another roofer');

    const reopened = await owner.patch(`/api/jobs/${job.id}`).send({ stage: 'lead' });
    expect(reopened.status).toBe(200);
    expect(reopened.body.lostReason).toBeNull();
    expect((await dbJob(t, A(), job.id)).lostReason).toBeNull();
  });

  test('the activity and audit rows for a move', async () => {
    const job = await aLead();
    const owner = await who.as('owner');

    const res = await owner.patch(`/api/jobs/${job.id}`).send({ stage: 'won', valueCents: 250_000 });
    expect(res.status).toBe(200);

    const lines = (await dbActivities(t, A(), job.id)).filter((a) => a.kind === 'job.stage_changed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      subjectType: 'job',
      summary: 'Moved to Won',
      actorType: 'user',
      actorUserId: who.user('owner').userId,
    });

    const audit = (await dbAudit(t, A(), 'job.update')).filter((row) => row.targetId === job.id);
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0]).toMatchObject({
      targetType: 'job',
      targetId: job.id,
      actorUserId: who.user('owner').userId,
    });
  });

  test('next step set and cleared writes activities', async () => {
    const job = await aLead();
    const owner = await who.as('owner');

    const set = await owner.patch(`/api/jobs/${job.id}`).send({ nextStep: 'Call back', nextStepOn: '2026-10-14' });
    expect(set.status).toBe(200);
    const stored = await dbJob(t, A(), job.id);
    expect(stored.nextStep).toBe('Call back');
    expect(stored.nextStepOn).toBe('2026-10-14');
    const afterSet = (await dbActivities(t, A(), job.id)).map((a) => a.summary);
    expect(afterSet).toContain('Next step: Call back (Oct 14)');

    const cleared = await owner.patch(`/api/jobs/${job.id}`).send({ nextStep: null, nextStepOn: null });
    expect(cleared.status).toBe(200);
    const after = await dbJob(t, A(), job.id);
    expect(after.nextStep).toBeNull();
    expect(after.nextStepOn).toBeNull();
    const afterClear = (await dbActivities(t, A(), job.id)).map((a) => a.summary);
    expect(afterClear).toContain('Next step cleared');
  });
});
