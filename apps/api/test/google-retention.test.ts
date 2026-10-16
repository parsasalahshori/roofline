import pg from 'pg';
import { beforeEach, describe, expect, inject, it } from 'vitest';
import { latestGoogleRetentionRuns } from '@roofline/db/system';
import { roof3dSnapshotFresh, type LngLat, type MeasurementView, type Ring, type Roof3dSnapshot, type SolarBuilding, type WindowMeasurementView } from '@roofline/shared';
import { Actors, addressFor, mustCreate } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { hipLayers, layersCover } from './roof-3d-fixture.ts';
import { seedFootprintFixture } from '../src/scripts/footprint-fixture.ts';
import { ORPHAN_GRACE_MS } from '../src/estimator/google-retention.ts';
import { googleRetention, sweepGoogleRetention } from '../src/jobs/scheduler/google-retention.ts';
import type { AppDeps } from '../src/app.ts';

/*
 * The google-retention job against a real database: Google's content (the Solar answer, the roof photo, Street View
 * photos, orphaned objects) goes at its date; our own measured numbers stay; a second run does nothing.
 */

const NOW = new Date('2026-10-12T15:00:00.000Z');
const DAY = 86_400_000;
const HOUSE: Ring = [
  [-96.0, 41.25],
  [-95.9997, 41.25],
  [-95.9997, 41.2502],
  [-96.0, 41.2502],
  [-96.0, 41.25],
];
const INSIDE: LngLat = [-95.99985, 41.2501];
const SOLAR_HOUSE: SolarBuilding = {
  center: INSIDE,
  box: { sw: [-96.0, 41.25], ne: [-95.9997, 41.2502] },
  imageryQuality: 'HIGH',
  imageryDate: '2024-05-01',
  segments: [],
};

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(NOW);
});

async function ownerQuery<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: inject('dbUrls').owner });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}

async function homeAt(n: number, at: LngLat): Promise<string> {
  const owner = await who.as('owner');
  const property = await mustCreate(owner, '/api/properties', addressFor(n));
  await ownerQuery(`update properties set geom = ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326) where id = $3`, [at[0], at[1], property.id]);
  return property.id;
}

/** A home measured in 3D (Solar answer + roof photo) and its windows measured (Street View photos), both at NOW. */
async function measuredHome(n = 70): Promise<{ roof: MeasurementView; windows: WindowMeasurementView; photoKey: string; windowKeys: string[] }> {
  await seedFootprintFixture(t.deps.pools, [{ sourceRef: 'house', ring: HOUSE }]);
  t.solar.set(INSIDE, SOLAR_HOUSE);
  const layers = hipLayers(HOUSE);
  t.solarLayers.set(layersCover(layers), layers);
  const owner = await who.as('owner');
  const propertyId = await homeAt(n, INSIDE);
  const r = await owner.post('/api/measurements').send({ propertyId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const w = await owner.post('/api/window-measurements').send({ propertyId });
  expect(w.status, JSON.stringify(w.body)).toBe(201);
  const roof = r.body as MeasurementView;
  const windows = w.body as WindowMeasurementView;
  expect(roof.roofPhoto).not.toBeNull();
  expect(windows.photos.length).toBeGreaterThan(0);
  const [row] = await ownerQuery<{ key: string }>(`select roof_3d->'photo'->>'key' as key from measurements where id = $1`, [roof.id]);
  const keys = await ownerQuery<{ key: string }>(`select p->>'key' as key from window_measurements, jsonb_array_elements(photos) p where id = $1`, [windows.id]);
  return { roof, windows, photoKey: row!.key, windowKeys: keys.map((k) => k.key) };
}

function at(days: number, ms = 0): Date {
  return new Date(NOW.getTime() + days * DAY + ms);
}

describe('google-retention job', () => {
  it('dates new rows from the download, keeps fresh content, deletes expired content, keeps our numbers, and is idempotent', async () => {
    const { roof, windows, photoKey, windowKeys } = await measuredHome();
    const store = t.objectStore;
    expect(store.has(photoKey)).toBe(true);
    for (const k of windowKeys) expect(store.has(k)).toBe(true);
    const [dates] = await ownerQuery<{ m: Date; w: Date }>(
      `select (select google_delete_by from measurements where id = $1) as m, (select photos_delete_by from window_measurements where id = $2) as w`,
      [roof.id, windows.id],
    );
    expect(dates!.m.toISOString()).toBe(at(30).toISOString());
    expect(dates!.w.toISOString()).toBe(at(30).toISOString());

    // Day 29: nothing is due.
    const fresh = await sweepGoogleRetention(t.deps, at(29));
    expect(fresh).toMatchObject({ measurementsCleared: 0, roofPhotosDeleted: 0, windowRowsCleared: 0, windowPhotosDeleted: 0, failures: 0 });
    expect(store.has(photoKey)).toBe(true);

    // Day 30: everything of Google's goes.
    const before = await ownerQuery<{ pitch_x12: number; surface_sq_ft: number; facets: number; roof: unknown; windows: unknown; estimated: unknown }>(
      `select m.pitch_x12, m.surface_sq_ft, m.facets, m.roof_3d->'roof' as roof, w.windows, w.estimated
         from measurements m, window_measurements w where m.id = $1 and w.id = $2`,
      [roof.id, windows.id],
    );
    const counts = await sweepGoogleRetention(t.deps, at(30));
    expect(counts).toMatchObject({ measurementsCleared: 1, roofPhotosDeleted: 1, windowRowsCleared: 1, windowPhotosDeleted: windowKeys.length, failures: 0, companiesFailed: 0 });
    expect(store.has(photoKey)).toBe(false);
    for (const k of windowKeys) expect(store.has(k)).toBe(false);

    const [m] = await ownerQuery<{ solar: unknown; photo: unknown; deleted: string | null; due: Date | null }>(
      `select solar, roof_3d->'photo' as photo, roof_3d->>'photoDeletedAt' as deleted, google_delete_by as due from measurements where id = $1`,
      [roof.id],
    );
    expect(m).toEqual({ solar: null, photo: null, deleted: at(30).toISOString(), due: null });
    const [w] = await ownerQuery<{ keys: string[]; deleted: string[]; due: Date | null }>(
      `select array_agg(p->>'key') as keys, array_agg(p->>'deletedAt') as deleted, min(photos_delete_by) as due
         from window_measurements, jsonb_array_elements(photos) p where id = $1`,
      [windows.id],
    );
    expect(w!.keys.every((k) => k === null)).toBe(true);
    expect(w!.deleted.every((d) => d === at(30).toISOString())).toBe(true);
    expect(w!.due).toBeNull();
    // Our own numbers: unchanged.
    const after = await ownerQuery(
      `select m.pitch_x12, m.surface_sq_ft, m.facets, m.roof_3d->'roof' as roof, w.windows, w.estimated
         from measurements m, window_measurements w where m.id = $1 and w.id = $2`,
      [roof.id, windows.id],
    );
    expect(after).toEqual(before);

    // The views say the photos expired; the photo routes answer 410.
    t.clock.set(at(30));
    const owner = await new Actors(t).as('owner');
    const view = (await owner.get(`/api/measurements/${roof.id}`)).body as MeasurementView;
    expect(view.roofPhoto).toBeNull();
    expect(view.roofPhotoExpired).toBe(true);
    expect(view.roof3d).not.toBeNull();
    expect(view.estimate.surfaceSqFt).toBe(roof.estimate.surfaceSqFt);
    expect((await owner.get(`/api/measurements/${roof.id}/roof-photo`)).status).toBe(410);
    const wv = (await owner.get(`/api/window-measurements/${windows.id}`)).body as WindowMeasurementView;
    expect(wv.photos.every((p) => p.expired === true)).toBe(true);
    expect(wv.estimated).toEqual(windows.estimated);
    expect((await owner.get(`/api/window-measurements/${windows.id}/photos/${windows.photos[0]!.id}`)).status).toBe(410);

    // Again: nothing more to do.
    const again = await sweepGoogleRetention(t.deps, at(31));
    expect(again).toMatchObject({ measurementsCleared: 0, roofPhotosDeleted: 0, windowRowsCleared: 0, windowPhotosDeleted: 0, orphansDeleted: 0, failures: 0 });
  });

  it('leaves nothing for a later Measure to reuse: the Solar answer is gone and the kept roof is past its reuse days', async () => {
    const { roof } = await measuredHome();
    await sweepGoogleRetention(t.deps, at(31));
    const kept = await ownerQuery<{ solar: unknown; roof3d: Roof3dSnapshot }>(`select solar, roof_3d as roof3d from measurements where property_id = $1`, [roof.propertyId]);
    expect(kept.every((k) => k.solar === null)).toBe(true);
    // Measure reads the newest kept Solar answer (none now) and reuses a kept roof only while roof3dSnapshotFresh.
    for (const k of kept) expect(roof3dSnapshotFresh(k.roof3d, INSIDE, at(31))).toBe(false);
  });

  it('a delete the store refuses leaves the row for the next run', async () => {
    const { roof, photoKey } = await measuredHome();
    t.objectStore.failNext(1);
    const first = await sweepGoogleRetention(t.deps, at(30));
    expect(first.failures).toBeGreaterThanOrEqual(1);
    const [m] = await ownerQuery<{ photo: unknown }>(`select roof_3d->'photo' as photo from measurements where id = $1`, [roof.id]);
    expect(m!.photo).not.toBeNull();
    const second = await sweepGoogleRetention(t.deps, at(30));
    expect(second.roofPhotosDeleted + first.roofPhotosDeleted).toBe(1);
    expect(t.objectStore.has(photoKey)).toBe(false);
  });

  it('honours a shorter GOOGLE_CONTENT_RETENTION_DAYS', async () => {
    const { photoKey } = await measuredHome();
    const deps = { ...t.deps, config: { ...t.deps.config, GOOGLE_CONTENT_RETENTION_DAYS: 7 } } as AppDeps;
    expect((await sweepGoogleRetention(deps, at(6))).measurementsCleared).toBe(0);
    expect((await sweepGoogleRetention(deps, at(7))).measurementsCleared).toBe(1);
    expect(t.objectStore.has(photoKey)).toBe(false);
  });

  it('backfills missing dates from the download (else created_at), then sweeps them', async () => {
    const { roof, windows } = await measuredHome();
    await ownerQuery(`update measurements set google_delete_by = null where id = $1`, [roof.id]);
    await ownerQuery(`update window_measurements set photos_delete_by = null where id = $1`, [windows.id]);
    // A Solar answer with a garbled date falls back to created_at.
    await ownerQuery(`update measurements set solar = jsonb_set(solar, '{fetchedAt}', '"not a date"'), created_at = $2 where id = $1`, [roof.id, at(-5)]);
    await sweepGoogleRetention(t.deps, at(1));
    const [d] = await ownerQuery<{ m: Date; w: Date }>(
      `select (select google_delete_by from measurements where id = $1) as m, (select photos_delete_by from window_measurements where id = $2) as w`,
      [roof.id, windows.id],
    );
    // The earlier of the Solar answer (created_at - 5 days, + 30) and the roof photo (its fetchedAt, + 30).
    expect(d!.m.toISOString()).toBe(at(25).toISOString());
    expect(d!.w.toISOString()).toBe(at(30).toISOString());
    expect((await sweepGoogleRetention(t.deps, at(25))).measurementsCleared).toBe(1);
  });

  it('deletes orphaned Google objects past the grace period, never other prefixes or young ones', async () => {
    const { photoKey } = await measuredHome();
    const store = t.objectStore;
    const bytes = new Uint8Array([1, 2, 3]);
    await store.put('roof-photos/orphan-old.png', bytes, 'image/png');
    await store.put('window-photos/orphan-old.jpg', bytes, 'image/jpeg');
    await store.put('roof-photos/orphan-young.png', bytes, 'image/png');
    await store.put('storm-photos/not-google.jpg', bytes, 'image/jpeg');
    const now = at(2);
    store.setLastModified('roof-photos/orphan-old.png', new Date(now.getTime() - ORPHAN_GRACE_MS - 1000));
    store.setLastModified('window-photos/orphan-old.jpg', new Date(now.getTime() - 2 * DAY));
    store.setLastModified('roof-photos/orphan-young.png', new Date(now.getTime() - 60_000));
    store.setLastModified('storm-photos/not-google.jpg', new Date(now.getTime() - 40 * DAY));
    store.setLastModified(photoKey, new Date(now.getTime() - 2 * DAY));

    const counts = await sweepGoogleRetention(t.deps, now);
    expect(counts.orphansDeleted).toBe(2);
    expect(store.has('roof-photos/orphan-old.png')).toBe(false);
    expect(store.has('window-photos/orphan-old.jpg')).toBe(false);
    expect(store.has('roof-photos/orphan-young.png')).toBe(true);
    expect(store.has('storm-photos/not-google.jpg')).toBe(true);
    expect(store.has(photoKey)).toBe(true); // still named by its row, and not yet due
    expect((await sweepGoogleRetention(t.deps, now)).orphansDeleted).toBe(0);
  });

  it('records each run with its counts, and logs counts only', async () => {
    await measuredHome();
    const logs: string[] = [];
    const log = console.log;
    console.log = (line: string) => logs.push(line);
    try {
      await googleRetention(t.deps, at(30));
    } finally {
      console.log = log;
    }
    const [run] = await latestGoogleRetentionRuns(t.deps.pools.system, 1);
    expect(run).toMatchObject({ retentionDays: 30, errorPlain: null });
    expect(run!.finishedAt).not.toBeNull();
    expect(run!.counts).toMatchObject({ measurementsCleared: 1, roofPhotosDeleted: 1, windowRowsCleared: 1 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^google-retention: \{"retentionDays":30,"measurementsCleared":1,/);
    expect(logs[0]).not.toMatch(/photos\/|Omaha|NE 68/);
  });
});
