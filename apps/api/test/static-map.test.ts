import { describe, expect, test } from 'vitest';
import type { Config } from '../src/config.ts';
import { FakeStaticMap, TINY_PNG } from '../src/providers/fakes/static-map.ts';
import { createStaticMap, MapTilerStaticMap, UnconfiguredStaticMap } from '../src/providers/static-map.ts';

const KEY = 'test-key-not-real';
const okFetch = (urls: string[]): typeof fetch =>
  (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(TINY_PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;

describe('MapTilerStaticMap', () => {
  test('returns bytes on an ok image response and asks for the center', async () => {
    const urls: string[] = [];
    const map = new MapTilerStaticMap({ key: KEY, fetch: okFetch(urls) });
    const out = await map.image({ center: [-96.8, 32.78] });
    expect(out).not.toBeNull();
    expect(out!.length).toBe(TINY_PNG.length);
    expect(urls[0]).toContain('/static/-96.8,32.78,');
  });
  test('adds a path when there are two or more points', async () => {
    const urls: string[] = [];
    const map = new MapTilerStaticMap({ key: KEY, fetch: okFetch(urls) });
    await map.image({ center: [-96.8, 32.78], path: [[-96.8, 32.78], [-96.79, 32.79]] });
    expect(urls[0]).toContain('&path=');
  });
  test('returns null on a 500', async () => {
    const f = (async () => new Response('no', { status: 500 })) as typeof fetch;
    expect(await new MapTilerStaticMap({ key: KEY, fetch: f }).image({ center: [0, 0] })).toBeNull();
  });
  test('returns null when the content type is not an image', async () => {
    const f = (async () => new Response('x', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
    expect(await new MapTilerStaticMap({ key: KEY, fetch: f }).image({ center: [0, 0] })).toBeNull();
  });
  test('returns null when fetch throws, and nothing leaks the key', async () => {
    const f = (async (url: string | URL | Request) => {
      throw new Error(`failed ${String(url)}`);
    }) as typeof fetch;
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a);
    try {
      expect(await new MapTilerStaticMap({ key: KEY, fetch: f }).image({ center: [0, 0] })).toBeNull();
    } finally {
      console.error = orig;
    }
    expect(JSON.stringify(errors)).not.toContain(KEY);
  });
});

describe('createStaticMap', () => {
  test('FAKE_PROVIDERS gives the fake', () => {
    expect(createStaticMap({ FAKE_PROVIDERS: true } as unknown as Config)).toBeInstanceOf(FakeStaticMap);
  });
  test('a key gives MapTiler', () => {
    expect(createStaticMap({ FAKE_PROVIDERS: false, MAPTILER_SERVER_KEY: KEY } as unknown as Config)).toBeInstanceOf(MapTilerStaticMap);
  });
  test('no key gives the unconfigured map, which answers null', async () => {
    const m = createStaticMap({ FAKE_PROVIDERS: false, MAPTILER_SERVER_KEY: undefined } as unknown as Config);
    expect(m).toBeInstanceOf(UnconfiguredStaticMap);
    expect(await m.image({ center: [0, 0] })).toBeNull();
  });
});
