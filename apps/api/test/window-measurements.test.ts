import pg from 'pg';
import { beforeEach, describe, expect, inject, it } from 'vitest';
import { Actors, addressFor, mustCreate, NO_UUID, NOT_FOUND } from './crm-helpers.ts';
import { makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';
import type { LngLat, Ring, WindowMeasurementView } from '@roofline/shared';
import { seedFootprintFixture } from '../src/scripts/footprint-fixture.ts';

/*
 * Measure windows through the API, with fakes for every outside service: the house's outline comes from a footprint
 * loaded by hand, Street View is the fake (a camera 20 m south of the house, a made-up photo), there are no Google
 * heights (one 9 ft floor is assumed) and no detector (the default).
 */

const NOW = new Date('2026-10-12T15:00:00.000Z');
/** A house about 25 m by 22 m at latitude 41.25 (Omaha). */
const HOUSE: Ring = [
  [-96.0, 41.25],
  [-95.9997, 41.25],
  [-95.9997, 41.2502],
  [-96.0, 41.2502],
  [-96.0, 41.25],
];
const INSIDE: LngLat = [-95.99985, 41.2501];

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(NOW);
});

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

async function measure(agent: SuperAgent, body: Record<string, unknown>): Promise<WindowMeasurementView> {
  const res = await agent.post('/api/window-measurements').send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as WindowMeasurementView;
}

async function measuredHouse(): Promise<{ owner: SuperAgent; view: WindowMeasurementView }> {
  await seedFootprintFixture(t.deps.pools, [{ sourceRef: 'house', ring: HOUSE }]);
  const propertyId = await homeAt(1, INSIDE);
  const owner = await who.as('owner');
  return { owner, view: await measure(owner, { propertyId }) };
}

const total = (v: WindowMeasurementView) => Object.values(v.estimated?.bySizeClass ?? {}).reduce((s, n) => s + n, 0);

describe('POST /api/window-measurements', () => {
  it('works the windows out from the walls, with the front photo and the wall drawn on it; no detector', async () => {
    const { view } = await measuredHouse();
    // 25 m + 22 m, twice: about 309 ft of wall, 9 ft high (no Google heights here).
    expect(view.walls).toMatchObject({ wallHeightFt: 9 });
    expect(view.walls!.perimeterFt).toBeGreaterThan(290);
    expect(view.walls!.perimeterFt).toBeLessThan(320);
    expect(view.walls!.frontWallFt!).toBeGreaterThan(70);
    expect(view.estimated!.covers).toBe('all-sides');
    expect(total(view)).toBe(Math.round((view.walls!.wallAreaSqFt! * 0.12) / 15));
    expect(view.estimated!.basis).toContain('9 ft high (assumed, no height data)');
    expect(view.detector).toBeNull();
    expect(view.windows).toEqual([]);
    expect(view.needsReview?.reasons).toContain('estimated-from-size');
    expect(view.needsReview?.reasons).not.toContain('stand-in-detector');
    expect(view.photos.length).toBeGreaterThanOrEqual(1);
    const photo = view.photos[0]!;
    expect(photo).toMatchObject({ widthPx: 640, heightPx: 640, capturedOn: '2023-06' });
    expect(Math.abs(photo.heading)).toBeLessThan(5); // the camera is south of the house, looking north
    expect(photo.distanceM).toBeGreaterThan(5);
    expect(photo.wallOverlay?.corners).toHaveLength(4);
    expect(view.stories).toBeNull();
    expect(view.tookMs).toBeGreaterThanOrEqual(0);
    expect(t.streetView.calls.filter((c) => c.method === 'image').length).toBe(view.photos.length);
  });

  it('no Street View: no photos, the walls estimate still there', async () => {
    t.streetView.none = true;
    const { view } = await measuredHouse();
    expect(view.missing).toEqual({ reason: 'no-street-view' });
    expect(view.photos).toEqual([]);
    expect(view.estimated!.covers).toBe('all-sides');
  });

  it('no outline: no-footprint and no estimate', async () => {
    const propertyId = await homeAt(2, [-95.9, 41.4]);
    const owner = await who.as('owner');
    const view = await measure(owner, { propertyId });
    expect(view.missing).toEqual({ reason: 'no-footprint' });
    expect(view.estimated).toBeNull();
    expect(view.walls).toBeNull();
  });

  it('refuses a body without an address, and an unknown property is a 404', async () => {
    const owner = await who.as('owner');
    expect((await owner.post('/api/window-measurements').send({})).status).toBe(400);
    expect((await owner.post('/api/window-measurements').send({ propertyId: NO_UUID })).status).toBe(404);
    expect((await owner.post('/api/window-measurements').send({ propertyId: NO_UUID, extra: 1 })).status).toBe(400);
  });
});

describe('GET, photos and visibility', () => {
  it('reads back; another company and a rep who cannot see the address get a 404', async () => {
    const { owner, view } = await measuredHouse();
    const got = await owner.get(`/api/window-measurements/${view.id}`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual(view);
    const rep = await who.as('rep');
    expect((await rep.get(`/api/window-measurements/${view.id}`)).body).toEqual({ error: NOT_FOUND });
    const other = await who.as('owner', 'b');
    expect((await other.get(`/api/window-measurements/${view.id}`)).status).toBe(404);
    expect((await other.get(`/api/window-measurements/${view.id}/photos/${view.photos[0]!.id}`)).status).toBe(404);
    expect((await owner.get('/api/window-measurements/not-an-id')).status).toBe(404);
  });

  it('serves the photo as a private JPEG for 30 days, then 404', async () => {
    const { owner, view } = await measuredHouse();
    const url = `/api/window-measurements/${view.id}/photos/${view.photos[0]!.id}`;
    const res = await owner.get(url).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
    expect((res.body as Buffer)[0]).toBe(0xff);
    expect((await owner.get(`/api/window-measurements/${view.id}/photos/${NO_UUID}`)).status).toBe(404);
    // 30 days on (Google's terms): the stored date has passed.
    await ownerSql(`update window_measurements set photos = jsonb_set(photos, '{0,deleteBy}', to_jsonb($1::text)) where id = $2`, ['2026-10-12T14:00:00.000Z', view.id]);
    expect((await owner.get(url)).status).toBe(404);
  });
});

describe('PATCH: marked windows, counts, the wall corners', () => {
  it('sizes marked windows from the photo; the estimate then covers the sides and back', async () => {
    const { owner, view } = await measuredHouse();
    const photo = view.photos.find((p) => p.wallOverlay !== undefined)!;
    const c = photo.wallOverlay!.corners;
    // A box in the middle of the drawn wall, a quarter of its height.
    const x = (c[0][0] + c[1][0]) / 2;
    const yTop = c[3][1];
    const yBottom = c[0][1];
    const box = { x: x - 0.02, y: yTop + (yBottom - yTop) * 0.3, w: 0.04, h: (yBottom - yTop) * 0.4 };
    const res = await owner.patch(`/api/window-measurements/${view.id}`).send({ marked: [{ id: 'w1', photoId: photo.id, box }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = res.body as WindowMeasurementView;
    expect(after.windows).toHaveLength(1);
    expect(after.windows[0]).toMatchObject({ id: 'w1', source: 'marked', photoId: photo.id, floor: 1, confidence: 1 });
    expect(after.windows[0]!.widthIn).toBeGreaterThan(10);
    expect(after.windows[0]!.heightIn).toBeGreaterThan(10);
    expect(after.estimated!.covers).toBe('sides-and-back');
    expect(after.needsReview?.reasons).toContain('front-only');
    expect(after.needsReview?.reasons).not.toContain('estimated-from-size');

    const excluded = await owner.patch(`/api/window-measurements/${view.id}`).send({ excludedWindowIds: ['w1'], manualCounts: { standard: 4 } });
    expect(excluded.status).toBe(200);
    expect(excluded.body.adjustments).toMatchObject({ excludedWindowIds: ['w1'], manualCounts: { standard: 4 } });
    // Taking the marked window away drops it from the excluded list too.
    const cleared = await owner.patch(`/api/window-measurements/${view.id}`).send({ marked: [] });
    expect(cleared.body.adjustments.excludedWindowIds).toEqual([]);
  });

  it('refuses bad marks, counts and ids', async () => {
    const { owner, view } = await measuredHouse();
    const url = `/api/window-measurements/${view.id}`;
    const photoId = view.photos[0]!.id;
    const ok = { x: 0.4, y: 0.4, w: 0.05, h: 0.1 };
    expect((await owner.patch(url).send({ marked: [{ id: 'a', photoId: NO_UUID, box: ok }] })).status).toBe(400);
    expect((await owner.patch(url).send({ marked: [{ id: 'a', photoId, box: { ...ok, x: 0.98 } }] })).status).toBe(400);
    expect((await owner.patch(url).send({ marked: [{ id: 'a', photoId, box: ok }, { id: 'a', photoId, box: ok }] })).status).toBe(400);
    const many = Array.from({ length: 61 }, (_, i) => ({ id: `m${i}`, photoId, box: ok }));
    expect((await owner.patch(url).send({ marked: many })).status).toBe(400);
    expect((await owner.patch(url).send({ manualCounts: { standard: 201 } })).status).toBe(400);
    expect((await owner.patch(url).send({ manualCounts: { huge: 1 } })).status).toBe(400);
    expect((await owner.patch(url).send({ excludedWindowIds: ['nope'] })).status).toBe(400);
    expect((await owner.patch(url).send({ wallCorners: { photoId, corners: [[0, 0], [1, 0], [1, 1]] } })).status).toBe(400);
    expect((await owner.patch(url).send({ other: 1 })).status).toBe(400);
    expect((await owner.patch(`/api/window-measurements/${NO_UUID}`).send({ manualCounts: {} })).status).toBe(404);
  });

  it("the person's wall corners re-fit the camera and the wall height", async () => {
    const { owner, view } = await measuredHouse();
    const photo = view.photos.find((p) => p.wallOverlay !== undefined)!;
    const c = photo.wallOverlay!.corners;
    // The person drags the top corners up: a taller wall than the 9 ft assumed.
    const lift = (c[0][1] - c[3][1]) * 0.6;
    const corners = [c[0], c[1], [c[2][0], c[2][1] - lift], [c[3][0], c[3][1] - lift]];
    const res = await owner.patch(`/api/window-measurements/${view.id}`).send({ wallCorners: { photoId: photo.id, corners } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = res.body as WindowMeasurementView;
    const fitted = after.photos.find((p) => p.id === photo.id)!.wallOverlay!;
    expect(fitted.fit).toBe('good');
    expect(fitted.wallHeightFromPhotoFt!).toBeGreaterThan(12);
    expect(after.walls!.wallHeightFt).toBeGreaterThan(12);
    expect(total(after)).toBeGreaterThan(total(view));
    expect(after.needsReview?.reasons ?? []).not.toContain('walls-unconfirmed');
    const undone = await owner.patch(`/api/window-measurements/${view.id}`).send({ wallCorners: null });
    expect(undone.body.walls.wallHeightFt).toBe(9);
  });
});

describe('GET /:id/preview', () => {
  it('prices Good/Better/Best for those who see money; null for a rep', async () => {
    const { owner, view } = await measuredHouse();
    const res = await owner.get(`/api/window-measurements/${view.id}/preview`);
    expect(res.status).toBe(200);
    expect(res.body.quotes.map((q: { tier: string }) => q.tier)).toEqual(['good', 'better', 'best']);
    expect(res.body.quotes[0].windows).toBe(total(view));
    expect(res.body.quotes[0].totalCents).toBeGreaterThan(0);
    const office = await who.as('office');
    expect((await office.get(`/api/window-measurements/${view.id}/preview`)).body.quotes).toHaveLength(3);
  });
});
