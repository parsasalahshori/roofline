import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { DEMO_LOOKUP_LOTS } from '../src/demo/places.ts';
import { DemoSolar, FakeSolar } from '../src/providers/fakes/solar.ts';
import { GoogleSolar, parseBuildingInsights } from '../src/providers/google-solar.ts';
import { createSolarApi, SolarUnavailableError, UnconfiguredSolar } from '../src/providers/solar.ts';

const KEY = 'test-solar-key-123';

/** The shape of a buildingInsights:findClosest answer (made-up numbers), trimmed to what is read plus some noise. */
const ANSWER = {
  name: 'buildings/abc',
  center: { latitude: 38.93441, longitude: -77.07166 },
  imageryDate: { year: 2024, month: 5, day: 1 },
  imageryQuality: 'HIGH',
  boundingBox: { sw: { latitude: 38.93433, longitude: -77.07175 }, ne: { latitude: 38.93448, longitude: -77.07158 } },
  regionCode: 'US',
  solarPotential: {
    maxArrayPanelsCount: 40,
    roofSegmentStats: [
      {
        pitchDegrees: 38.6,
        azimuthDegrees: 1.7,
        stats: { areaMeters2: 44.3, groundAreaMeters2: 34.6, sunshineQuantiles: [1, 2, 3] },
        center: { latitude: 38.93444, longitude: -77.07167 },
        boundingBox: { sw: { latitude: 38.93442, longitude: -77.07173 }, ne: { latitude: 38.93447, longitude: -77.07159 } },
        planeHeightAtCenterMeters: 123.2,
      },
      {
        // A flat segment: Google leaves the azimuth out.
        pitchDegrees: 1.2,
        stats: { areaMeters2: 14.7, groundAreaMeters2: 14.7 },
        center: { latitude: 38.9344, longitude: -77.07167 },
      },
      { pitchDegrees: 30, stats: { areaMeters2: 3 } },
      'not a segment',
    ],
  },
};

function fetchAnswering(status: number, body: unknown, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    seen.push(String(input));
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('Google Solar buildingInsights', () => {
  test('asks for the point with the lowest quality floor (so the best imagery there comes back) and reads the roof', async () => {
    const seen: string[] = [];
    const solar = new GoogleSolar({ apiKey: KEY, fetch: fetchAnswering(200, ANSWER, seen) });

    const building = await solar.buildingInsights([-77.0717, 38.9346]);

    expect(seen).toHaveLength(1);
    const url = new URL(seen[0]!);
    expect(url.origin + url.pathname).toBe('https://solar.googleapis.com/v1/buildingInsights:findClosest');
    expect(url.searchParams.get('location.latitude')).toBe('38.9346000');
    expect(url.searchParams.get('location.longitude')).toBe('-77.0717000');
    expect(url.searchParams.get('requiredQuality')).toBe('LOW');
    expect(url.searchParams.get('key')).toBe(KEY);
    expect(building).toEqual({
      center: [-77.07166, 38.93441],
      box: { sw: [-77.07175, 38.93433], ne: [-77.07158, 38.93448] },
      imageryQuality: 'HIGH',
      imageryDate: '2024-05-01',
      segments: [
        {
          pitchDeg: 38.6,
          azimuthDeg: 1.7,
          areaM2: 44.3,
          groundAreaM2: 34.6,
          center: [-77.07167, 38.93444],
          box: { sw: [-77.07173, 38.93442], ne: [-77.07159, 38.93447] },
        },
        { pitchDeg: 1.2, azimuthDeg: 0, areaM2: 14.7, groundAreaM2: 14.7, center: [-77.07167, 38.9344], box: null },
      ],
    });
  });

  test('no building there (404 NOT_FOUND) is null, not an error', async () => {
    const solar = new GoogleSolar({ apiKey: KEY, fetch: fetchAnswering(404, { error: { code: 404, status: 'NOT_FOUND' } }) });
    expect(await solar.buildingInsights([-77.0717, 38.9346])).toBeNull();
  });

  test('any other failure is SolarUnavailableError, and never carries the key', async () => {
    for (const fetchImpl of [
      fetchAnswering(403, { error: { message: `API key ${KEY} not valid` } }),
      fetchAnswering(500, 'oops'),
      fetchAnswering(200, 'not json'),
      (async () => {
        throw new Error(`connect failed for https://solar.googleapis.com/?key=${KEY}`);
      }) as typeof fetch,
    ]) {
      const solar = new GoogleSolar({ apiKey: KEY, fetch: fetchImpl });
      const err = await solar.buildingInsights([-77.0717, 38.9346]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SolarUnavailableError);
      expect(String((err as Error).message)).not.toContain(KEY);
      expect((err as Error).cause).toBeUndefined();
    }
  });

  test('a slow answer times out as unavailable', async () => {
    const never = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    const solar = new GoogleSolar({ apiKey: KEY, fetch: never, timeoutMs: 20 });
    await expect(solar.buildingInsights([-77.0717, 38.9346])).rejects.toBeInstanceOf(SolarUnavailableError);
  });

  test('parses an empty or odd answer to a building with no segments', () => {
    expect(parseBuildingInsights(null)).toEqual({ center: null, box: null, imageryQuality: null, imageryDate: null, segments: [] });
    expect(parseBuildingInsights({ solarPotential: { roofSegmentStats: 'x' } }).segments).toEqual([]);
  });
});

describe('createSolarApi', () => {
  const base = {
    NODE_ENV: 'development',
    APP_ORIGIN: 'http://localhost:4500',
    PUBLIC_BASE_URL: 'http://localhost:4500',
    DATABASE_URL_TENANT: 'postgres://t@localhost/x',
    DATABASE_URL_SYSTEM: 'postgres://s@localhost/x',
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  };

  test('the demo Solar gives recent HIGH imagery, except LOW 2014 imagery on every eighth lookup lot', async () => {
    const solar = new DemoSolar();
    const ordinary = (await solar.buildingInsights(DEMO_LOOKUP_LOTS[0]!))!;
    expect(ordinary.imageryQuality).toBe('HIGH');
    expect(Number(ordinary.imageryDate!.slice(0, 4))).toBeGreaterThanOrEqual(new Date().getUTCFullYear() - 2);
    const old = (await solar.buildingInsights(DEMO_LOOKUP_LOTS[7]!))!;
    expect(old).toMatchObject({ imageryQuality: 'LOW', imageryDate: '2014-06-12' });
    expect(DemoSolar.oldImageryAt(DEMO_LOOKUP_LOTS[15]!)).toBe(true);
    expect(DemoSolar.oldImageryAt(DEMO_LOOKUP_LOTS[8]!)).toBe(false);
  });

  test('DEMO_MODE uses the real Solar API when GOOGLE_SOLAR_API_KEY is set, else the demo one', () => {
    expect(createSolarApi(loadConfig({ ...base, DEMO_MODE: '1', GOOGLE_SOLAR_API_KEY: KEY }))).toBeInstanceOf(GoogleSolar);
    expect(createSolarApi(loadConfig({ ...base, DEMO_MODE: '1' }))).toBeInstanceOf(DemoSolar);
  });

  test('FAKE_PROVIDERS is the fake even with a key; otherwise the real one, or unconfigured without a key', () => {
    expect(createSolarApi(loadConfig({ ...base, FAKE_PROVIDERS: '1', GOOGLE_SOLAR_API_KEY: KEY }))).toBeInstanceOf(FakeSolar);
    expect(createSolarApi(loadConfig({ ...base, GOOGLE_SOLAR_API_KEY: KEY }))).toBeInstanceOf(GoogleSolar);
    const none = createSolarApi(loadConfig(base));
    expect(none).toBeInstanceOf(UnconfiguredSolar);
    expect(none.configured).toBe(false);
  });

  test('FOOTPRINT_WAIT_MS defaults to two minutes and takes a number of milliseconds', () => {
    expect(loadConfig(base).FOOTPRINT_WAIT_MS).toBe(120_000);
    expect(loadConfig({ ...base, FOOTPRINT_WAIT_MS: '30000' }).FOOTPRINT_WAIT_MS).toBe(30_000);
    expect(() => loadConfig({ ...base, FOOTPRINT_WAIT_MS: 'soon' })).toThrow(/FOOTPRINT_WAIT_MS/);
  });
});
