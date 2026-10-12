import pg from 'pg';
import { beforeEach, describe, expect, test } from 'vitest';
import { inject } from 'vitest';
import { simplifyTolerance, stormLayer, withTenant } from '@roofline/db';
import { makeTestApp, type TestApp } from './helpers.ts';

let t: TestApp;
const BBOX: [number, number, number, number] = [-96.2, 41.1, -95.8, 41.4];
const NOW = new Date('2026-10-12T15:00:00Z');

const square = (w: number, s: number, e: number, n: number) =>
  `SRID=4326;MULTIPOLYGON(((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s})))`;

const OMAHA = square(-96.2, 41.1, -95.8, 41.4);
const OMAHA_INNER = square(-96.1, 41.15, -95.9, 41.3);
const MIAMI = square(-80.4, 25.6, -80.0, 25.9);

async function owner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: inject('dbUrls').owner });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function storm(c: pg.Client, day: string, geom: string, contours: [number, string][], maxIn = 1.5): Promise<string> {
  const res = await c.query<{ id: string }>(
    `insert into storms (convective_day, max_in, geom_075, bbox, centroid, place_name)
     values ($1, $2, $3::geometry, ST_Envelope($3::geometry), ST_Centroid($3::geometry), 'Omaha, NE') returning id`,
    [day, maxIn, geom],
  );
  const id = res.rows[0]!.id;
  for (const [threshold, g] of contours) {
    await c.query('insert into storm_contours (storm_id, threshold_in, geom) values ($1, $2, $3::geometry)', [id, threshold, g]);
  }
  return id;
}

const report = (c: pg.Client, day: string, time: string, size: number, lng: number, lat: number) =>
  c.query(
    `insert into spotter_reports (report_date, time_utc, size_in, location, county, state, geom)
     values ($1, $2, $3, 'Omaha', 'Douglas', 'NE', ST_SetSRID(ST_MakePoint($4, $5), 4326))`,
    [day, time, size, lng, lat],
  );

const layer = (input: Partial<Parameters<typeof stormLayer>[1]> = {}) =>
  withTenant(t.deps.pools, { companyId: t.seed.a.companyId, userId: null, role: 'system', canApproveSpend: false }, (tx) =>
    stormLayer(tx, { bbox: BBOX, days: 14, zoom: 8, now: NOW, ...input }),
  );

let s1: string;
let s3: string;

beforeEach(async () => {
  t = await makeTestApp();
  await owner(async (c) => {
    s1 = await storm(c, '2026-10-12', OMAHA, [
      [0.75, OMAHA],
      [1.5, OMAHA_INNER],
    ]);
    await storm(c, '2026-10-12', MIAMI, [[0.75, MIAMI]]);
    s3 = await storm(c, '2026-09-12', OMAHA, [[0.75, OMAHA]]);
    await report(c, '2026-10-12', '18:05', 1.25, -95.93, 41.25);
    await report(c, '2026-10-12', '19:05', 1.0, -80.2, 25.7);
    await report(c, '2026-09-12', '18:05', 2.0, -95.9, 41.2);
  });
});

const setRuns = (rows: [string, string, string][]) =>
  owner(async (c) => {
    for (const [key, status, at] of rows) {
      await c.query(
        `insert into hail_runs (source_key, valid_at, convective_day, status, processed_at) values ($1, $2, '2026-10-12', $3, $2)`,
        [key, at, status],
      );
    }
  });

describe('simplifyTolerance', () => {
  test('steps down with zoom', () => {
    expect([0, 5, 6, 7, 8, 9, 10, 11, 12, 16].map(simplifyTolerance)).toEqual([0.02, 0.02, 0.01, 0.01, 0.004, 0.004, 0.0015, 0.0015, 0.0005, 0.0005]);
  });
});

describe('stormLayer', () => {
  test('returns the swaths and spots inside the box and the last N days', async () => {
    const out = await layer();
    expect(out.swaths.type).toBe('FeatureCollection');
    expect(out.swaths.features.map((f) => [f.properties.stormId, f.properties.thresholdIn])).toEqual([
      [s1, 0.75],
      [s1, 1.5],
    ]);
    expect(out.swaths.features.every((f) => f.properties.label === 'Radar-estimated')).toBe(true);
    expect(out.swaths.features[0]!.properties).toMatchObject({ maxIn: 1.5, convectiveDay: '2026-10-12', placeName: 'Omaha, NE' });
    expect(out.spots.features).toHaveLength(1);
    expect(out.spots.features[0]!.geometry.type).toBe('Point');
    expect(out.spots.features[0]!.properties).toMatchObject({ reportDate: '2026-10-12', sizeIn: 1.25, location: 'Omaha', county: 'Douglas', state: 'NE' });
  });

  test('a longer window includes the older storm and report', async () => {
    const out = await layer({ days: 60 });
    expect(out.swaths.features.map((f) => f.properties.stormId)).toEqual([s1, s1, s3]);
    expect(out.spots.features).toHaveLength(2);
  });

  test('a box away from Omaha finds nothing', async () => {
    const out = await layer({ bbox: [-100, 30, -99, 31] });
    expect(out.swaths.features).toEqual([]);
    expect(out.spots.features).toEqual([]);
  });

  test('newestRunAt is the newest processed run, null when there is none', async () => {
    expect((await layer()).newestRunAt).toBeNull();
    await setRuns([
      ['a', 'processed', '2026-10-12T10:00:00Z'],
      ['b', 'processed', '2026-10-12T14:00:00Z'],
      ['c', 'failed', '2026-10-12T14:30:00Z'],
    ]);
    expect((await layer({ bbox: [-100, 30, -99, 31], days: 1 })).newestRunAt).toEqual(new Date('2026-10-12T14:00:00Z'));
  });

  test('a higher zoom keeps at least as many points as a lower one', async () => {
    const wiggle = `SRID=4326;MULTIPOLYGON(((-96.2 41.1,-96.0 41.1001,-95.9 41.0999,-95.8 41.1,-95.8 41.4,-96.2 41.4,-96.2 41.1)))`;
    await owner((c) => storm(c, '2026-10-11', wiggle, [[0.75, wiggle]]));
    const count = (o: Awaited<ReturnType<typeof layer>>) => JSON.stringify(o.swaths.features.at(-1)!.geometry.coordinates).split('],[').length;
    const low = await layer({ zoom: 4 });
    const high = await layer({ zoom: 14 });
    expect(count(high)).toBeGreaterThanOrEqual(count(low));
  });
});
