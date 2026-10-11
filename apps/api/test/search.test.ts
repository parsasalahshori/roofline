import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import { customers, jobs } from '@roofline/db';
import { Actors, addressFor, inCompany, mustCreate } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
});

const A = () => t.seed.a.companyId;
const B = () => t.seed.b.companyId;

type Agent = Awaited<ReturnType<Actors['as']>>;

const search = (agent: Agent, q?: string) => agent.get('/api/search').query(q === undefined ? {} : { q });

/** Maria Lopez at 1200 Pine St, with one job. */
async function maria(agent: Agent) {
  const customer = await mustCreate(agent, '/api/customers', {
    displayName: 'Maria Lopez',
    phones: [{ number: '(402) 555-0142', primary: true }],
  });
  const property = await mustCreate(agent, '/api/properties', {
    customerId: customer.id,
    addressLine: '1200 Pine St',
    city: 'Omaha',
    state: 'NE',
    zip: '68102',
  });
  const job = await mustCreate(agent, '/api/jobs', { customerId: customer.id, propertyId: property.id, stage: 'inspection' });
  return { customer, property, job };
}

describe('GET /api/search', () => {
  test('finds customers, jobs and addresses', async () => {
    const owner = await who.as('owner');
    const m = await maria(owner);

    const byName = await search(owner, 'lop');
    expect(byName.status).toBe(200);
    expect(byName.body.customers).toEqual([{ id: m.customer.id, displayName: 'Maria Lopez', phone: '+14025550142' }]);
    expect(byName.body.jobs).toEqual([
      {
        id: m.job.id,
        stage: 'inspection',
        stageLabel: 'Inspection',
        customerId: m.customer.id,
        customerName: 'Maria Lopez',
        propertyId: m.property.id,
        addressLine: '1200 Pine St',
      },
    ]);
    // An address is found by its own text, not by the customer's name.
    expect(byName.body.addresses).toEqual([]);

    const byStreet = await search(owner, 'pine');
    expect(byStreet.status).toBe(200);
    expect(byStreet.body.customers).toEqual([]);
    expect(byStreet.body.addresses).toEqual([
      {
        id: m.property.id,
        addressLine: '1200 Pine St',
        city: 'Omaha',
        state: 'NE',
        zip: '68102',
        customerId: m.customer.id,
        customerName: 'Maria Lopez',
      },
    ]);
    expect(byStreet.body.jobs.map((j: { id: string }) => j.id)).toEqual([m.job.id]);
  });

  test('an address is also found by its city or ZIP; a customer by the digits of a phone number', async () => {
    const owner = await who.as('owner');
    const m = await maria(owner);
    for (const q of ['omaha', '68102']) {
      const res = await search(owner, q);
      expect(res.body.addresses.map((a: { id: string }) => a.id), q).toEqual([m.property.id]);
      // Jobs match on the customer's name or the address line, not the city or ZIP.
      expect(res.body.jobs, q).toEqual([]);
    }
    for (const q of ['555-0142', '(402) 555', '5550142']) {
      expect((await search(owner, q)).body.customers.map((c: { id: string }) => c.id), q).toEqual([m.customer.id]);
    }
    // Under three digits a number is not looked up.
    expect((await search(owner, '55')).body.customers).toEqual([]);
  });

  test('a customer with no number has phone null; the primary number is the one shown', async () => {
    const owner = await who.as('owner');
    await mustCreate(owner, '/api/customers', { displayName: 'Zed Nophone' });
    await mustCreate(owner, '/api/customers', {
      displayName: 'Zed Twophones',
      phones: [{ number: '402-555-0100' }, { number: '402-555-0101', primary: true }],
    });
    const res = await search(owner, 'zed');
    expect(res.body.customers.map((c: { displayName: string; phone: string | null }) => [c.displayName, c.phone])).toEqual([
      ['Zed Nophone', null],
      ['Zed Twophones', '+14025550101'],
    ]);
  });

  test('caps each list at 8', async () => {
    const owner = await who.as('owner');
    for (let n = 1; n <= 10; n += 1) {
      const customer = await mustCreate(owner, '/api/customers', { displayName: `Maple ${String(n).padStart(2, '0')}` });
      const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(n), addressLine: `${String(n).padStart(2, '0')} Maple Ave` });
      await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id });
    }
    const res = await search(owner, 'maple');
    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(8);
    expect(res.body.addresses).toHaveLength(8);
    expect(res.body.jobs).toHaveLength(8);
    // Customers come in name order; addresses in address order.
    expect(res.body.customers.map((c: { displayName: string }) => c.displayName)).toEqual(
      Array.from({ length: 8 }, (_, i) => `Maple ${String(i + 1).padStart(2, '0')}`),
    );
    expect(res.body.addresses.map((a: { addressLine: string }) => a.addressLine)).toEqual(
      Array.from({ length: 8 }, (_, i) => `${String(i + 1).padStart(2, '0')} Maple Ave`),
    );
  });

  test('jobs come newest first', async () => {
    const owner = await who.as('owner');
    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Order Customer' });
    const ids: string[] = [];
    for (let n = 1; n <= 3; n += 1) {
      t.clock.advance(60_000);
      const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(n) });
      ids.push((await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id })).id);
    }
    // The clock only stamps the rows the app writes; make the creation order unambiguous in the table.
    await inCompany(t, A(), async (tx) => {
      for (const [i, id] of ids.entries()) {
        await tx.update(jobs).set({ createdAt: new Date(Date.UTC(2026, 9, 1 + i)) }).where(eq(jobs.id, id));
      }
    });
    const res = await search(owner, 'order');
    expect(res.body.jobs.map((j: { id: string }) => j.id)).toEqual([...ids].reverse());
  });

  test.each([undefined, '', ' ', 'a', ' a ', '🏠', '  x  '])('returns empty lists for a short query: %j', async (q) => {
    const owner = await who.as('owner');
    await maria(owner);
    await mustCreate(owner, '/api/customers', { displayName: 'X Ray' });
    const res = await search(owner, q);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ customers: [], jobs: [], addresses: [] });
  });

  test('a repeated q is not a search', async () => {
    const owner = await who.as('owner');
    await maria(owner);
    const res = await owner.get('/api/search?q=maria&q=lopez');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Please check this field.', field: 'q' });
  });

  test('the query is trimmed', async () => {
    const owner = await who.as('owner');
    const m = await maria(owner);
    const res = await search(owner, '   lopez   ');
    expect(res.body.customers.map((c: { id: string }) => c.id)).toEqual([m.customer.id]);
  });

  test('more than 100 characters are cut to 100', async () => {
    const owner = await who.as('owner');
    const name = 'N'.repeat(100);
    const created = await mustCreate(owner, '/api/customers', { displayName: name });
    // 100 matching characters followed by noise that the cut removes.
    const res = await search(owner, `${name}ZZZZZZZZZZ`);
    expect(res.status).toBe(200);
    expect(res.body.customers.map((c: { id: string }) => c.id)).toEqual([created.id]);
  });

  test('survives LIKE characters, quotes and emoji', async () => {
    const owner = await who.as('owner');
    for (const displayName of ['Alpha', 'Beta', '100% Roofing', 'snake_case', "Pat O'Neil", 'Quote "Man"', 'Roof 🏠 Pros']) {
      await mustCreate(owner, '/api/customers', { displayName });
    }
    const names = async (q: string) => {
      const res = await search(owner, q);
      expect(res.status, q).toBe(200);
      expect(Object.keys(res.body).sort(), q).toEqual(['addresses', 'customers', 'jobs']);
      return res.body.customers.map((c: { displayName: string }) => c.displayName) as string[];
    };
    // A wildcard is matched as itself and does not match everything.
    expect(await names('%')).toEqual([]); // one character: too short to search
    expect(await names('0%')).toEqual(['100% Roofing']);
    expect(await names('e_c')).toEqual(['snake_case']);
    expect(await names('%%')).toEqual([]);
    expect(await names('__')).toEqual([]);
    expect(await names('\\')).toEqual([]);
    expect(await names('a\\')).toEqual([]);
    expect(await names("o'neil")).toEqual(["Pat O'Neil"]);
    expect(await names("'; drop table customers; --")).toEqual([]);
    expect(await names('"')).toEqual([]);
    expect(await names('"M')).toEqual(['Quote "Man"']);
    expect(await names('🏠')).toEqual([]); // one character
    expect(await names('f 🏠')).toEqual(['Roof 🏠 Pros']);
    expect(await names('x'.repeat(150))).toEqual([]);
    // A NUL character cannot be stored in text, so it is ignored rather than failing the query.
    const nul = await owner.get('/api/search?q=alp%00ha');
    expect(nul.status).toBe(200);
    expect(nul.body.customers.map((c: { displayName: string }) => c.displayName)).toEqual(['Alpha']);
    // Both ends of a 150-character query made of emoji are cut on a character, not in the middle of one.
    expect((await search(owner, '🏠'.repeat(150))).status).toBe(200);
  });

  test('leaves out archived customers and jobs, and addresses with no customer or an archived one', async () => {
    const owner = await who.as('owner');
    const live = await maria(owner);

    const gone = await mustCreate(owner, '/api/customers', { displayName: 'Maria Archived' });
    const goneProperty = await mustCreate(owner, '/api/properties', { customerId: gone.id, ...addressFor(5), addressLine: '5 Pine Archived Ct' });
    const noCustomer = await mustCreate(owner, '/api/properties', { ...addressFor(6), addressLine: '6 Pine Orphan Ct' });
    const archivedJobCustomer = await mustCreate(owner, '/api/customers', { displayName: 'Maria Jobless' });
    const archivedJobProperty = await mustCreate(owner, '/api/properties', { customerId: archivedJobCustomer.id, ...addressFor(7) });
    const archivedJob = await mustCreate(owner, '/api/jobs', { customerId: archivedJobCustomer.id, propertyId: archivedJobProperty.id });
    await inCompany(t, A(), async (tx) => {
      await tx.update(customers).set({ archivedAt: new Date() }).where(eq(customers.id, gone.id));
      await tx.update(jobs).set({ archivedAt: new Date() }).where(eq(jobs.id, archivedJob.id));
    });

    const res = await search(owner, 'maria');
    expect(res.body.customers.map((c: { id: string }) => c.id).sort()).toEqual([archivedJobCustomer.id, live.customer.id].sort());
    expect(res.body.jobs.map((j: { id: string }) => j.id)).toEqual([live.job.id]);

    const addresses = await search(owner, 'pine');
    expect(addresses.body.addresses.map((a: { id: string }) => a.id)).toEqual([live.property.id]);
    expect(JSON.stringify(addresses.body)).not.toContain(goneProperty.id);
    expect(JSON.stringify(addresses.body)).not.toContain(noCustomer.id);
  });

  test('scopes a rep to what they may see', async () => {
    const owner = await who.as('owner');
    const rep = await who.as('rep');

    const mine = await mustCreate(owner, '/api/customers', { displayName: 'Zed Mine' });
    const mineProperty = await mustCreate(owner, '/api/properties', { customerId: mine.id, ...addressFor(1), addressLine: '1 Zed Mine Rd' });
    const mineJob = await mustCreate(owner, '/api/jobs', {
      customerId: mine.id,
      propertyId: mineProperty.id,
      stage: 'inspection',
      assignedUserId: who.user('rep').userId,
    });

    const theirs = await mustCreate(owner, '/api/customers', { displayName: 'Zed Theirs' });
    const theirsProperty = await mustCreate(owner, '/api/properties', { customerId: theirs.id, ...addressFor(2), addressLine: '2 Zed Theirs Rd' });
    const theirsJob = await mustCreate(owner, '/api/jobs', {
      customerId: theirs.id,
      propertyId: theirsProperty.id,
      stage: 'inspection',
      assignedUserId: who.user('otherRep').userId,
    });

    const nobody = await mustCreate(owner, '/api/customers', { displayName: 'Zed Nobody' });
    const nobodyProperty = await mustCreate(owner, '/api/properties', { customerId: nobody.id, ...addressFor(3), addressLine: '3 Zed Nobody Rd' });

    const res = await search(rep, 'zed');
    expect(res.status).toBe(200);
    expect(res.body.customers.map((c: { id: string }) => c.id)).toEqual([mine.id]);
    expect(res.body.jobs.map((j: { id: string }) => j.id)).toEqual([mineJob.id]);
    expect(res.body.addresses.map((a: { id: string }) => a.id)).toEqual([mineProperty.id]);
    const text = JSON.stringify(res.body);
    for (const hidden of [theirs.id, theirsProperty.id, theirsJob.id, nobody.id, nobodyProperty.id]) expect(text).not.toContain(hidden);

    // The other rep sees their own side, and the owner sees all three.
    const other = await search(await who.as('otherRep'), 'zed');
    expect(other.body.customers.map((c: { id: string }) => c.id)).toEqual([theirs.id]);
    const all = await search(owner, 'zed');
    expect(all.body.customers.map((c: { id: string }) => c.id).sort()).toEqual([mine.id, theirs.id, nobody.id].sort());
    expect(all.body.addresses).toHaveLength(3);
    expect(all.body.jobs).toHaveLength(2);
  });

  test('a rep finds their own customer, and an unassigned lead anyone may pick up', async () => {
    const owner = await who.as('owner');
    const rep = await who.as('rep');
    const own = await mustCreate(rep, '/api/customers', { displayName: 'Quinn Own' });
    const leadCustomer = await mustCreate(owner, '/api/customers', { displayName: 'Quinn Lead' });
    const leadProperty = await mustCreate(owner, '/api/properties', { customerId: leadCustomer.id, ...addressFor(4), addressLine: '4 Quinn Way' });
    const lead = await mustCreate(owner, '/api/jobs', { customerId: leadCustomer.id, propertyId: leadProperty.id });
    const res = await search(rep, 'quinn');
    expect(res.body.customers.map((c: { id: string }) => c.id).sort()).toEqual([leadCustomer.id, own.id].sort());
    expect(res.body.jobs.map((j: { id: string }) => j.id)).toEqual([lead.id]);
    expect(res.body.addresses.map((a: { id: string }) => a.id)).toEqual([leadProperty.id]);
  });

  test('stays inside the company', async () => {
    const a = await maria(await who.as('owner'));
    const bOwner = await who.as('owner', 'b');
    const b = await maria(bOwner);
    await mustCreate(bOwner, '/api/customers', { displayName: 'Maria Only In B' });

    for (const q of ['lop', 'pine', 'maria', '555-0142']) {
      const res = await search(await who.as('owner'), q);
      const text = JSON.stringify(res.body);
      for (const id of [b.customer.id, b.property.id, b.job.id]) expect(text, q).not.toContain(id);
      expect(text, q).not.toContain('Only In B');
    }
    const res = await search(await who.as('owner'), 'maria');
    expect(res.body.customers.map((c: { id: string }) => c.id)).toEqual([a.customer.id]);
    expect(await inCompany(t, B(), (tx) => tx.select().from(customers))).toHaveLength(2);
    // And the other way round.
    const fromB = await search(bOwner, 'maria');
    expect(fromB.body.customers.map((c: { displayName: string }) => c.displayName)).toEqual(['Maria Lopez', 'Maria Only In B']);
    expect(JSON.stringify(fromB.body)).not.toContain(a.customer.id);
  });

  test('needs a signed-in member', async () => {
    const res = await request(t.app).get('/api/search').query({ q: 'maria' });
    expect(res.status).toBe(401);
  });
});
