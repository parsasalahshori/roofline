import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import { customers, jobs, properties } from '@roofline/db';
import { Actors, addressFor, inCompany, mustCreate } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const BAD_BOX = 'Please give the map area as west,south,east,north.';
const BAD_LAYERS = 'Please pick customers, jobs or both.';

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
});

const A = () => t.seed.a.companyId;

type Agent = Awaited<ReturnType<Actors['as']>>;
type Created = { id: string };

const OMAHA = { lat: 41.25, lng: -95.93 };
const BOX = '-96.2,41.1,-95.8,41.4';

const pins = (agent: Agent, bbox: string = BOX, layers?: string) =>
  agent.get('/api/map/pins').query({ bbox, ...(layers !== undefined && { layers }) });

const idsOf = (list: { jobId?: string; propertyId?: string }[], key: 'jobId' | 'propertyId') => list.map((p) => p[key]).sort();

/** Customer `name`, with an address at (lat, lng) and nothing else. */
async function located(agent: Agent, name: string, n: number, at: { lat: number; lng: number } | null, extra: Record<string, unknown> = {}) {
  const customer = (await mustCreate(agent, '/api/customers', { displayName: name })) as Created;
  const property = (await mustCreate(agent, '/api/properties', {
    customerId: customer.id,
    ...addressFor(n),
    ...(at !== null ? at : { lat: null, lng: null }), // null: saved with no point (no server lookup)
    ...extra,
  })) as Created;
  return { customer, property };
}

const job = (agent: Agent, c: { customer: Created; property: Created }, extra: Record<string, unknown> = {}) =>
  mustCreate(agent, '/api/jobs', { customerId: c.customer.id, propertyId: c.property.id, ...extra }) as Promise<Created>;

/** Inserts `n` customers, each with one located address, in a single statement (grid of 50 columns, 0.01 degree apart). */
async function bulkLocated(companyId: string, n: number, firstIndex = 1) {
  await inCompany(t, companyId, (tx) =>
    tx.execute(sql`
      with s as (
        select g, gen_random_uuid() as id from generate_series(${firstIndex}::int, ${firstIndex + n - 1}::int) g
      ), c as (
        insert into customers (id, company_id, display_name)
        select id, ${companyId}::uuid, 'Grid ' || g from s
      )
      insert into properties (company_id, customer_id, address_line, city, state, zip, address_key, geom)
      select ${companyId}::uuid, id, g || ' Grid St', 'Omaha', 'NE', '68102', g || ' grid st|68102',
             ST_SetSRID(ST_MakePoint(-96.5 + (g % 50) * 0.01, 41.0 + (g / 50) * 0.01), 4326)
      from s
    `),
  );
}

describe('GET /api/map/pins', () => {
  test('returns customer and open-job pins inside the box', async () => {
    const owner = await who.as('owner');
    const near = await located(owner, 'Maria Lopez', 1, OMAHA, { addressLine: '1200 Pine St' });
    const far = await located(owner, 'Far Away', 2, { lat: 30, lng: -90 });
    // A second house for Maria, outside the box.
    const faraway = await mustCreate(owner, '/api/properties', { customerId: near.customer.id, ...addressFor(3), lat: 30.1, lng: -90.1 });

    const proposal = await job(owner, near, { stage: 'proposal' });
    await job(owner, near, { stage: 'lost' });
    await job(owner, far, { stage: 'lead' });

    const res = await pins(owner);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      mode: 'points',
      customers: [
        {
          propertyId: near.property.id,
          customerId: near.customer.id,
          lng: -95.93,
          lat: 41.25,
          name: 'Maria Lopez',
          addressLine: '1200 Pine St',
        },
      ],
      jobs: [
        {
          jobId: proposal.id,
          customerId: near.customer.id,
          propertyId: near.property.id,
          stage: 'proposal',
          stageLabel: 'Proposal',
          lng: -95.93,
          lat: 41.25,
          name: 'Maria Lopez',
          addressLine: '1200 Pine St',
        },
      ],
    });
    expect(JSON.stringify(res.body)).not.toContain(far.property.id);
    expect(JSON.stringify(res.body)).not.toContain(faraway.id);

    // A box around the far houses finds those instead.
    const other = await pins(owner, '-90.5,29.5,-89.5,30.5');
    expect(idsOf(other.body.customers, 'propertyId')).toEqual([far.property.id, faraway.id].sort());
    expect(other.body.jobs.map((j: { stage: string }) => j.stage)).toEqual(['lead']);
  });

  test('a customer with several addresses has a pin for each; the open stages are lead, inspection, proposal and won', async () => {
    const owner = await who.as('owner');
    const c = await located(owner, 'Many Houses', 1, OMAHA);
    const second = await mustCreate(owner, '/api/properties', { customerId: c.customer.id, ...addressFor(2), lat: 41.26, lng: -95.94 });
    const stages = ['lead', 'inspection', 'proposal', 'won', 'installed', 'lost'] as const;
    for (const stage of stages) await job(owner, c, { stage });

    const res = await pins(owner);
    expect(idsOf(res.body.customers, 'propertyId')).toEqual([c.property.id, second.id].sort());
    expect(res.body.jobs.map((j: { stage: string }) => j.stage).sort()).toEqual(['inspection', 'lead', 'proposal', 'won']);
    expect(Object.fromEntries(res.body.jobs.map((j: { stage: string; stageLabel: string }) => [j.stage, j.stageLabel]))).toEqual({
      lead: 'Lead',
      inspection: 'Inspection',
      proposal: 'Proposal',
      won: 'Won',
    });
  });

  test('leaves out archived rows, addresses with no customer or no location', async () => {
    const owner = await who.as('owner');
    const live = await located(owner, 'Live', 1, OMAHA);
    const liveJob = await job(owner, live, { stage: 'lead' });

    const archivedCustomer = await located(owner, 'Archived Customer', 2, OMAHA);
    const archivedCustomerJob = await job(owner, archivedCustomer, { stage: 'proposal' });
    const archivedProperty = await located(owner, 'Archived Property', 3, OMAHA);
    const noPlace = await located(owner, 'No Place', 4, null);
    const archivedJob = await job(owner, live, { stage: 'proposal' });
    const noPlaceJob = await job(owner, noPlace, { stage: 'lead' });
    const orphan = await mustCreate(owner, '/api/properties', { ...addressFor(5), ...OMAHA });
    await inCompany(t, A(), async (tx) => {
      await tx.update(customers).set({ archivedAt: new Date() }).where(eq(customers.id, archivedCustomer.customer.id));
      await tx.update(properties).set({ archivedAt: new Date() }).where(eq(properties.id, archivedProperty.property.id));
      await tx.update(jobs).set({ archivedAt: new Date() }).where(eq(jobs.id, archivedJob.id));
    });

    const res = await pins(owner);
    expect(res.body.mode).toBe('points');
    expect(res.body.customers.map((p: { propertyId: string }) => p.propertyId)).toEqual([live.property.id]);
    expect(res.body.jobs.map((p: { jobId: string }) => p.jobId)).toEqual([liveJob.id]);
    const text = JSON.stringify(res.body);
    for (const hidden of [archivedCustomer.property.id, archivedCustomerJob.id, archivedProperty.property.id, noPlace.property.id, noPlaceJob.id, archivedJob.id, orphan.id]) {
      expect(text).not.toContain(hidden);
    }
  });

  test('layers picks customers, jobs, or both', async () => {
    const owner = await who.as('owner');
    const c = await located(owner, 'Both Layers', 1, OMAHA);
    await job(owner, c, { stage: 'lead' });

    const customersOnly = await pins(owner, BOX, 'customers');
    expect(customersOnly.body).toMatchObject({ mode: 'points', jobs: [] });
    expect(customersOnly.body.customers).toHaveLength(1);

    const jobsOnly = await pins(owner, BOX, 'jobs');
    expect(jobsOnly.body).toMatchObject({ mode: 'points', customers: [] });
    expect(jobsOnly.body.jobs).toHaveLength(1);

    for (const layers of ['customers,jobs', 'jobs,customers', 'jobs, customers', 'jobs,jobs']) {
      const both = await pins(owner, BOX, layers);
      expect(both.status, layers).toBe(200);
      expect(both.body.jobs, layers).toHaveLength(1);
      if (layers !== 'jobs,jobs') expect(both.body.customers, layers).toHaveLength(1);
    }
    expect((await pins(owner)).body.customers).toHaveLength(1);
  });

  test('a point on the edge of the box is inside it', async () => {
    const owner = await who.as('owner');
    const c = await located(owner, 'On The Edge', 1, { lat: 41.1, lng: -96.2 });
    const res = await pins(owner, '-96.2,41.1,-95.8,41.4');
    expect(res.body.customers.map((p: { propertyId: string }) => p.propertyId)).toEqual([c.property.id]);
  });

  test.each([
    ['too few numbers', '1,2,3'],
    ['too many numbers', '1,2,3,4,5'],
    ['west is not less than east', '10,0,5,1'],
    ['west equals east', '0,0,0,1'],
    ['south is not less than north', '0,5,1,4'],
    ['not numbers', 'a,b,c,d'],
    ['an empty part', '1,2,3,'],
    ['only commas', ',,,'],
    ['a blank part', '1, ,3,4'],
    ['west below -180', '-181,0,0,1'],
    ['east above 180', '0,0,181,1'],
    ['south below -90', '0,-91,1,1'],
    ['north above 90', '0,0,1,91'],
    ['Infinity', 'Infinity,0,1,1'],
    ['NaN', 'NaN,0,1,1'],
    ['an exponent', '1e999,0,1,2'],
    ['empty', ''],
  ])('refuses a bad box: %s', async (_name, bbox) => {
    const res = await pins(await who.as('owner'), bbox);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: BAD_BOX, field: 'bbox' });
  });

  test('refuses a missing or repeated bbox', async () => {
    const owner = await who.as('owner');
    for (const url of ['/api/map/pins', '/api/map/pins?bbox=0,0,1,1&bbox=0,0,2,2']) {
      const res = await owner.get(url);
      expect(res.status, url).toBe(400);
      expect(res.body, url).toEqual({ error: BAD_BOX, field: 'bbox' });
    }
  });

  test('accepts whole-world and decimal boxes', async () => {
    const owner = await who.as('owner');
    for (const bbox of ['-180,-90,180,90', '-96.2,41.1,-95.8,41.4', '-96.20,+41.1,-95.8,41.40', ' -96.2 , 41.1 , -95.8 , 41.4 ', '0,0,0.0001,0.0001']) {
      expect((await pins(owner, bbox)).status, bbox).toBe(200);
    }
  });

  test('refuses an unknown layer', async () => {
    const owner = await who.as('owner');
    for (const layers of ['roofs', 'customers,roofs', '', 'customer', 'JOBS']) {
      const res = await pins(owner, BOX, layers);
      expect(res.status, layers).toBe(400);
      expect(res.body, layers).toEqual({ error: BAD_LAYERS, field: 'layers' });
    }
  });

  test('a bad box is reported before a bad layer', async () => {
    const res = await pins(await who.as('owner'), 'x', 'roofs');
    expect(res.body).toEqual({ error: BAD_BOX, field: 'bbox' });
  });

  test('clusters on the server above 2,000 points', async () => {
    const owner = await who.as('owner');
    await bulkLocated(A(), 2000);
    const exactly = await pins(owner, '-97,40.5,-95,43');
    expect(exactly.status).toBe(200);
    expect(exactly.body.mode).toBe('points');
    expect(exactly.body.customers).toHaveLength(2000);

    await bulkLocated(A(), 1, 2001);
    const res = await pins(owner, '-97,40.5,-95,43');
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('clusters');
    expect(res.body.total).toBe(2001);
    const clusters = res.body.clusters as { layer: string; lng: number; lat: number; count: number }[];
    expect(clusters.length).toBeGreaterThan(1);
    expect(clusters.length).toBeLessThan(200);
    expect(new Set(clusters.map((c) => c.layer))).toEqual(new Set(['customers']));
    expect(clusters.reduce((sum, c) => sum + c.count, 0)).toBe(2001);
    for (const c of clusters) {
      expect(c.count).toBeGreaterThan(0);
      // Every cluster sits at the middle of points that are inside the box.
      expect(c.lng).toBeGreaterThanOrEqual(-97);
      expect(c.lng).toBeLessThanOrEqual(-95);
      expect(c.lat).toBeGreaterThanOrEqual(40.5);
      expect(c.lat).toBeLessThanOrEqual(43);
    }
    expect(Object.keys(res.body).sort()).toEqual(['clusters', 'mode', 'total']);
  });

  test('clusters are made per layer, and a box that holds few points still gets points', async () => {
    const owner = await who.as('owner');
    await bulkLocated(A(), 2001);
    // Jobs on three of the grid's addresses.
    await inCompany(t, A(), (tx) =>
      tx.execute(sql`
        insert into jobs (company_id, customer_id, property_id, stage)
        select company_id, customer_id, id, 'lead' from properties where company_id = ${A()}::uuid order by address_line limit 3
      `),
    );
    const res = await pins(owner, '-97,40.5,-95,43');
    expect(res.body.mode).toBe('clusters');
    expect(res.body.total).toBe(2004);
    const clusters = res.body.clusters as { layer: string; count: number }[];
    const sum = (layer: string) => clusters.filter((c) => c.layer === layer).reduce((s, c) => s + c.count, 0);
    expect(sum('customers')).toBe(2001);
    expect(sum('jobs')).toBe(3);

    // Only the jobs layer: three points, so no clustering.
    const jobsOnly = await pins(owner, '-97,40.5,-95,43', 'jobs');
    expect(jobsOnly.body.mode).toBe('points');
    expect(jobsOnly.body.jobs).toHaveLength(3);

    // A small box inside the grid: a few points.
    const small = await pins(owner, '-96.5,41.0,-96.45,41.02', 'customers');
    expect(small.body.mode).toBe('points');
    expect(small.body.customers.length).toBeGreaterThan(0);
    expect(small.body.customers.length).toBeLessThan(100);
  });

  test('scopes a rep', async () => {
    const owner = await who.as('owner');
    const rep = await who.as('rep');

    const mine = await located(owner, 'Mine', 1, OMAHA);
    const mineJob = await job(owner, mine, { stage: 'inspection', assignedUserId: who.user('rep').userId });
    const theirs = await located(owner, 'Theirs', 2, OMAHA);
    const theirsJob = await job(owner, theirs, { stage: 'inspection', assignedUserId: who.user('otherRep').userId });
    const nobody = await located(owner, 'Nobody', 3, OMAHA);
    const lead = await located(owner, 'Open Lead', 4, OMAHA);
    const leadJob = await job(owner, lead, { stage: 'lead' });
    const ownCustomer = (await mustCreate(rep, '/api/customers', { displayName: 'Own Customer' })) as Created;
    const ownProperty = (await mustCreate(rep, '/api/properties', { customerId: ownCustomer.id, ...addressFor(5), ...OMAHA })) as Created;

    const res = await pins(rep);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('points');
    expect(idsOf(res.body.customers, 'propertyId')).toEqual([mine.property.id, lead.property.id, ownProperty.id].sort());
    expect(idsOf(res.body.jobs, 'jobId')).toEqual([mineJob.id, leadJob.id].sort());
    const text = JSON.stringify(res.body);
    for (const hidden of [theirs.property.id, theirs.customer.id, theirsJob.id, nobody.property.id, nobody.customer.id]) {
      expect(text).not.toContain(hidden);
    }

    // The owner and the office see everything.
    for (const member of ['owner', 'office'] as const) {
      const all = await pins(await who.as(member));
      expect(all.body.customers, member).toHaveLength(5);
      expect(all.body.jobs, member).toHaveLength(3);
    }
  });

  test('a rep is counted on what they can see, not on what the company has', async () => {
    const owner = await who.as('owner');
    const rep = await who.as('rep');
    const mine = await located(rep, 'Mine', 1, OMAHA);
    await bulkLocated(A(), 2001, 100);

    const asOwner = await pins(owner, '-97,40.5,-95,43');
    expect(asOwner.body.mode).toBe('clusters');
    expect(asOwner.body.total).toBe(2002);

    const asRep = await pins(rep, '-97,40.5,-95,43');
    expect(asRep.body.mode).toBe('points');
    expect(asRep.body.customers.map((p: { propertyId: string }) => p.propertyId)).toEqual([mine.property.id]);
  });

  test('stays inside the company', async () => {
    const owner = await who.as('owner');
    const bOwner = await who.as('owner', 'b');
    const a = await located(owner, 'Acme Customer', 1, OMAHA);
    const b = await located(bOwner, 'Bolt Customer', 1, OMAHA);
    const bJob = await job(bOwner, b, { stage: 'lead' });

    const res = await pins(owner);
    expect(res.body.customers.map((p: { propertyId: string }) => p.propertyId)).toEqual([a.property.id]);
    expect(res.body.jobs).toEqual([]);
    const text = JSON.stringify(res.body);
    for (const id of [b.customer.id, b.property.id, bJob.id]) expect(text).not.toContain(id);

    await bulkLocated(t.seed.b.companyId, 2001);
    const stillA = await pins(owner, '-97,40.5,-95,43');
    expect(stillA.body.mode).toBe('points');
    expect(stillA.body.customers).toHaveLength(1);
  });

  test('needs a signed-in member', async () => {
    const res = await request(t.app).get('/api/map/pins').query({ bbox: BOX });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/map/area', () => {
  const SQUARE = 'POLYGON((-96.5 41.0, -95.5 41.0, -95.5 41.5, -96.5 41.5, -96.5 41.0))';
  const setArea = (companyId: string, wkt: string | null) =>
    inCompany(t, companyId, (tx) =>
      wkt === null
        ? tx.execute(sql`update companies set service_area = null where id = ${companyId}::uuid`)
        : tx.execute(sql`update companies set service_area = ST_Multi(ST_GeomFromText(${wkt}, 4326)) where id = ${companyId}::uuid`),
    );

  test('service area, else address extent, else null', async () => {
    const owner = await who.as('owner');
    const empty = await owner.get('/api/map/area');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ serviceArea: null, bounds: null });

    // An address with no location does not count.
    await located(owner, 'No Place', 1, null);
    expect((await owner.get('/api/map/area')).body).toEqual({ serviceArea: null, bounds: null });

    // One located property: its own extent.
    await located(owner, 'Here', 2, OMAHA);
    expect((await owner.get('/api/map/area')).body).toEqual({ serviceArea: null, bounds: [-95.93, 41.25, -95.93, 41.25] });

    // More: the box around all of them.
    await located(owner, 'There', 3, { lat: 40.8, lng: -96.7 });
    expect((await owner.get('/api/map/area')).body.bounds).toEqual([-96.7, 40.8, -95.93, 41.25]);

    // A service area wins over the addresses.
    await setArea(A(), SQUARE);
    const res = await owner.get('/api/map/area');
    expect(res.status).toBe(200);
    expect(res.body.serviceArea.type).toBe('MultiPolygon');
    expect(res.body.serviceArea.coordinates).toHaveLength(1);
    expect(res.body.serviceArea.coordinates[0][0]).toHaveLength(5);
    expect(res.body.serviceArea.coordinates[0][0][0]).toEqual([-96.5, 41]);
    expect(res.body.bounds).toEqual([-96.5, 41, -95.5, 41.5]);
    expect(Object.keys(res.body).sort()).toEqual(['bounds', 'serviceArea']);

    // Cleared again, the addresses are used.
    await setArea(A(), null);
    expect((await owner.get('/api/map/area')).body).toEqual({ serviceArea: null, bounds: [-96.7, 40.8, -95.93, 41.25] });
  });

  test('archived addresses are not counted', async () => {
    const owner = await who.as('owner');
    const c = await located(owner, 'Gone', 1, OMAHA);
    await inCompany(t, A(), (tx) => tx.update(properties).set({ archivedAt: new Date() }).where(eq(properties.id, c.property.id)));
    expect((await owner.get('/api/map/area')).body).toEqual({ serviceArea: null, bounds: null });
  });

  test("a rep gets the company's service area, and extent of only the addresses they may see", async () => {
    const owner = await who.as('owner');
    const rep = await who.as('rep');
    expect((await rep.get('/api/map/area')).body).toEqual({ serviceArea: null, bounds: null });

    await located(owner, 'Hidden', 1, OMAHA);
    expect((await rep.get('/api/map/area')).body).toEqual({ serviceArea: null, bounds: null });
    expect((await owner.get('/api/map/area')).body.bounds).toEqual([-95.93, 41.25, -95.93, 41.25]);

    await located(rep, 'Visible', 2, { lat: 40.8, lng: -96.7 });
    expect((await rep.get('/api/map/area')).body.bounds).toEqual([-96.7, 40.8, -96.7, 40.8]);

    await setArea(A(), SQUARE);
    const res = await rep.get('/api/map/area');
    expect(res.body.serviceArea.type).toBe('MultiPolygon');
    expect(res.body.bounds).toEqual([-96.5, 41, -95.5, 41.5]);
  });

  test('stays inside the company', async () => {
    const owner = await who.as('owner');
    const bOwner = await who.as('owner', 'b');
    await setArea(t.seed.b.companyId, SQUARE);
    await located(bOwner, 'Bolt', 1, OMAHA);
    expect((await owner.get('/api/map/area')).body).toEqual({ serviceArea: null, bounds: null });
    expect((await bOwner.get('/api/map/area')).body.bounds).toEqual([-96.5, 41, -95.5, 41.5]);
  });

  test('needs a signed-in member', async () => {
    expect((await request(t.app).get('/api/map/area')).status).toBe(401);
  });
});
