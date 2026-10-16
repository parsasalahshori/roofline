import pg from 'pg';
import { beforeEach, describe, expect, inject, it } from 'vitest';
import { Actors, addressFor, mustCreate, NO_UUID, NOT_FOUND } from './crm-helpers.ts';
import { makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';
import type { LngLat, Ring, WindowMeasurementView } from '@roofline/shared';
import { seedFootprintFixture } from '../src/scripts/footprint-fixture.ts';
import jpeg from 'jpeg-js';
import { DetectorError, type WindowDetector } from '../src/providers/window-detector.ts';
import { windowPhoto } from './window-photo-fixture.ts';

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

describe('the photo checks and the optional detector', () => {
  it('a blurred house (no edges where the wall is) is house-blurred, with the walls estimate', async () => {
    const data = new Uint8Array(640 * 640 * 4);
    for (let y = 0; y < 640; y++) for (let x = 0; x < 640; x++) {
      const i = (y * 640 + x) * 4;
      // A sharp checkered strip at the very top, smooth everywhere else (where the house is drawn).
      const v = y < 60 ? (((x >> 3) + (y >> 3)) % 2 === 0 ? 30 : 220) : 140;
      data.fill(v, i, i + 3);
      data[i + 3] = 255;
    }
    t.streetView.photo = new Uint8Array(jpeg.encode({ width: 640, height: 640, data }, 85).data);
    const { view } = await measuredHouse();
    expect(view.missing).toEqual({ reason: 'house-blurred' });
    expect(view.estimated!.covers).toBe('all-sides');
    expect(view.photos[0]!.wallOverlay?.fit).toBe('unknown');
  });

  it('WINDOW_DETECTOR=owlv2: its boxes on the front become detector windows; the estimate covers the rest', async () => {
    const seen: { region: unknown }[] = [];
    const fake: WindowDetector = {
      name: 'owlv2',
      configured: true,
      detect: async (_jpeg, hints) => {
        seen.push({ region: hints.region });
        const r = hints.region!;
        return [{ x: r.x + r.w * 0.45, y: r.y + r.h * 0.4, w: r.w * 0.08, h: r.h * 0.3, confidence: 0.42 }];
      },
    };
    t.deps.windowDetector = fake;
    const { view } = await measuredHouse();
    expect(seen.length).toBeGreaterThan(0);
    expect(view.detector).toBe('owlv2');
    // The 25 m front is shot in two counted halves (and a whole shot, not counted on): one window found per half.
    expect(view.windows.length).toBeGreaterThanOrEqual(1);
    expect(new Set(view.windows.map((w) => w.photoId)).size).toBe(view.windows.length);
    expect(view.windows[0]).toMatchObject({ source: 'detector', confidence: 0.42, floor: 1 });
    expect(view.estimated!.covers).toBe('sides-and-back');
    expect(view.needsReview?.reasons).toEqual(expect.arrayContaining(['front-only', 'low-confidence']));
  });

  it('a detector that fails is detector-error; the estimate stays', async () => {
    t.deps.windowDetector = { name: 'owlv2', configured: true, detect: async () => Promise.reject(new DetectorError('boom')) };
    const { view } = await measuredHouse();
    expect(view.missing).toEqual({ reason: 'detector-error' });
    expect(view.detector).toBeNull();
    expect(view.estimated!.covers).toBe('all-sides');
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

describe('on-site window photos', () => {
  async function upload(agent: SuperAgent, id: string, bytes: Uint8Array) {
    return agent.post(`/api/window-measurements/${id}/uploads`).attach('photo', Buffer.from(bytes), 'window.jpg');
  }

  it('uploads a photo (multipart or raw), serves it privately, and sizes a window on it from a letter sheet', async () => {
    const { owner, view } = await measuredHouse();
    const photo = windowPhoto({ focal35mm: 26 });
    const res = await upload(owner, view.id, photo.bytes);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), widthPx: 900, heightPx: 1200, focal35mm: 26, takenAt: '2026-10-15T10:30:00' });
    const raw = await owner.post(`/api/window-measurements/${view.id}/uploads`).set('Content-Type', 'image/jpeg').send(Buffer.from(windowPhoto({ exif: false, widthPx: 200, heightPx: 300 }).bytes));
    expect(raw.status).toBe(201);
    expect(raw.body).toMatchObject({ widthPx: 200, heightPx: 300, focal35mm: null, takenAt: null });

    const got = await owner.get(`/api/window-measurements/${view.id}/uploads/${res.body.id}`).buffer(true);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('image/jpeg');
    expect(got.headers['cache-control']).toBe('private, max-age=86400');
    expect(Buffer.compare(got.body as Buffer, Buffer.from(photo.bytes))).toBe(0);

    const patched = await owner.patch(`/api/window-measurements/${view.id}`).send({
      photoWindows: [{ id: 'p1', uploadId: res.body.id, label: 'Kitchen', corners: photo.window, scale: { kind: 'reference', reference: 'letter', corners: photo.paper } }],
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const after = patched.body as WindowMeasurementView;
    expect(after.uploads).toHaveLength(2);
    const w = after.photoWindows![0]!;
    expect(Math.abs(w.widthIn - 36) / 36).toBeLessThan(0.02);
    expect(Math.abs(w.heightIn - 60) / 60).toBeLessThan(0.02);
    expect(w).toMatchObject({ id: 'p1', label: 'Kitchen', sizeClass: 'standard', quality: 'good' });

    // Priced as measured; with every window photographed the estimate counts nothing.
    const before = (await owner.get(`/api/window-measurements/${view.id}/preview`)).body.quotes[0].windows;
    expect(before).toBe(total(view) + 1);
    await owner.patch(`/api/window-measurements/${view.id}`).send({ photosCoverAllWindows: true });
    const all = (await owner.get(`/api/window-measurements/${view.id}/preview`)).body.quotes[0];
    expect(all.windows).toBe(1);
    expect(all.lines).toEqual([expect.objectContaining({ sizeClass: 'standard', count: 1 })]);
  });

  it('a phone photo turned by EXIF (orientation 6): corners as displayed size it the same', async () => {
    const { owner, view } = await measuredHouse();
    const photo = windowPhoto({ orientation: 6 });
    const res = await upload(owner, view.id, photo.bytes);
    expect(res.body).toMatchObject({ widthPx: 900, heightPx: 1200 });
    const patched = await owner.patch(`/api/window-measurements/${view.id}`).send({
      photoWindows: [{ id: 'p1', uploadId: res.body.id, corners: photo.window, scale: { kind: 'known-side', side: 'width', inches: 36 } }],
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(Math.abs(patched.body.photoWindows[0].heightIn - 60) / 60).toBeLessThan(0.02);
  });

  it('refuses other files, HEIC, a photo over 12 MB, and a 41st photo', async () => {
    const { owner, view } = await measuredHouse();
    const text = await upload(owner, view.id, Buffer.from('<html>hello</html>'));
    expect(text.status).toBe(415);
    expect(text.body.error).toBe('Upload a JPEG or PNG photo.');
    const heic = await upload(owner, view.id, Uint8Array.from([0, 0, 0, 24, ...Buffer.from('ftypheic'), 0, 0, 0, 0, 1, 2, 3, 4]));
    expect(heic.status).toBe(415);
    expect(heic.body.error).toBe('Take the photo as JPEG, or set the camera to Most Compatible.');
    const big = new Uint8Array(12 * 1024 * 1024 + 10);
    big.set([0xff, 0xd8, 0xff]);
    expect((await upload(owner, view.id, big)).status).toBe(413);
    expect((await owner.post(`/api/window-measurements/${view.id}/uploads`).field('note', 'x')).status).toBe(400);
    const dummy = { id: NO_UUID, widthPx: 10, heightPx: 10, focal35mm: null, takenAt: null, key: 'k', kind: 'jpeg', orientation: 1, bytes: 1, uploadedAt: NOW.toISOString() };
    await ownerSql(`update window_measurements set uploads = $1::jsonb where id = $2`, [JSON.stringify(Array.from({ length: 40 }, () => dummy)), view.id]);
    expect((await upload(owner, view.id, windowPhoto({ widthPx: 100, heightPx: 100 }).bytes)).status).toBe(409);
  });

  it('validates photographed windows; one the math cannot size is a 422 naming it', async () => {
    const { owner, view } = await measuredHouse();
    const photo = windowPhoto();
    const id = (await upload(owner, view.id, photo.bytes)).body.id as string;
    const url = `/api/window-measurements/${view.id}`;
    const ok = { id: 'p1', uploadId: id, corners: photo.window, scale: { kind: 'known-side', side: 'width', inches: 36 } };
    expect((await owner.patch(url).send({ photoWindows: [{ ...ok, uploadId: NO_UUID }] })).status).toBe(400);
    expect((await owner.patch(url).send({ photoWindows: [{ ...ok, corners: [[0, 0], [5000, 0], [5000, 10], [0, 10]] }] })).status).toBe(400);
    expect((await owner.patch(url).send({ photoWindows: [{ ...ok, scale: { kind: 'known-side', side: 'width', inches: 201 } }] })).status).toBe(400);
    expect((await owner.patch(url).send({ photoWindows: [{ ...ok, scale: { kind: 'reference', reference: 'napkin', corners: photo.paper } }] })).status).toBe(400);
    expect((await owner.patch(url).send({ photoWindows: [{ ...ok, corners: [[0, 0], [1, 'x'], [2, 2], [3, 3]] }] })).status).toBe(400);
    expect((await owner.patch(url).send({ photoWindows: Array.from({ length: 61 }, (_, i) => ({ ...ok, id: `p${i}` })) })).status).toBe(400);
    expect((await owner.patch(url).send({ photosCoverAllWindows: 'yes' })).status).toBe(400);
    const line = [[100, 100], [200, 200], [300, 300], [400, 400]];
    const bad = await owner.patch(url).send({ photoWindows: [{ ...ok, label: 'Den', scale: { kind: 'reference', reference: 'letter', corners: line } }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toContain('"Den"');
    expect((await owner.get(url)).body.adjustments.photoWindows).toBeUndefined();
  });

  it('sizes a window from the measuring sheet: least squares, the frame 1.5 in in front of the glass, uncertainty, distance and angle', async () => {
    const { owner, view } = await measuredHouse();
    const photo = windowPhoto({ focal35mm: 26 });
    const id = (await upload(owner, view.id, photo.bytes)).body.id as string;
    const url = `/api/window-measurements/${view.id}`;
    const scale = { kind: 'sheet', paper: 'letter', ...photo.sheet, planeOffsetIn: 1.5 };
    const patched = await owner.patch(url).send({ photoWindows: [{ id: 'p1', uploadId: id, label: 'Bath', windowKey: 'bath', corners: photo.windowAt(1.5), scale }] });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const w = (patched.body as WindowMeasurementView).photoWindows![0]!;
    expect(Math.abs(w.widthIn - 36)).toBeLessThan(0.02);
    expect(Math.abs(w.heightIn - 60)).toBeLessThan(0.02);
    expect(w.quality).toBe('good');
    expect(w.windowKey).toBe('bath');
    expect((await owner.get(url)).body.adjustments.photoWindows[0].windowKey).toBe('bath');
    expect((await owner.patch(url).send({ photoWindows: [{ id: 'p1', uploadId: id, windowKey: 'x'.repeat(81), corners: photo.windowAt(1.5), scale }] })).status).toBe(400);
    expect(w.uncertaintyIn!.width).toBeGreaterThan(0);
    expect(w.uncertaintyIn!.width).toBeLessThan(0.5);
    expect(Math.abs(w.distanceIn! - 2.2 / 0.0254)).toBeLessThan(15);
    expect(Math.abs(w.viewAngleDeg! - 25)).toBeLessThan(6);
    // The uncorrected answer (offset 0) is visibly bigger: the frame is closer to the camera than the sheet.
    const naive = await owner.patch(url).send({ photoWindows: [{ id: 'p1', uploadId: id, corners: photo.windowAt(1.5), scale: { ...scale, planeOffsetIn: 0 } }] });
    expect(naive.body.photoWindows[0].widthIn - 36).toBeGreaterThan(0.4);
  });

  it('validates sheet points; too few or a bad fit is a 422 naming the window', async () => {
    const { owner, view } = await measuredHouse();
    const photo = windowPhoto();
    const id = (await upload(owner, view.id, photo.bytes)).body.id as string;
    const url = `/api/window-measurements/${view.id}`;
    const scale = { kind: 'sheet', paper: 'letter', ...photo.sheet, planeOffsetIn: 0 };
    const ok = { id: 'p1', uploadId: id, label: 'Den', corners: photo.window, scale };
    const send = (scaleOver: Record<string, unknown>) => owner.patch(url).send({ photoWindows: [{ ...ok, scale: { ...scale, ...scaleOver } }] });
    expect((await send({ planeOffsetIn: 6.5 })).status).toBe(400);
    expect((await send({ paper: 'legal' })).status).toBe(400);
    expect((await send({ sheetPointsIn: photo.sheet.sheetPointsIn.slice(1) })).status).toBe(400);
    expect((await send({ sheetPointsIn: photo.sheet.sheetPointsIn.map(([x, y], i) => (i === 0 ? [x, 12] : [x, y])) })).status).toBe(400);
    expect((await send({ imagePoints: photo.sheet.imagePoints.map(([x, y], i) => (i === 0 ? [x + 5000, y] : [x, y])) })).status).toBe(400);
    expect((await send({ imagePoints: photo.sheet.imagePoints.map(([x], i) => (i === 0 ? [x, Number.NaN] : [x, 1])) })).status).toBe(400);
    expect((await send({ imagePoints: Array.from({ length: 2001 }, () => [1, 1]), sheetPointsIn: Array.from({ length: 2001 }, () => [1, 1]) })).status).toBe(400);
    const few = await send({ imagePoints: photo.sheet.imagePoints.slice(0, 7), sheetPointsIn: photo.sheet.sheetPointsIn.slice(0, 7) });
    expect(few.status).toBe(422);
    expect(few.body.error).toContain('"Den"');
    expect(few.body.error).toContain('too few points');
    // Points scattered by several pixels (a curled sheet, a blurred photo): refused, not sized wrong.
    let seed = 3;
    const jitter = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed / 2147483647 - 0.5) * 16;
    };
    const blurred = await send({ imagePoints: photo.sheet.imagePoints.map(([x, y]) => [x + jitter(), y + jitter()]) });
    expect(blurred.status).toBe(422);
    expect(blurred.body.error).toContain('not flat');
    expect((await owner.get(url)).body.adjustments.photoWindows).toBeUndefined();
    expect((await send({})).status).toBe(200);
  });

  it('another company cannot see, fetch or add photos', async () => {
    const { owner, view } = await measuredHouse();
    const id = (await upload(owner, view.id, windowPhoto({ widthPx: 100, heightPx: 100 }).bytes)).body.id as string;
    const other = await who.as('owner', 'b');
    expect((await other.get(`/api/window-measurements/${view.id}/uploads/${id}`)).status).toBe(404);
    expect((await upload(other, view.id, windowPhoto({ widthPx: 100, heightPx: 100 }).bytes)).status).toBe(404);
    const rep = await who.as('rep');
    expect((await rep.get(`/api/window-measurements/${view.id}/uploads/${id}`)).status).toBe(404);
  });
});
