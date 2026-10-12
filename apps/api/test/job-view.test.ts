import { beforeEach, describe, expect, test } from 'vitest';
import { agentTasks } from '@roofline/db';
import { seedShowcase } from '../src/scripts/showcase.ts';
import { Actors, addressFor, inCompany, mustCreate, NOT_FOUND } from './crm-helpers.ts';
import { makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-12T15:00:00.000Z');

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(NOW);
});

const A = () => t.seed.a.companyId;

/** The first card of a board column, as the owner sees it. */
async function firstCardIn(agent: SuperAgent, stage: string): Promise<{ id: string }> {
  const res = await agent.get('/api/jobs/board').query({ stage });
  expect(res.status).toBe(200);
  const card = (res.body.jobs as { id: string }[])[0];
  if (!card) throw new Error(`no ${stage} card`);
  return card;
}

let houses = 0;

/** A customer and a house for them (a new house each time), then a job on that house, all made through the API. */
async function jobFor(agent: SuperAgent, displayName: string, extra: Record<string, unknown> = {}) {
  houses += 1;
  const customer = await mustCreate(agent, '/api/customers', { displayName });
  const property = await mustCreate(agent, '/api/properties', { customerId: customer.id, ...addressFor(houses) });
  return mustCreate(agent, '/api/jobs', { customerId: customer.id, propertyId: property.id, ...extra });
}

describe('the job view', () => {
  test('the owner sees the value and can edit', async () => {
    await seedShowcase(t.deps.pools, A(), t.clock.now(), { companyName: 'Acme Roofing' });
    const owner = await who.as('owner');
    const job = await firstCardIn(owner, 'won');

    const res = await owner.get(`/api/jobs/${job.id}/view`);
    expect(res.status).toBe(200);
    expect(typeof res.body.job.valueCents).toBe('number');
    expect(res.body.can).toMatchObject({ edit: true, seeValue: true });
    expect(typeof res.body.customer.displayName).toBe('string');
    expect(res.body.customer.displayName.length).toBeGreaterThan(0);
    expect(typeof res.body.home.addressLine).toBe('string');
    expect(res.body.home.addressLine.length).toBeGreaterThan(0);
    expect(res.body.appointments).toEqual([]);
    expect(res.body.quotes).toEqual([]);
    expect(res.body.job.archived).toBe(false);
  });

  test('a rep on an unassigned lead sees no value', async () => {
    const owner = await who.as('owner');
    const lead = await jobFor(owner, 'Unassigned Lead');
    expect((await owner.patch(`/api/jobs/${lead.id}`).send({ valueCents: 500_000 })).status).toBe(200);

    const res = await (await who.as('rep')).get(`/api/jobs/${lead.id}/view`);
    expect(res.status).toBe(200);
    expect(res.body.job.valueCents).toBeNull();
    expect(res.body.can.seeValue).toBe(false);
  });

  test('out of scope is a 404', async () => {
    const owner = await who.as('owner');
    const someoneElse = await jobFor(owner, 'Other Reps Lead', { assignedUserId: who.user('otherRep').userId });
    const rep = await who.as('rep');

    const hidden = await rep.get(`/api/jobs/${someoneElse.id}/view`);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual({ error: NOT_FOUND });

    const bOwner = await who.as('owner', 'b');
    const otherCompany = await bOwner.get(`/api/jobs/${someoneElse.id}/view`);
    expect(otherCompany.status).toBe(404);
    expect(otherCompany.body).toEqual({ error: NOT_FOUND });

    const malformed = await owner.get('/api/jobs/not-a-real-id/view');
    expect(malformed.status).toBe(404);
  });

  test('tasks are listed, newest first', async () => {
    const owner = await who.as('owner');
    const job = await jobFor(owner, 'Task Customer');
    const older = new Date(NOW.getTime() - DAY_MS);

    await inCompany(t, A(), (tx) =>
      tx.insert(agentTasks).values([
        {
          companyId: A(),
          agent: 'storm_scout',
          kind: 'storm_plan',
          title: 'Older task',
          status: 'done',
          subjectType: 'job',
          subjectId: job.id as string,
          createdAt: older,
          updatedAt: older,
        },
        {
          companyId: A(),
          agent: 'estimator',
          kind: 'proposal_send',
          title: 'Newer task',
          status: 'awaiting_owner',
          subjectType: 'job',
          subjectId: job.id as string,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]),
    );

    const res = await owner.get(`/api/jobs/${job.id}/view`);
    expect(res.status).toBe(200);
    expect(res.body.tasks).toEqual([
      { id: expect.any(String), title: 'Newer task', status: 'awaiting_owner' },
      { id: expect.any(String), title: 'Older task', status: 'done' },
    ]);
  });
});
