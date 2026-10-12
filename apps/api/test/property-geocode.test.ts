import { beforeEach, describe, expect, test } from 'vitest';
import { Actors, addressFor, dbProperty, mustCreate, NO_UUID, NOT_FOUND } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const NOT_LOCATED = "We couldn't find that address. Check the street, city and state.";
const MAP_UNAVAILABLE = "We couldn't reach the map service. Try again in a minute.";

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(new Date('2026-10-12T15:00:00.000Z'));
});

const A = () => t.seed.a.companyId;
const FARNAM = { addressLine: '1200 Farnam St', city: 'Omaha', state: 'NE', zip: '68102' };
const NOWHERE = { addressLine: '1 Nowhere Rd', city: 'Omaha', state: 'NE', zip: '68102' };

describe('geocoding a new home on save', () => {
  test('a new home at 1200 Farnam St gets a point and the Chicago zone', async () => {
    const owner = await who.as('owner');
    const res = await owner.post('/api/properties').send(FARNAM);
    expect(res.status).toBe(201);
    expect(typeof res.body.lat).toBe('number');
    expect(typeof res.body.lng).toBe('number');
    expect(res.body.timezone).toBe('America/Chicago');

    const row = await dbProperty(t, A(), res.body.id);
    expect(row.geom).toEqual([res.body.lng, res.body.lat]);
    expect(row.timezone).toBe('America/Chicago');
    expect(t.geocoder.calls.length).toBeGreaterThan(0);
  });

  test('1 Nowhere Rd is saved without a point', async () => {
    const owner = await who.as('owner');
    const res = await owner.post('/api/properties').send(NOWHERE);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ addressLine: '1 Nowhere Rd', lat: null, lng: null, timezone: null });
    const row = await dbProperty(t, A(), res.body.id);
    expect(row.geom).toBeNull();
  });

  test('a failing lookup still saves the address', async () => {
    const owner = await who.as('owner');
    t.geocoder.failNext();
    const res = await owner.post('/api/properties').send(addressFor(30));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ addressLine: '130 Oak St', lat: null, lng: null });
    expect((await owner.get(`/api/properties/${res.body.id}`)).body).toMatchObject({ lat: null, lng: null });
  });

  test('caller-supplied lat/lng skips the lookup', async () => {
    const owner = await who.as('owner');
    const before = t.geocoder.calls.length;
    const res = await owner.post('/api/properties').send({ ...FARNAM, lat: 41.2565, lng: -95.9345 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ lat: 41.2565, lng: -95.9345 });
    expect(t.geocoder.calls.length).toBe(before);
  });
});

describe('locating an existing home', () => {
  test('locate 200: a home saved without a point gets one, and GET shows it', async () => {
    const owner = await who.as('owner');
    t.geocoder.failNext();
    const home = await mustCreate(owner, '/api/properties', FARNAM);
    expect(home).toMatchObject({ lat: null, lng: null });

    const res = await owner.post(`/api/properties/${home.id}/locate`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ located: true });

    const got = await owner.get(`/api/properties/${home.id}`);
    expect(got.body.lat).toEqual(expect.any(Number));
    expect(got.body.lng).toEqual(expect.any(Number));
    expect(got.body.timezone).toBe('America/Chicago');
  });

  test('locate 400: an address the map cannot find names addressLine', async () => {
    const owner = await who.as('owner');
    const home = await mustCreate(owner, '/api/properties', NOWHERE);
    const res = await owner.post(`/api/properties/${home.id}/locate`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: NOT_LOCATED, field: 'addressLine' });
    expect((await owner.get(`/api/properties/${home.id}`)).body).toMatchObject({ lat: null, lng: null });
  });

  test('locate 503: the map service is down, and nothing changes', async () => {
    const owner = await who.as('owner');
    t.geocoder.failNext();
    const home = await mustCreate(owner, '/api/properties', FARNAM);
    t.geocoder.failNext(1);
    const res = await owner.post(`/api/properties/${home.id}/locate`);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: MAP_UNAVAILABLE });
    expect((await owner.get(`/api/properties/${home.id}`)).body).toMatchObject({ lat: null, lng: null });
  });

  test('company B gets 404', async () => {
    const owner = await who.as('owner');
    const home = await mustCreate(owner, '/api/properties', FARNAM);
    const res = await (await who.as('owner', 'b')).post(`/api/properties/${home.id}/locate`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_FOUND });
    const missing = await owner.post(`/api/properties/${NO_UUID}/locate`);
    expect(missing.status).toBe(404);
  });

  test('a rep who cannot see the home gets 404', async () => {
    const owner = await who.as('owner');
    const rep = await who.as('rep');
    const home = await mustCreate(owner, '/api/properties', FARNAM);
    const res = await rep.post(`/api/properties/${home.id}/locate`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_FOUND });
  });
});
