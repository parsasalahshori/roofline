import pg from 'pg';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, inject, it } from 'vitest';
import { Actors, addressFor, inCompany, mustCreate } from './crm-helpers.ts';
import { makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';
import { hipLayers, layersCover } from './roof-3d-fixture.ts';
import { seedFootprintFixture } from '../src/scripts/footprint-fixture.ts';
import { layersRequest } from '../src/estimator/roof-3d.ts';
import { measureRoof, polygonAreaSqFt, type LngLat, type MeasurementView, type Ring, type SolarBuilding } from '@roofline/shared';

/*
 * Measure with the roof in 3D: Google Solar's Data Layers (a fake here, answering a synthetic hip roof's height map)
 * reconstructed into the real outline, faces and lines; bought once per roof and kept; every other path unchanged
 * when Google has no imagery or does not answer.
 */

const NOW = new Date('2026-10-12T15:00:00.000Z');
/** A house about 25 m by 22 m (the measurements test's), its hip roof at 6/12. */
const HOUSE: Ring = [
  [-96.0, 41.25],
  [-95.9997, 41.25],
  [-95.9997, 41.2502],
  [-96.0, 41.2502],
  [-96.0, 41.25],
];
/** A shed about 16 m east of the house. */
const SHED: Ring = [
  [-95.9995, 41.25],
  [-95.9993, 41.25],
  [-95.9993, 41.2501],
  [-95.9995, 41.2501],
  [-95.9995, 41.25],
];
const INSIDE: LngLat = [-95.99985, 41.2501];

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(NOW);
});

const A = () => t.seed.a.companyId;

async function ownerSql(text: string, params: unknown[] = []): Promise<void> {
  const client = new pg.Client({ connectionString: inject('dbUrls').owner });
  await client.connect();
  try {
    await client.query(text, params);
  } finally {
    await client.end();
  }
}

async function homeAt(n: number, at: LngLat): Promise<string> {
  const owner = await who.as('owner');
  const property = await mustCreate(owner, '/api/properties', addressFor(n));
  await ownerSql(`update properties set geom = ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326) where id = $3`, [at[0], at[1], property.id]);
  return property.id;
}

async function loadNE(...footprints: { sourceRef: string; ring: Ring }[]): Promise<void> {
  await seedFootprintFixture(t.deps.pools, footprints);
}

async function measure(agent: SuperAgent, body: Record<string, unknown>): Promise<MeasurementView> {
  const res = await agent.post('/api/measurements').send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as MeasurementView;
}

async function patch(id: string, body: Record<string, unknown>): Promise<MeasurementView> {
  const owner = await who.as('owner');
  const res = await owner.patch(`/api/measurements/${id}`).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as MeasurementView;
}

/** Google Solar's building for the house: its box (the hip's segments are not needed for the 3D roof). */
const SOLAR_HOUSE: SolarBuilding = {
  center: INSIDE,
  box: { sw: [-96.0, 41.25], ne: [-95.9997, 41.2502] },
  imageryQuality: 'HIGH',
  imageryDate: '2024-05-01',
  segments: [],
};

function withHouseLayers(): void {
  const layers = hipLayers(HOUSE);
  t.solarLayers.set(layersCover(layers), layers);
}

describe('Measure with the roof in 3D', () => {
  it('measures the real roof: its outline, four faces with their pitch, hips and a ridge; the source is solar-3d', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE }, { sourceRef: 'shed', ring: SHED });
    t.solar.set(INSIDE, SOLAR_HOUSE);
    withHouseLayers();
    const owner = await who.as('owner');

    const view = await measure(owner, { propertyId: await homeAt(60, INSIDE) });

    // One Data Layers request, sized from Google Solar's building box.
    expect(t.solarLayers.calls).toHaveLength(1);
    expect(t.solarLayers.calls[0]!.radiusM).toBe(layersRequest(INSIDE, SOLAR_HOUSE).radiusM);
    expect(view.pitchSource).toBe('solar-3d');
    expect(view.roof3d).not.toBeNull();
    expect(view.estimate.pitchX12).toBe(6);
    // The outline is the reconstruction's (the house, squared), and the main building's ring with it.
    const area = polygonAreaSqFt(view.outline![0]!);
    expect(Math.abs(area / polygonAreaSqFt(HOUSE) - 1)).toBeLessThan(0.03);
    const main = view.structures.find((s) => s.main === true)!;
    expect(main.ring).toEqual(view.outline![0]);
    expect(view.structures.find((s) => s.main !== true)?.included).toBe(false);
    // Four faces at 6/12 (letters largest first), hips and a ridge, eaves all round.
    const roof = view.roof!;
    expect(roof.facets.map((f) => f.id)).toEqual(['A', 'B', 'C', 'D']);
    for (const f of roof.facets) expect(f.pitch).toBe('6/12');
    expect(roof.lines.filter((l) => l.kind === 'hip')).toHaveLength(4);
    expect(roof.lines.filter((l) => l.kind === 'ridge')).toHaveLength(1);
    expect(roof.lines.some((l) => l.kind === 'rake')).toBe(false);
    // Areas are the measured ones (no overhang added): plan = outline, sloped = plan x the 6/12 factor.
    expect(Math.abs(view.estimate.planSqFt / area - 1)).toBeLessThan(0.01);
    expect(view.estimate.surfaceSqFt / view.estimate.planSqFt).toBeCloseTo(Math.sqrt(1 + 0.25), 2);
    expect(view.estimate.edgeFt).toBe(roof.totals.eaveFt);
    // Stored as it reads, and the same on a second read.
    const owner2 = await who.as('owner');
    const again = await owner2.get(`/api/measurements/${view.id}`);
    expect(again.body).toEqual(view);
    const [row] = await inCompany(t, A(), async (tx) => {
      const r = await tx.execute(sql`select pitch_source, roof_3d is not null as kept, surface_sq_ft::float8 as surface from measurements where id = ${view.id}`);
      return r.rows as { pitch_source: string; kept: boolean; surface: number }[];
    });
    expect(row).toEqual({ pitch_source: 'solar-3d', kept: true, surface: view.estimate.surfaceSqFt });
  });

  it('measuring the home again reuses the kept roof: nothing is bought twice', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    t.solar.set(INSIDE, SOLAR_HOUSE);
    withHouseLayers();
    const owner = await who.as('owner');
    const propertyId = await homeAt(61, INSIDE);

    const first = await measure(owner, { propertyId });
    const second = await measure(owner, { propertyId });

    expect(t.solarLayers.calls).toHaveLength(1);
    expect(second.roof3d).toEqual(first.roof3d);
    expect(second.roof!.facets).toEqual(first.roof!.facets);
  });

  it('quoting only some sections, picking a pitch and moving the outline all work on the 3D roof', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    t.solar.set(INSIDE, SOLAR_HOUSE);
    withHouseLayers();
    const owner = await who.as('owner');
    const view = await measure(owner, { propertyId: await homeAt(62, INSIDE) });

    // Leave out section D: the estimate is the other three's, as measureRoof works it out with the 3D roof.
    const quoted = await patch(view.id, { excludedFacets: ['D'] });
    expect(quoted.excludedFacets).toEqual(['D']);
    expect(quoted.roof!.quoted!.facetCount).toBe(3);
    const expected = measureRoof({
      outline: quoted.outline!,
      pitchX12: 6,
      overhangFt: quoted.overhangFt,
      planes: quoted.pitchPlanes ?? null,
      excludedFacets: ['D'],
      roof3d: { roof: quoted.roof3d!, ownPitch: true },
    }).estimate;
    expect(quoted.estimate).toEqual(expected);
    expect(quoted.estimate.surfaceSqFt).toBeLessThan(view.estimate.surfaceSqFt);

    // A pitch picked by hand is every sloped face's; the faces and the sections left out stay.
    const steeper = await patch(view.id, { pitchX12: 9 });
    expect(steeper.pitchSource).toBe('manual');
    expect(steeper.roof3d).not.toBeNull();
    expect(steeper.roof!.facets.map((f) => f.pitch)).toEqual(['9/12', '9/12', '9/12', '9/12']);
    expect(steeper.excludedFacets).toEqual(['D']);
    expect(steeper.estimate.surfaceSqFt).toBeGreaterThan(quoted.estimate.surfaceSqFt);

    // An outline moved by hand is no longer the 3D roof: its roof is worked out from it, as before.
    const moved = steeper.outline![0]!.map(([lng, lat]): [number, number] => [lng + 0.00001, lat]);
    const redrawn = await patch(view.id, { outline: [moved] });
    expect(redrawn.roof3d).toBeNull();
    expect(redrawn.estimate).toEqual(measureRoof({ outline: [moved], pitchX12: 9, overhangFt: redrawn.overhangFt }).estimate);
  });

  it('no Data Layers imagery there: the outline roof as before, and the answer is kept so it is not asked again', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    t.solar.set(INSIDE, SOLAR_HOUSE);
    const owner = await who.as('owner');
    const propertyId = await homeAt(63, INSIDE);

    const first = await measure(owner, { propertyId });
    expect(first.roof3d).toBeNull();
    expect(first.pitchSource).not.toBe('solar-3d');
    expect(first.outline).toEqual([HOUSE.slice(0, -1)]);
    await measure(owner, { propertyId });
    expect(t.solarLayers.calls).toHaveLength(1);
  });

  it('Data Layers not answering: the outline roof as before, and the next Measure asks again', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    t.solar.set(INSIDE, SOLAR_HOUSE);
    withHouseLayers();
    t.solarLayers.failNext();
    const owner = await who.as('owner');
    const propertyId = await homeAt(64, INSIDE);

    const first = await measure(owner, { propertyId });
    expect(first.roof3d).toBeNull();
    const second = await measure(owner, { propertyId });
    expect(t.solarLayers.calls).toHaveLength(2);
    expect(second.pitchSource).toBe('solar-3d');
  });

  it('no building footprint there: the 3D roof alone (no buildings listed)', async () => {
    t.solar.set(INSIDE, SOLAR_HOUSE);
    withHouseLayers();
    // The footprint tile is loaded but empty here.
    await loadNE({ sourceRef: 'far', ring: [[-95.95, 41.3], [-95.9497, 41.3], [-95.9497, 41.3002], [-95.95, 41.3002], [-95.95, 41.3]] });
    const owner = await who.as('owner');

    const view = await measure(owner, { propertyId: await homeAt(65, INSIDE) });

    expect(view.pitchSource).toBe('solar-3d');
    expect(view.structures).toEqual([]);
    expect(view.roof!.facets).toHaveLength(4);
    expect(view.drawMode).toBe(false);
  });

  it("the prefetch buys the roof once and the Measure after it reuses it", async () => {
    const owner = await who.as('owner');
    const address = '600 Prefetch St, Omaha, NE 68102';
    const res = await owner.post('/api/measurements/prefetch').send({ address });
    expect(res.status).toBe(202);
    await t.settle();
    // The fake geocoder's point has no imagery: what matters is one request now, none at Measure.
    expect(t.solarLayers.calls).toHaveLength(1);
    await measure(owner, { address });
    expect(t.solarLayers.calls).toHaveLength(1);
  });

  it("Google's true-ortho photo is kept with the 3D roof and served to the owner and office only", async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    t.solar.set(INSIDE, SOLAR_HOUSE);
    withHouseLayers();
    const owner = await who.as('owner');
    const propertyId = await homeAt(67, INSIDE);
    const view = await measure(owner, { propertyId });

    expect(view.needsReview).toBeNull();
    expect(view.roofPhoto?.url).toBe(`/api/measurements/${view.id}/roof-photo`);
    // Its corners frame the roof: every outline corner lies inside them.
    const [tl, tr, br, bl] = view.roofPhoto!.corners;
    for (const [lng, lat] of view.outline![0]!) {
      expect(lng).toBeGreaterThan(Math.min(tl[0], bl[0]));
      expect(lng).toBeLessThan(Math.max(tr[0], br[0]));
      expect(lat).toBeGreaterThan(Math.min(bl[1], br[1]));
      expect(lat).toBeLessThan(Math.max(tl[1], tr[1]));
    }
    const photo = await owner.get(view.roofPhoto!.url);
    expect(photo.status).toBe(200);
    expect(photo.headers['content-type']).toBe('image/png');
    expect((photo.body as Buffer).subarray(1, 4).toString('ascii')).toBe('PNG');
    // Measuring again reuses it: no new request, the same photo.
    const again = await measure(owner, { propertyId });
    expect(t.solarLayers.calls).toHaveLength(1);
    expect(again.roofPhoto?.corners).toEqual(view.roofPhoto!.corners);
    // A rep may open the measurement, without the photo.
    const rep = await who.as('rep');
    expect((await rep.get(view.roofPhoto!.url)).status).toBe(403);
    // After the 30 days the Solar API terms allow, it is no longer shown or served.
    t.clock.set(new Date(NOW.getTime() + 31 * 86_400_000));
    const later = await new Actors(t).as('owner');
    const read = await later.get(`/api/measurements/${view.id}`);
    expect(read.status).toBe(200);
    expect(read.body.roofPhoto).toBeNull();
    expect((await later.get(view.roofPhoto!.url)).status).toBe(404);
  });

  it('a 3D roof that misses a quality target is marked for review', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    t.solar.set(INSIDE, SOLAR_HOUSE);
    const layers = hipLayers(HOUSE, { quality: 'MEDIUM' });
    t.solarLayers.set(layersCover(layers), layers);
    const owner = await who.as('owner');
    const view = await measure(owner, { propertyId: await homeAt(68, INSIDE) });
    expect(view.pitchSource).toBe('solar-3d');
    expect(view.needsReview).toEqual({ reasons: ['coarse-imagery'] });
  });

  it('a home whose roof the height map joins to the next home (a terrace): only this home, marked for review', async () => {
    // One hip roof over this home and the one east of it; Google's building box is this home's.
    const TERRACE: Ring = [
      [-96.0, 41.25],
      [-95.9994, 41.25],
      [-95.9994, 41.2502],
      [-96.0, 41.2502],
      [-96.0, 41.25],
    ];
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    t.solar.set(INSIDE, SOLAR_HOUSE);
    const layers = hipLayers(TERRACE);
    t.solarLayers.set(layersCover(layers), layers);
    const owner = await who.as('owner');
    const view = await measure(owner, { propertyId: await homeAt(70, INSIDE) });
    expect(view.pitchSource).toBe('solar-3d');
    expect(view.needsReview).toEqual({ reasons: ['joined-buildings'] });
    expect(Math.abs(polygonAreaSqFt(view.outline![0]!) / polygonAreaSqFt(HOUSE) - 1)).toBeLessThan(0.08);
  });

  it("with the 3D roof, Measure does not wait for the area's building outlines (they load on for the map)", async () => {
    // Nothing loaded yet in this area, and the outlines' download is slow: Measure answers from the 3D roof.
    t.solar.set(INSIDE, SOLAR_HOUSE);
    withHouseLayers();
    const release = t.footprints.hold();
    const owner = await who.as('owner');
    const propertyId = await homeAt(69, INSIDE);
    const started = Date.now();
    const view = await measure(owner, { propertyId });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(view.pitchSource).toBe('solar-3d');
    expect(view.roof!.facets).toHaveLength(4);
    release();
    await t.settle();
  });

  it('plan areas add up: the sloped total is the faces\' measured areas', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    t.solar.set(INSIDE, SOLAR_HOUSE);
    withHouseLayers();
    const owner = await who.as('owner');
    const view = await measure(owner, { propertyId: await homeAt(66, INSIDE) });
    const faces = view.roof3d!.faces;
    const sloped = faces.reduce((s, f) => s + f.slopedAreaSqFt, 0);
    expect(Math.abs(view.estimate.surfaceSqFt - sloped)).toBeLessThan(1);
    // 25.3 m x 22.2 m at 6/12, within 3%.
    const truth = polygonAreaSqFt(HOUSE) * Math.sqrt(1.25);
    expect(Math.abs(view.estimate.surfaceSqFt / truth - 1)).toBeLessThan(0.03);
  });
});
