import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { Actors, inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { footprintTileStatus } from '@roofline/db/system';
import { FakeFootprintSource } from '../src/providers/fakes/footprints.ts';
import { seedFootprintFixture } from '../src/scripts/footprint-fixture.ts';
import { polygonAreaSqFt, quadkeyOf, type LngLat, type MeasurementView, type Ring, type SolarBuilding } from '@roofline/shared';

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
  await seedFootprintFixture(t.deps.pools, footprints);
  const rows = await inCompany(t, t.seed.a.companyId, async (tx) => {
    const result = await tx.execute(sql`select id::text as id, source_ref from building_footprints`);
    return result.rows as { id: string; source_ref: string }[];
  });
  return Object.fromEntries(rows.map((r) => [r.source_ref, r.id]));
}

/** Single-point reverse lookups (a clicked roof's address). The bulk reverseMany is for storm routes only. */
const reverseCalls = () => {
  expect(t.geocoder.calls.filter((c) => c.method === 'reverseMany')).toEqual([]);
  return t.geocoder.calls.filter((c) => c.method === 'reverse').length;
};

/** The first building of the fake source's Omaha tile (not loaded yet), and a point inside it. */
async function fixtureBuilding(): Promise<{ ring: Ring; inside: { lat: number; lng: number }; quadkey: string }> {
  const quadkey = quadkeyOf(INSIDE_HOUSE.lng, INSIDE_HOUSE.lat);
  const rings: Ring[] = [];
  for await (const f of new FakeFootprintSource().features(quadkey)) rings.push(f.ring);
  const ring = rings[0]!;
  return { ring, inside: { lng: (ring[0]![0] + ring[2]![0]) / 2, lat: (ring[0]![1] + ring[2]![1]) / 2 }, quadkey };
}

/** Google Solar's roof over a 25 m by 22 m box whose south-west corner is `sw`: two halves at 9/12. */
function solarRoof(sw: LngLat): SolarBuilding {
  const [x0, y0] = sw;
  const x1 = x0 + 0.0003;
  const y1 = y0 + 0.0002;
  const ym = (y0 + y1) / 2;
  const half = (lat0: number, lat1: number, azimuthDeg: number) => ({
    pitchDeg: 36.87,
    azimuthDeg,
    groundAreaM2: 275,
    areaM2: 344,
    center: [(x0 + x1) / 2, (lat0 + lat1) / 2] as LngLat,
    box: { sw: [x0, lat0] as LngLat, ne: [x1, lat1] as LngLat },
  });
  return {
    center: [(x0 + x1) / 2, ym],
    box: { sw: [x0, y0], ne: [x1, y1] },
    imageryQuality: 'HIGH',
    imageryDate: '2024-05-01',
    segments: [half(y0, ym, 180), half(ym, y1, 0)],
  };
}

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

  it('a click in an area whose outlines are not loaded loads them and finds the roof', async () => {
    const b = await fixtureBuilding();
    const owner = await who.as('owner');
    expect(await footprintTileStatus(t.deps.pools.system, b.quadkey)).toBeNull();

    const res = await owner.get('/api/map/building-at').query(b.inside);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.source).toBe('footprint');
    expect(res.body.footprintId).toMatch(/^\d+$/);
    expect(await footprintTileStatus(t.deps.pools.system, b.quadkey)).toBe('ready');
    expect(t.solar.calls).toEqual([]);
  });

  it("where Microsoft has no outline, Google Solar's roof under the click is the building", async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    const sw: LngLat = [NOWHERE.lng - 0.00015, NOWHERE.lat - 0.0001];
    t.solar.set([NOWHERE.lng, NOWHERE.lat], solarRoof(sw));
    const owner = await who.as('owner');

    const res = await owner.get('/api/map/building-at').query(NOWHERE);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ footprintId: null, source: 'solar' });
    const ring = res.body.polygon.coordinates[0] as LngLat[];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(polygonAreaSqFt(ring)).toBeGreaterThan(550 * 10.7639 * 0.9);
    // A click beside Solar's roof (but within Google's 50 m search) is no building.
    const beside = await owner.get('/api/map/building-at').query({ lat: NOWHERE.lat + 0.0003, lng: NOWHERE.lng });
    expect(beside.status).toBe(404);
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

  it("reuses a saved home whose point is inside the building though it was never linked to it (the customer's own house)", async () => {
    const ids = await loadNE({ sourceRef: 'house', ring: HOUSE });
    const owner = await who.as('owner');
    const customer = await owner.post('/api/customers').send({ displayName: 'Paula Pin' });
    expect(customer.status).toBe(201);
    const home = await owner.post('/api/properties').send({ addressLine: '77 Elm St', city: 'Omaha', state: 'NE', zip: '68102', customerId: customer.body.id });
    expect(home.status, JSON.stringify(home.body)).toBe(201);
    await inCompany(t, t.seed.a.companyId, (tx) =>
      tx.execute(sql`update properties set geom = ST_SetSRID(ST_MakePoint(${INSIDE_HOUSE.lng}, ${INSIDE_HOUSE.lat}), 4326), footprint_id = null where id = ${home.body.id}`),
    );
    const res = await owner.post('/api/estimator/from-footprint').send({ footprintId: ids['house'], ...INSIDE_HOUSE });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const m = await view('owner', res.body.measurementId);
    expect(m.propertyId).toBe(home.body.id);
    expect(m.hasCustomer).toBe(true);
    expect(reverseCalls()).toBe(0);
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

describe('POST /api/estimator/from-point', () => {
  it("measures Google Solar's roof at the click, the address from one single-point reverse lookup", async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    const sw: LngLat = [NOWHERE.lng - 0.00015, NOWHERE.lat - 0.0001];
    t.solar.set([NOWHERE.lng, NOWHERE.lat], solarRoof(sw));
    const owner = await who.as('owner');

    const res = await owner.post('/api/estimator/from-point').send(NOWHERE);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(Object.keys(res.body)).toEqual(['measurementId']);
    expect(reverseCalls()).toBe(1);
    const m = (await owner.get(`/api/measurements/${res.body.measurementId}`)).body as MeasurementView;
    expect(m.drawMode).toBe(false);
    expect(m.structures).toEqual([]);
    expect(m.pitchSource).toBe('solar');
    expect(m.estimate.pitchX12).toBe(9);
    const home = await owner.get(`/api/properties/${m.propertyId}`);
    expect(home.body.addressLine).toBe('1 Fake St');
    // The same spot again: the address is cached, and Solar is not asked again.
    const again = await owner.post('/api/estimator/from-point').send(NOWHERE);
    expect(again.status).toBe(201);
    expect(reverseCalls()).toBe(1);
    expect(t.solar.calls).toHaveLength(1);
  });

  it('measures a footprint under the point when there is one (loading the area first)', async () => {
    const b = await fixtureBuilding();
    const owner = await who.as('owner');
    const res = await owner.post('/api/estimator/from-point').send(b.inside);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const m = (await owner.get(`/api/measurements/${res.body.measurementId}`)).body as MeasurementView;
    expect(m.drawMode).toBe(false);
    expect(m.structures.filter((s) => s.included)).toHaveLength(1);
  });

  it('a point with no address is a 404; owner and office only; checks its body', async () => {
    const owner = await who.as('owner');
    const south = await owner.post('/api/estimator/from-point').send({ lat: -33.9, lng: 18.4 });
    expect(south.status).toBe(404);
    const rep = await who.as('rep');
    expect((await rep.post('/api/estimator/from-point').send(NOWHERE)).status).toBe(403);
    expect((await owner.post('/api/estimator/from-point').send({ lat: 41.25 })).status).toBe(400);
    expect((await owner.post('/api/estimator/from-point').send({ ...NOWHERE, footprintId: '1' })).status).toBe(400);
  });
});

describe('POST /api/map/load-buildings', () => {
  it("starts loading the outlines of the area in view at building level, and not when zoomed out", async () => {
    const b = await fixtureBuilding();
    const owner = await who.as('owner');
    const bbox = [b.inside.lng - 0.005, b.inside.lat - 0.003, b.inside.lng + 0.005, b.inside.lat + 0.003].join(',');

    const res = await owner.post(`/api/map/load-buildings?bbox=${bbox}`);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ tiles: 1 });
    await t.settle();
    expect(await footprintTileStatus(t.deps.pools.system, b.quadkey)).toBe('ready');

    const wide = await owner.post('/api/map/load-buildings?bbox=-100,38,-90,44');
    expect(wide.status).toBe(202);
    expect(wide.body).toEqual({ tiles: 0 });
  });

  it('is for owner and office, and checks the box', async () => {
    const rep = await who.as('rep');
    expect((await rep.post('/api/map/load-buildings?bbox=-96.01,41.24,-95.99,41.26')).status).toBe(403);
    const office = await who.as('office');
    expect((await office.post('/api/map/load-buildings?bbox=nope')).status).toBe(400);
    expect((await office.post('/api/map/load-buildings')).status).toBe(400);
  });
});
