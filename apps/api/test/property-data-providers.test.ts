import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { ArkansasParcels } from '../src/providers/arkansas-parcels.ts';
import { FakePropertyData } from '../src/providers/fakes/property-data.ts';
import { FakeStreetImagery } from '../src/providers/fakes/street-imagery.ts';
import {
  createPropertyData,
  ownerOccupied,
  PropertyDataUnavailableError,
  UnconfiguredPropertyData,
} from '../src/providers/property-data.ts';
import { RegridPropertyData } from '../src/providers/regrid.ts';
import { createStreetImagery, MapillaryStreetImagery, UnconfiguredStreetImagery } from '../src/providers/street-imagery.ts';

/*
 * The property data and street imagery clients, against hand-written answers shaped like each provider's
 * documented responses (fictional values). Nothing here reaches the network: every client gets its own `fetch`.
 */

const REGRID_POINT = readFileSync(new URL('./fixtures/regrid/point.json', import.meta.url), 'utf8');
const ARKANSAS_POINT = readFileSync(new URL('./fixtures/arkansas-gis/point.json', import.meta.url), 'utf8');
const MAPILLARY_IMAGES = readFileSync(new URL('./fixtures/mapillary/images.json', import.meta.url), 'utf8');

const NOW = new Date('2026-10-13T15:00:00.000Z');
const TOKEN = 'regrid-test-token';
const HOUSE = { lat: 34.74995, lng: -92.2999 };
const ADDRESS = { line: '123 Example Ln', city: 'Faketown', state: 'AR', zip: '72999' };

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(answer: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return answer(url);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const json = (body: string | object, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const KEY = Buffer.alloc(32, 9).toString('base64');
const BASE_ENV = {
  NODE_ENV: 'development',
  APP_ORIGIN: 'https://app.roofline.test',
  DATABASE_URL_TENANT: 'postgres://app_tenant:pw@localhost:5432/roofline',
  DATABASE_URL_SYSTEM: 'postgres://app_system:pw@localhost:5432/roofline',
  ENCRYPTION_KEY: KEY,
  PUBLIC_BASE_URL: 'https://app.roofline.test',
} satisfies Record<string, string>;

describe('Regrid', () => {
  test('a point lookup sends the token in a header, never the URL, and maps the parcel', async () => {
    const f = fakeFetch(() => json(REGRID_POINT));
    const regrid = new RegridPropertyData({ token: TOKEN, fetch: f.fetch, baseUrl: 'https://regrid.test/api/v2', now: () => NOW });

    const record = await regrid.lookup({ point: HOUSE, address: ADDRESS });

    expect(f.calls).toHaveLength(1);
    const url = new URL(f.calls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://regrid.test/api/v2/parcels/point');
    expect(url.searchParams.get('lat')).toBe('34.74995');
    expect(url.searchParams.get('lon')).toBe('-92.2999');
    expect(url.searchParams.get('limit')).toBe('1');
    expect(f.calls[0]!.url).not.toContain(TOKEN);
    expect(new Headers(f.calls[0]!.init?.headers).get('x-regrid-token')).toBe(TOKEN);

    expect(record).toEqual({
      parcelId: '99-00000-001',
      owners: ['SAMPLE JORDAN Q', 'SAMPLE RILEY'],
      ownerOccupied: true,
      mailingAddress: '123 EXAMPLE LANE, FAKETOWN, AR 72999-0001',
      siteAddress: '123 EXAMPLE LN, FAKETOWN, AR 72999',
      county: 'Example',
      yearBuilt: 1987,
      livingSqFt: 1864,
      lastSaleDate: '2019-06-14',
      lastSaleCents: 18_450_000,
      assessedCents: 20_130_000,
      parcelRing: [
        [-92.3001, 34.7501],
        [-92.2997, 34.7501],
        [-92.2997, 34.7498],
        [-92.3001, 34.7498],
        [-92.3001, 34.7501],
      ],
      source: 'regrid',
      sourceUpdatedAt: '2026-08-20T00:00:00.000Z',
      fetchedAt: NOW.toISOString(),
    });
  });

  test('with no point it searches by the address', async () => {
    const f = fakeFetch(() => json(REGRID_POINT));
    const regrid = new RegridPropertyData({ token: TOKEN, fetch: f.fetch, baseUrl: 'https://regrid.test/api/v2', now: () => NOW });

    await regrid.lookup({ point: null, address: ADDRESS });

    const url = new URL(f.calls[0]!.url);
    expect(url.pathname).toBe('/api/v2/parcels/address');
    expect(url.searchParams.get('query')).toBe('123 Example Ln, Faketown, AR 72999');
  });

  test('no parcel there is null', async () => {
    const f = fakeFetch(() => json({ parcels: { type: 'FeatureCollection', features: [] } }));
    const regrid = new RegridPropertyData({ token: TOKEN, fetch: f.fetch });
    expect(await regrid.lookup({ point: HOUSE, address: null })).toBeNull();
  });

  test('a mailing address elsewhere is not owner-occupied', async () => {
    const changed = JSON.parse(REGRID_POINT) as { parcels: { features: { properties: { fields: Record<string, unknown> } }[] } };
    const fields = changed.parcels.features[0]!.properties.fields;
    fields.mailadd = 'PO BOX 12';
    fields.mail_zip = '72001';
    const f = fakeFetch(() => json(changed));
    const regrid = new RegridPropertyData({ token: TOKEN, fetch: f.fetch });
    expect((await regrid.lookup({ point: HOUSE, address: null }))?.ownerOccupied).toBe(false);
  });

  test.each([401, 403, 429, 500])('a %i is unavailable, and the error never carries the token', async (status) => {
    const f = fakeFetch(() => json({ status: 'error', message: `bad token ${TOKEN}` }, status));
    const regrid = new RegridPropertyData({ token: TOKEN, fetch: f.fetch });
    const err = await regrid.lookup({ point: HOUSE, address: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PropertyDataUnavailableError);
    expect((err as Error).message).toBe("Regrid didn't answer.");
    expect((err as Error).message).not.toContain(TOKEN);
  });

  test('a network failure or a timeout is unavailable', async () => {
    const down = new RegridPropertyData({
      token: TOKEN,
      fetch: (() => Promise.reject(new TypeError(`fetch failed for ${TOKEN}`))) as typeof fetch,
    });
    await expect(down.lookup({ point: HOUSE, address: null })).rejects.toThrow(PropertyDataUnavailableError);

    const slow = new RegridPropertyData({
      token: TOKEN,
      timeoutMs: 5,
      fetch: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })) as typeof fetch,
    });
    await expect(slow.lookup({ point: HOUSE, address: null })).rejects.toThrow(PropertyDataUnavailableError);
  });
});

describe('the Arkansas GIS Office parcels', () => {
  test('a point lookup asks the open layer in WGS84 and maps owner, site address, value and boundary', async () => {
    const f = fakeFetch(() => json(ARKANSAS_POINT));
    const ar = new ArkansasParcels({ fetch: f.fetch, baseUrl: 'https://ar.test/FeatureServer/6', now: () => NOW });

    const record = await ar.lookup({ point: { lat: 34.8, lng: -92.3999 }, address: null });

    const url = new URL(f.calls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://ar.test/FeatureServer/6/query');
    expect(url.searchParams.get('geometry')).toBe('-92.3999,34.8');
    expect(url.searchParams.get('inSR')).toBe('4326');
    expect(url.searchParams.get('outSR')).toBe('4326');
    expect(url.searchParams.get('f')).toBe('json');
    expect(record).toEqual({
      parcelId: '999-00001-000',
      owners: ['EXAMPLE CASEY & AVERY'],
      ownerOccupied: null,
      mailingAddress: null,
      siteAddress: '45 PLACEHOLDER RD, FAKEVILLE, AR 72998',
      county: 'Example County',
      yearBuilt: null,
      livingSqFt: null,
      lastSaleDate: null,
      lastSaleCents: null,
      assessedCents: 15_600_000,
      parcelRing: [
        [-92.4001, 34.8001],
        [-92.3997, 34.8001],
        [-92.3997, 34.7998],
        [-92.4001, 34.7998],
        [-92.4001, 34.8001],
      ],
      source: 'arkansas-gis',
      sourceUpdatedAt: '2026-09-17T00:00:00.000Z',
      fetchedAt: NOW.toISOString(),
    });
  });

  test('an address with no point finds nothing and asks nothing', async () => {
    const f = fakeFetch(() => json(ARKANSAS_POINT));
    const ar = new ArkansasParcels({ fetch: f.fetch });
    expect(await ar.lookup({ point: null, address: ADDRESS })).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  test('no parcel is null; an ArcGIS error (sent with a 200) is unavailable', async () => {
    const empty = new ArkansasParcels({ fetch: fakeFetch(() => json({ features: [] })).fetch });
    expect(await empty.lookup({ point: HOUSE, address: null })).toBeNull();

    const broken = new ArkansasParcels({ fetch: fakeFetch(() => json({ error: { code: 400, message: 'Invalid query' } })).fetch });
    await expect(broken.lookup({ point: HOUSE, address: null })).rejects.toThrow(PropertyDataUnavailableError);
  });
});

describe('Mapillary', () => {
  test('finds the photo taken nearest the house, with the token in the Authorization header', async () => {
    const f = fakeFetch(() => json(MAPILLARY_IMAGES));
    const mly = new MapillaryStreetImagery({ token: 'MLY|1|test', fetch: f.fetch, baseUrl: 'https://mly.test' });

    const image = await mly.nearest(HOUSE);

    const url = new URL(f.calls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://mly.test/images');
    const [west, south, east, north] = (url.searchParams.get('bbox') ?? '').split(',').map(Number);
    expect(west).toBeLessThan(HOUSE.lng);
    expect(east).toBeGreaterThan(HOUSE.lng);
    expect(south).toBeLessThan(HOUSE.lat);
    expect(north).toBeGreaterThan(HOUSE.lat);
    expect(url.searchParams.get('fields')).toContain('thumb_1024_url');
    expect(f.calls[0]!.url).not.toContain('MLY');
    expect(new Headers(f.calls[0]!.init?.headers).get('authorization')).toBe('OAuth MLY|1|test');
    expect(image).toEqual({
      id: '1000000000000002',
      thumbUrl: 'https://scontent.example.fbcdn.net/m1/v/t6/nearest.jpg',
      capturedAt: '2024-06-01T00:00:00.000Z',
      pageUrl: 'https://www.mapillary.com/app/?pKey=1000000000000002',
    });
  });

  test('no photos nearby is null; a refusal is unavailable', async () => {
    const none = new MapillaryStreetImagery({ token: 't', fetch: fakeFetch(() => json({ data: [] })).fetch });
    expect(await none.nearest(HOUSE)).toBeNull();

    const refused = new MapillaryStreetImagery({ token: 't', fetch: fakeFetch(() => json({ error: {} }, 401)).fetch });
    await expect(refused.nearest(HOUSE)).rejects.toThrow(PropertyDataUnavailableError);
  });
});

describe('owner-occupied', () => {
  test('a homestead exemption is owner-occupied whatever the mailing address', () => {
    expect(ownerOccupied({ homestead: true, mailStreet: 'PO Box 1', mailZip: '72001', siteStreet: '1 A St', siteZip: '72002' })).toBe(true);
  });
  test('the same street written differently matches', () => {
    expect(
      ownerOccupied({ homestead: null, mailStreet: '12 North Oak Street', mailZip: '72201-1234', siteStreet: '12 N OAK ST', siteZip: '72201' }),
    ).toBe(true);
  });
  test('a missing mailing address is unknown', () => {
    expect(ownerOccupied({ homestead: null, mailStreet: null, mailZip: null, siteStreet: '12 N Oak St', siteZip: '72201' })).toBeNull();
  });
});

describe('choosing the provider', () => {
  test('nothing set: owner records and street photos are off', () => {
    const config = loadConfig(BASE_ENV);
    expect(createPropertyData(config)).toBeInstanceOf(UnconfiguredPropertyData);
    expect(createPropertyData(config).configured).toBe(false);
    expect(createStreetImagery(config)).toBeInstanceOf(UnconfiguredStreetImagery);
  });

  test('a Regrid token turns Regrid on; a Mapillary token turns street photos on', () => {
    const config = loadConfig({ ...BASE_ENV, REGRID_API_TOKEN: TOKEN, MAPILLARY_TOKEN: 'MLY|1|abc' });
    expect(createPropertyData(config)).toBeInstanceOf(RegridPropertyData);
    expect(createStreetImagery(config)).toBeInstanceOf(MapillaryStreetImagery);
  });

  test('PROPERTY_DATA_PROVIDER=arkansas-gis uses the free state layer, even with a Regrid token', () => {
    expect(createPropertyData(loadConfig({ ...BASE_ENV, PROPERTY_DATA_PROVIDER: 'arkansas-gis' }))).toBeInstanceOf(ArkansasParcels);
    expect(
      createPropertyData(loadConfig({ ...BASE_ENV, PROPERTY_DATA_PROVIDER: 'arkansas-gis', REGRID_API_TOKEN: TOKEN })),
    ).toBeInstanceOf(ArkansasParcels);
  });

  test('PROPERTY_DATA_PROVIDER=regrid needs the token; an unknown provider is refused', () => {
    expect(() => loadConfig({ ...BASE_ENV, PROPERTY_DATA_PROVIDER: 'regrid' })).toThrow(/REGRID_API_TOKEN/);
    expect(() => loadConfig({ ...BASE_ENV, PROPERTY_DATA_PROVIDER: 'mapillo' })).toThrow(/PROPERTY_DATA_PROVIDER/);
  });

  test('FAKE_PROVIDERS and DEMO_MODE always use the fakes, even with real keys', () => {
    for (const flag of ['FAKE_PROVIDERS', 'DEMO_MODE']) {
      const config = loadConfig({ ...BASE_ENV, [flag]: '1', REGRID_API_TOKEN: TOKEN, MAPILLARY_TOKEN: 'MLY|1|abc' });
      expect(createPropertyData(config)).toBeInstanceOf(FakePropertyData);
      expect(createStreetImagery(config)).toBeInstanceOf(FakeStreetImagery);
    }
  });
});

describe('the fake', () => {
  test('answers the same fictional record for the same house, and none for nowhere', async () => {
    const fake = new FakePropertyData(() => NOW);
    const a = await fake.lookup({ point: HOUSE, address: ADDRESS });
    const b = await fake.lookup({ point: HOUSE, address: ADDRESS });
    expect(a).toEqual(b);
    expect(a?.source).toBe('fake');
    expect(a?.parcelId).toMatch(/^FAKE-/);
    expect(await fake.lookup({ point: null, address: { ...ADDRESS, line: '1 Nowhere Rd' } })).toBeNull();
    fake.failNext();
    await expect(fake.lookup({ point: HOUSE, address: null })).rejects.toThrow(PropertyDataUnavailableError);
  });
});
