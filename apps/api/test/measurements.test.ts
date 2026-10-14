import pg from 'pg';
import type { Stream } from 'node:stream';
import { inflateSync } from 'node:zlib';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, inject, it } from 'vitest';
import { Actors, addressFor, dbProperty, inCompany, mustCreate, NO_UUID, NOT_FOUND } from './crm-helpers.ts';
import { makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';
import { createMeasurement, proposals, type TenantContext } from '@roofline/db';
import { claimFootprintTile, finishFootprintTile, footprintTileStatus, insertFootprints, type FootprintInput } from '@roofline/db/system';
import { measureProperty } from '../src/estimator/measure.ts';
import { FakeFootprintSource } from '../src/providers/fakes/footprints.ts';
import { FakeSolar } from '../src/providers/fakes/solar.ts';
import { seedFootprintFixture } from '../src/scripts/footprint-fixture.ts';
import {
  measureRoof,
  polygonAreaSqFt,
  quadkeyOf,
  seededPitchX12,
  type LngLat,
  type MeasurementView,
  type Ring,
  type SolarBuilding,
  type SolarSegment,
} from '@roofline/shared';

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

/** The view hands out open rings (no repeated closing corner): what the outline editor expects. */
const open = (ring: Ring): Ring => ring.slice(0, -1);

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

/** Loads footprints into their (Omaha) footprint tile and marks it ready (the loader's job, run by hand). */
async function loadNE(...footprints: { sourceRef: string; ring: Ring }[]): Promise<void> {
  const input: FootprintInput[] = footprints.map((f) => ({ sourceRef: f.sourceRef, ring: f.ring }));
  await seedFootprintFixture(t.deps.pools, input);
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

/**
 * The estimate for an outline (the roof model's lines give ridge, valley and edges) with the company's overhang;
 * with `excludedFacets`, the quoted facets' estimate.
 */
const estimateOf = (outline: Ring[], pitchX12 = PITCH, overhangFt = OVERHANG, excludedFacets: string[] = []) =>
  measureRoof({ outline, pitchX12, overhangFt, excludedFacets }).estimate;

/** The first building of the fake source's Omaha tile (none of it loaded yet), a point inside it, and its tile. */
async function fixtureHome(): Promise<{ ring: Ring; centre: LngLat; quadkey: string }> {
  const quadkey = quadkeyOf(INSIDE[0], INSIDE[1]);
  const rings: Ring[] = [];
  for await (const f of new FakeFootprintSource().features(quadkey)) rings.push(f.ring);
  const ring = rings[0]!;
  return { ring, centre: [(ring[0]![0] + ring[2]![0]) / 2, (ring[0]![1] + ring[2]![1]) / 2], quadkey };
}

/** A Google Solar segment over the box [lng0, lng1] x [lat0, lat1]. */
function seg(lng0: number, lat0: number, lng1: number, lat1: number, pitchDeg: number, azimuthDeg: number, groundAreaM2: number): SolarSegment {
  return {
    pitchDeg,
    azimuthDeg,
    groundAreaM2,
    areaM2: groundAreaM2 / Math.cos((pitchDeg * Math.PI) / 180),
    center: [(lng0 + lng1) / 2, (lat0 + lat1) / 2],
    box: { sw: [lng0, lat0], ne: [lng1, lat1] },
  };
}

/**
 * Google Solar's answer for the HOUSE (25 m by 22 m, a hip roof): north and south halves at `mainDeg` (9/12 by
 * default), and the east and west hip ends at 45 degrees (12/12). Shifted by `dLng`/`dLat` degrees when asked.
 */
function solarOverHouse(mainDeg = 36.87, dLng = 0, dLat = 0): SolarBuilding {
  const x0 = -96.0 + dLng;
  const x1 = -95.9997 + dLng;
  const y0 = 41.25 + dLat;
  const y1 = 41.2502 + dLat;
  const ym = (y0 + y1) / 2;
  return {
    center: [(x0 + x1) / 2, ym],
    box: { sw: [x0, y0], ne: [x1, y1] },
    imageryQuality: 'HIGH',
    imageryDate: '2024-05-01',
    // Plan areas of a 25 m by 22 m hip roof: two 154 m2 trapezoids and two 121 m2 end triangles (11 m deep).
    segments: [
      seg(x0, y0, x1, ym, mainDeg, 180, 154),
      seg(x0, ym, x1, y1, mainDeg, 0, 154),
      seg(x1 - 0.000131, y0, x1, y1, 45, 90, 121),
      seg(x0, y0, x0 + 0.000131, y1, 45, 270, 121),
    ],
  };
}

/** Facet pitches by the way each faces (N, E, S, W). */
function pitchesByFacing(view: MeasurementView): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of view.roof?.facets ?? []) {
    const facing = ['N', 'E', 'S', 'W'][Math.round(((f.azimuthDeg ?? 0) % 360) / 90) % 4]!;
    (out[facing] ??= []).push(f.pitch);
  }
  return out;
}

describe('POST /api/measurements: outlines from footprints', () => {
  it("a home inside a fixture footprint measures to that ring's roof, at the home's own pitch", async () => {
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
    expect(view.outline).toEqual([open(HOUSE)]);
    expect(view.estimate).toEqual(estimateOf([HOUSE], seededPitchX12(propertyId)));
    expect(view.roof).not.toBeNull();
    expect(view.roof!.totals.slopedSqFt).toBe(view.estimate.surfaceSqFt);
    expect(view.roof!.totals.ridgeFt).toBe(view.estimate.ridgeFt);
    expect(view.facets).toBe(view.roof!.facets.length);
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
    expect(near.outline).toEqual([open(HOUSE)]);
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
    expect(view.outline).toEqual([open(HOUSE)]);
    expect(view.structures).toHaveLength(2);
    const byId = Object.fromEntries(view.structures.map((s) => [s.footprintId, s]));
    expect(byId[ids.house!]).toMatchObject({ included: true, ring: open(HOUSE) });
    expect(byId[ids.neighbor!]).toMatchObject({ included: false, ring: open(NEIGHBOR) });
    // Only the building measured is marked main; the others carry no key at all.
    expect(byId[ids.house!]!.main).toBe(true);
    expect('main' in byId[ids.neighbor!]!).toBe(false);
    expect((await getView(view.id)).structures).toEqual(view.structures);
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

  it('hasCustomer: false for a home nobody owns, true once the home has a customer or the measurement a job', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    const owner = await who.as('owner');
    const home = await homeAt(22, INSIDE);
    expect((await measure(owner, { propertyId: home })).hasCustomer).toBe(false);

    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Owner Of Home' });
    await ownerSql(`update properties set customer_id = $1 where id = $2`, [customer.id, home]);
    expect((await measure(owner, { propertyId: home })).hasCustomer).toBe(true);

    const jobHome = await homeAt(23, INSIDE);
    const job = await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: jobHome });
    await ownerSql(`update properties set customer_id = null where id = $1`, [jobHome]);
    const onJob = await measure(owner, { propertyId: jobHome, jobId: job.id });
    expect(onJob.hasCustomer).toBe(true);
    expect((await getView(onJob.id)).hasCustomer).toBe(true);
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
    expect(outlined.body.outline).toEqual([open(WIDER)]);
    expect(outlined.body.estimate).toEqual(estimateOf([WIDER], created.estimate.pitchX12));

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
    expect(onlyNeighbor.body.outline).toEqual([open(NEIGHBOR)]);
    expect(onlyNeighbor.body.estimate).toEqual(estimateOf([NEIGHBOR], 8));

    // Including the house again brings its outline back.
    const houseAgain = await owner.patch(path).send({ includedStructures: [ids.house!] });
    expect(houseAgain.status).toBe(200);
    expect(houseAgain.body.outline).toEqual([open(HOUSE)]);
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
    expect(after.outline).toEqual([open(HOUSE)]);
    expect(after.estimate).toEqual(estimateOf([HOUSE], created.estimate.pitchX12));
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
    expect(none.body.outline).toEqual([open(HOUSE)]);
    expect(none.body.drawMode).toBe(false);
  });

  it('a home with buildings keeps at least one in the quote: no included structure is a 400 and nothing changes', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE }, { sourceRef: 'neighbor', ring: NEIGHBOR });
    const owner = await who.as('owner');
    const created = await measure(owner, { propertyId: await homeAt(24, INSIDE) });
    expect(created.structures).toHaveLength(2);

    const none = await owner.patch(`/api/measurements/${created.id}`).send({ includedStructures: [] });
    expect(none.status).toBe(400);
    expect(none.body).toEqual({ error: 'Keep at least one building in the quote.', field: 'includedStructures' });
    expect(await getView(created.id)).toEqual(created);
  });
});

/** Every piece of text in a PDF: its content streams inflated, and the hex strings of each TJ array joined. */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    let body: string;
    try {
      body = inflateSync(pdf.subarray(start, end)).toString('latin1');
    } catch {
      continue;
    }
    for (const tj of body.matchAll(/\[([^\]]*)\] TJ/g)) {
      out.push(Buffer.from([...tj[1]!.matchAll(/<([0-9a-f]*)>/g)].map((h) => h[1]).join(''), 'hex').toString('latin1'));
    }
  }
  return out.join('\n');
}

const binaryParser = (res: Stream, callback: (err: Error | null, body: Buffer) => void): void => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('error', (err: Error) => callback(err, Buffer.alloc(0)));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

describe('PATCH excludedFacets: quoting only some sections of the roof', () => {
  /** The stored numbers proposals are priced from. */
  async function storedNumbers(id: string) {
    const rows = await inCompany(t, A(), async (tx) => {
      const result = await tx.execute(sql`
        select surface_sq_ft::float8 as surface, edge_ft::float8 as edge, ridge_ft::float8 as ridge,
               valley_ft::float8 as valley, footprint_sq_ft::float8 as footprint, facets, excluded_facets
          from measurements where id = ${id}`);
      return result.rows as { surface: number; edge: number; ridge: number; valley: number; footprint: number; facets: number; excluded_facets: string[] }[];
    });
    return rows[0]!;
  }

  it('stores the quoted numbers; the response, a later GET and measureRoof agree', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    const owner = await who.as('owner');
    const created = await measure(owner, { propertyId: await homeAt(40, INSIDE) });
    expect(created.excludedFacets).toEqual([]);
    const ids = created.roof!.facets.map((f) => f.id);
    expect(ids.length).toBeGreaterThan(2);
    const left = ids.at(-1)!;
    const path = `/api/measurements/${created.id}`;

    const res = await owner.patch(path).send({ excludedFacets: [left] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const view = res.body as MeasurementView;
    expect(view.excludedFacets).toEqual([left]);
    expect(view.roof!.excluded).toEqual([left]);
    expect(view.roof!.quoted!.facetCount).toBe(ids.length - 1);
    expect(view.estimate).toEqual(estimateOf([HOUSE], created.estimate.pitchX12, OVERHANG, [left]));
    expect(view.estimate.surfaceSqFt).toBeLessThan(created.estimate.surfaceSqFt);
    // The facet count stays the whole roof's.
    expect(view.facets).toBe(ids.length);
    expect((await owner.get(path)).body).toEqual(view);

    const stored = await storedNumbers(created.id);
    expect(stored).toMatchObject({
      surface: view.estimate.surfaceSqFt,
      edge: view.estimate.edgeFt,
      ridge: view.estimate.ridgeFt,
      valley: view.estimate.valleyFt,
      footprint: view.estimate.footprintSqFt,
      facets: ids.length,
      excluded_facets: [left],
    });

    // [] quotes the whole roof again.
    const whole = await owner.patch(path).send({ excludedFacets: [] });
    expect(whole.status).toBe(200);
    expect(whole.body.excludedFacets).toEqual([]);
    expect(whole.body.roof.excluded).toBeUndefined();
    expect(whole.body.estimate).toEqual(created.estimate);
  });

  it('refuses sections that are not on this roof, all of them, bad shapes and too many; nothing changes', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    const owner = await who.as('owner');
    const created = await measure(owner, { propertyId: await homeAt(41, INSIDE) });
    const ids = created.roof!.facets.map((f) => f.id);
    const path = `/api/measurements/${created.id}`;
    const pick = { error: 'Pick sections of this roof.', field: 'excludedFacets' };

    for (const bad of [['Z'], [ids[0], 'Q7'], 'A', null, [1], ['a'], ['AAA'], ['A1234'], Array.from({ length: 201 }, () => 'A')]) {
      const res = await owner.patch(path).send({ excludedFacets: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body).toEqual(pick);
    }
    const all = await owner.patch(path).send({ excludedFacets: ids });
    expect(all.status).toBe(400);
    expect(all.body).toEqual({ error: 'Keep at least one section in the quote.', field: 'excludedFacets' });
    // Named twice is still every section.
    expect((await owner.patch(path).send({ excludedFacets: [...ids, ids[0]] })).status).toBe(400);

    expect(await getView(created.id)).toEqual(created);
  });

  it('a pitch change keeps the same sections out; a new outline or other buildings quote the whole roof again', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE }, { sourceRef: 'neighbor', ring: NEIGHBOR });
    const fids = await footprintIds();
    const owner = await who.as('owner');
    const created = await measure(owner, { propertyId: await homeAt(42, INSIDE) });
    const path = `/api/measurements/${created.id}`;
    const left = created.roof!.facets.at(-1)!.id;

    expect((await owner.patch(path).send({ excludedFacets: [left] })).status).toBe(200);
    // The same facets at another pitch: still left out, and the estimate is the quoted one at that pitch.
    const pitched = await owner.patch(path).send({ pitchX12: 8 });
    expect(pitched.status).toBe(200);
    expect(pitched.body.excludedFacets).toEqual([left]);
    expect(pitched.body.estimate).toEqual(estimateOf([HOUSE], 8, OVERHANG, [left]));
    // A valley-only change keeps them too.
    const valley = await owner.patch(path).send({ valleyFt: 12 });
    expect(valley.status).toBe(200);
    expect(valley.body.excludedFacets).toEqual([left]);
    expect(valley.body.estimate.valleyFt).toBe(12);

    // Another building included: the roof's facets changed, so the whole roof is quoted again.
    const both = await owner.patch(path).send({ includedStructures: [fids.house!, fids.neighbor!] });
    expect(both.status).toBe(200);
    expect(both.body.excludedFacets).toEqual([]);
    expect(both.body.roof.excluded).toBeUndefined();
    expect(both.body.estimate).toEqual(estimateOf([HOUSE, NEIGHBOR], 8));
    // The building measured stays the main one.
    const main = (both.body as MeasurementView).structures.filter((s) => s.main === true).map((s) => s.footprintId);
    expect(main).toEqual([fids.house]);
    expect((await storedNumbers(created.id)).excluded_facets).toEqual([]);

    // A new outline: the same.
    const second = (await getView(created.id)).roof!.facets.at(-1)!.id;
    expect((await owner.patch(path).send({ excludedFacets: [second] })).body.excludedFacets).toEqual([second]);
    const outlined = await owner.patch(path).send({ outline: [WIDER] });
    expect(outlined.status).toBe(200);
    expect(outlined.body.excludedFacets).toEqual([]);
    expect(outlined.body.estimate).toEqual(estimateOf([WIDER], 8));

    // Sent with the outline, the sections are checked against the new roof.
    const withOutline = await owner.patch(path).send({ outline: [HOUSE], excludedFacets: [left] });
    expect(withOutline.status).toBe(200);
    expect(withOutline.body.excludedFacets).toEqual([left]);
    expect(withOutline.body.estimate).toEqual(estimateOf([HOUSE], 8, OVERHANG, [left]));
  });

  it("the preview's Good, Better and Best drop when a section is left out; a proposal and its PDF follow", async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    const owner = await who.as('owner');
    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Sections Customer' });
    const propertyId = await homeAt(43, INSIDE);
    const job = await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId });
    const created = await measure(owner, { propertyId, jobId: job.id });
    const path = `/api/measurements/${created.id}`;
    const totals = async () => {
      const res = await owner.get(`${path}/preview`);
      expect(res.status).toBe(200);
      return (res.body.options as { tier: string; totalCents: number }[]).map((o) => o.totalCents);
    };

    const before = await totals();
    expect(before).toHaveLength(3);
    const ids = created.roof!.facets.map((f) => f.id);
    expect((await owner.patch(path).send({ excludedFacets: [ids[0]] })).status).toBe(200);
    const after = await totals();
    after.forEach((cents, i) => expect(cents).toBeLessThan(before[i]!));

    // Make proposal prices the same quoted roof, and its PDF says which sections it covers.
    const made = await owner.post('/api/proposals').send({ measurementId: created.id });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect((made.body as { options: { totalCents: number }[] }).options.map((o) => o.totalCents)).toEqual(after);
    const pdf = await owner.get(`/api/proposals/${made.body.id}/pdf`).buffer(true).parse(binaryParser);
    expect(pdf.status).toBe(200);
    const quoted = ids.slice(1);
    const list = `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
    expect(pdfText(pdf.body as Buffer)).toContain(`Covers roof sections ${list} only (${quoted.length} of ${ids.length}).`);
  });
});

describe('locking', () => {
  it('a measurement with a sent proposal is locked; a ready (unsent) proposal does not lock', async () => {
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
        status: 'ready',
        validUntil: '2026-11-30',
        linkTokenHash: Buffer.alloc(32, 2),
        linkTokenEncrypted: Buffer.alloc(16, 2),
        sentAt: null,
        estimateBasis: 'estimate',
      }),
    );

    const locked = await owner.patch(`/api/measurements/${sentMeasurement.id}`).send({ pitchX12: 9 });
    expect(locked.status).toBe(409);
    expect(locked.body.error).toBe('Make a new measurement to change a sent proposal.');
    const sections = await owner.patch(`/api/measurements/${sentMeasurement.id}`).send({ excludedFacets: [sentMeasurement.roof!.facets[0]!.id] });
    expect(sections.status).toBe(409);
    expect(sections.body.error).toBe('Make a new measurement to change a sent proposal.');
    const read = await owner.get(`/api/measurements/${sentMeasurement.id}`);
    expect(read.body.locked).toBe(true);
    expect(read.body.estimate.pitchX12).toBe(sentMeasurement.estimate.pitchX12);

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
    expect((await getView(view.id)).estimate).toEqual(estimateOf([HOUSE], view.estimate.pitchX12));
    expect((await ownerB.get(`/api/measurements/${NO_UUID}`)).status).toBe(404);
  });
});

describe('exact and aerial measurements keep their numbers (B5)', () => {
  /** A measurement written as the exact-report poll (or the aerial measure) writes it: the outline is HOUSE, the numbers are the report's. */
  async function storedMeasurement(kind: 'exact' | 'estimate', method: 'eagleview' | 'aerial'): Promise<string> {
    const propertyId = await homeAt(30, INSIDE);
    const ctx: TenantContext = { companyId: A(), userId: null, role: 'system', canApproveSpend: false };
    const outline = estimateOf([HOUSE]);
    const view = await inCompany(t, A(), (tx) =>
      createMeasurement(
        tx,
        ctx,
        {
          propertyId,
          kind,
          method,
          outline: [HOUSE],
          structures: [],
          estimate: { ...outline, surfaceSqFt: 2612, squares: 26.12, edgeFt: 188, ridgeFt: 62, valleyFt: 24, pitchX12: 7 },
          overhangFt: OVERHANG,
          center: INSIDE,
        },
        NOW,
      ),
    );
    return view.id;
  }

  it("an exact report's measurement shows the report's surface, lengths and pitch, not the outline's", async () => {
    const id = await storedMeasurement('exact', 'eagleview');
    const view = await getView(id);
    expect(view.kind).toBe('exact');
    expect(view.estimate).toMatchObject({ surfaceSqFt: 2612, squares: 26.12, edgeFt: 188, ridgeFt: 62, valleyFt: 24, pitchX12: 7 });
    expect(view.estimate.surfaceSqFt).not.toBe(estimateOf([HOUSE]).surfaceSqFt);
  });

  it('an aerial measurement shows its stored numbers too', async () => {
    const id = await storedMeasurement('estimate', 'aerial');
    expect((await getView(id)).estimate).toMatchObject({ surfaceSqFt: 2612, pitchX12: 7, edgeFt: 188, ridgeFt: 62 });
  });

  it("an exact report's measurement cannot be changed (409), and its numbers stay", async () => {
    const id = await storedMeasurement('exact', 'eagleview');
    const owner = await who.as('owner');
    const res = await owner.patch(`/api/measurements/${id}`).send({ pitchX12: 9 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'An exact report cannot be changed. Make a new measurement to change it.' });
    expect((await getView(id)).estimate).toMatchObject({ surfaceSqFt: 2612, pitchX12: 7 });
  });
});

describe('footprint loads follow the point, not the state (C-M4)', () => {
  it('a home whose state is a territory still loads the tile under its point', async () => {
    const owner = await who.as('owner');
    const propertyId = await homeAt(31, INSIDE);
    await ownerSql(`update properties set state = 'PR' where id = $1`, [propertyId]);

    await measure(owner, { propertyId });

    expect(await footprintTileStatus(t.deps.pools.system, quadkeyOf(INSIDE[0], INSIDE[1]))).toBe('ready');
  });
});

describe('an area whose outlines are not loaded yet: found in the same request, never traced by hand', () => {
  it('a tile nobody is loading is loaded during the request, and the roof comes back measured', async () => {
    const home = await fixtureHome();
    const owner = await who.as('owner');
    const propertyId = await homeAt(40, home.centre);
    expect(await footprintTileStatus(t.deps.pools.system, home.quadkey)).toBeNull();

    const view = await measure(owner, { propertyId });

    expect(view.drawMode).toBe(false);
    expect(view.outline).not.toBeNull();
    expect(view.structures.filter((s) => s.included)).toHaveLength(1);
    expect(view.roof).not.toBeNull();
    expect(await footprintTileStatus(t.deps.pools.system, home.quadkey)).toBe('ready');
    expect(t.footprints.calls.map((c) => c.method)).toEqual(['tileUrls', 'features']);
    expect(t.jobs.sent.filter((j) => j.name === 'footprints-load')).toEqual([]);
  });

  it('a tile another process is loading is waited for, not loaded a second time', async () => {
    const home = await fixtureHome();
    const owner = await who.as('owner');
    const propertyId = await homeAt(41, home.centre);
    const system = t.deps.pools.system;
    // The worker (another process) has claimed the tile and is loading it.
    expect(await claimFootprintTile(system, home.quadkey, t.clock.now())).toBe(true);

    const pending = owner
      .post('/api/measurements')
      .send({ propertyId })
      .then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const count = await insertFootprints(system, { tile: home.quadkey, state: null }, [{ sourceRef: 'worker-loaded', ring: home.ring }]);
    await finishFootprintTile(system, home.quadkey, count, null, t.clock.now());
    const res = await pending;

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const view = res.body as MeasurementView;
    expect(view.drawMode).toBe(false);
    expect(view.structures.filter((s) => s.included)).toHaveLength(1);
    expect(t.footprints.calls).toEqual([]);
  });

  it('a claim left by a process that stopped mid-load (no heartbeat for over a minute) is taken over and loaded', async () => {
    const home = await fixtureHome();
    const owner = await who.as('owner');
    const propertyId = await homeAt(44, home.centre);
    expect(await claimFootprintTile(t.deps.pools.system, home.quadkey, new Date(NOW.getTime() - 2 * 60_000))).toBe(true);

    const view = await measure(owner, { propertyId });

    expect(view.drawMode).toBe(false);
    expect(await footprintTileStatus(t.deps.pools.system, home.quadkey)).toBe('ready');
    expect(t.footprints.calls.map((c) => c.method)).toEqual(['tileUrls', 'features']);
  });

  it('when the wait runs out it carries on: the outline from Google Solar, and the load is queued as well', async () => {
    t = await makeTestApp({ FOOTPRINT_WAIT_MS: 500 });
    who = new Actors(t);
    t.clock.set(NOW);
    const owner = await who.as('owner');
    const propertyId = await homeAt(42, INSIDE);
    const quadkey = quadkeyOf(INSIDE[0], INSIDE[1]);
    // A load elsewhere that will not finish within the wait.
    expect(await claimFootprintTile(t.deps.pools.system, quadkey, t.clock.now())).toBe(true);
    t.solar.set(INSIDE, solarOverHouse());

    const began = Date.now();
    const view = await measure(owner, { propertyId });

    expect(Date.now() - began).toBeLessThan(5000);
    expect(view.drawMode).toBe(false);
    expect(view.structures).toEqual([]);
    expect(view.pitchSource).toBe('solar');
    expect(polygonAreaSqFt(view.outline![0]!)).toBeGreaterThan(polygonAreaSqFt(HOUSE) * 0.9);
    expect(polygonAreaSqFt(view.outline![0]!)).toBeLessThan(polygonAreaSqFt(HOUSE) * 1.1);
    expect(t.jobs.sent.filter((j) => j.name === 'footprints-load').map((j) => j.singletonKey)).toEqual([quadkey]);
  });

  it('a load that fails gives draw mode only when Google Solar has nothing either, and queues a retry', async () => {
    const home = await fixtureHome();
    const owner = await who.as('owner');
    const propertyId = await homeAt(43, home.centre);
    t.footprints.failNext(1);

    const view = await measure(owner, { propertyId });

    expect(view.drawMode).toBe(true);
    expect(await footprintTileStatus(t.deps.pools.system, home.quadkey)).toBe('failed');
    expect(t.jobs.sent.filter((j) => j.name === 'footprints-load').map((j) => j.singletonKey)).toEqual([home.quadkey]);
    // The retry loads it, and measuring again finds the outline.
    await t.jobs.drain(t.deps);
    expect(t.jobs.errors).toEqual([]);
    expect((await measure(owner, { propertyId })).drawMode).toBe(false);
  });
});

describe('pitch from Google Solar', () => {
  it("the roof's pitch is Solar's dominant pitch, each facet takes its own plane's pitch, and the source is kept", async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    t.solar.set(INSIDE, solarOverHouse());
    const owner = await who.as('owner');

    const view = await measure(owner, { propertyId: await homeAt(50, INSIDE) });

    expect(t.solar.calls).toHaveLength(1);
    expect(view.pitchSource).toBe('solar');
    expect(view.estimate.pitchX12).toBe(9);
    expect(view.pitchPlanes).toHaveLength(4);
    const byFacing = pitchesByFacing(view);
    expect(byFacing.N).toEqual(['9/12']);
    expect(byFacing.S).toEqual(['9/12']);
    expect(byFacing.E).toEqual(['12/12']);
    expect(byFacing.W).toEqual(['12/12']);
    const expected = measureRoof({ outline: [HOUSE], pitchX12: 9, overhangFt: OVERHANG, planes: view.pitchPlanes ?? null }).estimate;
    expect(view.estimate).toEqual(expected);
    expect(view.estimate.surfaceSqFt).toBeGreaterThan(estimateOf([HOUSE], 9).surfaceSqFt);
    expect(view.roof!.totals.slopedSqFt).toBe(view.estimate.surfaceSqFt);
    expect(await getView(view.id)).toEqual(view);
    // The stored numbers (what a proposal is priced from) are the per-facet ones.
    const [row] = await inCompany(t, A(), async (tx) => {
      const r = await tx.execute(sql`select surface_sq_ft::float8 as surface, pitch_source from measurements where id = ${view.id}`);
      return r.rows as { surface: number; pitch_source: string }[];
    });
    expect(row).toEqual({ surface: view.estimate.surfaceSqFt, pitch_source: 'solar' });
  });

  it('no Solar building there (not found): the default pitch, silently', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    const owner = await who.as('owner');
    const propertyId = await homeAt(51, INSIDE);

    const view = await measure(owner, { propertyId });

    expect(t.solar.calls).toHaveLength(1);
    expect(view.pitchSource).toBe('default');
    expect(view.pitchPlanes).toBeNull();
    expect(view.estimate).toEqual(estimateOf([HOUSE], seededPitchX12(propertyId)));
  });

  it("a Solar building that is a neighbour's (no plane over the outline) leaves the default pitch", async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    // The same roof shape, but about 45 m north: a different building.
    t.solar.set(INSIDE, solarOverHouse(36.87, 0, 0.0004));
    const owner = await who.as('owner');
    const propertyId = await homeAt(52, INSIDE);

    const view = await measure(owner, { propertyId });

    expect(view.pitchSource).toBe('default');
    expect(view.estimate.pitchX12).toBe(seededPitchX12(propertyId));
  });

  it('Solar not answering keeps the default pitch, and the next measurement asks again', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    t.solar.set(INSIDE, solarOverHouse());
    t.solar.failNext(1);
    const owner = await who.as('owner');
    const propertyId = await homeAt(53, INSIDE);

    expect((await measure(owner, { propertyId })).pitchSource).toBe('default');
    expect((await measure(owner, { propertyId })).pitchSource).toBe('solar');
    expect(t.solar.calls).toHaveLength(2);
  });

  it("Solar's building at the address point is the neighbour's: it is asked again at the outline's middle", async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    // The address point sits beside the house; Solar's nearest building there is a neighbour about 33 m west.
    t.solar.set(NEAR_15M, solarOverHouse(36.87, -0.0004, 0));
    t.solar.set(INSIDE, solarOverHouse());
    const owner = await who.as('owner');

    const view = await measure(owner, { propertyId: await homeAt(90, NEAR_15M) });

    expect(t.solar.calls).toHaveLength(2);
    expect(t.solar.calls[1]![0]).toBeCloseTo(INSIDE[0], 6);
    expect(t.solar.calls[1]![1]).toBeCloseTo(INSIDE[1], 6);
    expect(view.pitchSource).toBe('solar');
    expect(view.estimate.pitchX12).toBe(9);
  });

  it('measuring the same home again reuses the answer kept on its measurement (no second paid call)', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    t.solar.set(INSIDE, solarOverHouse());
    const owner = await who.as('owner');
    const propertyId = await homeAt(54, INSIDE);
    const first = await measure(owner, { propertyId });
    expect(t.solar.calls).toHaveLength(1);

    // A fresh process (its own Solar, nothing remembered in memory) still does not ask again.
    const solar = new FakeSolar();
    const ctx: TenantContext = { companyId: A(), userId: null, role: 'system', canApproveSpend: false };
    const again = await measureProperty({ ...t.deps, solar }, ctx, { propertyId });
    expect(solar.calls).toEqual([]);
    expect(again.pitchSource).toBe('solar');
    expect(again.estimate).toEqual(first.estimate);

    // Thirty-one days on, it asks again.
    t.clock.set(new Date(NOW.getTime() + 31 * 86_400_000));
    await measureProperty({ ...t.deps, solar }, ctx, { propertyId });
    expect(solar.calls).toHaveLength(1);
  });

  it('a pitch picked by hand is the whole roof\'s: the source becomes manual and the facets drop their own', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    t.solar.set(INSIDE, solarOverHouse());
    const owner = await who.as('owner');
    const created = await measure(owner, { propertyId: await homeAt(55, INSIDE) });

    const res = await owner.patch(`/api/measurements/${created.id}`).send({ pitchX12: 7 });

    expect(res.status).toBe(200);
    const view = res.body as MeasurementView;
    expect(view.pitchSource).toBe('manual');
    expect(view.pitchPlanes).toBeNull();
    expect(view.roof!.facets.every((f) => f.pitch === '7/12')).toBe(true);
    expect(view.estimate).toEqual(estimateOf([HOUSE], 7));
  });

  it('an outline edit keeps the Solar pitch per facet', async () => {
    await loadNE({ sourceRef: 'house', ring: HOUSE });
    t.solar.set(INSIDE, solarOverHouse());
    const owner = await who.as('owner');
    const created = await measure(owner, { propertyId: await homeAt(56, INSIDE) });

    const res = await owner.patch(`/api/measurements/${created.id}`).send({ outline: [HOUSE.slice(0, -1)] });

    expect(res.status).toBe(200);
    expect((res.body as MeasurementView).pitchSource).toBe('solar');
    expect(pitchesByFacing(res.body as MeasurementView).E).toEqual(['12/12']);
  });

  it('no footprint near the home: Google Solar gives the outline (no tracing)', async () => {
    await loadNE({ sourceRef: 'far', ring: FAR });
    const owner = await who.as('owner');
    const propertyId = await homeAt(57, NOWHERE_NEAR);
    // The same roof, around NOWHERE_NEAR.
    t.solar.set(NOWHERE_NEAR, solarOverHouse(36.87, NOWHERE_NEAR[0] - INSIDE[0], NOWHERE_NEAR[1] - INSIDE[1]));

    const view = await measure(owner, { propertyId });

    expect(view.drawMode).toBe(false);
    expect(view.structures).toEqual([]);
    expect(view.pitchSource).toBe('solar');
    expect(view.estimate.pitchX12).toBe(9);
    const area = polygonAreaSqFt(view.outline![0]!);
    expect(area).toBeGreaterThan(polygonAreaSqFt(HOUSE) * 0.9);
    expect(area).toBeLessThan(polygonAreaSqFt(HOUSE) * 1.1);
  });

  it('draw mode when neither has the roof; a Solar building over 30 m away is not the home', async () => {
    await loadNE({ sourceRef: 'far', ring: FAR });
    const owner = await who.as('owner');
    const propertyId = await homeAt(58, NOWHERE_NEAR);
    t.solar.set(NOWHERE_NEAR, solarOverHouse(36.87, NOWHERE_NEAR[0] - INSIDE[0], NOWHERE_NEAR[1] - INSIDE[1] + 0.0005));

    const view = await measure(owner, { propertyId });

    expect(view.drawMode).toBe(true);
    expect(view.pitchSource).toBe('default');
  });
});

describe('POST /api/measurements/prefetch: a head start while the address is typed', () => {
  it('looks the address up, starts the area loading and asks Solar; Measure then reuses both', async () => {
    const owner = await who.as('owner');
    const address = '600 Prefetch St, Omaha, NE 68102';

    const res = await owner.post('/api/measurements/prefetch').send({ address });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ found: true });
    await t.settle();
    const looked = t.geocoder.calls.filter((c) => c.args[0] === address).length;
    expect(looked).toBe(1);
    expect(t.solar.calls).toHaveLength(1);
    const [lng, lat] = t.solar.calls[0]!;
    expect(await footprintTileStatus(t.deps.pools.system, quadkeyOf(lng, lat))).toBe('ready');

    const view = await measure(owner, { address });
    expect(t.geocoder.calls.filter((c) => c.args[0] === address)).toHaveLength(looked);
    expect(t.solar.calls).toHaveLength(1);
    expect(t.footprints.calls.filter((c) => c.method === 'features')).toHaveLength(1);
    expect(view.propertyId).toBeTruthy();
  });

  it('an address the geocoder cannot find is found: false; no address is a 400; nothing is saved', async () => {
    const owner = await who.as('owner');
    const missing = await owner.post('/api/measurements/prefetch').send({ address: 'Nowhere Lane, Atlantis' });
    expect(missing.status).toBe(202);
    expect(missing.body).toEqual({ found: false });
    const empty = await owner.post('/api/measurements/prefetch').send({});
    expect(empty.status).toBe(400);
    const extra = await owner.post('/api/measurements/prefetch').send({ address: '1 A St', jobId: NO_UUID });
    expect(extra.status).toBe(400);
    const listed = await owner.get('/api/properties?q=Nowhere');
    expect(listed.body.total).toBe(0);
  });
});
