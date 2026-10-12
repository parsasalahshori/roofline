import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { FootprintsUnavailableError } from '../src/providers/footprints.ts';
import { MicrosoftFootprints, TMP_PREFIX } from '../src/providers/ms-footprints.ts';

const ZIP = new URL('./fixtures/footprints/NE.geojson.zip', import.meta.url);
const BASE = 'https://x.test/b/';

function source(body: () => Response): { src: MicrosoftFootprints; urls: string[] } {
  const urls: string[] = [];
  const f = (async (input: unknown) => {
    urls.push(String(input));
    return body();
  }) as unknown as typeof fetch;
  return { src: new MicrosoftFootprints({ baseUrl: BASE, fetch: f }), urls };
}
const okZip = () => new Response(readFileSync(ZIP));
const mine = () => readdirSync(tmpdir()).filter((n) => n.startsWith(TMP_PREFIX));

async function collect(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('MicrosoftFootprints', () => {
  const { src } = source(okZip);
  it('stateFileUrl maps NE to Nebraska.geojson.zip', () => {
    expect(src.stateFileUrl('NE')).toBe('https://x.test/b/Nebraska.geojson.zip');
  });
  it('DC maps to DistrictofColumbia', () => {
    expect(src.stateFileUrl('dc')).toBe('https://x.test/b/DistrictofColumbia.geojson.zip');
  });
  it('NY maps to NewYork', () => {
    expect(src.stateFileUrl('NY')).toBe('https://x.test/b/NewYork.geojson.zip');
  });
  it('unknown state throws', () => {
    expect(() => src.stateFileUrl('ZZ')).toThrow(FootprintsUnavailableError);
  });

  it('features streams the 6 polygons of the NE fixture, skipping the multipolygon, the point and the unclosed ring', async () => {
    const { src: s, urls } = source(okZip);
    const got = (await collect(s.features('NE'))) as { sourceRef: string; ring: number[][] }[];
    expect(urls).toEqual(['https://x.test/b/Nebraska.geojson.zip']);
    expect(got.map((g) => g.sourceRef)).toEqual([1, 2, 3, 4, 5, 6].map((i) => `fake-ne-${i}`));
    for (const g of got) {
      expect(g.ring.length).toBeGreaterThanOrEqual(4);
      expect(g.ring[0]).toEqual(g.ring[g.ring.length - 1]);
    }
  });

  it('a non-ok response throws an error whose message has no response text', async () => {
    const { src: s } = source(() => new Response('SECRET PROVIDER TEXT', { status: 503 }));
    const err = await collect(s.features('NE')).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).not.toContain('SECRET');
    expect(err?.message).toContain('503');
  });

  it('no temp files are left', async () => {
    const before = mine();
    const { src: s } = source(okZip);
    await collect(s.features('NE'));
    // early stop by the consumer
    const it = s.features('NE');
    await it.next();
    await it.return(undefined);
    expect(mine()).toEqual(before);
  });

  it('a corrupt zip throws and cleans up', async () => {
    const before = mine();
    const { src: s } = source(() => new Response(Buffer.from('this is not a zip file at all')));
    const err = await collect(s.features('NE')).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(mine()).toEqual(before);
  });
});
