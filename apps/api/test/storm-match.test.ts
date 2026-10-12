import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
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
  setFixtureServiceArea,
  setFixtureThreshold,
  type Query,
} from '@roofline/db/testing';
import { matchCompany, matchCompanyStorms } from '../src/storm/match.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

/*
 * Storm matching (S1 Task 9) against a real database: storms and footprints are global tables seeded
 * through the owner connection with the shared fixtures. E1's seedFootprintFixture is not on this base,
 * so footprints come from insertFixtureFootprint (small squares generated in the fixture file).
 * These tests need Docker and run on CI only.
 */

const NOW = new Date('2026-10-12T15:00:00Z');
const DAY = '2026-10-11';
const MINUTE = 60_000;

let owner: pg.Pool;
let t: TestApp;

const q: Query = async (text, values) => (await owner.query(text, values)).rows;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
});
afterAll(async () => {
  await owner.end();
});

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
  await setFixtureServiceArea(q, t.seed.a.companyId, OMAHA_BOX);
  await setFixtureThreshold(q, t.seed.a.companyId, 1.0);
});

const companyA = () => t.seed.a.companyId;
const rowsOf = (companyId: string) =>
  q('select * from company_storms where company_id = $1 order by created_at', [companyId]);
const draftsSent = () => t.jobs.sent.filter((s) => s.name === 'storm-draft');

describe('matchCompany', () => {
  test('threshold edge: a 0.99 contour does not match a 1.00 threshold, a 1.00 contour does', async () => {
    await insertFixtureStorm(q, {
      convectiveDay: DAY,
      contours: [
        { thresholdIn: 0.75, box: [-95.98, 41.22, -95.88, 41.3] },
        { thresholdIn: 0.99, box: [-95.96, 41.24, -95.9, 41.28] },
      ],
    });
    expect(await matchCompany(t.deps, companyA(), NOW)).toEqual({ created: [], grown: [] });
    expect(await rowsOf(companyA())).toEqual([]);

    await insertFixtureStorm(q, {
      convectiveDay: DAY,
      contours: [
        { thresholdIn: 0.75, box: [-95.98, 41.22, -95.88, 41.3] },
        { thresholdIn: 1.0, box: [-95.96, 41.24, -95.9, 41.28] },
      ],
    });
    const result = await matchCompany(t.deps, companyA(), NOW);
    expect(result.created).toHaveLength(1);
    expect(result.grown).toEqual([]);
  });

  test('a storm outside the service area matches nothing', async () => {
    await setFixtureServiceArea(q, companyA(), LINCOLN_BOX);
    await insertOmahaStorm(q, DAY);
    expect(await matchCompany(t.deps, companyA(), NOW)).toEqual({ created: [], grown: [] });
    expect(await rowsOf(companyA())).toHaveLength(0);
    expect(await q('select id from company_storms')).toHaveLength(0);
  });

  test('two companies get separate rows for the same storm', async () => {
    await setFixtureServiceArea(q, t.seed.b.companyId, OMAHA_BOX);
    await setFixtureThreshold(q, t.seed.b.companyId, 1.0);
    const stormId = await insertOmahaStorm(q, DAY);
    const a = await matchCompany(t.deps, companyA(), NOW);
    const b = await matchCompany(t.deps, t.seed.b.companyId, NOW);
    expect(a.created).toHaveLength(1);
    expect(b.created).toHaveLength(1);
    expect(a.created[0]).not.toBe(b.created[0]);
    const rows = await q('select id, company_id, storm_id from company_storms');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.company_id).sort()).toEqual([companyA(), t.seed.b.companyId].sort());
    expect(rows.every((r) => r.storm_id === stormId)).toBe(true);
  });

  test('growth increases the counts and reports the storm as grown', async () => {
    await insertOmahaStorm(q, DAY);
    await insertFixtureProperty(q, companyA(), OMAHA_CORE);
    await insertFixtureFootprint(q, OMAHA_CORE);
    const first = await matchCompany(t.deps, companyA(), NOW);
    expect(first.created).toHaveLength(1);
    const id = first.created[0]!;
    let [row] = await rowsOf(companyA());
    expect(row).toMatchObject({ id, customers_hit: 1, homes_hit: 1 });

    await insertFixtureProperty(q, companyA(), OMAHA_MIDDLE);
    await insertFixtureFootprint(q, [-95.93, 41.26]);
    await insertFixtureFootprint(q, [-95.94, 41.24]);
    const second = await matchCompany(t.deps, companyA(), new Date(NOW.getTime() + 10 * MINUTE));
    expect(second).toEqual({ created: [], grown: [id] });
    [row] = await rowsOf(companyA());
    expect(row).toMatchObject({ id, customers_hit: 2, homes_hit: 3 });
  });

  test("a customer's hail_in comes from the highest contour containing the home", async () => {
    await insertOmahaStorm(q, DAY);
    await insertFixtureProperty(q, companyA(), OMAHA_CORE);
    await insertFixtureProperty(q, companyA(), OMAHA_MIDDLE);
    await matchCompany(t.deps, companyA(), NOW);
    const hits = await q('select hail_in from storm_hits where company_id = $1', [companyA()]);
    expect(hits.map((h) => Number(h.hail_in)).sort()).toEqual([1.0, 1.5]);
  });

  test('a dismissed storm does not reopen', async () => {
    await insertOmahaStorm(q, DAY);
    await insertFixtureProperty(q, companyA(), OMAHA_CORE);
    await matchCompany(t.deps, companyA(), NOW);
    await q(`update company_storms set status = 'dismissed' where company_id = $1`, [companyA()]);
    await insertFixtureProperty(q, companyA(), OMAHA_MIDDLE);
    const again = await matchCompany(t.deps, companyA(), new Date(NOW.getTime() + 10 * MINUTE));
    expect(again).toEqual({ created: [], grown: [] });
    const [row] = await rowsOf(companyA());
    expect(row).toMatchObject({ status: 'dismissed', customers_hit: 1 });
  });

  test('a final storm is matched once more after becoming final, then skipped', async () => {
    const stormId = await insertOmahaStorm(q, DAY);
    await insertFixtureProperty(q, companyA(), OMAHA_CORE);
    await matchCompany(t.deps, companyA(), NOW);

    await q(`update storms set status = 'final', final_at = $2 where id = $1`, [stormId, new Date(NOW.getTime() + 5 * MINUTE)]);
    await insertFixtureProperty(q, companyA(), OMAHA_MIDDLE);
    const t10 = new Date(NOW.getTime() + 10 * MINUTE);
    await matchCompany(t.deps, companyA(), t10);
    let [row] = await rowsOf(companyA());
    expect(row).toMatchObject({ customers_hit: 2 });
    expect(new Date(row!.last_matched_at as string).getTime()).toBe(t10.getTime());

    await insertFixtureProperty(q, companyA(), OMAHA_CORE);
    const t20 = new Date(NOW.getTime() + 20 * MINUTE);
    expect(await matchCompany(t.deps, companyA(), t20)).toEqual({ created: [], grown: [] });
    [row] = await rowsOf(companyA());
    expect(row).toMatchObject({ customers_hit: 2 });
    expect(new Date(row!.last_matched_at as string).getTime()).toBe(t10.getTime());
  });

  test('a freshly created provisional storm queues no storm-draft and alerts once', async () => {
    const stormId = await insertOmahaStorm(q, DAY);
    await q('update storms set last_grew_at = $2 where id = $1', [stormId, NOW]);
    const { created } = await matchCompany(t.deps, companyA(), NOW);
    expect(created).toHaveLength(1);
    expect(draftsSent()).toEqual([]);
    const alertsAfterFirst = t.mailer.sent.length;
    await matchCompany(t.deps, companyA(), new Date(NOW.getTime() + 10 * MINUTE));
    expect(draftsSent()).toEqual([]);
    expect(t.mailer.sent).toHaveLength(alertsAfterFirst);
  });

  test('a final storm queues storm-draft once, keyed by the company storm id', async () => {
    await insertOmahaStorm(q, DAY, 'final');
    const { created } = await matchCompany(t.deps, companyA(), NOW);
    expect(created).toHaveLength(1);
    const id = created[0]!;
    expect(draftsSent()).toEqual([
      { name: 'storm-draft', data: { companyId: companyA(), companyStormId: id }, singletonKey: id },
    ]);
  });

  test('footprint count with fixture footprints', async () => {
    await insertOmahaStorm(q, DAY);
    for (const at of [OMAHA_CORE, OMAHA_MIDDLE, [-95.93, 41.26], [-95.94, 41.24]] as [number, number][]) {
      await insertFixtureFootprint(q, at);
    }
    await insertFixtureFootprint(q, FAR_AWAY);
    await insertFixtureFootprint(q, OMAHA_EDGE);
    await matchCompany(t.deps, companyA(), NOW);
    const [row] = await rowsOf(companyA());
    expect(row).toMatchObject({ homes_hit: 4 });
  });

  test('matchCompanyStorms (the job handler) uses the app clock', async () => {
    await insertOmahaStorm(q, DAY);
    await insertLincolnStorm(q, DAY);
    t.clock.set(NOW);
    await matchCompanyStorms(t.deps, companyA());
    const rows = await rowsOf(companyA());
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0]!.last_matched_at as string).getTime()).toBe(NOW.getTime());
  });
});
