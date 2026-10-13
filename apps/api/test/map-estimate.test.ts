import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { Actors, inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { claimFootprintState, finishFootprintState, insertFootprints } from '@roofline/db/system';
import type { MeasurementView, Ring } from '@roofline/shared';

/*
 * "Estimate this roof" from the map: GET /api/map/building-at finds the outline under a click (no geocoding), and
 * POST /api/estimator/from-footprint starts a measurement with that building selected, reverse-geocoding the
 * building at most once. Footprints are global rows written through the system pool, as the loader does.
 */

const NOW = new Date('2026-10-12T15:00:00.000Z');

/** A house about 25 m by 22 m, and a second structure about 16 m east of it. Corners are [lng, lat]. */
const HOUSE: Ring = [
  [-96.0, 41.25],
  [-95.9997, 41.25],
  [-95.9997, 41.2502],
  [-96.0, 41.2502],
  [-96.0, 41.25],
];
const NEIGHBOR: Ring = [
  [-95.9995, 41.25],
  [-95.9992, 41.25],
  [-95.9992, 41.2502],
  [-95.9995, 41.2502],
  [-95.9995, 41.25],
];
const INSIDE_HOUSE = { lat: 41.2501, lng: -95.99985 };
const INSIDE_NEIGHBOR = { lat: 41.2501, lng: -95.99935 };
const NOWHERE = { lat: 41.4, lng: -95.9 };

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(NOW);
});

async function loadNE(...footprints: { sourceRef: string; ring: Ring }[]): Promise<Record<string, string>> {
  const now = t.clock.now();
  expect(await claimFootprintState(t.deps.pools.system, 'NE', 'https://fixtures.test/NE.zip', now)).toBe(true);
  const count = await insertFootprints(t.deps.pools.system, 'NE', footprints);
  await finishFootprintState(t.deps.pools.system, 'NE', count, now);
  const rows = await inCompany(t, t.seed.a.companyId, async (tx) => {
    const result = await tx.execute(sql`select id::text as id, source_ref from building_footprints`);
    return result.rows as { id: string; source_ref: string }[];
  });
  return Object.fromEntries(rows.map((r) => [r.source_ref, r.id]));
}

const reverseCalls = () => t.geocoder.calls.filter((c) => c.method === 'reverseMany').length;

describe('GET /api/map/building-at', () => {
  it('answers the outline under the point, closed, with its centroid', async () => {
    const ids = await loadNE({ sourceRef: 'house', ring: HOUSE }, { sourceRef: 'neighbor', ring: NEIGHBOR });
    const owner = await who.as('owner');
    const res = await owner.get('/api/map/building-at').query(INSIDE_HOUSE);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.footprintId).toBe(ids['house']);
    expect(res.body.polygon.type).toBe('Polygon');
    const ring = res.body.polygon.coordinates[0] as number[][];
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
    expect(res.body.centroid.lat).toBeCloseTo(41.2501, 4);
    expect(res.body.centroid.lng).toBeCloseTo(-95.99985, 4);

    const next = await owner.get('/api/map/building-at').query(INSIDE_NEIGHBOR);
    expect(next.body.footprintId).toBe(ids['neighbor']);
    expect(reverseCalls()).toBe(0);
  });

  it('is a 404 no_building where there is no outline', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    const office = await who.as('office');
    const res = await office.get('/api/map/building-at').query(NOWHERE);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'no_building' });
  });

  it('is for owner and office only, and checks the point', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    const rep = await who.as('rep');
    expect((await rep.get('/api/map/building-at').query(INSIDE_HOUSE)).status).toBe(403);
    const owner = await who.as('owner');
    expect((await owner.get('/api/map/building-at').query({ lat: '91', lng: '-96' })).status).toBe(400);
    expect((await owner.get('/api/map/building-at').query({ lat: 'abc', lng: '-96' })).status).toBe(400);
    expect((await owner.get('/api/map/building-at').query({ lat: '41.25' })).status).toBe(400);
  });
});

describe('POST /api/estimator/from-footprint', () => {
  async function view(agentWho: 'owner' | 'office', id: string, company: 'a' | 'b' = 'a'): Promise<MeasurementView> {
    const agent = await who.as(agentWho, company);
    const res = await agent.get(`/api/measurements/${id}`);
    expect(res.status).toBe(200);
    return res.body as MeasurementView;
  }

  it('saves the home from one reverse lookup and measures with the picked building selected', async () => {
    const ids = await loadNE({ sourceRef: 'house', ring: HOUSE }, { sourceRef: 'neighbor', ring: NEIGHBOR });
    const owner = await who.as('owner');
    const res = await owner.post('/api/estimator/from-footprint').send({ footprintId: ids['neighbor'], ...INSIDE_NEIGHBOR });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(Object.keys(res.body)).toEqual(['measurementId']);
    expect(reverseCalls()).toBe(1);

    const m = await view('owner', res.body.measurementId);
    expect(m.method).toBe('outline');
    const included = m.structures.filter((s) => s.included).map((s) => s.footprintId);
    expect(included).toEqual([ids['neighbor']]);
    expect(m.structures.map((s) => s.footprintId).sort()).toEqual([ids['house'], ids['neighbor']].sort());

    const property = await owner.get(`/api/properties/${m.propertyId}`);
    expect(property.status).toBe(200);
    expect(property.body.addressLine).toBe('1 Fake St');
  });

  it('a building already looked up makes no second lookup (the company home, then the per-building cache)', async () => {
    const ids = await loadNE({ sourceRef: 'house', ring: HOUSE });
    const body = { footprintId: ids['house'], ...INSIDE_HOUSE };
    const owner = await who.as('owner');
    const first = await owner.post('/api/estimator/from-footprint').send(body);
    expect(first.status).toBe(201);
    expect(reverseCalls()).toBe(1);

    // The same company again: its home on that building is reused.
    const office = await who.as('office');
    const second = await office.post('/api/estimator/from-footprint').send(body);
    expect(second.status).toBe(201);
    expect(second.body.measurementId).not.toBe(first.body.measurementId);
    expect((await view('owner', second.body.measurementId)).propertyId).toBe((await view('owner', first.body.measurementId)).propertyId);
    expect(reverseCalls()).toBe(1);

    // Another company: no home of its own there yet, but the building's address is cached.
    const ownerB = await who.as('owner', 'b');
    const third = await ownerB.post('/api/estimator/from-footprint').send(body);
    expect(third.status, JSON.stringify(third.body)).toBe(201);
    expect(reverseCalls()).toBe(1);
  });

  it('keeps companies apart: each gets its own home and cannot read the other measurement', async () => {
    const ids = await loadNE({ sourceRef: 'house', ring: HOUSE });
    const body = { footprintId: ids['house'], ...INSIDE_HOUSE };
    const ownerA = await who.as('owner');
    const ownerB = await who.as('owner', 'b');
    const a = await ownerA.post('/api/estimator/from-footprint').send(body);
    const b = await ownerB.post('/api/estimator/from-footprint').send(body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const viewA = await view('owner', a.body.measurementId, 'a');
    const viewB = await view('owner', b.body.measurementId, 'b');
    expect(viewB.propertyId).not.toBe(viewA.propertyId);
    expect((await ownerB.get(`/api/measurements/${a.body.measurementId}`)).status).toBe(404);
    expect((await ownerA.get(`/api/measurements/${b.body.measurementId}`)).status).toBe(404);
    expect((await ownerB.get(`/api/properties/${viewA.propertyId}`)).status).toBe(404);
  });

  it('is a 404 no_building for an unknown footprint, with no lookup', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    const owner = await who.as('owner');
    const res = await owner.post('/api/estimator/from-footprint').send({ footprintId: '999999999', ...INSIDE_HOUSE });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'no_building' });
    expect(reverseCalls()).toBe(0);
  });

  it('is for owner and office only, and checks its body', async () => {
    const ids = await loadNE({ sourceRef: 'house', ring: HOUSE });
    const rep = await who.as('rep');
    expect((await rep.post('/api/estimator/from-footprint').send({ footprintId: ids['house'], ...INSIDE_HOUSE })).status).toBe(403);
    const owner = await who.as('owner');
    expect((await owner.post('/api/estimator/from-footprint').send({ footprintId: 'abc', ...INSIDE_HOUSE })).status).toBe(400);
    expect((await owner.post('/api/estimator/from-footprint').send({ footprintId: ids['house'], lat: 41.25 })).status).toBe(400);
    expect((await owner.post('/api/estimator/from-footprint').send({ footprintId: ids['house'], ...INSIDE_HOUSE, extra: 1 })).status).toBe(400);
    // A click nowhere near the named building.
    expect((await owner.post('/api/estimator/from-footprint').send({ footprintId: ids['house'], ...NOWHERE })).status).toBe(400);
    expect(reverseCalls()).toBe(0);
  });
});
