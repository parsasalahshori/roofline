import pg from 'pg';
import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import { inject } from 'vitest';
import { Actors } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const BAD_BOX = 'Please give the map area as west,south,east,north.';
const BAD_ZOOM = 'Please give the map zoom as a whole number from 0 to 22.';
const BAD_DAYS = 'Please give the number of days as a whole number from 1 to 30.';

const BOX = '-96.2,41.1,-95.8,41.4';
const PATHS = ['/api/storms/layer', '/api/map/storm-layer'] as const;

const square = (w: number, s: number, e: number, n: number) =>
  `SRID=4326;MULTIPOLYGON(((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s})))`;
const OMAHA = square(-96.2, 41.1, -95.8, 41.4);
const MIAMI = square(-80.4, 25.6, -80.0, 25.9);

let t: TestApp;
let who: Actors;
let now: Date;

const dayOffset = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);

async function owner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: inject('dbUrls').owner });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function storm(c: pg.Client, day: string, geom: string, name: string): Promise<string> {
  const res = await c.query<{ id: string }>(
    `insert into storms (convective_day, max_in, geom_075, bbox, centroid, place_name)
     values ($1, 1.5, $2::geometry, ST_Envelope($2::geometry), ST_Centroid($2::geometry), $3) returning id`,
    [day, geom, name],
  );
  const id = res.rows[0]!.id;
  await c.query('insert into storm_contours (storm_id, threshold_in, geom) values ($1, 0.75, $2::geometry)', [id, geom]);
  return id;
}

const run = (c: pg.Client, key: string, at: Date) =>
  c.query(`insert into hail_runs (source_key, valid_at, convective_day, status, processed_at) values ($1, $2, $3, 'processed', $2)`, [
    key,
    at.toISOString(),
    dayOffset(0),
  ]);

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  now = t.clock.now();
});

describe.each(PATHS)('GET %s', (path) => {
  test('needs a session', async () => {
    const res = await request(t.app).get(path).query({ bbox: BOX });
    expect(res.status).toBe(401);
  });

  test.each([undefined, '', 'a,b,c,d', '1,2,3', '-96.2,41.4,-95.8,41.1', '-200,0,10,10'])('bbox %j is a 400', async (bbox) => {
    const owner_ = await who.as('owner');
    const res = await owner_.get(path).query(bbox === undefined ? {} : { bbox });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: BAD_BOX, field: 'bbox' });
  });

  test.each(['abc', '-1', '23', '1.5', ''])('zoom %j is a 400', async (zoom) => {
    const owner_ = await who.as('owner');
    const res = await owner_.get(path).query({ bbox: BOX, zoom });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: BAD_ZOOM, field: 'zoom' });
  });

  test.each(['abc', '0', '31', '2.5', ''])('days %j is a 400', async (days) => {
    const owner_ = await who.as('owner');
    const res = await owner_.get(path).query({ bbox: BOX, days });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: BAD_DAYS, field: 'days' });
  });

  test('returns only the storms inside the box and the last 7 days, all labelled radar-estimated', async () => {
    await owner(async (c) => {
      await storm(c, dayOffset(0), OMAHA, 'Omaha, NE');
      await storm(c, dayOffset(0), MIAMI, 'Miami, FL');
      await storm(c, dayOffset(20), OMAHA, 'Old Omaha, NE');
    });
    const owner_ = await who.as('owner');
    const res = await owner_.get(path).query({ bbox: BOX });
    expect(res.status).toBe(200);
    expect(res.body.swaths.type).toBe('FeatureCollection');
    expect(res.body.swaths.features).toHaveLength(1);
    expect(res.body.swaths.features[0].properties).toMatchObject({ placeName: 'Omaha, NE', label: 'Radar-estimated' });
    expect(res.body.spots.features).toEqual([]);

    const longer = await owner_.get(path).query({ bbox: BOX, days: 30, zoom: 8 });
    expect(longer.status).toBe(200);
    expect(longer.body.swaths.features).toHaveLength(2);
    expect(longer.body.swaths.features.every((f: { properties: { label: string } }) => f.properties.label === 'Radar-estimated')).toBe(true);
  });

  test('a rep may call it too', async () => {
    const rep = await who.as('rep');
    const res = await rep.get(path).query({ bbox: BOX });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ newestRunAt: null, stale: true });
  });

  test('stale is false for a run 10 minutes old', async () => {
    const owner_ = await who.as('owner');
    await owner((c) => run(c, 'fresh', new Date(now.getTime() - 10 * 60_000)));
    t.clock.set(now);
    const res = await owner_.get(path).query({ bbox: BOX });
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(false);
    expect(res.body.newestRunAt).toBe(new Date(now.getTime() - 10 * 60_000).toISOString());
  });

  test('stale is true for a run 200 minutes old', async () => {
    const owner_ = await who.as('owner');
    await owner((c) => run(c, 'old', new Date(now.getTime() - 200 * 60_000)));
    t.clock.set(now);
    const res = await owner_.get(path).query({ bbox: BOX });
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(true);
  });

  test('with no runs newestRunAt is null and stale is true', async () => {
    const owner_ = await who.as('owner');
    const res = await owner_.get(path).query({ bbox: BOX });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ newestRunAt: null, stale: true });
  });
});
