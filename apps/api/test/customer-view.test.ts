import { beforeEach, describe, expect, test } from 'vitest';
import { Actors, addressFor, mustCreate, NO_UUID, NOT_FOUND } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(new Date('2026-10-12T15:00:00.000Z'));
});

const repId = () => who.user('rep').userId;
const otherRepId = () => who.user('otherRep').userId;

type View = {
  customer: { id: string; displayName: string };
  homes: { id: string; jobs: { id: string; stage: string }[] }[];
  jobs: { id: string; stage: string; customerId: string; propertyId: string }[];
  upcoming: unknown[];
  can: { edit: boolean; changeConsent: boolean; archive: boolean };
};

const viewOf = async (agent: Awaited<ReturnType<Actors['as']>>, customerId: string) => agent.get(`/api/customers/${customerId}/view`);

describe('the customer view', () => {
  test('shows the customer with homes and their jobs', async () => {
    const owner = await who.as('owner');
    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Molly Lindgren' });
    const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(1) });
    const job = await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id });

    const res = await viewOf(owner, customer.id);
    expect(res.status).toBe(200);
    const view = res.body as View;
    expect(view.customer).toMatchObject({ id: customer.id, displayName: 'Molly Lindgren' });
    expect(view.homes).toHaveLength(1);
    expect(view.homes[0]!.id).toBe(property.id);
    expect(view.homes[0]!.jobs).toEqual([{ id: job.id, stage: 'lead' }]);
    expect(view.jobs).toHaveLength(1);
    expect(view.jobs[0]).toMatchObject({ id: job.id, stage: 'lead', customerId: customer.id, propertyId: property.id });
    expect(view.can.changeConsent).toBe(true);
  });

  test('tells a rep they cannot change consent', async () => {
    const rep = await who.as('rep');
    const customer = await mustCreate(rep, '/api/customers', { displayName: 'Rep Customer' });
    const res = await viewOf(rep, customer.id);
    expect(res.status).toBe(200);
    expect((res.body as View).can.changeConsent).toBe(false);
  });

  test('a rep sees only customers in their scope: a customer with no visible job is 404', async () => {
    const owner = await who.as('owner');
    const rep = await who.as('rep');
    const hidden = await mustCreate(owner, '/api/customers', { displayName: 'Nobody Customer' });
    const res = await viewOf(rep, hidden.id);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_FOUND });
  });

  test('a rep sees a shared customer, but not the jobs or homes of the job they cannot see', async () => {
    const owner = await who.as('owner');
    const rep = await who.as('rep');
    const shared = await mustCreate(owner, '/api/customers', { displayName: 'Shared Customer' });
    const houseA = await mustCreate(owner, '/api/properties', { customerId: shared.id, ...addressFor(2) });
    const houseB = await mustCreate(owner, '/api/properties', { customerId: shared.id, ...addressFor(3) });
    const visible = await mustCreate(owner, '/api/jobs', {
      customerId: shared.id,
      propertyId: houseA.id,
      stage: 'inspection',
      assignedUserId: repId(),
    });
    const hidden = await mustCreate(owner, '/api/jobs', {
      customerId: shared.id,
      propertyId: houseB.id,
      stage: 'inspection',
      assignedUserId: otherRepId(),
    });

    const res = await viewOf(rep, shared.id);
    expect(res.status).toBe(200);
    const view = res.body as View;
    expect(view.jobs.map((j) => j.id)).toEqual([visible.id]);
    expect(view.jobs.map((j) => j.id)).not.toContain(hidden.id);
    const homeJobIds = view.homes.flatMap((h) => h.jobs.map((j) => j.id));
    expect(homeJobIds).toEqual([visible.id]);
    expect(homeJobIds).not.toContain(hidden.id);

    // The owner sees both.
    const ownerView = (await viewOf(owner, shared.id)).body as View;
    expect(ownerView.jobs.map((j) => j.id).sort()).toEqual([visible.id, hidden.id].sort());
  });

  test('company B gets 404', async () => {
    const owner = await who.as('owner');
    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Acme Only' });
    const res = await viewOf(await who.as('owner', 'b'), customer.id);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_FOUND });
    const missing = await viewOf(owner, NO_UUID);
    expect(missing.status).toBe(404);
  });

  test('upcoming is empty until appointments exist', async () => {
    const owner = await who.as('owner');
    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Quiet Customer' });
    const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(4) });
    await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id });
    const res = await viewOf(owner, customer.id);
    expect(res.status).toBe(200);
    expect((res.body as View).upcoming).toEqual([]);
  });
});
