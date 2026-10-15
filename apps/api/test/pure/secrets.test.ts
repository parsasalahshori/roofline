import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { roof3dAt } from '../../src/estimator/roof-3d.ts';
import { GoogleSolarLayers } from '../../src/providers/google-solar-layers.ts';
import { describeErrorForLog } from '../../src/errors.ts';
import { pureDeps } from './helpers.ts';
import { heightTiff, maskTiff, rgbTiff } from './tiffs.ts';

/*
 * Google's Data Layers URLs carry the API key. Whatever happens (success, every failure the client knows), nothing a
 * Measure logs, counts, keeps or throws may contain the key or a full Google URL. The test captures every console
 * channel, the app's error log, the roof-3d events and the snapshot, and greps them.
 */

const KEY = 'test-solar-key-not-real-0123456789';
const GOOGLE = 'googleapis.com';

let captured: string[] = [];
const channels = ['log', 'info', 'warn', 'error', 'debug'] as const;

beforeEach(() => {
  captured = [];
  for (const ch of channels) vi.spyOn(console, ch).mockImplementation((...args: unknown[]) => captured.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : JSON.stringify(a))).join(' ')));
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A Google that answers the given way; every URL it was asked is recorded (they do hold the key: that is the point). */
function google(mode: 'ok' | 'http-500' | 'throws-with-url' | 'bad-tiff' | 'no-imagery' | 'slow'): typeof fetch {
  const g = { width: 120, height: 120 };
  return (async (input: string, init: RequestInit) => {
    const url = String(input);
    if (mode === 'throws-with-url') throw new TypeError(`fetch failed: ${url}`);
    if (mode === 'http-500') return new Response(`internal error for ${url}`, { status: 500 });
    if (mode === 'no-imagery') return new Response(JSON.stringify({ error: { code: 404, message: url } }), { status: 404 });
    if (mode === 'slow') {
      return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error(`aborted ${url}`))));
    }
    if (url.includes('dataLayers:get')) {
      return new Response(JSON.stringify({ dsmUrl: `https://solar.${GOOGLE}/v1/geoTiff:get?id=d`, maskUrl: `https://solar.${GOOGLE}/v1/geoTiff:get?id=m`, rgbUrl: `https://solar.${GOOGLE}/v1/geoTiff:get?id=r`, imageryQuality: 'HIGH' }));
    }
    if (mode === 'bad-tiff') return new Response(`not a tiff ${url}`);
    const bytes = url.includes('id=d') ? heightTiff(g, (i) => 3 + ((i % 120) < 60 ? (i % 120) / 20 : (120 - (i % 120)) / 20)) : url.includes('id=m') ? maskTiff(g, (i) => ((i % 120) > 20 && (i % 120) < 100 && i > 20 * 120 && i < 100 * 120 ? 1 : 0)) : rgbTiff(g);
    return new Response(bytes);
  }) as unknown as typeof fetch;
}

describe('secrets never reach logs, errors, counters or snapshots', () => {
  for (const mode of ['ok', 'http-500', 'throws-with-url', 'bad-tiff', 'no-imagery', 'slow'] as const) {
    it(`Data Layers ${mode}`, async () => {
      const api = new GoogleSolarLayers({ apiKey: KEY, fetch: google(mode), timeoutMs: 30 });
      // Events go to the real console sink (as in production), which is captured.
      const { deps, events, errors } = pureDeps(api, { nodeEnv: 'production', collect: false });
      const snap = await roof3dAt(deps, [-92.31, 34.75], null);
      const thrown = await api.roofLayers([-92.31, 34.75], 20).then(
        () => null,
        (e: unknown) => e,
      );
      const everything = [
        ...captured,
        JSON.stringify(snap),
        JSON.stringify(events),
        ...errors.map((e) => describeErrorForLog(e)),
        thrown === null ? '' : `${(thrown as Error).message} ${(thrown as Error).stack ?? ''} ${String((thrown as Error).cause ?? '')} ${JSON.stringify(thrown)}`,
      ].join('\n');
      // The capture works: the roof-3d outcome line reached the console.
      expect(captured.some((line) => line.includes('roof-3d'))).toBe(true);
      expect(everything).not.toContain(KEY);
      expect(everything).not.toContain(encodeURIComponent(KEY));
      expect(everything).not.toContain(GOOGLE);
    });
  }

  it('the source never logs a URL or the key from the providers (a static check over the files that build them)', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const file of ['../../src/providers/google-solar-layers.ts', '../../src/estimator/roof-3d.ts', '../../src/estimator/roof-3d-events.ts']) {
      const text = await readFile(new URL(file, import.meta.url), 'utf8');
      expect(text, file).not.toMatch(/console\.\w+\([^)]*(url|apiKey|withKey)/i);
      expect(text, file).not.toMatch(/new \w*Error\([^)]*(url|apiKey|withKey)/i);
      expect(text, file).not.toMatch(/cause:/);
    }
  });
});
