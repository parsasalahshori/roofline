import { writeArrayBuffer } from 'geotiff';
import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { layersRequest } from '../src/estimator/roof-3d.ts';
import { FakeSolarLayers } from '../src/providers/fakes/solar-layers.ts';
import { GoogleSolarLayers, layersFrom, readGeoTiff } from '../src/providers/google-solar-layers.ts';
import { createSolarLayersApi, SolarLayersUnavailableError, UnconfiguredSolarLayers } from '../src/providers/solar-layers.ts';

const KEY = 'test-solar-key-123';
const W = 6;
const H = 4;
const ORIGIN = [563000, 3845900] as const;

/** A float32 height map W x H on a 0.1 m UTM 15N grid (heights 10 + the pixel index / 10; -9999 at pixel 0). */
function dsmTiff(): ArrayBuffer {
  const data = new Float32Array(W * H).map((_, i) => (i === 0 ? -9999 : 10 + i / 10));
  return writeArrayBuffer(data, {
    width: W,
    height: H,
    BitsPerSample: [32],
    SampleFormat: [3],
    ModelPixelScale: [0.1, 0.1, 0],
    ModelTiepoint: [0, 0, 0, ORIGIN[0], ORIGIN[1], 0],
    ProjectedCSTypeGeoKey: 32615,
    GTModelTypeGeoKey: 1,
    GTRasterTypeGeoKey: 1,
    GDAL_NODATA: '-9999',
  } as Parameters<typeof writeArrayBuffer>[1]);
}

/** A byte mask, on the same grid or (`coarse`) on a 0.2 m grid half the size: roof in the right half. */
function maskTiff(coarse = false): ArrayBuffer {
  const w = coarse ? W / 2 : W;
  const h = coarse ? H / 2 : H;
  const data = new Uint8Array(w * h).map((_, i) => ((i % w) >= w / 2 ? 1 : 0));
  return writeArrayBuffer(data, {
    width: w,
    height: h,
    ModelPixelScale: [coarse ? 0.2 : 0.1, coarse ? 0.2 : 0.1, 0],
    ModelTiepoint: [0, 0, 0, ORIGIN[0], ORIGIN[1], 0],
    ProjectedCSTypeGeoKey: 32615,
  } as Parameters<typeof writeArrayBuffer>[1]);
}

const LAYERS_ANSWER = {
  imageryDate: { year: 2023, month: 10, day: 16 },
  imageryProcessedDate: { year: 2026, month: 9, day: 9 },
  dsmUrl: 'https://solar.googleapis.com/v1/geoTiff:get?id=dsm123',
  rgbUrl: 'https://solar.googleapis.com/v1/geoTiff:get?id=rgb123',
  maskUrl: 'https://solar.googleapis.com/v1/geoTiff:get?id=mask123',
  imageryQuality: 'HIGH',
};

/** A 3-band byte photo on the height map's grid: red 200, green 100 + column, blue 50. */
function rgbTiff(): ArrayBuffer {
  const data = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    data[i * 3] = 200;
    data[i * 3 + 1] = 100 + (i % W);
    data[i * 3 + 2] = 50;
  }
  return writeArrayBuffer(data, {
    width: W,
    height: H,
    SamplesPerPixel: 3,
    BitsPerSample: [8, 8, 8],
    PhotometricInterpretation: 2,
    ModelPixelScale: [0.1, 0.1, 0],
    ModelTiepoint: [0, 0, 0, ORIGIN[0], ORIGIN[1], 0],
    ProjectedCSTypeGeoKey: 32615,
  } as Parameters<typeof writeArrayBuffer>[1]);
}

function googleAnswering(o: { status?: number; body?: unknown; coarseMask?: boolean; fileStatus?: number; rgbStatus?: number } = {}, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    if (url.includes('dataLayers:get')) {
      return new Response(JSON.stringify(o.body ?? LAYERS_ANSWER), { status: o.status ?? 200, headers: { 'content-type': 'application/json' } });
    }
    if (o.fileStatus !== undefined) return new Response('nope', { status: o.fileStatus });
    if (url.includes('rgb123') && o.rgbStatus !== undefined) return new Response('nope', { status: o.rgbStatus });
    const bytes = url.includes('dsm123') ? dsmTiff() : url.includes('rgb123') ? rgbTiff() : maskTiff(o.coarseMask);
    return new Response(bytes, { status: 200, headers: { 'content-type': 'image/tiff' } });
  }) as typeof fetch;
}

describe('Google Solar Data Layers', () => {
  test('asks once (MEDIUM floor: HIGH where Google has it), downloads the height map, mask and photo, and reads them', async () => {
    const seen: string[] = [];
    const layers = await new GoogleSolarLayers({ apiKey: KEY, fetch: googleAnswering({}, seen) }).roofLayers([-92.311074, 34.753229], 22.4);

    expect(seen).toHaveLength(4);
    const ask = new URL(seen[0]!);
    expect(ask.origin + ask.pathname).toBe('https://solar.googleapis.com/v1/dataLayers:get');
    expect(ask.searchParams.get('location.latitude')).toBe('34.7532290');
    expect(ask.searchParams.get('location.longitude')).toBe('-92.3110740');
    expect(ask.searchParams.get('radiusMeters')).toBe('23');
    expect(ask.searchParams.get('view')).toBe('IMAGERY_LAYERS');
    expect(ask.searchParams.get('requiredQuality')).toBe('MEDIUM');
    expect(ask.searchParams.get('pixelSizeMeters')).toBe('0.1');
    expect(ask.searchParams.get('key')).toBe(KEY);
    // The files need the key too.
    const files = seen.slice(1).map((u) => new URL(u));
    expect(files.map((u) => u.searchParams.get('id')).sort()).toEqual(['dsm123', 'mask123', 'rgb123']);
    for (const u of files) expect(u.searchParams.get('key')).toBe(KEY);

    expect(layers).not.toBeNull();
    expect(layers!.epsg).toBe(32615);
    expect([layers!.originX, layers!.originY]).toEqual([...ORIGIN]);
    expect(layers!.raster.width).toBe(W);
    expect(layers!.raster.height).toBe(H);
    expect(layers!.raster.pixelSizeM).toBeCloseTo(0.1, 9);
    expect(Number.isNaN(layers!.raster.dsm[0])).toBe(true);
    expect(layers!.raster.dsm[7]).toBeCloseTo(10.7, 5);
    expect(Array.from(layers!.raster.mask.slice(0, W))).toEqual([0, 0, 0, 1, 1, 1]);
    expect(layers!.imageryQuality).toBe('HIGH');
    expect(layers!.imageryDate).toBe('2023-10-16');
    // The photo, 3 bytes a pixel on its grid.
    expect(layers!.photo).toMatchObject({ width: W, height: H, originX: ORIGIN[0], originY: ORIGIN[1] });
    expect(Array.from(layers!.photo!.rgb.slice(0, 6))).toEqual([200, 100, 50, 200, 101, 50]);
  });

  test('a photo that does not come costs nothing else: the layers come without it', async () => {
    const layers = await new GoogleSolarLayers({ apiKey: KEY, fetch: googleAnswering({ rgbStatus: 500 }) }).roofLayers([-92.3, 34.75], 20);
    expect(layers).not.toBeNull();
    expect(layers!.photo).toBeNull();
  });

  test('a mask on another grid is resampled onto the height map', async () => {
    const layers = await new GoogleSolarLayers({ apiKey: KEY, fetch: googleAnswering({ coarseMask: true }) }).roofLayers([-92.3, 34.75], 20);
    expect(layers!.raster.mask).toHaveLength(W * H);
    expect(Array.from(layers!.raster.mask.slice(W, 2 * W))).toEqual([0, 0, 0, 0, 1, 1]);
  });

  test('no HIGH or MEDIUM imagery (NOT_FOUND) is null, not an error', async () => {
    const layers = await new GoogleSolarLayers({ apiKey: KEY, fetch: googleAnswering({ status: 404, body: { error: { code: 404 } } }) }).roofLayers([-92.3, 34.75], 20);
    expect(layers).toBeNull();
  });

  test('errors, a failed download or an unreadable file are SolarLayersUnavailableError, never carrying the key', async () => {
    for (const fetchFn of [
      googleAnswering({ status: 403, body: { error: 'denied' } }),
      googleAnswering({ fileStatus: 500 }),
      (async () => {
        throw new TypeError(`fetch failed for https://solar.googleapis.com/v1/dataLayers:get?key=${KEY}`);
      }) as typeof fetch,
    ]) {
      const error = await new GoogleSolarLayers({ apiKey: KEY, fetch: fetchFn }).roofLayers([-92.3, 34.75], 20).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SolarLayersUnavailableError);
      expect(String((error as Error).message)).not.toContain(KEY);
      expect((error as Error).cause).toBeUndefined();
    }
    await expect(readGeoTiff(new TextEncoder().encode('not a tiff').buffer as ArrayBuffer)).rejects.toBeInstanceOf(SolarLayersUnavailableError);
  });

  test('a grid in no UTM zone is refused', async () => {
    const dsm = await readGeoTiff(dsmTiff());
    expect(() => layersFrom({ ...dsm, epsg: 4326 }, dsm, { imageryQuality: null, imageryDate: null })).toThrow(SolarLayersUnavailableError);
  });

  test('the app uses the real API when GOOGLE_SOLAR_API_KEY is set (DEMO_MODE too), the fake for FAKE_PROVIDERS, and can be turned off', () => {
    const base = {
      NODE_ENV: 'development',
      APP_ORIGIN: 'http://localhost:4500',
      PUBLIC_BASE_URL: 'http://localhost:4500',
      DATABASE_URL_TENANT: 'postgres://t@localhost/x',
      DATABASE_URL_SYSTEM: 'postgres://s@localhost/x',
      ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    };
    expect(createSolarLayersApi(loadConfig({ ...base, DEMO_MODE: '1', GOOGLE_SOLAR_API_KEY: KEY }))).toBeInstanceOf(GoogleSolarLayers);
    expect(createSolarLayersApi(loadConfig({ ...base, DEMO_MODE: '1' }))).toBeInstanceOf(FakeSolarLayers);
    expect(createSolarLayersApi(loadConfig({ ...base, DEMO_MODE: '1', GOOGLE_SOLAR_API_KEY: KEY, GOOGLE_SOLAR_DATA_LAYERS: '0' }))).toBeInstanceOf(FakeSolarLayers);
    expect(createSolarLayersApi(loadConfig({ ...base, FAKE_PROVIDERS: '1', GOOGLE_SOLAR_API_KEY: KEY }))).toBeInstanceOf(FakeSolarLayers);
    expect(createSolarLayersApi(loadConfig({ ...base, GOOGLE_SOLAR_API_KEY: KEY }))).toBeInstanceOf(GoogleSolarLayers);
    expect(createSolarLayersApi(loadConfig({ ...base, GOOGLE_SOLAR_API_KEY: KEY, GOOGLE_SOLAR_DATA_LAYERS: 'false' }))).toBeInstanceOf(UnconfiguredSolarLayers);
    expect(createSolarLayersApi(loadConfig(base))).toBeInstanceOf(UnconfiguredSolarLayers);
  });
});

describe('layersRequest', () => {
  test("round Google Solar's building when it is the home's, with a margin and reaching the point", () => {
    const building = { center: [-96, 41.25] as [number, number], box: { sw: [-96.0, 41.25] as [number, number], ne: [-95.9997, 41.2502] as [number, number] }, imageryQuality: 'HIGH', imageryDate: null, segments: [] };
    const req = layersRequest([-95.99985, 41.2501], building);
    expect(req.center[0]).toBeCloseTo(-95.99985, 6);
    expect(req.center[1]).toBeCloseTo(41.2501, 6);
    // Half the box diagonal (about 16.7 m) plus 6 m.
    expect(req.radiusM).toBe(23);
    // A neighbour's building (far from the point), or none: round the point.
    expect(layersRequest([-95.9, 41.25], building)).toEqual({ center: [-95.9, 41.25], radiusM: 30 });
    expect(layersRequest([-95.9, 41.25], null)).toEqual({ center: [-95.9, 41.25], radiusM: 30 });
  });
});
