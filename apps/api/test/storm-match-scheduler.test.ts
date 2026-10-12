import pg from 'pg';
import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { stormMatch } from '../src/jobs/scheduler/storm-match.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const owner = new pg.Pool({ connectionString: inject('dbUrls').owner });

/*
 * packages/db/test/fixtures/storms.ts lies outside this project's rootDir (apps/api), so the few
 * helpers this file needs are repeated here. Boxes are [west, south, east, north], WGS84.
 */
type Box = [number, number, number, number];
const OMAHA_BOX: Box = [-96.0, 41.2, -95.85, 41.32];
const LINCOLN_BOX: Box = [-96.8, 40.75, -96.6, 40.88];
const OMAHA_OUTER: Box = [-96.05, 41.15, -95.8, 41.35];

const wkt = ([w, s, e, n]: Box) => `POLYGON((${w} ${s}, ${e} ${s}, ${e} ${n}, ${w} ${n}, ${w} ${s}))`;

async function setServiceArea(companyId: string, box: Box): Promise<void> {
  await owner.query(`update companies set service_area = ST_Multi(ST_GeomFromText($2, 4326)) where id = $1`, [companyId, wkt(box)]);
}

async function insertOmahaStorm(convectiveDay: string): Promise<void> {
  await owner.query(
    `insert into storms (convective_day, status, max_in, geom_075, bbox, centroid)
     values ($1, 'provisional', 1.5, ST_Multi(ST_GeomFromText($2, 4326)), ST_GeomFromText($2, 4326),
             ST_SetSRID(ST_MakePoint(-95.925, 41.25), 4326))`,
    [convectiveDay, wkt(OMAHA_OUTER)],
  );
}
const NOW = new Date('2026-10-12T15:00:00Z');

let t: TestApp;
let a: string;

afterAll(async () => {
  await owner.end();
});

beforeEach(async () => {
  t = await makeTestApp();
  a = t.seed.a.companyId;
  await setServiceArea(a, OMAHA_BOX);
  await setServiceArea(t.seed.b.companyId, LINCOLN_BOX);
});

describe('storm-match schedule', () => {
  test('queues storm-match-company with singletonKey = companyId for a company whose area meets a recent storm', async () => {
    await insertOmahaStorm('2026-10-11');
    await stormMatch(t.deps, NOW);
    expect(t.jobs.sent).toEqual([{ name: 'storm-match-company', data: { companyId: a }, singletonKey: a }]);
  });

  test('queues nothing when the storm is older than four convective days', async () => {
    await insertOmahaStorm('2026-10-01');
    await stormMatch(t.deps, NOW);
    expect(t.jobs.sent).toEqual([]);
  });

  test('a second run while the first job still waits records a second send with the same key', async () => {
    await insertOmahaStorm('2026-10-11');
    await stormMatch(t.deps, NOW);
    await stormMatch(t.deps, NOW);
    expect(t.jobs.sent).toHaveLength(2);
    expect(t.jobs.sent.map((s) => s.singletonKey)).toEqual([a, a]);
  });
});
