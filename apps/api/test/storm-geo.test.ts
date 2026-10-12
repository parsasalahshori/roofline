import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { coverCircles, swathCenter, withTenant } from '@roofline/db';
import { insertOmahaStorm, OMAHA_BOX, setFixtureThreshold, type Query } from '@roofline/db/testing';
import { GOOGLE_MIN_CIRCLE_RADIUS_M, META_MIN_CIRCLE_RADIUS_M } from '@roofline/shared';
import { AD_CARD_LINE, resolveAdImage } from '../src/storm/creative.ts';
import { agentCtx } from './task-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

/*
 * Targeting circles over a storm's hail contour (S1 Task 19) and the ad image, against a real database.
 * These tests need Docker and run on CI only.
 */

const DAY = '2026-10-11';

let owner: pg.Pool;
let t: TestApp;
let companyStormId: string;
let stormId: string;

const q: Query = async (text, values) => (await owner.query(text, values)).rows;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
});
afterAll(async () => {
  await owner.end();
});

const companyA = () => t.seed.a.companyId;

async function addCompanyStorm(companyId: string, forStorm: string): Promise<string> {
  const rows = await q(
    `insert into company_storms (company_id, storm_id, max_in, customers_hit, homes_hit)
     values ($1, $2, 1.5, 0, 0) returning id`,
    [companyId, forStorm],
  );
  return rows[0]!.id as string;
}

const circlesFor = (min: number, max: number, id = companyStormId) =>
  withTenant(t.deps.pools, agentCtx(companyA()), (tx) => coverCircles(tx, id, min, max));

beforeEach(async () => {
  t = await makeTestApp();
  await setFixtureThreshold(q, companyA(), 1.0);
  stormId = await insertOmahaStorm(q, DAY);
  companyStormId = await addCompanyStorm(companyA(), stormId);
});

describe('coverCircles', () => {
  test('Google minimum: 1 to 50 circles, none under 1 km', async () => {
    const circles = await circlesFor(GOOGLE_MIN_CIRCLE_RADIUS_M, 50);
    expect(circles.length).toBeGreaterThanOrEqual(1);
    expect(circles.length).toBeLessThanOrEqual(50);
    for (const c of circles) expect(c.radiusM).toBeGreaterThanOrEqual(1000);
  });

  test('Meta minimum: none under one mile', async () => {
    const circles = await circlesFor(META_MIN_CIRCLE_RADIUS_M, 50);
    expect(circles.length).toBeGreaterThanOrEqual(1);
    expect(circles.length).toBeLessThanOrEqual(50);
    for (const c of circles) expect(c.radiusM).toBeGreaterThanOrEqual(1609);
  });

  test('the circles cover at least 99% of the threshold contour', async () => {
    const circles = await circlesFor(GOOGLE_MIN_CIRCLE_RADIUS_M, 50);
    const rows = await q(
      `with k as (
         select ST_Transform(geom, 5070) as g from storm_contours
         where storm_id = $1 and threshold_in = (select min(threshold_in) from storm_contours where storm_id = $1 and threshold_in >= 1.0)
       ),
       u as (
         select ST_Union(ST_Buffer(ST_Transform(ST_SetSRID(ST_MakePoint(x.lng, x.lat), 4326), 5070), x.r)) as g
         from jsonb_to_recordset($2::jsonb) as x(lat float8, lng float8, r float8)
       )
       select ST_Area(ST_Intersection(k.g, u.g)) / ST_Area(k.g) as covered from k, u`,
      [stormId, JSON.stringify(circles.map((c) => ({ lat: c.lat, lng: c.lng, r: c.radiusM })))],
    );
    expect(Number(rows[0]!.covered)).toBeGreaterThanOrEqual(0.99);
  });

  test('a small maximum doubles the radius and keeps to the maximum', async () => {
    const circles = await circlesFor(GOOGLE_MIN_CIRCLE_RADIUS_M, 3);
    expect(circles.length).toBeGreaterThanOrEqual(1);
    expect(circles.length).toBeLessThanOrEqual(3);
    expect(Math.max(...circles.map((c) => c.radiusM))).toBeGreaterThan(GOOGLE_MIN_CIRCLE_RADIUS_M);
  });

  test('a storm with no contour at or above the threshold has no circles', async () => {
    await setFixtureThreshold(q, companyA(), 2.0);
    expect(await circlesFor(GOOGLE_MIN_CIRCLE_RADIUS_M, 50)).toEqual([]);
  });

  test("another company cannot read this company's storm", async () => {
    const ctxB = agentCtx(t.seed.b.companyId);
    const circles = await withTenant(t.deps.pools, ctxB, (tx) =>
      coverCircles(tx, companyStormId, GOOGLE_MIN_CIRCLE_RADIUS_M, 50),
    );
    expect(circles).toEqual([]);
    const centre = await withTenant(t.deps.pools, ctxB, (tx) => swathCenter(tx, companyStormId));
    expect(centre).toBeNull();
  });
});

describe('swathCenter', () => {
  test('is a point inside the Omaha box', async () => {
    const centre = await withTenant(t.deps.pools, agentCtx(companyA()), (tx) => swathCenter(tx, companyStormId));
    expect(centre).not.toBeNull();
    const [west, south, east, north] = OMAHA_BOX;
    expect(centre!.lng).toBeGreaterThan(west);
    expect(centre!.lng).toBeLessThan(east);
    expect(centre!.lat).toBeGreaterThan(south);
    expect(centre!.lat).toBeLessThan(north);
  });
});

describe('resolveAdImage', () => {
  const adFiles = async () =>
    q(`select id from stored_files where company_id = $1 and kind = 'ad_image'`, [companyA()]);

  test('renders the card once, stores it once, and reuses it', async () => {
    const ctx = agentCtx(companyA());
    const first = await resolveAdImage(t.deps, ctx, { companyName: 'Acme Roofing', photoId: null });
    expect(t.adImage.calls).toHaveLength(1);
    expect(t.adImage.calls[0]!.args[0]).toMatchObject({ companyName: 'Acme Roofing', line: AD_CARD_LINE });
    const puts = t.objectStore.calls.filter((c) => c.method === 'put');
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ contentType: 'image/png' });
    expect(first.contentType).toBe('image/png');
    expect(await adFiles()).toHaveLength(1);

    const second = await resolveAdImage(t.deps, ctx, { companyName: 'Acme Roofing', photoId: null });
    expect(second.storedFileId).toBe(first.storedFileId);
    expect(await adFiles()).toHaveLength(1);
    expect(t.objectStore.calls.filter((c) => c.method === 'put')).toHaveLength(1);
  });
});

