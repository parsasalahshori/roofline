import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { candidateStormsForCompany, findCompanyStorm, maxInInArea, upsertCompanyStorm } from '../src/repos/company-storms.ts';
import { countCustomersHit, countHomes, refreshHits, thresholdContourInArea } from '../src/repos/storm-hits.ts';
import { createPools, type Pools } from '../src/pools.ts';
import { companyStorms } from '../src/schema/index.ts';
import { type Tx, withTenant } from '../src/tenant.ts';
import { resetDb, type SeededCompany, seedTwoCompanies } from '../src/testing/index.ts';
import {
  FAR_AWAY,
  insertFixtureFootprint,
  insertFixtureProperty,
  insertFixtureStorm,
  insertLincolnStorm,
  insertOmahaStorm,
  LINCOLN_BOX,
  OMAHA_BOX,
  OMAHA_CORE,
  OMAHA_EDGE,
  OMAHA_MIDDLE,
  type Query,
  setFixtureServiceArea,
  setFixtureThreshold,
} from './fixtures/storms.ts';

const urls = inject('dbUrls');

let owner: pg.Pool;
let pools: Pools;
let seed: { a: SeededCompany; b: SeededCompany };

const q: Query = async (text, values) => (await owner.query(text, values)).rows;

const asCompany = <T>(companyId: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(pools, { companyId, userId: null, role: 'system', canApproveSpend: false }, fn);

const DAY = '2026-05-01';
const NOW = new Date('2026-05-02T12:00:00Z');

/** Upserts the company storm row and returns its id. */
async function companyStormId(tx: Tx, stormId: string): Promise<string> {
  const { companyStorm } = await upsertCompanyStorm(tx, { stormId, maxIn: 1.5, customersHit: 0, homesHit: 0, now: NOW });
  return companyStorm.id;
}

async function hitRows(companyStormIdValue: string) {
  return q(
    `select property_id, customer_id, hail_in::float8 as hail_in from storm_hits where company_storm_id = $1 order by hail_in desc`,
    [companyStormIdValue],
  );
}

beforeAll(async () => {
  owner = new pg.Pool({ connectionString: urls.owner });
  pools = createPools({ tenant: urls.tenant, system: urls.system });
});

afterAll(async () => {
  await pools?.end();
  await owner?.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
  seed = await seedTwoCompanies(urls.owner);
  await setFixtureServiceArea(q, seed.a.companyId, OMAHA_BOX);
});

describe('storm match repos', () => {
  test('threshold edge: a 0.99 contour is below a 1.00 threshold and a 1.00 contour meets it', async () => {
    const a = await insertFixtureStorm(q, {
      convectiveDay: DAY,
      contours: [
        { thresholdIn: 0.75, box: [-95.99, 41.21, -95.9, 41.3] },
        { thresholdIn: 0.99, box: [-95.97, 41.22, -95.92, 41.28] },
      ],
    });
    const b = await insertFixtureStorm(q, {
      convectiveDay: DAY,
      contours: [
        { thresholdIn: 0.75, box: [-95.99, 41.21, -95.9, 41.3] },
        { thresholdIn: 1.0, box: [-95.97, 41.22, -95.92, 41.28] },
      ],
    });
    await asCompany(seed.a.companyId, async (tx) => {
      expect(await thresholdContourInArea(tx, a, 1.0)).toBeNull();
      expect(await maxInInArea(tx, a)).toBe(0.99);
      expect(await thresholdContourInArea(tx, b, 1.0)).not.toBeNull();
    });
  });

  test('a storm outside the service area yields nothing', async () => {
    await setFixtureServiceArea(q, seed.a.companyId, LINCOLN_BOX);
    const storm = await insertOmahaStorm(q, DAY);
    await insertFixtureFootprint(q, OMAHA_CORE);
    await insertFixtureProperty(q, seed.a.companyId, OMAHA_CORE);
    await asCompany(seed.a.companyId, async (tx) => {
      const csId = await companyStormId(tx, storm);
      expect(await maxInInArea(tx, storm)).toBeNull();
      expect(await thresholdContourInArea(tx, storm, 1.0)).toBeNull();
      expect(await countHomes(tx, storm, 1.0)).toBe(0);
      expect(await refreshHits(tx, csId, storm, 1.0)).toEqual({ customersHit: 0 });
      expect(await candidateStormsForCompany(tx, [DAY])).toEqual([]);
    });
  });

  test('upsertCompanyStorm creates then updates in place', async () => {
    const storm = await insertOmahaStorm(q, DAY);
    const later = new Date('2026-05-03T08:00:00Z');
    await asCompany(seed.a.companyId, async (tx) => {
      const first = await upsertCompanyStorm(tx, { stormId: storm, maxIn: 1.0, customersHit: 2, homesHit: 10, now: NOW });
      expect(first.created).toBe(true);
      const second = await upsertCompanyStorm(tx, { stormId: storm, maxIn: 1.5, customersHit: 5, homesHit: 40, now: later });
      expect(second.created).toBe(false);
      expect(second.companyStorm.id).toBe(first.companyStorm.id);
      expect(second.companyStorm.customersHit).toBe(5);
      expect(second.companyStorm.homesHit).toBe(40);
      expect(second.companyStorm.maxIn).toBe(1.5);
      expect(second.companyStorm.lastMatchedAt).toEqual(later);
    });
  });

  test('upsertCompanyStorm leaves a dismissed storm dismissed', async () => {
    const storm = await insertOmahaStorm(q, DAY);
    await asCompany(seed.a.companyId, async (tx) => {
      await upsertCompanyStorm(tx, { stormId: storm, maxIn: 1.0, customersHit: 1, homesHit: 1, now: NOW });
      await tx.update(companyStorms).set({ status: 'dismissed' }).where(eq(companyStorms.stormId, storm));
      const again = await upsertCompanyStorm(tx, { stormId: storm, maxIn: 1.5, customersHit: 3, homesHit: 3, now: NOW });
      expect(again.created).toBe(false);
      expect(again.companyStorm.status).toBe('dismissed');
      expect(again.companyStorm.customersHit).toBe(3);
    });
  });

  test('two companies get separate company_storm rows for the same storm', async () => {
    await setFixtureServiceArea(q, seed.b.companyId, OMAHA_BOX);
    const storm = await insertOmahaStorm(q, DAY);
    const aRow = await asCompany(seed.a.companyId, async (tx) => (await upsertCompanyStorm(tx, { stormId: storm, maxIn: 1.5, customersHit: 0, homesHit: 0, now: NOW })).companyStorm);
    const bRow = await asCompany(seed.b.companyId, async (tx) => (await upsertCompanyStorm(tx, { stormId: storm, maxIn: 1.5, customersHit: 0, homesHit: 0, now: NOW })).companyStorm);
    expect(aRow.id).not.toBe(bRow.id);
    expect(aRow.companyId).toBe(seed.a.companyId);
    expect(bRow.companyId).toBe(seed.b.companyId);
    expect((await asCompany(seed.a.companyId, (tx) => findCompanyStorm(tx, storm)))?.id).toBe(aRow.id);
    expect((await asCompany(seed.b.companyId, (tx) => findCompanyStorm(tx, storm)))?.id).toBe(bRow.id);
  });

  test('refreshHits: hail_in is the highest contour level containing each property', async () => {
    const storm = await insertOmahaStorm(q, DAY);
    const core = await insertFixtureProperty(q, seed.a.companyId, OMAHA_CORE);
    const middle = await insertFixtureProperty(q, seed.a.companyId, OMAHA_MIDDLE);
    const edge = await insertFixtureProperty(q, seed.a.companyId, OMAHA_EDGE);
    await asCompany(seed.a.companyId, async (tx) => {
      const csId = await companyStormId(tx, storm);
      expect(await refreshHits(tx, csId, storm, 1.0)).toEqual({ customersHit: 2 });
      const rows = await hitRows(csId);
      expect(rows.map((r) => [r.property_id, r.hail_in])).toEqual([
        [core.propertyId, 1.5],
        [middle.propertyId, 1.0],
      ]);
    });
    await asCompany(seed.a.companyId, async (tx) => {
      const cs = (await findCompanyStorm(tx, storm))!;
      expect(await refreshHits(tx, cs.id, storm, 0.75)).toEqual({ customersHit: 3 });
      const rows = await hitRows(cs.id);
      expect(rows).toHaveLength(3);
      expect(rows.find((r) => r.property_id === edge.propertyId)?.hail_in).toBe(0.75);
      expect(await countCustomersHit(tx, storm, 0.75)).toBe(3);
      expect(await countCustomersHit(tx, storm, 1.0)).toBe(2);
    });
  });

  test('refreshHits skips archived properties and counts a property with no customer as a hit but not a customer', async () => {
    const storm = await insertOmahaStorm(q, DAY);
    await insertFixtureProperty(q, seed.a.companyId, OMAHA_CORE);
    await insertFixtureProperty(q, seed.a.companyId, OMAHA_CORE, { archived: true });
    await insertFixtureProperty(q, seed.a.companyId, OMAHA_MIDDLE, { withCustomer: false });
    await asCompany(seed.a.companyId, async (tx) => {
      const csId = await companyStormId(tx, storm);
      expect(await refreshHits(tx, csId, storm, 1.0)).toEqual({ customersHit: 1 });
      const rows = await hitRows(csId);
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.customer_id === null)).toHaveLength(1);
    });
  });

  test('refreshHits is idempotent and growth increases the count', async () => {
    const storm = await insertOmahaStorm(q, DAY);
    await insertFixtureProperty(q, seed.a.companyId, OMAHA_CORE);
    const csId = await asCompany(seed.a.companyId, async (tx) => {
      const id = await companyStormId(tx, storm);
      expect(await refreshHits(tx, id, storm, 1.0)).toEqual({ customersHit: 1 });
      expect(await refreshHits(tx, id, storm, 1.0)).toEqual({ customersHit: 1 });
      return id;
    });
    expect(await hitRows(csId)).toHaveLength(1);
    await insertFixtureProperty(q, seed.a.companyId, OMAHA_MIDDLE);
    await asCompany(seed.a.companyId, async (tx) => {
      expect(await refreshHits(tx, csId, storm, 1.0)).toEqual({ customersHit: 2 });
    });
    expect(await hitRows(csId)).toHaveLength(2);
  });

  test('countHomes counts footprints whose centroid is in the threshold contour', async () => {
    const storm = await insertOmahaStorm(q, DAY);
    await insertFixtureFootprint(q, OMAHA_CORE);
    await insertFixtureFootprint(q, [-95.92, 41.25]);
    await insertFixtureFootprint(q, [-95.93, 41.26]);
    await insertFixtureFootprint(q, OMAHA_EDGE);
    await insertFixtureFootprint(q, FAR_AWAY);
    // Thin polygon that overlaps the 1.0 contour (west edge -95.98) but whose centroid (-95.9825) is outside it.
    await q(
      `insert into building_footprints (state, geom, area_sq_ft, source, source_ref)
       values ('NE', ST_GeomFromText('POLYGON((-95.99 41.2499, -95.975 41.2499, -95.975 41.2501, -95.99 41.2501, -95.99 41.2499))', 4326), 1000, 'fixture', 'straddle')`,
    );
    await asCompany(seed.a.companyId, async (tx) => {
      expect(await countHomes(tx, storm, 1.0)).toBe(3);
      expect(await countHomes(tx, storm, 0.75)).toBe(5);
    });
  });

  test('maxInInArea ignores contours that miss the service area', async () => {
    const storm = await insertOmahaStorm(q, DAY);
    await setFixtureServiceArea(q, seed.a.companyId, [OMAHA_EDGE[0] - 0.005, OMAHA_EDGE[1] - 0.005, OMAHA_EDGE[0] + 0.005, OMAHA_EDGE[1] + 0.005]);
    await setFixtureThreshold(q, seed.a.companyId, 0.75);
    await asCompany(seed.a.companyId, async (tx) => {
      expect(await maxInInArea(tx, storm)).toBe(0.75);
    });
  });

  test('candidateStormsForCompany returns only storms of those days that meet the area, newest first', async () => {
    const day1 = '2026-05-01';
    const day2 = '2026-05-02';
    const day3 = '2026-05-03';
    const s1 = await insertOmahaStorm(q, day1, 'final');
    const s2 = await insertOmahaStorm(q, day2);
    await insertLincolnStorm(q, day2);
    await insertOmahaStorm(q, day3);
    await asCompany(seed.a.companyId, async (tx) => {
      const rows = await candidateStormsForCompany(tx, [day1, day2]);
      expect(rows.map((r) => r.id)).toEqual([s2, s1]);
      expect(rows.map((r) => r.convectiveDay)).toEqual([day2, day1]);
      expect(rows[0]).toMatchObject({ status: 'provisional', maxIn: 1.5, finalAt: null });
      expect(rows[1]!.status).toBe('final');
      expect(await candidateStormsForCompany(tx, [])).toEqual([]);
    });
  });
});
