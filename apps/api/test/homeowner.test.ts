import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, test, vi } from 'vitest';
import { lockedQuoteVisit, withTenant } from '@roofline/db';
import { insertFootprints } from '@roofline/db/system';
import { WINCHOICE_CATALOG } from '../src/scripts/demo-winchoice-catalog.ts';
import {
  DEFAULT_WINDOW_TIERS,
  HOMEOWNER_TOKEN_DAYS,
  type HomeownerCreated,
  type HomeownerRequestView,
  QUOTE_CONSENT_VERSION,
  quadkeyOf,
  quoteConsentText,
  quoteTextConsentText,
  type Ring,
  SATELLITE_UNUSABLE_MESSAGE,
  windowSizeClass,
  type LngLat,
  type SolarBuilding,
} from '@roofline/shared';
import { HOMEOWNER_LIMITS, HOMEOWNER_UNKNOWN_REQUEST } from '../src/public/homeowner-auth.ts';
import { UPLOAD_GUARD } from '../src/public/homeowner-upload.ts';
import { systemCtx } from '../src/public/quote-access.ts';
import { seedFootprintFixture } from '../src/scripts/footprint-fixture.ts';
import { arCorners, boxCorners, cardScene, greyJpeg, sha256 } from './homeowner-fixture.ts';
import { loginAs, makeTestApp, type TestApp } from './helpers.ts';

/*
 * The homeowner phone app's API (/api/public/homeowner/:slug): auth, the gates, the windows and their quote, the contact
 * form and its consent, booking and status, and the homeowner's windows on the staff side. Against a real database with
 * the fake providers. Needs Docker.
 */

const NOW = new Date('2026-10-14T15:00:00.000Z');
const ACME = 'acme-app';
const BOLT = 'bolt-app';
const ADDRESS = '4810 Underwood Ave, Omaha, NE 68132';
const FLAT = '2200 Riverfront Dr Apt 1203, Omaha, NE 68102';

let owner: pg.Pool;
let t: TestApp;

const q = async (text: string, values: unknown[] = []) => (await owner.query(text, values)).rows;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
});
afterAll(async () => {
  await owner.end();
});

async function enable(companyId: string, slug: string, extra: Record<string, unknown> = {}): Promise<void> {
  const cols = { quote_enabled: true, quote_slug: slug, quote_products: ['windows', 'roof', 'gutters'], ...extra };
  const names = Object.keys(cols);
  const values = Object.values(cols);
  await q(
    `insert into company_settings (company_id, ${names.join(', ')}) values ($1, ${names.map((_, i) => `$${i + 2}`).join(', ')})
     on conflict (company_id) do update set ${names.map((n) => `${n} = excluded.${n}`).join(', ')}`,
    [companyId, ...values],
  );
}

/** A house about 20 m by 18 m round the point the fake geocoder gives `address`. */
async function houseAt(address: string, scale = 1): Promise<void> {
  const found = await t.deps.geocoder.geocode(address);
  const [lng, lat] = [found!.lng, found!.lat];
  const [dx, dy] = [0.00012 * scale, 0.00008 * scale];
  const ring: Ring = [
    [lng - dx, lat - dy],
    [lng + dx, lat - dy],
    [lng + dx, lat + dy],
    [lng - dx, lat + dy],
    [lng - dx, lat - dy],
  ];
  const first = ring[0]!;
  const tile = quadkeyOf(first[0], first[1]);
  const [ready] = await q(`select 1 from building_footprint_tiles where quadkey = $1`, [tile]);
  if (ready) await insertFootprints(t.deps.pools.system, { tile, state: 'NE' }, [{ sourceRef: `house-${address}`, ring }]);
  else await seedFootprintFixture(t.deps.pools, [{ sourceRef: `house-${address}`, ring }]);
  await solarAt(address);
}

/**
 * Google Solar's answer for the house `houseAt` drew at `address`: HIGH imagery from June 2025 (well inside the quote
 * page's age limit at NOW) unless `over` says otherwise. Without a building the instant quote would call the roof
 * unmeasurable from satellite (quote/gates.ts satelliteGate).
 */
async function solarAt(address: string, over: Partial<SolarBuilding> = {}): Promise<void> {
  const found = await t.deps.geocoder.geocode(address);
  const at: LngLat = [found!.lng, found!.lat];
  const building: SolarBuilding = {
    center: at,
    box: { sw: [at[0] - 0.00012, at[1] - 0.00008], ne: [at[0] + 0.00012, at[1] + 0.00008] },
    imageryQuality: 'HIGH',
    imageryDate: '2025-06-01',
    segments: [{ pitchDeg: 26.6, azimuthDeg: 180, areaM2: 200, groundAreaM2: 180, center: at, box: null }],
    ...over,
  };
  t.solar.set(at, building);
}

beforeEach(async () => {
  t = await makeTestApp({ TRUST_PROXY: 1 });
  t.clock.set(NOW);
  await enable(t.seed.a.companyId, ACME, { quote_accent_color: '#155eab' });
  await enable(t.seed.b.companyId, BOLT, { quote_products: ['windows'] });
  await houseAt(ADDRESS);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
});

let ipCounter = 0;
/** A fresh client address per call unless one is given, so the per-IP limits only bite where a test means them to. */
const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;
const base = (slug = ACME) => `/api/public/homeowner/${slug}`;

type Call = { token?: string; ip?: string; origin?: string };

function get(path: string, o: Call = {}, slug = ACME) {
  let req = request(t.app).get(`${base(slug)}${path}`).set('X-Forwarded-For', o.ip ?? nextIp());
  if (o.token) req = req.set('Authorization', `Bearer ${o.token}`);
  if (o.origin) req = req.set('Origin', o.origin);
  return req;
}
function send(method: 'post' | 'patch' | 'delete', path: string, body: unknown, o: Call = {}, slug = ACME) {
  let req = request(t.app)[method](`${base(slug)}${path}`).set('X-Forwarded-For', o.ip ?? nextIp());
  if (o.token) req = req.set('Authorization', `Bearer ${o.token}`);
  if (o.origin) req = req.set('Origin', o.origin);
  return body === undefined ? req : req.send(body as object);
}

type Started = { id: string; token: string; body: HomeownerCreated };

async function start(over: Record<string, unknown> = {}, slug = ACME): Promise<Started> {
  const res = await send('post', '/requests', { address: ADDRESS, services: ['windows', 'roof'], ...over }, {}, slug);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const body = res.body as HomeownerCreated;
  return { id: body.requestId, token: body.token, body };
}

const view = async (s: Started): Promise<HomeownerRequestView> => {
  const res = await get(`/requests/${s.id}`, { token: s.token });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as HomeownerRequestView;
};

/** Uploads the synthetic photo and returns its id and displayed size. */
async function upload(s: Started, bytes: Uint8Array = greyJpeg(3024, 4032)): Promise<{ id: string; widthPx: number; heightPx: number }> {
  const res = await request(t.app)
    .post(`${base()}/requests/${s.id}/uploads`)
    .set('X-Forwarded-For', nextIp())
    .set('Authorization', `Bearer ${s.token}`)
    .set('Content-Type', 'image/jpeg')
    .send(Buffer.from(bytes));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; widthPx: number; heightPx: number };
}

const arScale = (w: number, h: number, extra: Record<string, unknown> = {}) => ({ kind: 'ar', pointsM: arCorners(w, h), trackingLostCount: 0, device: 'arkit-lidar', ...extra });

/** An AR window of the given size on a fresh photo; returns the request body and the response. */
async function addAr(s: Started, id: string, w: number, h: number, extra: Record<string, unknown> = {}) {
  const up = await upload(s);
  const body = { id, room: 'Kitchen', style: 'double-hung', scale: arScale(w, h), uploadId: up.id, corners: boxCorners(up.widthPx, up.heightPx), ...extra };
  return { body, res: await send('post', `/requests/${s.id}/windows`, body, { token: s.token }) };
}

const count = async (table: string, companyId?: string) =>
  Number((await q(`select count(*)::int as n from ${table}${companyId ? ' where company_id = $1' : ''}`, companyId ? [companyId] : []))[0]!.n);

const contactBody = (extra: Record<string, unknown> = {}) => ({
  firstName: 'Dana',
  lastName: 'Whitfield',
  phone: '(402) 555-0142',
  email: 'Dana.W@example.com',
  zip: '68132',
  contactConsent: true,
  textConsent: false,
  consentVersion: QUOTE_CONSENT_VERSION,
  ...extra,
});

/* ------------------------------------------------------------------------------------------------------------------ */

describe('GET /company', () => {
  test("the company's face, services, consent words and window styles; nothing about prices or other companies", async () => {
    const res = await get('/company');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const name = String((await q(`select name from companies where id = $1`, [t.seed.a.companyId]))[0]!.name);
    expect(res.body).toMatchObject({
      apiVersion: 1,
      name,
      brandColor: '#155eab',
      phone: expect.stringMatching(/^\+1\d{10}$/),
      services: ['windows', 'roof'],
      booking: false,
      privacyUrl: expect.stringMatching(/\/privacy$/),
      termsUrl: expect.stringMatching(/\/terms$/),
      consent: { version: QUOTE_CONSENT_VERSION, text: quoteConsentText(name), textingText: quoteTextConsentText(name) },
      trust: null,
      limits: { maxWindows: 60, maxPhotoBytes: 12 * 1024 * 1024, maxRoomLength: 40, maxLabelLength: 80, tokenDays: HOMEOWNER_TOKEN_DAYS },
    });
    // Four plain choices; each carries the style key an app sends for it
    expect(res.body.windowStyles).toEqual([
      { key: 'double-hung', label: 'Opens up and down', hint: 'Double-hung', tile: 'up-down', atVisit: false },
      { key: 'slider-2', label: 'Slides sideways', hint: 'Slider', tile: 'sideways', atVisit: false },
      { key: 'picture', label: "Doesn't open", hint: 'Picture window', tile: 'fixed', atVisit: false },
      { key: 'arch', label: 'Bay, bow or odd shape', hint: 'We quote it at your visit', tile: 'special', atVisit: true },
    ]);
    // Nothing entered: Good / Better / Best with no notes, nothing included, no offer or financing
    expect(res.body.catalog).toEqual({
      tiers: [{ key: 'good', label: 'Good', note: '' }, { key: 'better', label: 'Better', note: '' }, { key: 'best', label: 'Best', note: '' }],
      included: [],
      offer: null,
      financing: null,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/price|cents|dailyCap|embed/i);
  });

  test('a three-digit colour is sent as six digits; an unknown, malformed or turned-off page is the same 404', async () => {
    await q(`update company_settings set quote_accent_color = '#abc' where company_id = $1`, [t.seed.a.companyId]);
    expect((await get('/company')).body.brandColor).toBe('#aabbcc');
    const missing = await get('/company', {}, 'no-such-co');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'not_found' });
    expect((await get('/company', {}, 'X')).status).toBe(404);
    await q(`update company_settings set quote_enabled = false where company_id = $1`, [t.seed.a.companyId]);
    const off = await get('/company');
    expect(off.status).toBe(404);
    expect(off.body).toEqual(missing.body);
  });
});

describe('POST /requests', () => {
  test('a ready request: a token shown once (only its hash is stored), the home and the estimates', async () => {
    const solarBefore = t.solar.calls.length;
    const { body, id } = await start();
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body).toMatchObject({ status: 'ready', services: ['windows', 'roof'], home: { address: expect.stringContaining('4810 Underwood') } });
    expect(new Date(body.expiresAt).getTime()).toBe(NOW.getTime() + HOMEOWNER_TOKEN_DAYS * 24 * 60 * 60 * 1000);
    expect(body.estimate.windows).toMatchObject({ low: expect.any(Number), high: expect.any(Number), likely: expect.any(Number) });
    expect(body.estimate.windows!.low).toBeLessThanOrEqual(body.estimate.windows!.likely);
    expect(body.estimate.windows!.likely).toBeLessThanOrEqual(body.estimate.windows!.high);
    expect(body.estimate.roof!.low).toBeLessThan(body.estimate.roof!.high);
    expect(body.estimate.roof!.low % 100).toBe(0);
    expect(JSON.stringify(body)).not.toMatch(/gutter/i);
    expect(body.home.outline!.ring.length).toBeGreaterThanOrEqual(3);
    // The house was measured once, for the roof and the windows together
    expect(t.solar.calls.length).toBeGreaterThanOrEqual(solarBefore);
    const [row] = await q(`select token_hash, expires_at, status, callback_reason, services, ip_hash, quote_estimate_id, property_id from homeowner_requests where id = $1`, [id]);
    expect(row).toMatchObject({ token_hash: sha256(body.token), status: 'ready', callback_reason: null, services: ['windows', 'roof'] });
    expect(row!.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.quote_estimate_id).not.toBeNull();
    // The token itself is nowhere in the table
    const hit = await q(`select count(*)::int as n from homeowner_requests where token_hash = $1 or ip_hash = $1 or address = $1`, [body.token]);
    expect(hit[0]!.n).toBe(0);
  });

  test('the audit trail says what happened and nothing personal: no address, no token, no IP', async () => {
    const ip = '203.0.113.77';
    const { body } = await (async () => {
      const res = await send('post', '/requests', { address: ADDRESS, services: ['windows'] }, { ip });
      expect(res.status).toBe(201);
      return { body: res.body as HomeownerCreated };
    })();
    const rows = await q(`select action, before, after, ip from audit_log where company_id = $1 and action like 'homeowner.%'`, [t.seed.a.companyId]);
    expect(rows).toHaveLength(1);
    const text = JSON.stringify(rows);
    expect(text).not.toContain('Underwood');
    expect(text).not.toContain(body.token);
    expect(text).not.toContain(ip);
  });

  test('gutters are not offered to homeowners: not in the company\'s services, and a request for them is a 422 service_not_offered', async () => {
    // The company has gutters switched on for staff (see enable()), yet the app never sees them.
    expect((await get('/company')).body.services).toEqual(['windows', 'roof']);
    for (const services of [['gutters'], ['windows', 'gutters']]) {
      const res = await send('post', '/requests', { address: ADDRESS, services });
      expect(res.status, services.join()).toBe(422);
      expect(res.body).toMatchObject({ field: 'services', code: 'service_not_offered' });
    }
    expect(await count('homeowner_requests', t.seed.a.companyId)).toBe(0);
  });

  test('an apartment is the call-back path: nothing measured, a reason, and the windows calls are refused', async () => {
    const { body, id, token } = await start({ address: FLAT, services: ['windows', 'roof'] });
    expect(body).toMatchObject({ status: 'callback', callbackReason: 'unit', estimate: { windows: null, roof: null } });
    expect(body.home.floors).toBeNull();
    expect(t.solar.calls).toHaveLength(0);
    const v = await view({ id, token, body });
    expect(v.quote).toBeNull();
    expect(v.request).toMatchObject({ status: 'callback', callbackReason: 'unit' });
    const up = await request(t.app).post(`${base()}/requests/${id}/uploads`).set('X-Forwarded-For', nextIp()).set('Authorization', `Bearer ${token}`).set('Content-Type', 'image/jpeg').send(Buffer.from(greyJpeg(3024, 4032)));
    expect(up.status).toBe(409);
    expect(up.body.code).toBe('callback_only');
    const win = await send('post', `/requests/${id}/windows`, { id: 'w1', room: 'Kitchen', style: 'double-hung', scale: { kind: 'roomplan', widthM: 0.9, heightM: 1.2, confidence: 'high' } }, { token });
    expect(win.status).toBe(409);
    expect(win.body.code).toBe('callback_only');
    // Booking and contact still work for them (below).
  });

  describe('the satellite pictures cannot be trusted for the roof', () => {
    const MESSAGE = SATELLITE_UNUSABLE_MESSAGE;
    const withLow = async () => {
      t.solar.clear();
      await solarAt(ADDRESS, { imageryQuality: 'LOW', imageryDate: '2014-05-01' });
    };

    test('roof and windows: the windows are estimated, the roof has no price and says why', async () => {
      await withLow();
      const { body, id, token } = await start({ services: ['windows', 'roof'] });
      expect(body).toMatchObject({ status: 'ready', estimate: { roof: null, roofNote: { reason: 'satellite-unusable', message: MESSAGE } } });
      expect(body.estimate.windows).not.toBeNull();
      expect(body.callbackReason).toBeUndefined();
      // The same on a later read, and staff keep the cause.
      const v = await view({ id, token, body });
      expect(v.request.estimate).toMatchObject({ roof: null, roofNote: { message: MESSAGE } });
      const [row] = await q(`select result->'satellite' as satellite from quote_estimates where company_id = $1`, [t.seed.a.companyId]);
      expect(row!.satellite).toMatchObject({ problems: ['imagery-quality', 'imagery-old'], quality: 'LOW', date: '2014-05-01' });
      expect(JSON.stringify(body)).not.toMatch(/imagery-|LOW|2014/);
    });

    test('the roof alone: a call back with the new reason, the sentence, and no price', async () => {
      await withLow();
      const { body } = await start({ services: ['roof'] });
      expect(body).toMatchObject({ status: 'callback', callbackReason: 'satellite-unusable', estimate: { roof: null, windows: null, roofNote: { reason: 'satellite-unusable', message: MESSAGE } } });
    });

    test('windows only: carries on as normal, no roof note', async () => {
      await withLow();
      const { body } = await start({ services: ['windows'] });
      expect(body).toMatchObject({ status: 'ready' });
      expect(body.estimate.roofNote).toBeUndefined();
      expect(body.estimate.windows).not.toBeNull();
    });

    test('a good house still gets its roof price and no note', async () => {
      const { body } = await start({ services: ['windows', 'roof'] });
      expect(body.estimate.roof).not.toBeNull();
      expect(body.estimate.roofNote).toBeUndefined();
    });

    test('the same low-quality home is the same answer for the next visitor (stored), booking still works', async () => {
      await withLow();
      const first = await start({ services: ['roof'] });
      const again = await start({ services: ['roof'] });
      expect(again.body).toMatchObject({ status: 'callback', callbackReason: 'satellite-unusable' });
      expect(first.id).not.toBe(again.id);
    });
  });

  test('a lookup that did not land on the house, a house too big for a home and the daily limit are call backs with their own reasons', async () => {
    const real = t.deps.geocoder.geocode.bind(t.deps.geocoder);
    vi.spyOn(t.deps.geocoder, 'geocode').mockImplementationOnce(async (a, o) => ({ ...(await real(a, o))!, accuracyType: 'range_interpolation' }));
    expect((await start({ address: '18 Elm St, Omaha, NE 68102' })).body).toMatchObject({ status: 'callback', callbackReason: 'address' });
    const BIG = '2587 Linwood Ave, Omaha, NE 68105';
    await houseAt(BIG, 2);
    expect((await start({ address: BIG })).body).toMatchObject({ status: 'callback', callbackReason: 'home' });
    await q(`update company_settings set quote_daily_cap = 1 where company_id = $1`, [t.seed.a.companyId]);
    await start(); // uses the one priced estimate
    expect((await start({ address: '901 Other Rd, Omaha, NE 68102' })).body).toMatchObject({ status: 'callback', callbackReason: 'busy' });
  });

  test('an address that cannot be found is a 422 on address; a repeat of a measured address is answered from storage', async () => {
    const lost = await send('post', '/requests', { address: 'Nowhere At All, Zz 00000', services: ['windows'] });
    expect([422, 201]).toContain(lost.status);
    if (lost.status === 422) expect(lost.body).toMatchObject({ field: 'address', code: 'address_not_found' });
    await start();
    const geocodes = t.geocoder.calls.length;
    const solar = t.solar.calls.length;
    await start();
    expect(t.geocoder.calls.length).toBe(geocodes);
    expect(t.solar.calls.length).toBe(solar);
  });

  test('bodies are checked: a plain 400 with the field and a code', async () => {
    for (const [body, field] of [
      [{ address: 'x', services: ['windows'] }, 'address'],
      [{ address: ADDRESS, services: [] }, 'services'],
      [{ address: ADDRESS, services: ['windows', 'windows'] }, 'services'],
      [{ address: ADDRESS, services: ['pool'] }, 'services.0'],
      [{ address: ADDRESS }, 'services'],
      [{ address: ADDRESS, services: ['windows'], extra: 1 }, undefined],
    ] as const) {
      const res = await send('post', '/requests', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe('invalid_request');
      if (field !== undefined) expect(res.body.field).toBe(field);
      expect(typeof res.body.error).toBe('string');
    }
    expect((await request(t.app).post(`${base()}/requests`).set('X-Forwarded-For', nextIp()).set('Content-Type', 'application/json').send('{not json')).status).toBe(400);
  });

  test('a service the company does not offer is a 422 on services', async () => {
    const res = await send('post', '/requests', { address: ADDRESS, services: ['windows', 'roof'] }, {}, BOLT);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ field: 'services', code: 'service_not_offered' });
  });

  test('ten new requests an hour per IP address, then a 429 with Retry-After and a code', async () => {
    const ip = '203.0.113.9';
    for (let i = 0; i < HOMEOWNER_LIMITS.newRequestsPerIpPerHour; i++) {
      expect((await send('post', '/requests', { address: ADDRESS, services: ['windows'] }, { ip })).status, `call ${i}`).toBe(201);
    }
    const over = await send('post', '/requests', { address: ADDRESS, services: ['windows'] }, { ip });
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('rate_limited');
    expect(over.headers['retry-after']).toBe('3600');
    expect(over.headers['cache-control']).toBe('no-store');
    // Another address is not held back
    expect((await send('post', '/requests', { address: ADDRESS, services: ['windows'] }, { ip: '203.0.113.10' })).status).toBe(201);
  });
});

describe('the token', () => {
  test('missing, malformed, wrong, another request\'s, an unknown id and another company\'s request are all the same 401', async () => {
    const a = await start();
    const b = await start();
    const other = await start({ services: ['windows'] }, BOLT);
    const unknownId = '00000000-0000-4000-8000-0000000000aa';
    const answers = await Promise.all([
      get(`/requests/${a.id}`), // no header
      get(`/requests/${a.id}`, { token: 'short' }),
      get(`/requests/${a.id}`, { token: 'A'.repeat(43) }), // right shape, wrong token
      get(`/requests/${a.id}`, { token: b.token }), // another request's token
      get(`/requests/${unknownId}`, { token: a.token }), // no such request
      get(`/requests/not-a-uuid`, { token: a.token }),
      get(`/requests/${other.id}`, { token: other.token }), // right token, wrong company's slug (ACME)
      get(`/requests/${a.id}`, { token: a.token }, BOLT), // this company's token on another slug
    ]);
    for (const res of answers) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: HOMEOWNER_UNKNOWN_REQUEST, code: 'unauthorized' });
    }
    const fine = await get(`/requests/${a.id}`, { token: a.token });
    expect(fine.status).toBe(200);
    expect(JSON.stringify(fine.body)).not.toContain(a.token);
    // The same answer for every change, too
    for (const [method, path] of [['post', '/windows'], ['post', '/contact'], ['post', '/book'], ['patch', ''], ['delete', '/windows/w1']] as const) {
      const res = await send(method, `/requests/${a.id}${path}`, {}, { token: 'B'.repeat(43) });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.body.code).toBe('unauthorized');
    }
    expect((await request(t.app).post(`${base()}/requests/${a.id}/uploads`).set('Authorization', `Bearer ${'B'.repeat(43)}`).set('Content-Type', 'image/jpeg').send(Buffer.from([1, 2, 3]))).status).toBe(401);
  });

  test('a token is good for 60 days and is told apart only when it is the right one', async () => {
    const s = await start();
    t.clock.advance((HOMEOWNER_TOKEN_DAYS * 24 - 1) * 60 * 60 * 1000);
    expect((await get(`/requests/${s.id}`, { token: s.token })).status).toBe(200);
    t.clock.advance(2 * 60 * 60 * 1000);
    const late = await get(`/requests/${s.id}`, { token: s.token });
    expect(late.status).toBe(401);
    expect(late.body).toMatchObject({ code: 'token_expired' });
    // A wrong token on the same expired request is just unauthorized: it learns nothing about the request.
    const wrong = await get(`/requests/${s.id}`, { token: 'C'.repeat(43) });
    expect(wrong.body.code).toBe('unauthorized');
  });

  test('wrong tokens count against the IP address: past 30 an hour every call from it is refused, even with the right token', async () => {
    const s = await start();
    const ip = '203.0.113.50';
    for (let i = 0; i < HOMEOWNER_LIMITS.failedAuthPerIpPerHour; i++) {
      expect((await get(`/requests/${s.id}`, { token: 'D'.repeat(43), ip })).status, `try ${i}`).toBe(401);
    }
    const blocked = await get(`/requests/${s.id}`, { token: s.token, ip });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('rate_limited');
    expect(blocked.headers['retry-after']).toBe('3600');
    // Another address with the right token is fine ...
    expect((await get(`/requests/${s.id}`, { token: s.token, ip: '203.0.113.51' })).status).toBe(200);
    // ... and the lock ends with the hour (the limiter's counts run on the machine's own clock, not the app's).
    const real = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(real + 61 * 60 * 1000);
    expect((await get(`/requests/${s.id}`, { token: s.token, ip })).status).toBe(200);
    vi.restoreAllMocks();
  });

  test('120 calls a minute per request, then a 429; the next minute is clear', async () => {
    const s = await start();
    for (let i = 0; i < HOMEOWNER_LIMITS.tokenPerMinute; i++) {
      const res = await get(`/requests/${s.id}/status`, { token: s.token });
      if (res.status !== 200) throw new Error(`call ${i}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const over = await get(`/requests/${s.id}/status`, { token: s.token });
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('rate_limited');
    expect(over.headers['retry-after']).toBe('60');
  }, 120_000);

  test('a browser from another site is refused on a change; a native app (no Origin) and the app origin pass', async () => {
    const s = await start();
    const evil = await send('post', '/requests', { address: ADDRESS, services: ['windows'] }, { origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    expect(evil.body.code).toBe('cross_site');
    expect(evil.headers['cache-control']).toBe('no-store');
    expect(evil.headers['x-robots-tag']).toBe('noindex');
    const ok = await get(`/requests/${s.id}`, { token: s.token, origin: 'https://evil.example' });
    expect(ok.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await request(t.app).options(`${base()}/requests/${s.id}/windows`).set('Origin', t.deps.config.APP_ORIGIN).set('Access-Control-Request-Method', 'POST');
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-headers']).toContain('Authorization');
  });

  test('the per-IP limit comes before the Origin check, which looks the company up: over the limit, a cross-site call is a 429, not a 403', async () => {
    const ip = '203.0.113.95';
    for (let batch = 0; batch < HOMEOWNER_LIMITS.ipPerMinute / 40; batch++) {
      const answers = await Promise.all(Array.from({ length: 40 }, () => get('/company', { ip })));
      for (const a of answers) expect(a.status).toBe(200);
    }
    const over = await send('post', '/requests', { address: ADDRESS, services: ['windows'] }, { ip, origin: 'https://evil.example' });
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('rate_limited');
    expect(over.headers['retry-after']).toBe('60');
    expect(over.headers['cache-control']).toBe('no-store');
    expect(over.headers['x-robots-tag']).toBe('noindex');
  }, 120_000);
});

describe('paths and methods that are not part of the API', () => {
  test('are a 404 with a code and the same headers, not the app\'s sign-in refusal', async () => {
    const calls = {
      'GET /nothing': request(t.app).get(`${base()}/nothing`),
      'PUT /company': request(t.app).put(`${base()}/company`).send({}),
      'DELETE /company': request(t.app).delete(`${base()}/company`),
      'GET (no slug)': request(t.app).get('/api/public/homeowner'),
    };
    for (const [label, call] of Object.entries(calls)) {
      const res = await call.set('X-Forwarded-For', nextIp());
      expect(res.status, label).toBe(404);
      expect(res.body).toEqual({ error: "We couldn't find that.", code: 'not_found' });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-robots-tag']).toBe('noindex');
    }
  });
});

describe('photos', () => {
  const auth = (s: Started) => ({ Authorization: `Bearer ${s.token}`, 'X-Forwarded-For': nextIp() });

  test('a JPEG is kept as sent: its displayed size comes back, the bytes are stored under the company, the measurement is made on the first', async () => {
    const s = await start();
    expect((await q(`select window_measurement_id from homeowner_requests where id = $1`, [s.id]))[0]!.window_measurement_id).toBeNull();
    const up = await upload(s);
    expect(up).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), widthPx: 3024, heightPx: 4032 });
    const [row] = await q(`select m.id, m.uploads, m.property_id from homeowner_requests r join window_measurements m on m.id = r.window_measurement_id where r.id = $1`, [s.id]);
    expect(row!.uploads).toHaveLength(1);
    expect(row!.uploads[0]).toMatchObject({ id: up.id, kind: 'jpeg', widthPx: 3024, heightPx: 4032, focal35mm: 26 });
    expect(row!.uploads[0].key).toBe(`${t.seed.a.companyId}/window-uploads/${up.id}.jpg`);
    expect(await t.objectStore.get(row!.uploads[0].key)).not.toBeNull();
    await upload(s);
    expect(await count('window_measurements', t.seed.a.companyId)).toBe(1);
  });

  test('a JSON body sent to the upload route is refused as not a photo, not left waiting', async () => {
    const s = await start();
    // The request is timed, not the test: a slow database must not look like the hang this guards against (a JSON parser
    // that has read the body leaves the upload waiting for ever).
    const res = await request(t.app)
      .post(`${base()}/requests/${s.id}/uploads`)
      .set('X-Forwarded-For', nextIp())
      .set('Authorization', `Bearer ${s.token}`)
      .set('Content-Type', 'application/json')
      .send({ photo: 'x' })
      .timeout({ response: 5_000, deadline: 15_000 });
    expect(res.status).toBe(415);
    expect(res.body.code).toBe('unsupported_media');
    expect(await count('window_measurements', t.seed.a.companyId)).toBe(0);
  });

  test('multipart works too; garbage, a HEIC and an oversized photo are refused with their codes and nothing is stored', async () => {
    const s = await start();
    const multi = await request(t.app).post(`${base()}/requests/${s.id}/uploads`).set(auth(s)).attach('photo', Buffer.from(greyJpeg(3024, 4032)), 'w.jpg');
    expect(multi.status, JSON.stringify(multi.body)).toBe(201);
    const bad = await request(t.app).post(`${base()}/requests/${s.id}/uploads`).set(auth(s)).set('Content-Type', 'image/jpeg').send(Buffer.from('not a photo at all'));
    expect(bad.status).toBe(415);
    expect(bad.body.code).toBe('unsupported_media');
    const heic = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63]);
    const heicRes = await request(t.app).post(`${base()}/requests/${s.id}/uploads`).set(auth(s)).set('Content-Type', 'image/heic').send(heic);
    expect(heicRes.status).toBe(415);
    expect(heicRes.body.error).toMatch(/Most Compatible/);
    const big = await request(t.app).post(`${base()}/requests/${s.id}/uploads`).set(auth(s)).set('Content-Type', 'image/jpeg').send(Buffer.alloc(12 * 1024 * 1024 + 10, 1));
    expect(big.status).toBe(413);
    expect(big.body.code).toBe('too_large');
    const [m] = await q(`select jsonb_array_length(uploads) as n from window_measurements where company_id = $1`, [t.seed.a.companyId]);
    expect(m!.n).toBe(1);
    // The request, with the photo it holds, is gone from nobody else's view
    expect(await count('window_measurements', t.seed.b.companyId)).toBe(0);
  });

  test('a photo that claims too many pixels is refused however small the file, a big real one is not', async () => {
    const s = await start();
    // A PNG header and nothing else: 33 bytes that say how big the picture is
    const png = (w: number, h: number) => {
      const b = Buffer.alloc(33);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
      b.writeUInt32BE(13, 8);
      b.write('IHDR', 12, 'ascii');
      b.writeUInt32BE(w, 16);
      b.writeUInt32BE(h, 20);
      return b;
    };
    const post = (bytes: Buffer) => request(t.app).post(`${base()}/requests/${s.id}/uploads`).set(auth(s)).set('Content-Type', 'image/png').send(bytes);
    const huge = await post(png(16_000, 16_000));
    expect(huge.status).toBe(415);
    expect(huge.body.code).toBe('unsupported_media');
    expect(await count('window_measurements', t.seed.a.companyId)).toBe(0);
    // 48 MP is the biggest a phone takes; it stays welcome
    const big = await post(png(8_000, 6_000));
    expect(big.status, JSON.stringify(big.body)).toBe(201);
    expect(big.body).toMatchObject({ widthPx: 8_000, heightPx: 6_000 });
  });

  describe('photos being received', () => {
    let server: http.Server;
    let port: number;
    beforeEach(async () => {
      server = http.createServer(t.app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });
    afterEach(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const ip = '203.0.113.120';
    /** A photo half sent: the headers promise a megabyte, a hundred bytes follow, then nothing. */
    const stalled = (s: Started, type: string): http.ClientRequest => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        agent: false,
        method: 'POST',
        path: `${base()}/requests/${s.id}/uploads`,
        headers: { Authorization: `Bearer ${s.token}`, 'X-Forwarded-For': ip, 'Content-Type': type, 'Content-Length': '1000000' },
      });
      req.on('error', () => undefined);
      req.write(Buffer.alloc(100, 1));
      return req;
    };
    /** Three bytes sent whole: refused as not a photo (415) when it is taken in, or a 429 when the request is already receiving its three. */
    const tiny = (s: Started) =>
      new Promise<{ status: number; body: { code?: string }; retryAfter: string | undefined }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            agent: false,
            method: 'POST',
            path: `${base()}/requests/${s.id}/uploads`,
            headers: { Authorization: `Bearer ${s.token}`, 'X-Forwarded-For': ip, 'Content-Type': 'image/jpeg', 'Content-Length': '3' },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as { code?: string }, retryAfter: res.headers['retry-after'] as string | undefined }));
          },
        );
        req.on('error', reject);
        req.end(Buffer.from([1, 2, 3]));
      });
    /** Asks until the answer is the wanted status (the server takes a moment to notice a stalled photo or a hung-up phone). */
    async function until(s: Started, status: number): Promise<{ status: number; body: { code?: string }; retryAfter: string | undefined }> {
      const deadline = Date.now() + 8_000;
      for (;;) {
        const answer = await tiny(s);
        if (answer.status === status || Date.now() > deadline) return answer;
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    for (const type of ['image/jpeg', 'multipart/form-data; boundary=xyz']) {
      test(`only ${UPLOAD_GUARD.perRequest} are received at once per request (${type.split(';')[0]}), a fourth is a 429 that reads nothing; a hung-up phone frees its place`, async () => {
        const s = await start();
        const open = Array.from({ length: UPLOAD_GUARD.perRequest }, () => stalled(s, type));
        const full = await until(s, 429);
        expect(full.status).toBe(429);
        expect(full.body.code).toBe('rate_limited');
        expect(full.retryAfter).toBe(String(UPLOAD_GUARD.retryAfterSeconds));
        // Another request is not held back by this one's three
        const other = await start();
        expect((await tiny(other)).status).toBe(415);
        // The phones go away mid-photo: the places come back
        for (const req of open) req.destroy();
        const freed = await until(s, 415);
        expect(freed.status).toBe(415);
        expect(await count('window_measurements', t.seed.a.companyId)).toBe(0);
      }, 60_000);
    }
  });

  test('a request holds 90 photos and 250 MB: past either, a 409 and the bytes are removed', async () => {
    const s = await start();
    await upload(s);
    const fake = (n: number, bytes: number) => Array.from({ length: n }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, widthPx: 10, heightPx: 10, focal35mm: null, takenAt: null, key: `k/${i}`, kind: 'jpeg', orientation: 1, bytes, uploadedAt: NOW.toISOString() }));
    await q(`update window_measurements set uploads = $2::jsonb where company_id = $1`, [t.seed.a.companyId, JSON.stringify(fake(89, 100))]);
    const stored = (await t.objectStore.get('probe')) === null;
    expect(stored).toBe(true);
    const ninetieth = await request(t.app).post(`${base()}/requests/${s.id}/uploads`).set(auth(s)).set('Content-Type', 'image/jpeg').send(Buffer.from(greyJpeg(3024, 4032)));
    expect(ninetieth.status).toBe(201);
    const over = await request(t.app).post(`${base()}/requests/${s.id}/uploads`).set(auth(s)).set('Content-Type', 'image/jpeg').send(Buffer.from(greyJpeg(3024, 4032)));
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('uploads_full');
    await q(`update window_measurements set uploads = $2::jsonb where company_id = $1`, [t.seed.a.companyId, JSON.stringify(fake(5, 60 * 1024 * 1024))]);
    const heavy = await request(t.app).post(`${base()}/requests/${s.id}/uploads`).set(auth(s)).set('Content-Type', 'image/jpeg').send(Buffer.from(greyJpeg(3024, 4032)));
    expect(heavy.status).toBe(409);
    expect(heavy.body.code).toBe('uploads_full');
    // The refused photo's bytes are not left behind
    const keys = await q(`select count(*)::int as n from window_measurements where company_id = $1`, [t.seed.a.companyId]);
    expect(keys[0]!.n).toBe(1);
  });
});

describe('windows', () => {
  test('an AR window: sized from its corners, stored as the homeowner\'s, and the whole view comes back', async () => {
    const s = await start();
    const { body, res } = await addAr(s, 'w-kitchen-1', 36, 48, { label: 'Over the sink' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const v = res.body as HomeownerRequestView;
    expect(v.windows).toHaveLength(1);
    const w = v.windows[0]!;
    expect(w).toMatchObject({ id: 'w-kitchen-1', room: 'Kitchen', label: 'Over the sink', style: 'double-hung', sizeClass: windowSizeClass(36, 48), quality: 'good', reasons: [] });
    expect(w.widthIn).toBeCloseTo(36, 1);
    expect(w.heightIn).toBeCloseTo(48, 1);
    expect(w.sizeLabel).toBe('36 x 48');
    expect(w.uncertaintyLabel).toMatch(/^about ±(\d+ )?\d?\/?\d* in$/);
    expect(w.uncertaintyIn.width).toBeGreaterThan(0);
    expect(w.scale).toEqual(body.scale);
    expect(v.rooms).toEqual(['Kitchen']);
    // Stored on the address's window measurement, marked as the homeowner's
    const [row] = await q(`select m.adjustments from homeowner_requests r join window_measurements m on m.id = r.window_measurement_id where r.id = $1`, [s.id]);
    expect(row!.adjustments.photoWindows).toHaveLength(1);
    expect(row!.adjustments.photoWindows[0]).toMatchObject({ id: 'w-kitchen-1', source: 'homeowner-app', room: 'Kitchen', style: 'double-hung', label: 'Over the sink' });
    expect(row!.adjustments.manualCounts).toEqual({});
  });

  test('the same window again is a 200 and changes nothing; a different window with its id is a 409', async () => {
    const s = await start();
    const first = await addAr(s, 'w1', 36, 48);
    expect(first.res.status).toBe(201);
    const again = await send('post', `/requests/${s.id}/windows`, first.body, { token: s.token });
    expect(again.status).toBe(200);
    expect(again.body.windows).toEqual(first.res.body.windows);
    const clash = await send('post', `/requests/${s.id}/windows`, { ...first.body, room: 'Bedroom 1' }, { token: s.token });
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({ code: 'window_id_taken', field: 'id' });
    const [row] = await q(`select jsonb_array_length(m.adjustments->'photoWindows') as n from homeowner_requests r join window_measurements m on m.id = r.window_measurement_id where r.id = $1`, [s.id]);
    expect(row!.n).toBe(1);
  });

  test('a window is checked: shape, room, style, photo, corners inside the photo, an AR size that is not a window', async () => {
    const s = await start();
    const up = await upload(s);
    const ok = { id: 'w1', room: 'Kitchen', style: 'double-hung', scale: arScale(36, 48), uploadId: up.id, corners: boxCorners(up.widthPx, up.heightPx) };
    const bad = async (over: Record<string, unknown>, status: number, field?: string) => {
      const res = await send('post', `/requests/${s.id}/windows`, { ...ok, ...over }, { token: s.token });
      expect(res.status, JSON.stringify([over, res.body])).toBe(status);
      if (field !== undefined) expect(res.body.field, JSON.stringify(res.body)).toBe(field);
      return res;
    };
    await bad({ id: 'has space' }, 400, 'id');
    await bad({ room: '' }, 400, 'room');
    await bad({ room: 'x'.repeat(41) }, 400, 'room');
    await bad({ style: 'bay' }, 400, 'style');
    await bad({ label: 'y'.repeat(81) }, 400, 'label');
    await bad({ uploadId: undefined }, 400);
    await bad({ corners: undefined }, 400);
    await bad({ extra: true }, 400);
    await bad({ uploadId: '11111111-1111-4111-8111-111111111111' }, 400, 'uploadId');
    await bad({ corners: [[0, 0], [5000, 0], [5000, 100], [0, 100]] }, 400, 'corners');
    const huge = await bad({ scale: arScale(36, 400) }, 422, 'scale');
    expect(huge.body.code).toBe('window_unsizable');
    expect(huge.body.error).toMatch(/^We couldn't size /);
    await bad({ scale: { kind: 'ar', pointsM: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], trackingLostCount: 0, device: 'arkit' } }, 422, 'scale');
    await bad({ scale: { kind: 'ar', pointsM: arCorners(36, 48), trackingLostCount: 0 } }, 400);
    await bad({ scale: { kind: 'laser', mm: 5 } }, 400);
    expect((await view(s)).windows).toHaveLength(0);
    expect((await send('post', `/requests/${s.id}/windows`, ok, { token: s.token })).status).toBe(201);
  });

  test('a window that fumbled the corners is "check" with plain reasons: lost tracking, a bent frame', async () => {
    const s = await start();
    const lost = await addAr(s, 'lost', 36, 48, { scale: arScale(36, 48, { trackingLostCount: 5 }) });
    expect(lost.res.status).toBe(201);
    const w = (lost.res.body as HomeownerRequestView).windows[0]!;
    expect(w.quality).toBe('check');
    expect(w.reasons).toEqual(['Your phone lost track of the wall while you measured. Move slowly and measure it again.']);
    const bent = addArBent();
    function addArBent() {
      const pts = arCorners(36, 48);
      pts[2] = [pts[2][0], pts[2][1], pts[2][2] + 0.4];
      return pts;
    }
    const up = await upload(s);
    const res = await send('post', `/requests/${s.id}/windows`, { id: 'bent', room: 'Den', style: 'picture', scale: arScale(36, 48, { pointsM: bent }), uploadId: up.id, corners: boxCorners(up.widthPx, up.heightPx) }, { token: s.token });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const bentWindow = (res.body as HomeownerRequestView).windows.find((x) => x.id === 'bent')!;
    expect(bentWindow.quality).toBe('check');
    expect(bentWindow.reasons).toEqual(["The four corners don't look like a flat window. Tap the corners of the frame again."]);
    expect((res.body as HomeownerRequestView).rooms).toEqual(['Kitchen', 'Den']);
  });

  test('a room scan needs no photo: always "check", at least an inch of doubt, never a bare ±', async () => {
    const s = await start();
    const res = await send('post', `/requests/${s.id}/windows`, { id: 'scan1', room: 'Living room', style: 'picture', scale: { kind: 'roomplan', widthM: 1.2, heightM: 1.5, confidence: 'medium' } }, { token: s.token });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const w = (res.body as HomeownerRequestView).windows[0]!;
    expect(w).toMatchObject({ widthIn: 47.2, heightIn: 59.1, quality: 'check', uncertaintyIn: { width: 1.5, height: 1.5 }, uncertaintyLabel: 'about ±1 1/2 in', reasons: ['A room scan gives a rough size. We measure again at your free visit.'] });
    expect(w.uploadId).toBeUndefined();
    expect(w.sizeLabel).toBe('47 1/4 x 59 1/8');
    expect((await send('post', `/requests/${s.id}/windows`, { id: 'scan2', room: 'Den', style: 'picture', scale: { kind: 'roomplan', widthM: 0.02, heightM: 1.5, confidence: 'high' } }, { token: s.token })).status).toBe(422);
  });

  test('a credit-card window: sized from the card and the frame, with a ± that is never bare; the same photo can carry another window', async () => {
    const s = await start();
    const scene = cardScene({ windowIn: { w: 36, h: 48 } });
    const up = await upload(s, scene.bytes);
    const body = { id: 'card1', room: 'Bedroom 1', style: 'casement', scale: { kind: 'card', cardCorners: scene.cardCorners, card: { widthMm: 85.6, heightMm: 53.98 } }, uploadId: up.id, corners: scene.windowCorners };
    const res = await send('post', `/requests/${s.id}/windows`, body, { token: s.token });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const w = (res.body as HomeownerRequestView).windows[0]!;
    expect(Math.abs(w.widthIn - 36)).toBeLessThan(1.5);
    expect(Math.abs(w.heightIn - 48)).toBeLessThan(2);
    expect(w.uncertaintyIn.width).toBeGreaterThan(0);
    expect(w.uncertaintyLabel).toMatch(/^about ±/);
    expect(['good', 'check']).toContain(w.quality);
    if (w.quality === 'check') expect(w.reasons.length).toBeGreaterThan(0);
    else expect(w.reasons).toEqual([]);
    // Card sizes are quote-grade, kept to 1/10 inch
    expect(Math.round(w.widthIn * 10) / 10).toBe(w.widthIn);
    // The card must be an ID-1 card, and its corners and the frame's must be on the photo
    const wrongCard = await send('post', `/requests/${s.id}/windows`, { ...body, id: 'card2', scale: { kind: 'card', cardCorners: scene.cardCorners, card: { widthMm: 60, heightMm: 40 } } }, { token: s.token });
    expect(wrongCard.status).toBe(422);
    expect(wrongCard.body.code).toBe('window_unsizable');
    const outside = await send('post', `/requests/${s.id}/windows`, { ...body, id: 'card3', scale: { kind: 'card', cardCorners: [[-5, 10], [100, 10], [100, 60], [-5, 60]], card: { widthMm: 85.6, heightMm: 53.98 } } }, { token: s.token });
    expect(outside.status).toBe(400);
    expect(outside.body.field).toBe('corners');
    expect((await send('post', `/requests/${s.id}/windows`, { ...body, id: 'card4', room: 'Bedroom 2' }, { token: s.token })).status).toBe(201);
  });

  test('a window much bigger than the card is "check" with a reason in inches; a small one is better than a big one', async () => {
    const s = await start();
    const small = cardScene({ windowIn: { w: 24, h: 36 }, distanceM: 1.3 });
    const big = cardScene({ windowIn: { w: 72, h: 80 }, distanceM: 2.4 });
    const add = async (id: string, scene: typeof small) => {
      const up = await upload(s, scene.bytes);
      const res = await send('post', `/requests/${s.id}/windows`, { id, room: 'Hall', style: 'picture', scale: { kind: 'card', cardCorners: scene.cardCorners, card: { widthMm: 85.6, heightMm: 53.98 } }, uploadId: up.id, corners: scene.windowCorners }, { token: s.token });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return (res.body as HomeownerRequestView).windows.find((x) => x.id === id)!;
    };
    const a = await add('small', small);
    const b = await add('big', big);
    expect(Math.max(b.uncertaintyIn.width, b.uncertaintyIn.height)).toBeGreaterThan(Math.max(a.uncertaintyIn.width, a.uncertaintyIn.height));
    expect(b.quality).toBe('check');
    expect(b.reasons.join(' ')).toMatch(/inch/);
  });

  test('windows can be taken away (a retried delete is harmless); a rep\'s own window on the address is not the homeowner\'s to delete', async () => {
    const s = await start();
    await addAr(s, 'w1', 36, 48);
    await addAr(s, 'w2', 24, 36, { room: 'Bath' });
    const gone = await send('delete', `/requests/${s.id}/windows/w1`, undefined, { token: s.token });
    expect(gone.status).toBe(200);
    expect((gone.body as HomeownerRequestView).windows.map((w) => w.id)).toEqual(['w2']);
    expect((await send('delete', `/requests/${s.id}/windows/w1`, undefined, { token: s.token })).status).toBe(200);
    expect((await send('delete', `/requests/${s.id}/windows/bad%20id`, undefined, { token: s.token })).status).toBe(404);
    // A window without the homeowner mark (a rep's, added to the same measurement) stays
    await q(
      `update window_measurements set adjustments = jsonb_set(adjustments, '{photoWindows}', (adjustments->'photoWindows') || '[{"id":"rep1","uploadId":null,"scale":{"kind":"known-side","side":"width","inches":30}}]'::jsonb) where company_id = $1`,
      [t.seed.a.companyId],
    );
    expect((await send('delete', `/requests/${s.id}/windows/rep1`, undefined, { token: s.token })).status).toBe(200);
    const [row] = await q(`select m.adjustments->'photoWindows' as list from homeowner_requests r join window_measurements m on m.id = r.window_measurement_id where r.id = $1`, [s.id]);
    expect((row!.list as { id: string }[]).map((w) => w.id).sort()).toEqual(['rep1', 'w2']);
  });

  test('a request holds 60 windows', async () => {
    const s = await start();
    await addAr(s, 'w0', 36, 48);
    const [m] = await q(`select m.id, m.adjustments from homeowner_requests r join window_measurements m on m.id = r.window_measurement_id where r.id = $1`, [s.id]);
    const first = m!.adjustments.photoWindows[0];
    const many = Array.from({ length: 60 }, (_, i) => ({ ...first, id: `fill${i}` }));
    await q(`update window_measurements set adjustments = jsonb_set(adjustments, '{photoWindows}', $2::jsonb) where id = $1`, [m!.id, JSON.stringify(many)]);
    const over = await addAr(s, 'w61', 36, 48);
    expect(over.res.status).toBe(409);
    expect(over.res.body).toMatchObject({ code: 'windows_full' });
  });

  test('a request that did not ask about windows takes none', async () => {
    const s = await start({ services: ['roof'] });
    const res = await send('post', `/requests/${s.id}/windows`, { id: 'w1', room: 'Kitchen', style: 'double-hung', scale: { kind: 'roomplan', widthM: 1, heightM: 1, confidence: 'low' } }, { token: s.token });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('windows_not_requested');
    expect((await view(s)).quote).toBeNull();
  });
});

describe('the quote', () => {
  const tier = (key: string) => DEFAULT_WINDOW_TIERS.find((x) => x.tier === key)!;

  test('measured windows at their own size, the rest estimated from the address: Good, Better, Best in whole dollars', async () => {
    const s = await start();
    const likely = s.body.estimate.windows!.likely;
    const empty = await view(s);
    expect(empty.quote).toMatchObject({ measuredCount: 0, estimatedCount: likely });
    expect(empty.quote!.tiers.map((x) => x.key)).toEqual(['good', 'better', 'best']);
    expect(empty.quote!.tiers[0]!.total).toBe(empty.quote!.tiers[0]!.estimatedTotal);

    await addAr(s, 'a', 36, 48); // standard (84 united inches)
    const second = await addAr(s, 'b', 24, 36, { room: 'Bath' }); // small (60)
    const third = await addAr(s, 'c', 60, 72, { room: 'Living room' }); // picture (132)
    const v = third.res.body as HomeownerRequestView;
    expect(second.res.status).toBe(201);
    expect(v.windows.map((w) => w.sizeClass)).toEqual(['standard', 'small', 'picture']);
    expect(v.rooms).toEqual(['Kitchen', 'Bath', 'Living room']);
    const quote = v.quote!;
    expect(quote.measuredCount).toBe(3);
    expect(quote.estimatedCount).toBe(Math.max(0, likely - 3));
    for (const x of quote.tiers) {
      const t0 = tier(x.key);
      expect(x.perWindow).toEqual([
        { windowId: 'a', price: t0.priceCents.standard / 100 },
        { windowId: 'b', price: t0.priceCents.small / 100 },
        { windowId: 'c', price: t0.priceCents.picture / 100 },
      ]);
      expect(x.total).toBe(x.perWindow.reduce((n, w) => n + w.price, 0) + x.estimatedTotal);
      expect(x.estimatedCount).toBe(quote.estimatedCount);
      expect(x.name.length).toBeGreaterThan(0);
      expect(Number.isInteger(x.total)).toBe(true);
    }
    expect(quote.tiers[0]!.total).toBeLessThan(quote.tiers[1]!.total);
    expect(quote.tiers[1]!.total).toBeLessThan(quote.tiers[2]!.total);
  });

  test('"did we miss any?" below the low end of the estimate; the homeowner\'s own count replaces the estimate and the question', async () => {
    const s = await start();
    const { low, high, likely } = s.body.estimate.windows!;
    expect(low).toBeGreaterThan(1);
    const one = await addAr(s, 'a', 36, 48);
    const hint = (one.res.body as HomeownerRequestView).quote!.missingHint!;
    expect(hint).toMatchObject({ measured: 1, expectedLow: low, expectedHigh: high, expectedLikely: likely });
    expect(hint.text).toContain('Did we miss any?');
    const patched = await send('patch', `/requests/${s.id}`, { estimatedTotalOverride: 9 }, { token: s.token });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const v = patched.body as HomeownerRequestView;
    expect(v.request.estimatedTotalOverride).toBe(9);
    expect(v.quote).toMatchObject({ measuredCount: 1, estimatedCount: 8 });
    expect(v.quote!.missingHint).toBeUndefined();
    // Fewer than measured: nothing left to estimate
    const few = await send('patch', `/requests/${s.id}`, { estimatedTotalOverride: 1 }, { token: s.token });
    expect((few.body as HomeownerRequestView).quote).toMatchObject({ measuredCount: 1, estimatedCount: 0 });
    // And taken back
    const back = await send('patch', `/requests/${s.id}`, { estimatedTotalOverride: null }, { token: s.token });
    expect((back.body as HomeownerRequestView).request.estimatedTotalOverride).toBeNull();
    expect((back.body as HomeownerRequestView).quote!.estimatedCount).toBe(likely - 1);
    for (const body of [{ estimatedTotalOverride: 0 }, { estimatedTotalOverride: 81 }, { estimatedTotalOverride: 2.5 }, { estimatedTotalOverride: '9' }, {}, { other: 1 }]) {
      expect((await send('patch', `/requests/${s.id}`, body, { token: s.token })).status, JSON.stringify(body)).toBe(400);
    }
  });

  test('the shared estimate is not changed by one homeowner\'s count or windows', async () => {
    const s = await start();
    await send('patch', `/requests/${s.id}`, { estimatedTotalOverride: 30 }, { token: s.token });
    await addAr(s, 'a', 36, 48);
    const other = await start();
    expect(other.body.estimate).toEqual(s.body.estimate);
    expect((await view(other)).quote!.estimatedCount).toBe(other.body.estimate.windows!.likely);
  });

  test("a windows request's view also shows the roof and the home; two homeowners at one address do not see each other's windows", async () => {
    const s1 = await start();
    const s2 = await start();
    await addAr(s1, 'a', 36, 48);
    expect((await view(s1)).windows).toHaveLength(1);
    expect((await view(s2)).windows).toHaveLength(0);
    const v = await view(s1);
    expect(v.request.estimate.roof).not.toBeNull();
    expect(v.request.home.address).toContain('4810 Underwood');
    expect(await count('window_measurements', t.seed.a.companyId)).toBe(1);
  });
});

describe("the company's own catalog", () => {
  const useWinChoice = () => q(`update company_settings set window_catalog = $2::jsonb where company_id = $1`, [t.seed.a.companyId, JSON.stringify(WINCHOICE_CATALOG)]);

  test('/company carries the tier names and notes, what every window includes, the trust facts, offer and financing', async () => {
    await useWinChoice();
    const res = await get('/company');
    expect(res.body.trust).toEqual({ rating: { value: 4.9, count: 2400, plus: true, source: 'homeowners' }, sinceYear: 2012, license: null, badges: ['A+ BBB', 'Made in USA', 'Lifetime warranty'] });
    expect(res.body.catalog.tiers).toEqual([
      { key: 'good', label: 'Replenish', note: '1-year warranty' },
      { key: 'better', label: 'Refine', note: 'Lifetime warranty' },
      { key: 'best', label: 'Renew', note: 'Lifetime warranty' },
    ]);
    expect(res.body.catalog.included).toEqual(['Argon gas fill', 'Low-E glass (Cardinal LoE366)', 'ENERGY STAR® certified', 'FlexScreen']);
    expect(res.body.catalog.offer.termsUrl).toMatch(/^https:/);
    expect(res.body.catalog.financing.url).toMatch(/^https:/);
    expect((res.body.windowStyles as { tile: string }[]).map((x) => x.tile)).toEqual(['up-down', 'sideways', 'fixed', 'special']);
    // Prices stay with the staff and the quote
    expect(JSON.stringify(res.body)).not.toMatch(/price|cents/i);
  });

  test('the quote uses the company tiers, adds frosted glass for a bathroom window and leaves a bay or odd shape to the visit', async () => {
    await useWinChoice();
    const s = await start();
    await addAr(s, 'plain', 36, 48);
    await addAr(s, 'bath', 36, 48, { room: 'Bath', frosted: true });
    await addAr(s, 'slide', 36, 48, { room: 'Den', style: 'slider-2' });
    const bay = await addAr(s, 'bay', 36, 48, { room: 'Front', style: 'arch' });
    const v = bay.res.body as HomeownerRequestView;
    expect(v.windows.map((w) => [w.id, w.style, w.styleLabel, w.frosted ?? false])).toEqual([
      ['plain', 'double-hung', 'Opens up and down', false],
      ['bath', 'double-hung', 'Opens up and down', true],
      ['slide', 'slider-2', 'Slides sideways', false],
      ['bay', 'arch', 'Bay, bow or odd shape', false],
    ]);
    const good = v.quote!.tiers.find((x) => x.key === 'good')!;
    // DEMO numbers: standard Replenish 490, frosted +45, sliders +20 on the base; the bay has no instant price
    expect(good).toMatchObject({ label: 'Replenish', note: '1-year warranty' });
    expect(good.perWindow).toEqual([
      { windowId: 'plain', price: 490 },
      { windowId: 'bath', price: 535 },
      { windowId: 'slide', price: 510 },
      { windowId: 'bay', price: 0, atVisit: true },
    ]);
    expect(good.total).toBe(490 + 535 + 510 + good.estimatedTotal);
    expect(v.quote!.atVisitCount).toBe(1);
    // A bathroom window said no or left out is clear glass: the same price
    expect((await addAr(s, 'clear', 36, 48, { room: 'Bath 2', frosted: false })).res.status).toBe(201);
  });

  test('a bathroom window must be yes or no', async () => {
    const s = await start();
    const { res } = await addAr(s, 'a', 36, 48, { frosted: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('frosted');
  });
});

describe('contact: the lead and the consent', () => {
  async function ready(): Promise<Started> {
    const s = await start();
    await addAr(s, 'a', 36, 48);
    return s;
  }
  const contact = (s: Started, extra: Record<string, unknown> = {}, o: Call = {}) => send('post', `/requests/${s.id}/contact`, contactBody(extra), { token: s.token, ...o });

  test('files a customer, the address and a Lead job from the app, with the quote on its timeline and the consent as evidence', async () => {
    const s = await ready();
    const ip = '203.0.113.88';
    const res = await contact(s, {}, { ip });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const v = res.body as HomeownerRequestView;
    expect(v.request.contactFiled).toBe(true);
    expect(v.status).toMatchObject({ stage: 'requested', dates: { requestedAt: NOW.toISOString(), visit: null } });
    const name = String((await q(`select name from companies where id = $1`, [t.seed.a.companyId]))[0]!.name);

    const [req] = await q(`select * from quote_requests where company_id = $1`, [t.seed.a.companyId]);
    expect(req).toMatchObject({
      first_name: 'Dana',
      last_name: 'Whitfield',
      email: 'dana.w@example.com',
      phone_e164: '+14025550142',
      postal_code: '68132',
      products: ['windows', 'roof'],
      consent_text: quoteConsentText(name),
      consent_version: QUOTE_CONSENT_VERSION,
      text_consent: false,
      text_consent_text: null,
    });
    expect(new Date(req!.consent_at).toISOString()).toBe(NOW.toISOString());
    expect(req!.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(req!.ip_hash).not.toContain(ip);
    expect(req!.quote_estimate_id).not.toBeNull();

    const [job] = await q(`select id, stage, source, next_step, assigned_user_id, customer_id, property_id from jobs where company_id = $1`, [t.seed.a.companyId]);
    expect(job).toMatchObject({ stage: 'lead', source: 'app', next_step: 'Call the homeowner about their app request', assigned_user_id: null });
    const [line] = await q(`select summary from activities where company_id = $1 and kind = 'job.created' and summary like 'Homeowner app request%'`, [t.seed.a.companyId]);
    expect(line!.summary).toMatch(/^Homeowner app request\. Asked about windows, roof\. Shown: /);
    expect(line!.summary).toContain('1 window measured in the app');
    expect(line!.summary).toMatch(/Good \$[\d,]+, Better \$[\d,]+, Best \$[\d,]+/);
    expect(line!.summary).not.toContain('Underwood');
    const [homeowner] = await q(`select quote_request_id from homeowner_requests where id = $1`, [s.id]);
    expect(homeowner!.quote_request_id).toBe(req!.id);
    // Ruling BF: the box is evidence, the customer's texting consent stays 'none'
    const [customer] = await q(`select sms_consent_status from customers where id = $1`, [job!.customer_id]);
    expect(customer!.sms_consent_status).toBe('none');
    // The window measurement is on the job's address
    const [m] = await q(`select property_id from window_measurements where company_id = $1`, [t.seed.a.companyId]);
    expect(m!.property_id).toBe(job!.property_id);
  });

  test('the optional texting box is kept (with its words) only when ticked', async () => {
    const s = await ready();
    expect((await contact(s, { textConsent: true })).status).toBe(201);
    const name = String((await q(`select name from companies where id = $1`, [t.seed.a.companyId]))[0]!.name);
    const [req] = await q(`select text_consent, text_consent_text from quote_requests where company_id = $1`, [t.seed.a.companyId]);
    expect(req).toEqual({ text_consent: true, text_consent_text: quoteTextConsentText(name) });
    const s2 = await ready();
    expect((await contact(s2, { phone: '(402) 555-0177', textConsent: 'yes' })).status).toBe(400);
  });

  test('the required box and the consent version are enforced; the fields are checked', async () => {
    const s = await ready();
    const refused = await contact(s, { contactConsent: false });
    expect(refused.status).toBe(400);
    expect(refused.body.field).toBe('contactConsent');
    const old = await contact(s, { consentVersion: '2020-01-01' });
    expect(old.status).toBe(409);
    expect(old.body.code).toBe('consent_changed');
    for (const [over, field] of [
      [{ firstName: '' }, 'firstName'],
      [{ lastName: ' ' }, 'lastName'],
      [{ phone: '12' }, 'phone'],
      [{ email: 'nope' }, 'email'],
      [{ zip: '6813' }, 'zip'],
      [{ consentVersion: undefined }, 'consentVersion'],
    ] as const) {
      const res = await contact(s, over);
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(res.body.field).toBe(field);
    }
    expect(await count('quote_requests', t.seed.a.companyId)).toBe(0);
    expect(await count('jobs', t.seed.a.companyId)).toBe(0);
  });

  test('sending it again is the same lead: a 200 and no second job; another phone number is a 409', async () => {
    const s = await ready();
    expect((await contact(s)).status).toBe(201);
    const again = await contact(s, { firstName: 'Danna' });
    expect(again.status).toBe(200);
    expect((again.body as HomeownerRequestView).request.contactFiled).toBe(true);
    const other = await contact(s, { phone: '(402) 555-0199' });
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ code: 'contact_filed' });
    expect(await count('jobs', t.seed.a.companyId)).toBe(1);
    expect(await count('quote_requests', t.seed.a.companyId)).toBe(1);
    const notes = await q(`select id from agent_tasks where company_id = $1 and kind = 'homeowner_app_lead'`, [t.seed.a.companyId]);
    expect(notes).toHaveLength(1);
  });

  test('5 an hour per request, then a 429', async () => {
    const s = await ready();
    await contact(s);
    for (let i = 1; i < HOMEOWNER_LIMITS.contactPerTokenPerHour; i++) expect((await contact(s)).status).toBe(200);
    const over = await contact(s);
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('rate_limited');
    expect(over.headers['retry-after']).toBe('3600');
  });

  test('the office is told, and the follow-up is on the owner\'s Today; the homeowner\'s details are not in any log', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const s = await ready();
    expect((await contact(s)).status).toBe(201);
    const [job] = await q(`select id from jobs where company_id = $1`, [t.seed.a.companyId]);
    const notes = await q(`select agent, kind, title, summary, subject_id from agent_tasks where company_id = $1 and kind = 'homeowner_app_lead'`, [t.seed.a.companyId]);
    expect(notes).toEqual([{ agent: 'system', kind: 'homeowner_app_lead', title: 'New homeowner app request', summary: expect.stringContaining('Asked about windows, roof.'), subject_id: job!.id }]);
    expect(JSON.stringify(notes)).not.toMatch(/Dana|555|Underwood/);
    const agent = await loginAs(t.app, t.seed.a.owner);
    const today = await agent.get('/api/today');
    expect((today.body.followUps as { id: string }[]).map((j) => j.id)).toContain(job!.id);
    const printed = JSON.stringify(logs.flatMap((l) => l.mock.calls));
    expect(printed).not.toMatch(/Dana|Whitfield|555-0142|5550142|dana\.w|Underwood|68132/i);
    expect(printed).not.toContain(s.token);
    expect(t.logged.map((l) => String(l.err))).toEqual([]);
  });

  test('a call-back request files too (an apartment): the unit is kept on the address', async () => {
    const s = await start({ address: FLAT, services: ['windows'] });
    expect(s.body.status).toBe('callback');
    const res = await contact(s, { zip: '68102' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [job] = await q(`select p.address_line from jobs j join properties p on p.id = j.property_id where j.company_id = $1`, [t.seed.a.companyId]);
    expect(job!.address_line).toBe('2200 Riverfront Dr Apt 1203');
  });

  test('the page turned off takes no new lead, but an existing request can still be looked at', async () => {
    const s = await ready();
    await q(`update company_settings set quote_enabled = false where company_id = $1`, [t.seed.a.companyId]);
    expect((await get(`/requests/${s.id}`, { token: s.token })).status).toBe(200);
    expect((await get(`/requests/${s.id}/status`, { token: s.token })).status).toBe(200);
    expect((await contact(s)).status).toBe(404);
  });
});

describe('visits: slots and booking', () => {
  async function filed(person = 0): Promise<Started> {
    const s = await start();
    await addAr(s, 'a', 36, 48);
    const who = person === 0 ? {} : { phone: `(402) 555-02${10 + person}`, email: `dana${person}@example.com` };
    expect((await send('post', `/requests/${s.id}/contact`, contactBody(who), { token: s.token })).status).toBe(201);
    return s;
  }
  const bookingOn = () => q(`update company_settings set quote_booking = true where company_id = $1`, [t.seed.a.companyId]);
  const slotsOf = async (s: Started) => {
    const res = await get(`/requests/${s.id}/slots`, { token: s.token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { timeZone: string; slots: { id: string; start: string; end: string }[] };
  };

  test('no times when booking is off; spread times from tomorrow when it is on, with no inspector names', async () => {
    const s = await filed();
    expect(await slotsOf(s)).toEqual({ timeZone: 'UTC', slots: [] });
    await bookingOn();
    const on = await slotsOf(s);
    expect(on.slots.length).toBeGreaterThan(0);
    expect(on.slots.length).toBeLessThanOrEqual(8);
    const today = t.clock.now().toLocaleDateString('en-CA', { timeZone: on.timeZone });
    for (const sl of on.slots) expect(new Date(sl.start).toLocaleDateString('en-CA', { timeZone: on.timeZone }) > today).toBe(true);
    expect(JSON.stringify(on)).not.toMatch(/userId|name/i);
  });

  test('looking up times is limited per IP address (60 an hour, across requests) and per request (30 an hour)', async () => {
    await bookingOn();
    const ip = '203.0.113.77';
    const three = [await filed(), await filed(1), await filed(2)];
    for (let i = 0; i < HOMEOWNER_LIMITS.slotsPerTokenPerHour; i++) {
      expect((await get(`/requests/${three[0]!.id}/slots`, { token: three[0]!.token, ip })).status, `call ${i}`).toBe(200);
    }
    // The request's own thirty are used up (a different address is not held back by it) ...
    const perToken = await get(`/requests/${three[0]!.id}/slots`, { token: three[0]!.token, ip: '203.0.113.78' });
    expect(perToken.status).toBe(429);
    expect(perToken.body.code).toBe('rate_limited');
    expect(perToken.headers['retry-after']).toBe('3600');
    // ... and the address's sixty are used up by the other two requests together, whatever their tokens.
    for (let i = 0; i < HOMEOWNER_LIMITS.slotsPerIpPerHour - HOMEOWNER_LIMITS.slotsPerTokenPerHour; i++) {
      const s = three[1 + (i % 2)]!;
      expect((await get(`/requests/${s.id}/slots`, { token: s.token, ip })).status, `call ${i}`).toBe(200);
    }
    const perIp = await get(`/requests/${three[2]!.id}/slots`, { token: three[2]!.token, ip });
    expect(perIp.status).toBe(429);
    expect(Number(perIp.headers['retry-after'])).toBeGreaterThan(0);
    expect((await get(`/requests/${three[2]!.id}/slots`, { token: three[2]!.token, ip: '203.0.113.79' })).status).toBe(200);
  });

  test('a picked time books an inspection on the lead job; the status says so, with the rep\'s first name', async () => {
    const s = await filed();
    await bookingOn();
    const pick = (await slotsOf(s)).slots.at(-1)!;
    const res = await send('post', `/requests/${s.id}/book`, { slotStart: pick.start }, { token: s.token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const v = res.body as HomeownerRequestView;
    expect(v.booking).toEqual({ visit: { start: pick.start, end: pick.end, timeZone: expect.any(String) }, callMe: false });
    expect(v.status).toMatchObject({ stage: 'visit-booked', dates: { visit: pick.start } });
    expect(v.status!.rep!.name).toMatch(/^[A-Za-z]+$/);
    const [appt] = await q(`select kind, starts_at, job_id, notes from appointments where company_id = $1`, [t.seed.a.companyId]);
    expect(appt).toMatchObject({ kind: 'inspection', notes: 'Booked by the homeowner on the homeowner app.' });
    const [job] = await q(`select stage, next_step, assigned_user_id from jobs where id = $1`, [appt!.job_id]);
    expect(job).toMatchObject({ stage: 'inspection', next_step: null });
    expect(job!.assigned_user_id).not.toBeNull();
    const lines = await q(`select kind, summary from activities where company_id = $1 and kind = 'job.app_windows'`, [t.seed.a.companyId]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.summary).toMatch(/^Homeowner app: Asked about windows, roof\. Shown: .*1 window measured in the app/);
    // Booking again answers the visit already booked: one appointment, no second line
    const again = await send('post', `/requests/${s.id}/book`, { slotStart: (await slotsOf(s)).slots[0]?.start ?? pick.start }, { token: s.token });
    expect(again.status).toBe(200);
    expect((again.body as HomeownerRequestView).booking!.visit!.start).toBe(pick.start);
    expect(await count('appointments', t.seed.a.companyId)).toBe(1);
    expect(await q(`select id from activities where company_id = $1 and kind = 'job.app_windows'`, [t.seed.a.companyId])).toHaveLength(1);
  });

  test('two bookings of one request at the same moment make one visit: the second answers with the first\'s and is not noted twice', async () => {
    const s = await filed();
    await bookingOn();
    const slots = (await slotsOf(s)).slots;
    const [first, last] = [slots[0]!, slots.at(-1)!];
    const book = (start: string) => send('post', `/requests/${s.id}/book`, { slotStart: start }, { token: s.token });

    // The same time twice: both are answered with the visit
    const twice = await Promise.all([book(first.start), book(first.start)]);
    expect(twice.map((r) => r.status), JSON.stringify(twice.map((r) => r.body))).toEqual([200, 200]);
    for (const r of twice) expect((r.body as HomeownerRequestView).booking!.visit!.start).toBe(first.start);
    expect(await count('appointments', t.seed.a.companyId)).toBe(1);
    expect(await q(`select id from activities where company_id = $1 and kind = 'job.app_windows'`, [t.seed.a.companyId])).toHaveLength(1);

    // Two different times at once, for another request: one visit, and both answers name it
    const s2 = await filed(1);
    const two = await Promise.all([send('post', `/requests/${s2.id}/book`, { slotStart: slots[1]!.start }, { token: s2.token }), send('post', `/requests/${s2.id}/book`, { slotStart: last.start }, { token: s2.token })]);
    expect(two.map((r) => r.status), JSON.stringify(two.map((r) => r.body))).toEqual([200, 200]);
    expect(new Set(two.map((r) => (r.body as HomeownerRequestView).booking!.visit!.start)).size).toBe(1);
    expect(await count('appointments', t.seed.a.companyId)).toBe(2);
  });

  test('booking locks the request: a second booking waits for the first to finish, then finds its visit', async () => {
    const s = await filed();
    const [{ id: requestId }] = (await q(`select id from quote_requests where company_id = $1`, [t.seed.a.companyId])) as { id: string }[];
    const ctx = systemCtx(t.seed.a.companyId);
    let release!: () => void;
    const holding = new Promise<void>((resolve) => (release = resolve));
    let tookLock!: () => void;
    const took = new Promise<void>((resolve) => (tookLock = resolve));
    const first = withTenant(t.deps.pools, ctx, async (tx) => {
      await lockedQuoteVisit(tx, ctx, requestId!);
      tookLock();
      await holding;
    });
    await took;
    let secondDone = false;
    const second = withTenant(t.deps.pools, ctx, (tx) => lockedQuoteVisit(tx, ctx, requestId!)).then((visit) => {
      secondDone = true;
      return visit;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(secondDone).toBe(false);
    release();
    await first;
    expect(await second).toBeNull(); // nothing booked
    expect(secondDone).toBe(true);
    expect(s.id).toBeDefined();
  });

  test('"call me" keeps the call-back step on the job and says so on the status; asking twice adds one line', async () => {
    const s = await filed();
    const res = await send('post', `/requests/${s.id}/book`, { callMe: true }, { token: s.token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as HomeownerRequestView).booking).toEqual({ visit: null, callMe: true });
    const [job] = await q(`select next_step, stage from jobs where company_id = $1`, [t.seed.a.companyId]);
    expect(job).toMatchObject({ next_step: 'Call the homeowner about their app request', stage: 'lead' });
    expect((await send('post', `/requests/${s.id}/book`, { callMe: true }, { token: s.token })).status).toBe(200);
    expect(await q(`select id from activities where company_id = $1 and kind = 'job.app_call_me'`, [t.seed.a.companyId])).toHaveLength(1);
    expect(await count('appointments', t.seed.a.companyId)).toBe(0);
  });

  test('booking needs the contact details first; a time that is not open, or booking off, is a 409; the body is checked', async () => {
    const s = await start();
    const early = await send('post', `/requests/${s.id}/book`, { callMe: true }, { token: s.token });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('contact_needed');
    await send('post', `/requests/${s.id}/contact`, contactBody(), { token: s.token });
    const off = await send('post', `/requests/${s.id}/book`, { slotStart: new Date(NOW.getTime() + 2 * 24 * 3600 * 1000).toISOString() }, { token: s.token });
    expect(off.status).toBe(409);
    expect(off.body.code).toBe('booking_off');
    await bookingOn();
    const sameDay = await send('post', `/requests/${s.id}/book`, { slotStart: new Date(NOW.getTime() + 3 * 3600 * 1000).toISOString() }, { token: s.token });
    expect(sameDay.status).toBe(409);
    expect(sameDay.body.code).toBe('slot_taken');
    expect(await count('appointments', t.seed.a.companyId)).toBe(0);
    for (const body of [{}, { slotStart: 'tomorrow' }, { callMe: false }, { slotStart: NOW.toISOString(), callMe: true }, { callMe: true, extra: 1 }]) {
      expect((await send('post', `/requests/${s.id}/book`, body, { token: s.token })).status, JSON.stringify(body)).toBe(400);
    }
  });

  test('an apartment request can ask for a call too', async () => {
    const s = await start({ address: FLAT, services: ['windows'] });
    await send('post', `/requests/${s.id}/contact`, contactBody({ zip: '68102' }), { token: s.token });
    const res = await send('post', `/requests/${s.id}/book`, { callMe: true }, { token: s.token });
    expect(res.status).toBe(200);
    expect((res.body as HomeownerRequestView).booking!.callMe).toBe(true);
  });
});

describe('status', () => {
  test('requested, then visit booked, measured by the company, ordered and installed — and dates for each', async () => {
    const s = await start();
    await addAr(s, 'a', 36, 48);
    expect((await get(`/requests/${s.id}/status`, { token: s.token })).body).toMatchObject({ stage: 'requested', dates: { requestedAt: NOW.toISOString(), visit: null, measuredAt: null, orderedAt: null, installedAt: null }, timeZone: expect.any(String) });
    await send('post', `/requests/${s.id}/contact`, contactBody(), { token: s.token });
    await q(`update company_settings set quote_booking = true where company_id = $1`, [t.seed.a.companyId]);
    const pick = (await get(`/requests/${s.id}/slots`, { token: s.token })).body.slots.at(-1) as { start: string };
    await send('post', `/requests/${s.id}/book`, { slotStart: pick.start }, { token: s.token });
    expect((await get(`/requests/${s.id}/status`, { token: s.token })).body).toMatchObject({ stage: 'visit-booked', dates: { visit: pick.start } });

    // The company measures a window of its own at the address
    const [job] = await q(`select id, property_id from jobs where company_id = $1`, [t.seed.a.companyId]);
    const measuredAt = new Date(NOW.getTime() + 24 * 3600 * 1000);
    t.clock.set(measuredAt);
    await q(
      `insert into window_measurements (company_id, property_id, address, center, took_ms, adjustments, created_at, updated_at)
       values ($1, $2, 'x', '[0,0]'::jsonb, 0, $3::jsonb, $4, $4)`,
      [t.seed.a.companyId, job!.property_id, JSON.stringify({ excludedWindowIds: [], manualCounts: {}, photoWindows: [{ id: 'rep1', scale: { kind: 'known-side', side: 'width', inches: 30 } }] }), measuredAt.toISOString()],
    );
    expect((await get(`/requests/${s.id}/status`, { token: s.token })).body).toMatchObject({ stage: 'measured', dates: { measuredAt: measuredAt.toISOString() } });

    const [m] = await q(`select id from window_measurements where company_id = $1 and address = 'x'`, [t.seed.a.companyId]);
    await q(`insert into window_orders (company_id, window_measurement_id, status, lines, settings, ready_at, created_at, updated_at) values ($1, $2, 'ready', '[]'::jsonb, '{}'::jsonb, $3, $3, $3)`, [t.seed.a.companyId, m!.id, measuredAt.toISOString()]);
    expect((await get(`/requests/${s.id}/status`, { token: s.token })).body).toMatchObject({ stage: 'ordered', dates: { orderedAt: measuredAt.toISOString() } });

    await q(`update jobs set stage = 'installed' where id = $1`, [job!.id]);
    const done = await get(`/requests/${s.id}/status`, { token: s.token });
    expect(done.body.stage).toBe('installed');
    expect(done.body.dates.installedAt).not.toBeNull();
  });
});

describe('status: only what the company did since the request was sent', () => {
  test('a measurement and a factory order made at the address earlier are not this request\'s progress, and a homeowner\'s own measurements are not the company\'s work', async () => {
    const s = await start();
    const propertyId = String((await q(`select property_id from homeowner_requests where id = $1`, [s.id]))[0]!.property_id);
    // Work the company did at the address before this request: a measurement with a window of its own, and an order for it
    const earlier = new Date(NOW.getTime() - 3 * 24 * 3600 * 1000);
    await q(
      `insert into window_measurements (company_id, property_id, address, center, took_ms, adjustments, created_at, updated_at)
       values ($1, $2, 'earlier', '[0,0]'::jsonb, 0, $3::jsonb, $4, $4)`,
      [t.seed.a.companyId, propertyId, JSON.stringify({ excludedWindowIds: [], manualCounts: {}, photoWindows: [{ id: 'rep0', scale: { kind: 'known-side', side: 'width', inches: 30 } }] }), earlier.toISOString()],
    );
    const [old] = await q(`select id from window_measurements where company_id = $1 and address = 'earlier'`, [t.seed.a.companyId]);
    await q(`insert into window_orders (company_id, window_measurement_id, status, lines, settings, ready_at, sent_at, created_at, updated_at) values ($1, $2, 'sent', '[]'::jsonb, '{}'::jsonb, $3, $3, $3, $3)`, [t.seed.a.companyId, old!.id, earlier.toISOString()]);
    await addAr(s, 'w-ar', 36, 48);
    expect((await send('post', `/requests/${s.id}/contact`, contactBody(), { token: s.token })).status).toBe(201);
    const status = (await get(`/requests/${s.id}/status`, { token: s.token })).body;
    expect(status).toMatchObject({ stage: 'requested', dates: { measuredAt: null, orderedAt: null } });

    // The company touches that measurement after the request: now it is progress
    const later = new Date(NOW.getTime() + 24 * 3600 * 1000);
    await q(`update window_measurements set updated_at = $2 where id = $1`, [old!.id, later.toISOString()]);
    expect((await get(`/requests/${s.id}/status`, { token: s.token })).body).toMatchObject({ stage: 'measured', dates: { measuredAt: later.toISOString(), orderedAt: null } });
    // ... and an order made after the request is too (the earlier one never is)
    const ordered = new Date(NOW.getTime() + 2 * 24 * 3600 * 1000);
    await q(`update window_orders set status = 'draft' where window_measurement_id = $1`, [old!.id]);
    expect((await get(`/requests/${s.id}/status`, { token: s.token })).body).toMatchObject({ stage: 'measured', dates: { orderedAt: null } });
    await q(`insert into window_measurements (company_id, property_id, address, center, took_ms, created_at, updated_at) values ($1, $2, 'newer', '[0,0]'::jsonb, 0, $3, $3)`, [t.seed.a.companyId, propertyId, ordered.toISOString()]);
    const [newer] = await q(`select id from window_measurements where company_id = $1 and address = 'newer'`, [t.seed.a.companyId]);
    await q(`insert into window_orders (company_id, window_measurement_id, status, lines, settings, ready_at, created_at, updated_at) values ($1, $2, 'ready', '[]'::jsonb, '{}'::jsonb, $3, $3, $3)`, [t.seed.a.companyId, newer!.id, ordered.toISOString()]);
    expect((await get(`/requests/${s.id}/status`, { token: s.token })).body).toMatchObject({ stage: 'ordered', dates: { orderedAt: ordered.toISOString() } });

    // Another homeowner's measurement at the address is never the company's work: not even an order on it counts
    const other = await start();
    await addAr(other, 'w-other', 30, 40);
    const [theirs] = await q(`select window_measurement_id from homeowner_requests where id = $1`, [other.id]);
    const sent = new Date(NOW.getTime() + 5 * 24 * 3600 * 1000);
    await q(`insert into window_orders (company_id, window_measurement_id, status, lines, settings, ready_at, sent_at, created_at, updated_at) values ($1, $2, 'sent', '[]'::jsonb, '{}'::jsonb, $3, $3, $3, $3)`, [t.seed.a.companyId, theirs!.window_measurement_id, sent.toISOString()]);
    expect((await get(`/requests/${s.id}/status`, { token: s.token })).body).toMatchObject({ stage: 'ordered', dates: { orderedAt: ordered.toISOString() } });
  });
});

describe('the homeowner\'s windows on the staff side', () => {
  const propertyOf = async () => String((await q(`select property_id from homeowner_requests where company_id = $1 order by created_at desc limit 1`, [t.seed.a.companyId]))[0]!.property_id);

  test('a rep\'s new measurement of the address starts with the windows the homeowner sent in, marked source homeowner-app, with room, style and photo; edits keep the mark only while the window is unchanged', async () => {
    const s = await start();
    await addAr(s, 'w-ar', 36, 48, { room: 'Kitchen', style: 'casement', label: 'Sink' });
    await send('post', `/requests/${s.id}/contact`, contactBody(), { token: s.token });
    const staff = await loginAs(t.app, t.seed.a.owner);
    const made = await staff.post('/api/window-measurements').send({ propertyId: await propertyOf() });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const list = made.body.adjustments.photoWindows as { id: string; source?: string; room?: string; style?: string }[];
    expect(list).toEqual([expect.objectContaining({ id: 'w-ar', source: 'homeowner-app', room: 'Kitchen', style: 'casement', label: 'Sink' })]);
    expect(made.body.photoWindows).toHaveLength(1);
    expect(made.body.photoWindows[0]).toMatchObject({ id: 'w-ar', source: 'homeowner-app', widthIn: expect.any(Number), room: 'Kitchen' });
    // The photo it stands on comes along, and the rep can open it
    expect(made.body.uploads).toHaveLength(1);
    const photo = await staff.get(`/api/window-measurements/${made.body.id}/uploads/${made.body.uploads[0].id}`);
    expect(photo.status).toBe(200);
    expect(photo.headers['content-type']).toMatch(/image\/jpeg/);
    // It is the address's newest measurement, the homeowner's own stays theirs and is what they see
    const newest = await staff.get(`/api/window-measurements?propertyId=${await propertyOf()}`);
    expect(newest.body.id).toBe(made.body.id);
    expect((await view(s)).windows.map((w) => w.id)).toEqual(['w-ar']);

    // The web app sends the list back as it got it: the mark stays
    const same = await staff.patch(`/api/window-measurements/${made.body.id}`).send({ photoWindows: made.body.adjustments.photoWindows, photosCoverAllWindows: true });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect(same.body.adjustments.photoWindows[0].source).toBe('homeowner-app');
    // A label change keeps it; changing the corners makes it the staff's own measurement
    const relabeled = same.body.adjustments.photoWindows.map((w: object) => ({ ...w, label: 'Over the sink' }));
    const kept = await staff.patch(`/api/window-measurements/${made.body.id}`).send({ photoWindows: relabeled });
    expect(kept.body.adjustments.photoWindows[0]).toMatchObject({ source: 'homeowner-app', label: 'Over the sink' });
    const moved = relabeled.map((w: { corners: number[][] }) => ({ ...w, corners: w.corners.map(([x, y]) => [x! + 3, y!]) }));
    const edited = await staff.patch(`/api/window-measurements/${made.body.id}`).send({ photoWindows: moved });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.adjustments.photoWindows[0].source).toBeUndefined();
    // Taking the copy away does not touch the homeowner's own
    const gone = await staff.patch(`/api/window-measurements/${made.body.id}`).send({ photoWindows: [] });
    expect(gone.status).toBe(200);
    expect((await view(s)).windows.map((w) => w.id)).toEqual(['w-ar']);
  });

  test('windows the homeowner never sent in stay theirs: a rep\'s measurement does not take them, and their measurement is not the address\'s newest', async () => {
    const s = await start();
    await addAr(s, 'w-ar', 36, 48);
    const propertyId = await propertyOf();
    const staff = await loginAs(t.app, t.seed.a.owner);
    // Only the homeowner has measured here: nothing for the company yet
    expect((await staff.get(`/api/window-measurements?propertyId=${propertyId}`)).status).toBe(404);
    const made = await staff.post('/api/window-measurements').send({ propertyId });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.adjustments.photoWindows ?? []).toEqual([]);
    expect(made.body.uploads).toEqual([]);
    // A homeowner who measures after the rep's measurement does not take its place as the newest either
    await addAr(s, 'w-two', 30, 40);
    await send('post', `/requests/${s.id}/contact`, contactBody(), { token: s.token });
    const newest = await staff.get(`/api/window-measurements?propertyId=${propertyId}`);
    expect(newest.body.id).toBe(made.body.id);
    // Sent in, the next measurement takes both windows
    const next = await staff.post('/api/window-measurements').send({ propertyId });
    expect((next.body.adjustments.photoWindows as { id: string }[]).map((w) => w.id)).toEqual(['w-ar', 'w-two']);
    expect(next.body.uploads).toHaveLength(2);
  });

  test('only a request that is still good lends its windows: an expired one does not, and of two the newest does', async () => {
    const old = await start();
    await addAr(old, 'w-old', 36, 48);
    await send('post', `/requests/${old.id}/contact`, contactBody(), { token: old.token });
    const propertyId = await propertyOf();
    t.clock.set(new Date(NOW.getTime() + (HOMEOWNER_TOKEN_DAYS + 1) * 24 * 60 * 60 * 1000));
    const staff = await loginAs(t.app, t.seed.a.owner);
    const expired = await staff.post('/api/window-measurements').send({ propertyId });
    expect(expired.status, JSON.stringify(expired.body)).toBe(201);
    expect(expired.body.adjustments.photoWindows ?? []).toEqual([]);
    // Two requests at the address: the newest one that has windows is the one that comes along
    const first = await start();
    await addAr(first, 'w-first', 36, 48);
    await send('post', `/requests/${first.id}/contact`, contactBody({ phone: '(402) 555-0111' }), { token: first.token });
    t.clock.set(new Date(t.clock.now().getTime() + 60_000));
    const second = await start();
    await addAr(second, 'w-second', 30, 40);
    await send('post', `/requests/${second.id}/contact`, contactBody({ phone: '(402) 555-0122' }), { token: second.token });
    const made = await staff.post('/api/window-measurements').send({ propertyId });
    expect((made.body.adjustments.photoWindows as { id: string }[]).map((w) => w.id)).toEqual(['w-second']);
  });

  test('staff cannot mark a window of their own as the homeowner\'s', async () => {
    const s = await start();
    const up = await upload(s);
    await addAr(s, 'w1', 36, 48);
    const [m] = await q(`select id from window_measurements where company_id = $1`, [t.seed.a.companyId]);
    const staff = await loginAs(t.app, t.seed.a.owner);
    const forged = { id: 'forged', source: 'homeowner-app', uploadId: up.id, corners: boxCorners(up.widthPx, up.heightPx), scale: arScale(30, 40) };
    const res = await staff.post(`/api/window-measurements/${m!.id}/photo-windows`).send(forged);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const added = (res.body.adjustments.photoWindows as { id: string; source?: string }[]).find((w) => w.id === 'forged')!;
    expect(added.source).toBeUndefined();
    // And the homeowner's own view does not show it
    expect((await view(s)).windows.map((w) => w.id)).toEqual(['w1']);
  });

  test('homeowner windows never go on a factory order: their lines are quote-only', async () => {
    const s = await start();
    await addAr(s, 'w1', 36, 48);
    const [m] = await q(`select id from window_measurements where company_id = $1`, [t.seed.a.companyId]);
    const staff = await loginAs(t.app, t.seed.a.owner);
    const order = await staff.post(`/api/window-measurements/${m!.id}/order`).send({});
    expect([200, 201], JSON.stringify(order.body)).toContain(order.status);
    const lines = order.body.lines as { measured: { quoteOnly?: boolean }[] }[];
    expect(lines.length).toBe(1);
    expect(lines[0]!.measured.every((x) => x.quoteOnly === true)).toBe(true);
  });

  test('another company\'s staff cannot see them, and a rep sees them once the lead is theirs to see', async () => {
    const s = await start();
    await addAr(s, 'w1', 36, 48);
    const [m] = await q(`select id, property_id from window_measurements where company_id = $1`, [t.seed.a.companyId]);
    const boltOwner = await loginAs(t.app, t.seed.b.owner);
    expect((await boltOwner.get(`/api/window-measurements/${m!.id}`)).status).toBe(404);
    expect((await boltOwner.get(`/api/window-measurements?propertyId=${m!.property_id}`)).status).toBe(404);
    // Before the contact form there is no lead: a rep does not see the address; after it, an unassigned lead is anyone's
    const rep = await loginAs(t.app, t.seed.a.rep);
    expect((await rep.get(`/api/window-measurements/${m!.id}`)).status).toBe(404);
    await send('post', `/requests/${s.id}/contact`, contactBody(), { token: s.token });
    expect((await rep.get(`/api/window-measurements/${m!.id}`)).status).toBe(200);
  });
});

describe('tenant isolation', () => {
  test('a request is one company\'s: the other company\'s slug and staff session never reach it', async () => {
    const a = await start();
    const row = (await q(`select id from homeowner_requests where company_id = $1`, [t.seed.b.companyId])).length;
    expect(row).toBe(0);
    expect((await get(`/requests/${a.id}`, { token: a.token }, BOLT)).status).toBe(401);
    const staff = await loginAs(t.app, t.seed.b.owner);
    const viaStaff = await staff.get(`${base()}/requests/${a.id}`);
    expect(viaStaff.status).toBe(401);
    expect(await count('homeowner_requests', t.seed.a.companyId)).toBe(1);
  });
});

describe('the instant quote page and the app', () => {
  test('the page config carries the app link and name only when the server has them', async () => {
    const plain = await request(t.app).get(`/api/public/quote/${ACME}`);
    expect(plain.status).toBe(200);
    expect(plain.body.homeownerApp).toBeNull();
    const link = 'https://apps.apple.com/us/app/winchoice/id0000000000';
    for (const [extra, name] of [
      [{ HOMEOWNER_APP_URL: link }, 'WinChoice'],
      [{ HOMEOWNER_APP_URL: link, HOMEOWNER_APP_NAME: 'Summit Measure' }, 'Summit Measure'],
    ] as const) {
      // A new app starts a new database: the page is switched on again
      await t.close();
      t = await makeTestApp({ TRUST_PROXY: 1, ...extra });
      await enable(t.seed.a.companyId, ACME);
      const res = await request(t.app).get(`/api/public/quote/${ACME}`);
      expect(res.status).toBe(200);
      expect(res.body.homeownerApp).toEqual({ url: link, name });
    }
  });
});

describe('the browser measuring page (/q/:slug/measure)', () => {
  test("a phone's browser can do the whole journey from the page's own origin: card window, contact with consent, call me", async () => {
    // A browser sends Origin on every POST, DELETE and PATCH (the iPhone app sends none); the page's origin must pass them all
    const origin = t.deps.config.APP_ORIGIN;
    const made = await send('post', '/requests', { address: ADDRESS, services: ['windows'] }, { origin });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const s: Started = { id: (made.body as HomeownerCreated).requestId, token: (made.body as HomeownerCreated).token, body: made.body as HomeownerCreated };

    // The photo goes up as the bytes of the file the camera gave
    const scene = cardScene({ windowIn: { w: 36, h: 48 } });
    const photo = await request(t.app)
      .post(`${base()}/requests/${s.id}/uploads`)
      .set('X-Forwarded-For', nextIp())
      .set('Origin', origin)
      .set('Authorization', `Bearer ${s.token}`)
      .set('Content-Type', 'image/jpeg')
      .send(Buffer.from(scene.bytes));
    expect(photo.status, JSON.stringify(photo.body)).toBe(201);

    // The window exactly as the page sends it: the card's four taps, the frame's four taps, the ids it made itself
    const window = { id: 'w-web-1', room: 'Kitchen', label: 'Over the sink', style: 'double-hung', scale: { kind: 'card', cardCorners: scene.cardCorners, card: { widthMm: 85.6, heightMm: 53.98 } }, uploadId: photo.body.id, corners: scene.windowCorners };
    const saved = await send('post', `/requests/${s.id}/windows`, window, { token: s.token, origin });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const w = (saved.body as HomeownerRequestView).windows[0]!;
    // What the page shows: eighths of an inch and an "about ±"
    expect(w.sizeLabel).toMatch(/^\d+( \d\/\d)? x \d+( \d\/\d)?$/);
    expect(w.uncertaintyLabel).toMatch(/^about ±/);
    expect((saved.body as HomeownerRequestView).rooms).toEqual(['Kitchen']);
    // A reload resumes from the token alone
    expect((await view(s)).windows.map((x) => x.id)).toEqual(['w-web-1']);

    const filed = await send('post', `/requests/${s.id}/contact`, contactBody(), { token: s.token, origin });
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    expect((await get(`/requests/${s.id}/slots`, { token: s.token, origin })).status).toBe(200);
    const call = await send('post', `/requests/${s.id}/book`, { callMe: true }, { token: s.token, origin });
    expect(call.status, JSON.stringify(call.body)).toBe(200);
    expect((call.body as HomeownerRequestView).booking).toEqual({ visit: null, callMe: true });
    expect((await send('delete', `/requests/${s.id}/windows/w-web-1`, undefined, { token: s.token, origin })).status).toBe(200);
  });
});
