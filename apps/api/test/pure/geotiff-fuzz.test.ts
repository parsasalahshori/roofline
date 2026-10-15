import { describe, expect, it } from 'vitest';
import { type Ring } from '@roofline/shared';
import { rasterProblem } from '@roofline/shared/roof-reconstruct';
import { roofOnLayersResult } from '../../src/estimator/roof-3d.ts';
import { GoogleSolarLayers, layersFrom, readGeoTiff, readRgbGeoTiff } from '../../src/providers/google-solar-layers.ts';
import { SolarLayersUnavailableError } from '../../src/providers/solar-layers.ts';
import { hipLayers } from '../roof-3d-fixture.ts';
import { heightTiff, maskTiff, rgbTiff, rng } from './tiffs.ts';

/*
 * Whatever bytes come back as a "GeoTIFF", and whatever grid they make, the decoder and the reconstruction's entry
 * return a typed answer: SolarLayersUnavailableError with a reason, or a roof / a typed miss. Never another exception,
 * never a hang (each case is bounded by the test timeout).
 */

const META = { imageryQuality: 'HIGH', imageryDate: '2024-05-01' };

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    expect(e).toBeInstanceOf(SolarLayersUnavailableError);
    return (e as SolarLayersUnavailableError).reason;
  }
}

describe('GeoTIFF decoding under bad input', () => {
  const good = heightTiff({ width: 40, height: 30 }, (i) => 10 + (i % 7) / 10);

  it('truncated at 60 seeded lengths: a typed decode failure (or the whole file), never another exception', async () => {
    const next = rng(7);
    const seen = new Set<string>();
    for (let k = 0; k < 60; k++) {
      const n = Math.floor(next() * good.byteLength);
      const r = await reason(readGeoTiff(good.slice(0, n)));
      expect(['decode', 'ok']).toContain(r);
      seen.add(r);
    }
    expect(seen.has('decode')).toBe(true);
  });

  it('60 seeded random byte strings and random corruptions of a real file: typed, never another exception', async () => {
    const next = rng(8);
    for (let k = 0; k < 30; k++) {
      const bytes = new Uint8Array(Math.floor(next() * 4096));
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(next() * 256);
      expect(['decode', 'too-large']).toContain(await reason(readGeoTiff(bytes.buffer)));
      expect(['decode']).toContain(await reason(readRgbGeoTiff(bytes.buffer)));
    }
    for (let k = 0; k < 30; k++) {
      const bytes = new Uint8Array(good.slice(0));
      for (let j = 0; j < 8; j++) bytes[Math.floor(next() * bytes.length)] = Math.floor(next() * 256);
      expect(['ok', 'decode', 'too-large']).toContain(await reason(readGeoTiff(bytes.buffer)));
    }
  });

  it('empty bytes, a 1-pixel grid, a 4000 x 4000 grid (refused before decoding), NaN and Infinity heights', async () => {
    expect(await reason(readGeoTiff(new ArrayBuffer(0)))).toBe('decode');
    const one = await readGeoTiff(heightTiff({ width: 1, height: 1 }, () => 5));
    expect(one.width * one.height).toBe(1);
    expect(await reason(readGeoTiff(maskTiff({ width: 4000, height: 4000 }, () => 0)))).toBe('too-large');
    const odd = await readGeoTiff(heightTiff({ width: 4, height: 4 }, (i) => [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -9999][i % 4]!));
    const layers = layersFrom(odd, await readGeoTiff(maskTiff({ width: 4, height: 4 }, () => 1)), META);
    expect(Array.from(layers.raster.dsm).every((z) => Number.isNaN(z))).toBe(true);
    expect(rasterProblem(layers.raster, { col: 2, row: 2 })).toBe('no-data');
  });

  it('a mask in another UTM zone, a grid in no UTM zone, skewed pixels: typed refusals', async () => {
    const dsm = await readGeoTiff(heightTiff({ width: 10, height: 10 }, () => 5));
    const otherZone = await readGeoTiff(maskTiff({ width: 10, height: 10, epsg: 32616 }, () => 1));
    expect(() => layersFrom(dsm, otherZone, META)).toThrow(SolarLayersUnavailableError);
    try {
      layersFrom(dsm, otherZone, META);
    } catch (e) {
      expect((e as SolarLayersUnavailableError).reason).toBe('mismatch');
    }
    const latLng = await readGeoTiff(heightTiff({ width: 10, height: 10, epsg: 4326 }, () => 5));
    expect(() => layersFrom(latLng, latLng, META)).toThrow(/height map/);
    expect(() => layersFrom({ ...dsm, pixelY: 0.2 }, otherZone, META)).toThrow(SolarLayersUnavailableError);
  });

  it('a photo that is not RGB, or truncated: typed decode failure', async () => {
    const photo = rgbTiff({ width: 8, height: 8 });
    expect(await reason(readRgbGeoTiff(photo))).toBe('ok');
    expect(await reason(readRgbGeoTiff(photo.slice(0, photo.byteLength - 40)))).toBe('decode');
    expect(await reason(readRgbGeoTiff(maskTiff({ width: 8, height: 8 }, () => 1)))).toBe('decode');
  });
});

describe('the reconstruction entry under bad grids', () => {
  const RING: Ring = [
    [-92.3, 34.75],
    [-92.2997, 34.75],
    [-92.2997, 34.7502],
    [-92.3, 34.7502],
    [-92.3, 34.75],
  ];
  const base = hipLayers(RING);
  const inside: [number, number] = [-92.29985, 34.7501];

  it('holes, a mask touching every edge, two separate roofs, a checkerboard mask, spikes of NaN: an answer, never a throw', () => {
    const W = base.raster.width;
    const H = base.raster.height;
    const variants = {
      holes: base.raster.mask.map((v, i) => (v && (i % 97 === 0 || Math.floor(i / W) % 41 === 0) ? 0 : v)),
      edge: new Uint8Array(W * H).fill(1),
      twoRoofs: base.raster.mask.map((v, i) => (v && (i % W) % 60 < 30 ? 1 : 0)),
      checker: new Uint8Array(W * H).map((_, i) => ((i % W) + Math.floor(i / W)) % 2),
    };
    for (const [name, mask] of Object.entries(variants)) {
      const found = roofOnLayersResult({ ...base, raster: { ...base.raster, mask } }, inside);
      expect(found, name).toBeDefined();
      // A mask over the whole 60 m grid is bigger than any home (MAX_ROOF_PART_M2) and runs off the edge.
      if (name === 'edge') expect(['clipped', 'too-large']).toContain('miss' in found ? found.miss : 'roof');
    }
    const spiky = base.raster.dsm.map((z, i) => (i % 13 === 0 ? Number.NaN : i % 17 === 0 ? 1e30 : z));
    expect(roofOnLayersResult({ ...base, raster: { ...base.raster, dsm: spiky } }, inside)).toBeDefined();
  });

  it('a 1-pixel grid and a 3 x 3 grid: typed', () => {
    const one = { ...base, raster: { width: 1, height: 1, pixelSizeM: 0.1, dsm: new Float32Array([5]), mask: new Uint8Array([1]) } };
    expect(roofOnLayersResult(one, inside)).toEqual({ miss: 'bad-size' });
    const three = { ...base, raster: { width: 3, height: 3, pixelSizeM: 0.1, dsm: new Float32Array(9).fill(5), mask: new Uint8Array(9).fill(1) } };
    expect('miss' in roofOnLayersResult(three, inside)).toBe(true);
  });

  it('southern hemisphere and either side of a UTM zone boundary: the same hip roof is found', () => {
    for (const [lng, lat] of [
      [151.2, -33.87],
      [-96.0002, 41.25],
      [-95.9999, 41.25],
      [-90.0001, 30.0],
      [0.0001, 51.5],
    ] as const) {
      const ring: Ring = [
        [lng, lat],
        [lng + 0.0003, lat],
        [lng + 0.0003, lat + 0.0002],
        [lng, lat + 0.0002],
        [lng, lat],
      ];
      const found = roofOnLayersResult(hipLayers(ring), [lng + 0.00015, lat + 0.0001]);
      expect('roof' in found ? found.roof.faces.length : found.miss, `${lng},${lat}`).toBe(4);
    }
  });
});

describe('the Data Layers client under bad answers', () => {
  const ANSWER = { dsmUrl: 'https://solar.googleapis.com/v1/geoTiff:get?id=d', maskUrl: 'https://solar.googleapis.com/v1/geoTiff:get?id=m', imageryQuality: 'HIGH' };

  it('file URLs off Google\'s host are never fetched (they would be sent the key): a typed bad answer', async () => {
    const seen: string[] = [];
    const fetchFn = (async (input: string) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ ...ANSWER, dsmUrl: 'https://evil.example/geoTiff?id=d' }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await reason(new GoogleSolarLayers({ apiKey: 'k-123', fetch: fetchFn }).roofLayers([-92.3, 34.75], 20));
    expect(r).toBe('bad-answer');
    expect(seen.some((u) => u.includes('evil.example'))).toBe(false);
  });

  it('a body that never ends is cut off by the timeout (typed), not waited for forever', async () => {
    const fetchFn = (async (_input: string, init: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"dsmUrl":'));
          init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    const r = await reason(new GoogleSolarLayers({ apiKey: 'k-123', fetch: fetchFn, timeoutMs: 50 }).roofLayers([-92.3, 34.75], 20));
    expect(r).toBe('timeout');
  });

  it('an answer that is not JSON, or huge: typed', async () => {
    const answering = (body: string) => (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    expect(await reason(new GoogleSolarLayers({ apiKey: 'k', fetch: answering('<html>') }).roofLayers([-92.3, 34.75], 20))).toBe('bad-answer');
    expect(await reason(new GoogleSolarLayers({ apiKey: 'k', fetch: answering('x'.repeat(70_000)) }).roofLayers([-92.3, 34.75], 20))).toBe('too-large');
  });

  it('coordinates off the globe are refused before any request', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response('{}');
    }) as unknown as typeof fetch;
    const api = new GoogleSolarLayers({ apiKey: 'k', fetch: fetchFn });
    for (const c of [[Number.NaN, 1], [1, Number.POSITIVE_INFINITY], [200, 10], [10, -95]] as const) expect(await api.roofLayers([c[0], c[1]], 20)).toBeNull();
    expect(calls).toBe(0);
  });
});
