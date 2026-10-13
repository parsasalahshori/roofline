import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import { UnconfiguredPropertyData } from '../src/providers/property-data.ts';
import { UnconfiguredStreetImagery } from '../src/providers/street-imagery.ts';
import { Actors, mustCreate, NO_UUID, NOT_FOUND } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

/* `GET /api/properties/:id/record`: the home's public owner and parcel record and a street photo, live from the fakes. */

const UNAVAILABLE = "We couldn't reach the property records service. Try again in a minute.";

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(new Date('2026-10-13T15:00:00.000Z'));
});

const HOME = { addressLine: '123 Example Ln', city: 'Faketown', state: 'AR', zip: '72999', lat: 34.74995, lng: -92.2999 };
const PHOTO = {
  id: '1000000000000002',
  thumbUrl: 'https://scontent.example.fbcdn.net/nearest.jpg',
  capturedAt: '2024-06-01T00:00:00.000Z',
  pageUrl: 'https://www.mapillary.com/app/?pKey=1000000000000002',
};

describe('the owner record of a home', () => {
  test('answers the record for the point and address of the home, and the nearest street photo', async () => {
    const owner = await who.as('owner');
    const home = await mustCreate(owner, '/api/properties', HOME);
    t.streetImagery.image = PHOTO;

    const res = await owner.get(`/api/properties/${home.id}/record`);

    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.record).toMatchObject({ source: 'fake', fetchedAt: '2026-10-13T15:00:00.000Z' });
    expect(res.body.record.owners.length).toBeGreaterThan(0);
    expect(res.body.streetImage).toEqual(PHOTO);
    expect(t.propertyData.calls).toEqual([
      {
        query: {
          point: { lat: 34.74995, lng: -92.2999 },
          address: { line: '123 Example Ln', city: 'Faketown', state: 'AR', zip: '72999' },
        },
      },
    ]);
    expect(t.streetImagery.calls).toEqual([{ lat: 34.74995, lng: -92.2999 }]);
  });

  test('a home with no point is looked up by address, with no street photo', async () => {
    const owner = await who.as('owner');
    t.geocoder.failNext();
    const home = await mustCreate(owner, '/api/properties', { ...HOME, lat: undefined, lng: undefined });

    const res = await owner.get(`/api/properties/${home.id}/record`);

    expect(res.status).toBe(200);
    expect(res.body.record).not.toBeNull();
    expect(res.body.streetImage).toBeNull();
    expect(t.propertyData.calls[0]?.query.point).toBeNull();
    expect(t.streetImagery.calls).toEqual([]);
  });

  test('no parcel found is a null record', async () => {
    const owner = await who.as('owner');
    const home = await mustCreate(owner, '/api/properties', { ...HOME, addressLine: '1 Nowhere Rd', lat: undefined, lng: undefined });
    const res = await owner.get(`/api/properties/${home.id}/record`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: true, record: null, streetImage: null });
  });

  test('not set up: configured false and no record, and nothing is asked', async () => {
    const owner = await who.as('owner');
    const home = await mustCreate(owner, '/api/properties', HOME);
    t.deps.propertyData = new UnconfiguredPropertyData();
    t.deps.streetImagery = new UnconfiguredStreetImagery();

    const res = await owner.get(`/api/properties/${home.id}/record`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: false, record: null, streetImage: null });
  });

  test('a provider outage is a 503; a street photo outage still answers the record', async () => {
    const owner = await who.as('owner');
    const home = await mustCreate(owner, '/api/properties', HOME);

    t.propertyData.failNext();
    const down = await owner.get(`/api/properties/${home.id}/record`);
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ error: UNAVAILABLE });

    t.streetImagery.failNext();
    const ok = await owner.get(`/api/properties/${home.id}/record`);
    expect(ok.status).toBe(200);
    expect(ok.body.record).not.toBeNull();
    expect(ok.body.streetImage).toBeNull();
  });

  test('a rep who cannot see the home, another company, or a missing id gets 404 and asks no provider', async () => {
    const owner = await who.as('owner');
    const home = await mustCreate(owner, '/api/properties', HOME);

    for (const agent of [await who.as('rep'), await who.as('owner', 'b')]) {
      const res = await agent.get(`/api/properties/${home.id}/record`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: NOT_FOUND });
    }
    expect((await owner.get(`/api/properties/${NO_UUID}/record`)).status).toBe(404);
    expect(t.propertyData.calls).toEqual([]);
  });

  test('signed out is a 401', async () => {
    const res = await request(t.app).get(`/api/properties/${NO_UUID}/record`);
    expect(res.status).toBe(401);
  });
});
