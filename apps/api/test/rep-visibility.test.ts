import { beforeEach, describe, expect, test } from 'vitest';
import { Actors, addressFor, dbAudit, dbCustomer, dbJob, dbProperty, mustCreate, NO_UUID, NOT_FOUND } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const NOT_ALLOWED = "Your role can't do that. Ask the owner.";
const NO_CUSTOMER = "We couldn't find that customer.";
const NO_ADDRESS = "We couldn't find that address.";

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(new Date('2026-10-12T15:00:00.000Z'));
});

const A = () => t.seed.a.companyId;
const repId = () => who.user('rep').userId;
const otherRepId = () => who.user('otherRep').userId;

/**
 * One company, set up so every row of the visibility rule (spec 3.2) has an example. "The rep" is
 * `rep`; "the other rep" is `otherRep`.
 *
 *   job         stage       assigned    made by   value   the rep sees it because...
 *   created     proposal    nobody      rep       111     they created it
 *   assigned    inspection  rep         owner     222     it is assigned to them
 *   lead        lead        nobody      owner     333     it is an unassigned lead
 *   other       lead        otherRep    owner     444     (hidden)
 *   quiet       inspection  nobody      owner     555     (hidden: unassigned, but no longer a lead)
 *   m1          inspection  otherRep    owner     666     (hidden)   } both for the customer "Mixed"
 *   m2          inspection  rep         owner     777     assigned   }
 *
 * Customers: Rep Customer (rep made it), Assigned/Lead/Mixed (through a job the rep sees); Other,
 * Quiet, Nobody are hidden. Properties: houses 1, 2, 3 and 9 are on jobs the rep sees; house 8 is
 * Mixed's other house (visible through its customer); houses 4, 5, 6 and 7 are hidden.
 */
async function world() {
  const owner = await who.as('owner');
  const rep = await who.as('rep');
  const customer = (agent: typeof owner, displayName: string) => mustCreate(agent, '/api/customers', { displayName });
  const house = (agent: typeof owner, n: number, customerId?: string) =>
    mustCreate(agent, '/api/properties', { ...(customerId !== undefined && { customerId }), ...addressFor(n) });
  const job = (agent: typeof owner, customerId: string, propertyId: string, extra: Record<string, unknown>) =>
    mustCreate(agent, '/api/jobs', { customerId, propertyId, ...extra });

  const repCustomer = await customer(rep, 'Rep Customer');
  const house1 = await house(rep, 1, repCustomer.id);
  const created = await job(rep, repCustomer.id, house1.id, { stage: 'proposal', valueCents: 111 });

  const assignedCustomer = await customer(owner, 'Assigned Customer');
  const house2 = await house(owner, 2, assignedCustomer.id);
  const assigned = await job(owner, assignedCustomer.id, house2.id, { stage: 'inspection', assignedUserId: repId(), valueCents: 222 });

  const leadCustomer = await customer(owner, 'Lead Customer');
  const house3 = await house(owner, 3, leadCustomer.id);
  const lead = await job(owner, leadCustomer.id, house3.id, { valueCents: 333 });

  const otherCustomer = await customer(owner, 'Other Customer');
  const house4 = await house(owner, 4, otherCustomer.id);
  const other = await job(owner, otherCustomer.id, house4.id, { assignedUserId: otherRepId(), valueCents: 444 });

  const quietCustomer = await customer(owner, 'Quiet Customer');
  const house5 = await house(owner, 5, quietCustomer.id);
  const quiet = await job(owner, quietCustomer.id, house5.id, { stage: 'inspection', valueCents: 555 });

  const nobody = await customer(owner, 'Nobody Customer');
  const house6 = await house(owner, 6, nobody.id);
  const house7 = await house(owner, 7);

  const mixed = await customer(owner, 'Mixed Customer');
  const house8 = await house(owner, 8, mixed.id);
  const house9 = await house(owner, 9, mixed.id);
  const m1 = await job(owner, mixed.id, house8.id, { stage: 'inspection', assignedUserId: otherRepId(), valueCents: 666 });
  const m2 = await job(owner, mixed.id, house9.id, { stage: 'inspection', assignedUserId: repId(), valueCents: 777 });

  return {
    owner,
    rep,
    jobs: { created, assigned, lead, other, quiet, m1, m2 },
    customers: { repCustomer, assignedCustomer, leadCustomer, otherCustomer, quietCustomer, nobody, mixed },
    houses: { house1, house2, house3, house4, house5, house6, house7, house8, house9 },
  };
}

const ids = (...rows: { id: string }[]) => rows.map((r) => r.id).sort();
const idsOf = (list: { id: string }[]) => list.map((r) => r.id).sort();

describe('jobs a rep can see', () => {
  test('a rep sees jobs assigned to them, jobs they created, and unassigned leads — and no others', async () => {
    const w = await world();
    const res = await w.rep.get('/api/jobs');
    expect(res.status).toBe(200);
    const { created, assigned, lead, m2 } = w.jobs;
    expect(idsOf(res.body.jobs)).toEqual(ids(created, assigned, lead, m2));
    expect(res.body.total).toBe(4);
    for (const job of [created, assigned, lead, m2]) {
      expect((await w.rep.get(`/api/jobs/${job.id}`)).status, job.id).toBe(200);
    }
  });

  test("a rep does not see another rep's job: GET → 404", async () => {
    const w = await world();
    for (const job of [w.jobs.other, w.jobs.m1]) {
      const res = await w.rep.get(`/api/jobs/${job.id}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: NOT_FOUND });
    }
  });

  test("a rep does not see an unassigned job that has moved on from lead", async () => {
    const w = await world();
    const res = await w.rep.get(`/api/jobs/${w.jobs.quiet.id}`);
    expect(res.status).toBe(404);
    expect(idsOf((await w.rep.get('/api/jobs')).body.jobs)).not.toContain(w.jobs.quiet.id);
  });

  test("a rep can't PATCH another rep's job: 404, and nothing changes", async () => {
    const w = await world();
    const before = await dbJob(t, A(), w.jobs.other.id);
    for (const job of [w.jobs.other, w.jobs.quiet]) {
      const res = await w.rep.patch(`/api/jobs/${job.id}`).send({ stage: 'won', valueCents: 1 });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: NOT_FOUND });
    }
    expect(await dbJob(t, A(), w.jobs.other.id)).toEqual(before);
    expect(await dbAudit(t, A(), 'job.update')).toEqual([]);
  });

  test("a rep can't archive, restore or read the timeline of a job they can't see", async () => {
    const w = await world();
    const id = w.jobs.other.id;
    for (const res of [
      await w.rep.post(`/api/jobs/${id}/archive`),
      await w.rep.post(`/api/jobs/${id}/unarchive`),
      await w.rep.get(`/api/activities?subjectType=job&subjectId=${id}`),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: NOT_FOUND });
    }
    expect((await dbJob(t, A(), id)).archivedAt).toBeNull();
  });

  test('a rep works on the jobs they can see, and the timeline of one shows', async () => {
    const w = await world();
    const moved = await w.rep.patch(`/api/jobs/${w.jobs.assigned.id}`).send({ stage: 'proposal' });
    expect(moved.status).toBe(200);
    expect(moved.body.stage).toBe('proposal');
    expect((await w.rep.post(`/api/jobs/${w.jobs.created.id}/archive`)).status).toBe(200);
    const lines = await w.rep.get(`/api/activities?subjectType=job&subjectId=${w.jobs.assigned.id}`);
    expect(lines.status).toBe(200);
    expect(lines.body.activities.map((a: { kind: string }) => a.kind)).toContain('job.stage_changed');
  });

  test('an unassigned lead is the rep\'s only while it is both unassigned and a lead', async () => {
    const w = await world();
    const id = w.jobs.lead.id;
    await w.owner.patch(`/api/jobs/${id}`).send({ stage: 'inspection' });
    expect((await w.rep.get(`/api/jobs/${id}`)).status).toBe(404);
    await w.owner.patch(`/api/jobs/${id}`).send({ stage: 'lead' });
    expect((await w.rep.get(`/api/jobs/${id}`)).status).toBe(200);
    await w.owner.patch(`/api/jobs/${id}`).send({ assignedUserId: otherRepId() });
    expect((await w.rep.get(`/api/jobs/${id}`)).status).toBe(404);
  });

  test('a rep who takes an unassigned lead keeps it after it moves on; the other rep loses sight of it', async () => {
    const w = await world();
    const otherRep = await who.as('otherRep');
    const id = w.jobs.lead.id;
    expect((await otherRep.get(`/api/jobs/${id}`)).status).toBe(200); // an unassigned lead is everyone's
    const took = await w.rep.patch(`/api/jobs/${id}`).send({ assignedUserId: repId(), stage: 'inspection' });
    expect(took.status).toBe(200);
    expect((await w.rep.get(`/api/jobs/${id}`)).status).toBe(200);
    expect((await otherRep.get(`/api/jobs/${id}`)).status).toBe(404);
  });

  test('the owner and the office see every job, customer and address in the company', async () => {
    const w = await world();
    for (const member of ['owner', 'office'] as const) {
      const agent = await who.as(member);
      expect((await agent.get('/api/jobs')).body.total, member).toBe(7);
      expect((await agent.get('/api/customers')).body.total, member).toBe(7);
      expect((await agent.get('/api/properties')).body.total, member).toBe(9);
      expect((await agent.get(`/api/jobs/${w.jobs.other.id}`)).status, member).toBe(200);
    }
  });
});

describe('customers a rep can see', () => {
  test('a rep sees a customer only through a visible job, or because they created it', async () => {
    const w = await world();
    const res = await w.rep.get('/api/customers');
    expect(res.status).toBe(200);
    const { repCustomer, assignedCustomer, leadCustomer, mixed } = w.customers;
    expect(idsOf(res.body.customers)).toEqual(ids(repCustomer, assignedCustomer, leadCustomer, mixed));
    expect(res.body.total).toBe(4);

    const { otherCustomer, quietCustomer, nobody } = w.customers;
    for (const hidden of [otherCustomer, quietCustomer, nobody]) {
      const open = await w.rep.get(`/api/customers/${hidden.id}`);
      expect(open.status, hidden.displayName as string).toBe(404);
      expect(open.body).toEqual({ error: NOT_FOUND });
    }
    // Search does not reach a customer the rep may not see.
    expect((await w.rep.get('/api/customers?q=Other')).body).toEqual({ customers: [], total: 0 });
  });

  test('a customer reached through a job is one the rep may edit, archive and read the timeline of', async () => {
    const w = await world();
    const id = w.customers.assignedCustomer.id;
    expect((await w.rep.patch(`/api/customers/${id}`).send({ displayName: 'Renamed by rep' })).status).toBe(200);
    expect((await w.rep.get(`/api/activities?subjectType=customer&subjectId=${id}`)).status).toBe(200);
    expect((await w.rep.post(`/api/customers/${id}/archive`)).status).toBe(200);
    expect((await dbCustomer(t, A(), id)).displayName).toBe('Renamed by rep');
  });

  test("a rep can't edit or archive a customer they can't see: 404", async () => {
    const w = await world();
    const id = w.customers.otherCustomer.id;
    for (const res of [
      await w.rep.patch(`/api/customers/${id}`).send({ displayName: 'Mine now' }),
      await w.rep.post(`/api/customers/${id}/archive`),
      await w.rep.post(`/api/customers/${id}/unarchive`),
      await w.rep.get(`/api/activities?subjectType=customer&subjectId=${id}`),
    ]) {
      expect(res.status).toBe(404);
    }
    expect((await dbCustomer(t, A(), id)).displayName).toBe('Other Customer');
  });

  test('the customer goes out of sight when the job that showed it is reassigned, and comes back with it', async () => {
    const w = await world();
    const id = w.customers.assignedCustomer.id;
    expect((await w.rep.get(`/api/customers/${id}`)).status).toBe(200);
    await w.owner.patch(`/api/jobs/${w.jobs.assigned.id}`).send({ assignedUserId: otherRepId() });
    expect((await w.rep.get(`/api/customers/${id}`)).status).toBe(404);
    await w.owner.patch(`/api/jobs/${w.jobs.assigned.id}`).send({ assignedUserId: repId() });
    expect((await w.rep.get(`/api/customers/${id}`)).status).toBe(200);
  });

  test('a customer the rep created stays theirs whatever happens to their jobs', async () => {
    const w = await world();
    await w.owner.patch(`/api/jobs/${w.jobs.created.id}`).send({ assignedUserId: otherRepId() });
    expect((await w.rep.get(`/api/customers/${w.customers.repCustomer.id}`)).status).toBe(200);
  });

  test('a customer with one visible job and one hidden job is visible', async () => {
    const w = await world();
    expect((await w.rep.get(`/api/customers/${w.customers.mixed.id}`)).status).toBe(200);
    expect((await w.rep.get(`/api/jobs/${w.jobs.m1.id}`)).status).toBe(404);
  });
});

describe('addresses a rep can see', () => {
  test('a rep sees an address on a job they can see, or one that belongs to a customer they can see', async () => {
    const w = await world();
    const res = await w.rep.get('/api/properties');
    expect(res.status).toBe(200);
    const { house1, house2, house3, house8, house9 } = w.houses;
    // house8 is on a job the rep cannot see (m1), but it is Mixed Customer's, and the rep sees Mixed.
    expect(idsOf(res.body.properties)).toEqual(ids(house1, house2, house3, house8, house9));
    expect(res.body.total).toBe(5);
  });

  test('an address on no visible job and for no visible customer is a 404 to open, edit and archive', async () => {
    const w = await world();
    const { house4, house5, house6, house7 } = w.houses;
    for (const house of [house4, house5, house6, house7]) {
      for (const res of [
        await w.rep.get(`/api/properties/${house.id}`),
        await w.rep.patch(`/api/properties/${house.id}`).send({ city: 'Lincoln' }),
        await w.rep.post(`/api/properties/${house.id}/archive`),
        await w.rep.post(`/api/properties/${house.id}/unarchive`),
        await w.rep.get(`/api/activities?subjectType=property&subjectId=${house.id}`),
      ]) {
        expect(res.status, house.addressLine as string).toBe(404);
        expect(res.body).toEqual({ error: NOT_FOUND });
      }
      expect((await dbProperty(t, A(), house.id)).city).toBe('Omaha');
    }
  });

  test('a visible address can be opened, edited and read', async () => {
    const w = await world();
    expect((await w.rep.get(`/api/properties/${w.houses.house8.id}`)).status).toBe(200);
    const res = await w.rep.patch(`/api/properties/${w.houses.house2.id}`).send({ city: 'Lincoln' });
    expect(res.status).toBe(200);
    expect(res.body.city).toBe('Lincoln');
    expect((await w.rep.get(`/api/activities?subjectType=property&subjectId=${w.houses.house3.id}`)).status).toBe(200);
  });

  test('an address leaves the rep\'s sight with its last visible job, unless a visible customer owns it', async () => {
    const w = await world();
    // house2: customer Assigned (seen through the job). Take the job away and both go.
    await w.owner.patch(`/api/jobs/${w.jobs.assigned.id}`).send({ assignedUserId: otherRepId() });
    expect((await w.rep.get(`/api/properties/${w.houses.house2.id}`)).status).toBe(404);
    // house9: Mixed stays visible through m2, so house9 does as well.
    expect((await w.rep.get(`/api/properties/${w.houses.house9.id}`)).status).toBe(200);
  });

  test('a rep can save an address for a customer they can see, and not for one they cannot', async () => {
    const w = await world();
    const ok = await w.rep.post('/api/properties').send({ customerId: w.customers.assignedCustomer.id, ...addressFor(20) });
    expect(ok.status).toBe(201);
    expect((await w.rep.get(`/api/properties/${ok.body.id}`)).status).toBe(200);

    const hidden = await w.rep.post('/api/properties').send({ customerId: w.customers.otherCustomer.id, ...addressFor(21) });
    expect(hidden.status).toBe(400);
    expect(hidden.body).toEqual({ error: NO_CUSTOMER, field: 'customerId' });
    const move = await w.rep.patch(`/api/properties/${w.houses.house2.id}`).send({ customerId: w.customers.otherCustomer.id });
    expect(move.status).toBe(400);
    expect(move.body).toEqual({ error: NO_CUSTOMER, field: 'customerId' });
  });

  test('a rep can only start a job on a customer and an address they can see', async () => {
    const w = await world();
    const { assignedCustomer, otherCustomer } = w.customers;
    const hiddenCustomer = await w.rep.post('/api/jobs').send({ customerId: otherCustomer.id, propertyId: w.houses.house2.id });
    expect(hiddenCustomer.status).toBe(400);
    expect(hiddenCustomer.body).toEqual({ error: NO_CUSTOMER, field: 'customerId' });
    const hiddenHouse = await w.rep.post('/api/jobs').send({ customerId: assignedCustomer.id, propertyId: w.houses.house4.id });
    expect(hiddenHouse.status).toBe(400);
    expect(hiddenHouse.body).toEqual({ error: NO_ADDRESS, field: 'propertyId' });

    const ok = await w.rep.post('/api/jobs').send({ customerId: assignedCustomer.id, propertyId: w.houses.house2.id, stage: 'proposal' });
    expect(ok.status).toBe(201);
    // They made it, so they see it, though it is neither assigned nor a lead.
    expect((await w.rep.get(`/api/jobs/${ok.body.id}`)).status).toBe(200);
  });
});

describe('what a rep may assign', () => {
  test('a rep can give a job to themselves or to nobody; anyone else is a 403 and nothing is saved', async () => {
    const w = await world();
    const id = w.jobs.lead.id;
    for (const other of [otherRepId(), who.user('owner').userId, who.user('office').userId, NO_UUID, 'not-an-id']) {
      const res = await w.rep.patch(`/api/jobs/${id}`).send({ assignedUserId: other });
      expect(res.status, other).toBe(403);
      expect(res.body, other).toEqual({ error: NOT_ALLOWED });
    }
    expect((await dbJob(t, A(), id)).assignedUserId).toBeNull();

    const mine = await w.rep.patch(`/api/jobs/${id}`).send({ assignedUserId: repId() });
    expect(mine.status).toBe(200);
    expect(mine.body.assignedUserId).toBe(repId());
    const nobody = await w.rep.patch(`/api/jobs/${id}`).send({ assignedUserId: null });
    expect(nobody.status).toBe(200);
    expect(nobody.body.assignedUserId).toBeNull();
  });

  test('the same rule holds when the job is made', async () => {
    const w = await world();
    const base = { customerId: w.customers.repCustomer.id, propertyId: w.houses.house1.id };
    const refused = await w.rep.post('/api/jobs').send({ ...base, assignedUserId: otherRepId() });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: NOT_ALLOWED });
    const self = await w.rep.post('/api/jobs').send({ ...base, assignedUserId: repId() });
    expect(self.status).toBe(201);
    const nobody = await w.rep.post('/api/jobs').send({ ...base, assignedUserId: null });
    expect(nobody.status).toBe(201);
  });

  test("the 403 for a rep comes before looking at the job, so it says nothing about jobs they can't see", async () => {
    const w = await world();
    const res = await w.rep.patch(`/api/jobs/${w.jobs.other.id}`).send({ assignedUserId: otherRepId() });
    expect(res.status).toBe(403);
    // Taking it for themselves is a 404: they can't see it.
    const take = await w.rep.patch(`/api/jobs/${w.jobs.other.id}`).send({ assignedUserId: repId() });
    expect(take.status).toBe(404);
    expect((await dbJob(t, A(), w.jobs.other.id)).assignedUserId).toBe(otherRepId());
  });

  test('the owner and the office can assign anyone', async () => {
    const w = await world();
    const office = await who.as('office');
    expect((await office.patch(`/api/jobs/${w.jobs.other.id}`).send({ assignedUserId: repId() })).status).toBe(200);
    expect((await w.owner.patch(`/api/jobs/${w.jobs.other.id}`).send({ assignedUserId: otherRepId() })).status).toBe(200);
  });
});

describe('what a rep sees of the money', () => {
  test('value shows on a rep\'s own jobs (assigned or created) and is left out of the others, in lists and one at a time', async () => {
    const w = await world();
    const list = await w.rep.get('/api/jobs');
    const byId = new Map<string, Record<string, unknown>>(list.body.jobs.map((j: { id: string }) => [j.id, j]));
    const { created, assigned, lead, m2 } = w.jobs;
    expect(byId.get(created.id)).toHaveProperty('valueCents', 111);
    expect(byId.get(assigned.id)).toHaveProperty('valueCents', 222);
    expect(byId.get(m2.id)).toHaveProperty('valueCents', 777);
    // An unassigned lead the rep did not make: visible, but no money.
    expect(byId.get(lead.id)).toBeDefined();
    expect(byId.get(lead.id)).not.toHaveProperty('valueCents');

    expect((await w.rep.get(`/api/jobs/${created.id}`)).body.valueCents).toBe(111);
    expect((await w.rep.get(`/api/jobs/${assigned.id}`)).body.valueCents).toBe(222);
    const leadOne = await w.rep.get(`/api/jobs/${lead.id}`);
    expect(leadOne.status).toBe(200);
    expect(leadOne.body).not.toHaveProperty('valueCents');
    expect(JSON.stringify(leadOne.body)).not.toContain('333');
  });

  test('a rep who takes the lead gets to see its value', async () => {
    const w = await world();
    const res = await w.rep.patch(`/api/jobs/${w.jobs.lead.id}`).send({ assignedUserId: repId() });
    expect(res.body.valueCents).toBe(333);
    const back = await w.rep.patch(`/api/jobs/${w.jobs.lead.id}`).send({ assignedUserId: null });
    expect(back.status).toBe(200);
    expect(back.body).not.toHaveProperty('valueCents');
  });

  test('a rep editing a job they can only see as a lead does not get the value back in the answer', async () => {
    const w = await world();
    const res = await w.rep.patch(`/api/jobs/${w.jobs.lead.id}`).send({ source: 'web' });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('valueCents');
  });

  test('the owner and the office always see the value, including when there is none', async () => {
    const w = await world();
    const bare = await mustCreate(w.owner, '/api/jobs', {
      customerId: w.customers.repCustomer.id,
      propertyId: w.houses.house1.id,
    });
    for (const member of ['owner', 'office'] as const) {
      const agent = await who.as(member);
      const list = await agent.get('/api/jobs?limit=200');
      const values = new Map<string, unknown>(list.body.jobs.map((j: { id: string; valueCents: unknown }) => [j.id, j.valueCents]));
      expect(values.get(w.jobs.other.id), member).toBe(444);
      expect(values.get(w.jobs.lead.id), member).toBe(333);
      expect(values.has(bare.id as string), member).toBe(true);
      expect(values.get(bare.id as string), member).toBeNull();
      expect((await agent.get(`/api/jobs/${w.jobs.quiet.id}`)).body.valueCents, member).toBe(555);
    }
  });
});

describe('archived records follow the same rule', () => {
  test('an archived job is visible to a rep exactly when an active one would be', async () => {
    const w = await world();
    await w.owner.post(`/api/jobs/${w.jobs.assigned.id}/archive`);
    await w.owner.post(`/api/jobs/${w.jobs.other.id}/archive`);

    const active = await w.rep.get('/api/jobs');
    expect(idsOf(active.body.jobs)).not.toContain(w.jobs.assigned.id);
    const all = await w.rep.get('/api/jobs?includeArchived=true');
    expect(idsOf(all.body.jobs)).toContain(w.jobs.assigned.id);
    expect(idsOf(all.body.jobs)).not.toContain(w.jobs.other.id);

    expect((await w.rep.get(`/api/jobs/${w.jobs.assigned.id}`)).status).toBe(200);
    expect((await w.rep.get(`/api/jobs/${w.jobs.other.id}`)).status).toBe(404);
    expect((await w.rep.post(`/api/jobs/${w.jobs.assigned.id}/unarchive`)).status).toBe(200);
  });

  test('an archived job still shows its customer and address to the rep', async () => {
    const w = await world();
    await w.owner.post(`/api/jobs/${w.jobs.assigned.id}/archive`);
    expect((await w.rep.get(`/api/customers/${w.customers.assignedCustomer.id}`)).status).toBe(200);
    expect((await w.rep.get(`/api/properties/${w.houses.house2.id}`)).status).toBe(200);
  });

  test('archived customers and addresses are listed for a rep only with includeArchived, and only the ones they could see', async () => {
    const w = await world();
    await w.owner.post(`/api/customers/${w.customers.assignedCustomer.id}/archive`);
    await w.owner.post(`/api/customers/${w.customers.otherCustomer.id}/archive`);
    await w.owner.post(`/api/properties/${w.houses.house2.id}/archive`);
    await w.owner.post(`/api/properties/${w.houses.house4.id}/archive`);

    expect(idsOf((await w.rep.get('/api/customers')).body.customers)).not.toContain(w.customers.assignedCustomer.id);
    const customers = (await w.rep.get('/api/customers?includeArchived=true')).body.customers;
    expect(idsOf(customers)).toContain(w.customers.assignedCustomer.id);
    expect(idsOf(customers)).not.toContain(w.customers.otherCustomer.id);

    expect(idsOf((await w.rep.get('/api/properties')).body.properties)).not.toContain(w.houses.house2.id);
    const properties = (await w.rep.get('/api/properties?includeArchived=true')).body.properties;
    expect(idsOf(properties)).toContain(w.houses.house2.id);
    expect(idsOf(properties)).not.toContain(w.houses.house4.id);
    expect((await w.rep.get(`/api/properties/${w.houses.house4.id}`)).status).toBe(404);
  });
});
