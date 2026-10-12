import pg from 'pg';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, inject, it } from 'vitest';
import { Actors, addressFor, dbProperty, inCompany, mustCreate, NO_UUID, NOT_FOUND } from './crm-helpers.ts';
import { makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';
import { proposals } from '@roofline/db';
import { claimFootprintState, finishFootprintState, insertFootprints, type FootprintInput } from '@roofline/db/system';
import { instantEstimate, type LngLat, type MeasurementView, type Ring } from '@roofline/shared';

/*
 * The measurements API: POST /api/measurements measures a home from the building outline under its
 * point; GET and PATCH read and change the measurement. Footprints are global rows written through
 * the system pool (the loader's job), so each test loads what it needs into state NE.
 *
 * Geometry: at latitude 41.25, 0.0001 degrees of longitude is about 8.4 m and 0.0001 degrees of
 * latitude about 11.1 m. Corners are [lng, lat].
 */

const NOW = new Date('2026-10-12T15:00:00.000Z');
const PITCH = 6;
const OVERHANG = 1;

/** A house about 25 m by 22 m. */
const HOUSE: Ring = [
  [-96.0, 41.25],
  [-95.9997, 41.25],
  [-95.9997, 41.2502],
  [-96.0, 41.2502],
  [-96.0, 41.25],
];
/** A second structure about 16 m east of the house. */
const NEIGHBOR: Ring = [
  [-95.9995, 41.25],
  [-95.9992, 41.25],
  [-95.9992, 41.2502],
  [-95.9995, 41.2502],
  [-95.9995, 41.25],
];
/** A structure far from every test point. */
const FAR: Ring = [
  [-95.95, 41.3],
  [-95.9497, 41.3],
  [-95.9497, 41.3002],
  [-95.95, 41.3002],
  [-95.95, 41.3],
];
/** A larger rectangle for outline edits (still a sensible house). */
const WIDER: Ring = [
  [-96.0, 41.25],
  [-95.9995, 41.25],
  [-95.9995, 41.2503],
  [-96.0, 41.2503],
  [-96.0, 41.25],
];

/** Inside the house. */
const INSIDE: LngLat = [-95.99985, 41.2501];
/** About 15 m west of the house: outside it, but within the snap distance. */
const NEAR_15M: LngLat = [-96.00018, 41.2501];
/** About 35 m west of the house: outside the snap distance. */
const FAR_35M: LngLat = [-96.00042, 41.2501];
/** Nowhere near any fixture footprint. */
const NOWHERE_NEAR: LngLat = [-95.9, 41.4];

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(NOW);
});

const A = () => t.seed.a.companyId;
const repId = () => who.user('rep').userId;
const otherRepId = () => who.user('otherRep').userId;

/** One statement through the owner connection (it sees every table, so it can set a test's geometry). */
async function ownerSql(text: string, params: unknown[] = []): Promise<void> {
  const client = new pg.Client({ connectionString: inject('dbUrls').owner });
  await client.connect();
  try {
    await client.query(text, params);
  } finally {
    await client.end();
  }
}

/** Puts a saved address's point where the test needs it (the fake geocoder's point is not controlled). */
async function placeAt(propertyId: string, at: LngLat): Promise<void> {
  await ownerSql(`update properties set geom = ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326) where id = $3`, [at[0], at[1], propertyId]);
}

/** A saved address for the owner of company A, with its point at `at`. */
async function homeAt(n: number, at: LngLat): Promise<string> {
  const owner = await who.as('owner');
  const property = await mustCreate(owner, '/api/properties', addressFor(n));
  await placeAt(property.id, at);
  return property.id;
}

/** Loads footprints into state NE and marks it ready (the loader's job, run by hand). */
async function loadNE(...footprints: { sourceRef: string; ring: Ring }[]): Promise<void> {
  const now = t.clock.now();
  const input: FootprintInput[] = footprints.map((f) => ({ sourceRef: f.sourceRef, ring: f.ring }));
  expect(await claimFootprintState(t.deps.pools.system, 'NE', 'https://fixtures.test/NE.zip', now)).toBe(true);
  const count = await insertFootprints(t.deps.pools.system, 'NE', input);
  await finishFootprintState(t.deps.pools.system, 'NE', count, now);
}

/** The ids of the footprints the tests loaded, by their source ref. */
async function footprintIds(): Promise<Record<string, string>> {
  const rows = await inCompany(t, A(), async (tx) => {
    const result = await tx.execute(sql`select id::text as id, source_ref from building_footprints`);
    return result.rows as { id: string; source_ref: string }[];
  });
  return Object.fromEntries(rows.map((r) => [r.source_ref, r.id]));
}

/** POST /api/measurements that must be a 201; returns the view. */
async function measure(agent: SuperAgent, body: Record<string, unknown>): Promise<MeasurementView> {
  const res = await agent.post('/api/measurements').send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as MeasurementView;
}

/** A measurement's view as the owner of company A reads it. */
async function getView(id: string): Promise<MeasurementView> {
  const owner = await who.as('owner');
  const res = await owner.get(`/api/measurements/${id}`);
  expect(res.status).toBe(200);
  return res.body as MeasurementView;
}

/** The fixture's estimate for an outline with the company's default pitch and overhang. */
const estimateOf = (outline: Ring[], pitchX12 = PITCH, overhangFt = OVERHANG) =>
  instantEstimate({ outline, pitchX12, overhangFt, valleyFt: 0 });

describe('POST /api/measurements: outlines from footprints', () => {
  it('a home inside a fixture footprint measures to instantEstimate on that ring', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    const houseId = (await footprintIds()).house!;
    const propertyId = await homeAt(1, INSIDE);
    const owner = await who.as('owner');

    const res = await owner.post('/api/measurements').send({ propertyId });

    expect(res.status).toBe(201);
    const view = res.body as MeasurementView;
    expect(view.propertyId).toBe(propertyId);
    expect(view.method).toBe('outline');
    expect(view.kind).toBe('estimate');
    expect(view.drawMode).toBe(false);
    expect(view.outline).toEqual([HOUSE]);
    expect(view.estimate).toEqual(instantEstimate({ outline: [HOUSE], pitchX12: PITCH, overhangFt: OVERHANG }));
    expect(view.structures).toHaveLength(1);
    expect(view.structures[0]).toMatchObject({ footprintId: houseId, included: true });
    expect((await dbProperty(t, A(), propertyId)).footprintId).toBe(houseId);
  });

  it('uses the nearest footprint within 30 m', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    const houseId = (await footprintIds()).house!;
    const owner = await who.as('owner');

    // About 15 m away: the house is the main structure.
    const near = await measure(owner, { propertyId: await homeAt(2, NEAR_15M) });
    expect(near.drawMode).toBe(false);
    expect(near.outline).toEqual([HOUSE]);
    const included = near.structures.filter((s) => s.included);
    expect(included).toHaveLength(1);
    expect(included[0]!.footprintId).toBe(houseId);

    // About 35 m away: nothing within the snap distance, so draw mode.
    const far = await measure(owner, { propertyId: await homeAt(3, FAR_35M) });
    expect(far.drawMode).toBe(true);
    expect(far.outline).toBeNull();
    expect(far.structures.filter((s) => s.included)).toHaveLength(0);
  });

  it('other nearby buildings are listed excluded', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE }, { sourceRef: 'neighbor', ring: NEIGHBOR });
    const ids = await footprintIds();
    const owner = await who.as('owner');

    const view = await measure(owner, { propertyId: await homeAt(4, INSIDE) });

    expect(view.drawMode).toBe(false);
    expect(view.outline).toEqual([HOUSE]);
    expect(view.structures).toHaveLength(2);
    const byId = Object.fromEntries(view.structures.map((s) => [s.footprintId, s]));
    expect(byId[ids.house!]).toMatchObject({ included: true, ring: HOUSE });
    expect(byId[ids.neighbor!]).toMatchObject({ included: false, ring: NEIGHBOR });
  });

  it('no footprint near the point gives draw mode', async () => {
    await loadNE({ sourceRef: 'far', ring: FAR });
    const owner = await who.as('owner');

    const view = await measure(owner, { propertyId: await homeAt(5, NOWHERE_NEAR) });

    expect(view.drawMode).toBe(true);
    expect(view.outline).toBeNull();
    expect(view.estimate.surfaceSqFt).toBe(0);
    expect(view.kind).toBe('estimate');
    expect(view.method).toBe('outline');
  });

  it('a state that is not loaded gives draw mode and queues one footprints-load', async () => {
    const owner = await who.as('owner');
    const propertyId = await homeAt(6, INSIDE);

    const view = await measure(owner, { propertyId });

    expect(view.drawMode).toBe(true);
    expect(view.outline).toBeNull();
    const loads = t.jobs.sent.filter((s) => s.name === 'footprints-load');
    expect(loads).toHaveLength(1);
    expect(loads[0]!.singletonKey).toBe('NE');
    expect(loads[0]!.data).toMatchObject({ state: 'NE' });
  });

  it('a home with no point opens draw mode on the centre of the US', async () => {
    const owner = await who.as('owner');
    const propertyId = await homeAt(22, INSIDE);
    await ownerSql('update properties set geom = null where id = $1', [propertyId]);
    t.geocoder.failNext(1);

    const view = await measure(owner, { propertyId });

    expect(view.drawMode).toBe(true);
    expect(view.center).toEqual([-98.5795, 39.8283]);
    const read = await getView(view.id);
    expect(read.center).toEqual([-98.5795, 39.8283]);
  });

  it('a new address is geocoded and saved', async () => {
    const owner = await who.as('owner');
    const address = '512 Maple Ave, Omaha, NE 68102';

    const view = await measure(owner, { address });

    expect(t.geocoder.calls.some((c) => c.args[0] === address)).toBe(true);
    const saved = await dbProperty(t, A(), view.propertyId);
    expect(saved).toMatchObject({ addressLine: '512 Maple Ave', city: 'Omaha', state: 'NE', zip: '68102' });
  });

  it('a job at another address is a 404', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    const owner = await who.as('owner');
    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Mismatch Customer' });
    const jobHome = await homeAt(20, INSIDE);
    const otherHome = await homeAt(21, INSIDE);
    const job = await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: jobHome });
    const res = await owner.post('/api/measurements').send({ propertyId: otherHome, jobId: job.id });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_FOUND });
  });
});

describe('PATCH /api/measurements/:id: recomputes', () => {
  it('PATCH outline recomputes the estimate; PATCH pitch recomputes; included structures toggle; GET matches', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE }, { sourceRef: 'neighbor', ring: NEIGHBOR });
    const ids = await footprintIds();
    const owner = await who.as('owner');
    const created = await measure(owner, { propertyId: await homeAt(7, INSIDE) });
    const path = `/api/measurements/${created.id}`;

    // A new outline: the estimate is that outline's, with the stored pitch and overhang.
    const outlined = await owner.patch(path).send({ outline: [WIDER] });
    expect(outlined.status).toBe(200);
    expect(outlined.body.outline).toEqual([WIDER]);
    expect(outlined.body.estimate).toEqual(estimateOf([WIDER]));

    // A new pitch: the pitch and the surface change, and both equal instantEstimate.
    const pitched = await owner.patch(path).send({ pitchX12: 8 });
    expect(pitched.status).toBe(200);
    expect(pitched.body.estimate.pitchX12).toBe(8);
    expect(pitched.body.estimate.surfaceSqFt).toBeGreaterThan(outlined.body.estimate.surfaceSqFt);
    expect(pitched.body.estimate).toEqual(estimateOf([WIDER], 8));

    // Excluding the house leaves only the neighbour, and the outline follows.
    const onlyNeighbor = await owner.patch(path).send({ includedStructures: [ids.neighbor!] });
    expect(onlyNeighbor.status).toBe(200);
    const flags = Object.fromEntries(onlyNeighbor.body.structures.map((s: { footprintId: string; included: boolean }) => [s.footprintId, s.included]));
    expect(flags[ids.house!]).toBe(false);
    expect(flags[ids.neighbor!]).toBe(true);
    expect(onlyNeighbor.body.outline).toEqual([NEIGHBOR]);
    expect(onlyNeighbor.body.estimate).toEqual(estimateOf([NEIGHBOR], 8));

    // Including the house again brings its outline back.
    const houseAgain = await owner.patch(path).send({ includedStructures: [ids.house!] });
    expect(houseAgain.status).toBe(200);
    expect(houseAgain.body.outline).toEqual([HOUSE]);
    expect(houseAgain.body.estimate).toEqual(estimateOf([HOUSE], 8));

    // A later read answers the same view as the last change.
    const read = await owner.get(path);
    expect(read.status).toBe(200);
    expect(read.body).toEqual(houseAgain.body);
  });
});

describe('PATCH /api/measurements/:id: bad input', () => {
  it('rejects bad outlines with plain messages, and out-of-range numbers name their field', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    const owner = await who.as('owner');
    const created = await measure(owner, { propertyId: await homeAt(8, INSIDE) });
    const path = `/api/measurements/${created.id}`;

    // A bow-tie: the two diagonals cross.
    const bowTie: Ring = [
      [-96.0, 41.25],
      [-95.9997, 41.2502],
      [-95.9997, 41.25],
      [-96.0, 41.2502],
      [-96.0, 41.25],
    ];
    const crossing = await owner.patch(path).send({ outline: [bowTie] });
    expect(crossing.status).toBe(400);
    expect(crossing.body).toEqual({ error: 'Corners must form a closed shape without crossing lines.', field: 'outline' });

    // About 1 km by 1 km: a warehouse, not a house.
    const warehouse: Ring = [
      [-96.0, 41.25],
      [-95.988, 41.25],
      [-95.988, 41.259],
      [-96.0, 41.259],
      [-96.0, 41.25],
    ];
    const large = await owner.patch(path).send({ outline: [warehouse] });
    expect(large.status).toBe(400);
    expect(large.body).toEqual({ error: 'That outline is too large for a house.', field: 'outline' });

    // Two distinct corners (the ring goes out and back): not a shape.
    const twoCorners: Ring = [
      [-96.0, 41.25],
      [-95.9997, 41.25],
      [-96.0, 41.25],
    ];
    const few = await owner.patch(path).send({ outline: [twoCorners] });
    expect(few.status).toBe(400);
    expect(few.body).toEqual({ error: 'Add at least three corners.', field: 'outline' });

    const pitch = await owner.patch(path).send({ pitchX12: 25 });
    expect(pitch.status).toBe(400);
    expect(pitch.body.field).toBe('pitchX12');

    const overhang = await owner.patch(path).send({ overhangFt: 4 });
    expect(overhang.status).toBe(400);
    expect(overhang.body.field).toBe('overhangFt');

    const valley = await owner.patch(path).send({ valleyFt: -1 });
    expect(valley.status).toBe(400);
    expect(valley.body.field).toBe('valleyFt');

    // Nothing changed.
    const after = await getView(created.id);
    expect(after.outline).toEqual([HOUSE]);
    expect(after.estimate).toEqual(estimateOf([HOUSE]));
  });

  it('unknown structure ids are a 400 and a drawn outline survives a structures change', async () => {
    await loadNE({ sourceRef: 'far', ring: FAR });
    const owner = await who.as('owner');
    const created = await measure(owner, { propertyId: await homeAt(23, NOWHERE_NEAR) });
    expect(created.structures).toEqual([]);
    const path = `/api/measurements/${created.id}`;

    const drawn = await owner.patch(path).send({ outline: [HOUSE] });
    expect(drawn.status).toBe(200);

    const unknown = await owner.patch(path).send({ includedStructures: ['999999'] });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ error: 'Please pick the structures to include.', field: 'includedStructures' });

    const none = await owner.patch(path).send({ includedStructures: [] });
    expect(none.status).toBe(200);
    expect(none.body.outline).toEqual([HOUSE]);
    expect(none.body.drawMode).toBe(false);
  });
});

describe('locking', () => {
  it('a measurement with a sent proposal is locked; a draft proposal does not lock', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    const owner = await who.as('owner');
    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Locked Customer' });
    const propertyId = await homeAt(9, INSIDE);
    const job = await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId });
    const sentMeasurement = await measure(owner, { propertyId, jobId: job.id });
    const draftMeasurement = await measure(owner, { propertyId, jobId: job.id });

    await inCompany(t, A(), (tx) =>
      tx.insert(proposals).values({
        companyId: A(),
        jobId: job.id,
        customerId: customer.id,
        propertyId,
        measurementId: sentMeasurement.id,
        number: 'P-0001',
        status: 'sent',
        validUntil: '2026-11-30',
        linkTokenHash: Buffer.alloc(32, 1),
        linkTokenEncrypted: Buffer.alloc(16, 1),
        sentAt: NOW,
        estimateBasis: 'estimate',
      }),
    );
    await inCompany(t, A(), (tx) =>
      tx.insert(proposals).values({
        companyId: A(),
        jobId: job.id,
        customerId: customer.id,
        propertyId,
        measurementId: draftMeasurement.id,
        number: 'P-0002',
        status: 'draft',
        validUntil: '2026-11-30',
        linkTokenHash: Buffer.alloc(32, 2),
        linkTokenEncrypted: Buffer.alloc(16, 2),
        sentAt: null,
        estimateBasis: 'estimate',
      }),
    );

    const locked = await owner.patch(`/api/measurements/${sentMeasurement.id}`).send({ pitchX12: 9 });
    expect(locked.status).toBe(409);
    expect(locked.body.error).toBe('This measurement is locked because a proposal was sent from it.');
    const read = await owner.get(`/api/measurements/${sentMeasurement.id}`);
    expect(read.body.locked).toBe(true);
    expect(read.body.estimate.pitchX12).toBe(PITCH);

    const draftPatch = await owner.patch(`/api/measurements/${draftMeasurement.id}`).send({ pitchX12: 9 });
    expect(draftPatch.status).toBe(200);
    expect(draftPatch.body.locked).toBe(false);
    expect(draftPatch.body.estimate.pitchX12).toBe(9);
  });
});

describe('rep visibility of measurements', () => {
  it('a rep sees only measurements of their own scope', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    const owner = await who.as('owner');
    const rep = await who.as('rep');

    // A job assigned to the other rep, at its own house.
    const otherCustomer = await mustCreate(owner, '/api/customers', { displayName: 'Other Rep Customer' });
    const otherHome = await homeAt(10, INSIDE);
    const otherJob = await mustCreate(owner, '/api/jobs', {
      customerId: otherCustomer.id,
      propertyId: otherHome,
      stage: 'inspection',
      assignedUserId: otherRepId(),
    });
    const otherMeasurement = await measure(owner, { propertyId: otherHome, jobId: otherJob.id });

    expect((await rep.get(`/api/measurements/${otherMeasurement.id}`)).status).toBe(404);
    const hiddenPatch = await rep.patch(`/api/measurements/${otherMeasurement.id}`).send({ pitchX12: 9 });
    expect(hiddenPatch.status).toBe(404);
    expect(hiddenPatch.body).toEqual({ error: NOT_FOUND });
    const hiddenPost = await rep.post('/api/measurements').send({ propertyId: otherHome });
    expect(hiddenPost.status).toBe(404);
    expect(hiddenPost.body).toEqual({ error: NOT_FOUND });
    expect((await owner.get(`/api/measurements/${otherMeasurement.id}`)).status).toBe(200);

    // A job assigned to this rep, at its own house: the rep sees and changes it.
    const repCustomer = await mustCreate(owner, '/api/customers', { displayName: 'Rep Customer' });
    const repHome = await homeAt(11, INSIDE);
    const repJob = await mustCreate(owner, '/api/jobs', {
      customerId: repCustomer.id,
      propertyId: repHome,
      stage: 'inspection',
      assignedUserId: repId(),
    });
    const repMeasurement = await measure(rep, { propertyId: repHome, jobId: repJob.id });
    expect((await rep.get(`/api/measurements/${repMeasurement.id}`)).status).toBe(200);
    const repPatch = await rep.patch(`/api/measurements/${repMeasurement.id}`).send({ pitchX12: 7 });
    expect(repPatch.status).toBe(200);
    expect(repPatch.body.estimate.pitchX12).toBe(7);
  });
});

describe('company isolation', () => {
  it('another company gets 404', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    const ownerA = await who.as('owner');
    const ownerB = await who.as('owner', 'b');
    const propertyId = await homeAt(12, INSIDE);
    const view = await measure(ownerA, { propertyId });
    const path = `/api/measurements/${view.id}`;

    const read = await ownerB.get(path);
    expect(read.status).toBe(404);
    expect(read.body).toEqual({ error: NOT_FOUND });

    const change = await ownerB.patch(path).send({ pitchX12: 9 });
    expect(change.status).toBe(404);
    expect(change.body).toEqual({ error: NOT_FOUND });

    const foreign = await ownerB.post('/api/measurements').send({ propertyId });
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual({ error: NOT_FOUND });

    // Company A's view is unchanged by those attempts.
    expect((await getView(view.id)).estimate).toEqual(estimateOf([HOUSE]));
    expect((await ownerB.get(`/api/measurements/${NO_UUID}`)).status).toBe(404);
  });
});
