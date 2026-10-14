import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { INDEX_TTL_MS, MicrosoftFootprints, parseDatasetLinks, ringOfLine } from '../src/providers/ms-footprints.ts';

const BASE = 'https://x.test/g/';
const Q = '021332333';
const RING = [
  [-95.93456, 41.256455],
  [-95.93444, 41.256455],
  [-95.93444, 41.256545],
  [-95.93456, 41.256545],
  [-95.93456, 41.256455],
];
const line = (geometry: unknown) => JSON.stringify({ type: 'Feature', properties: { height: 3.4, confidence: -1 }, geometry });
const polygon = (ring: unknown) => line({ type: 'Polygon', coordinates: [ring] });

const INDEX = [
  'Location,QuadKey,Url,Size,UploadDate',
  `Mexico,${Q},https://x.test/g/mx.csv.gz,1KB,2026-02-23`,
  `UnitedStates,${Q},https://x.test/g/a.csv.gz,1KB,2026-02-23`,
  `UnitedStates,${Q},https://x.test/g/b.csv.gz,1KB,2026-02-23`,
  'UnitedStates,021332332,https://x.test/g/c.csv.gz,1KB,2026-02-23',
].join('\r\n');

function source(files: Record<string, () => Response>, now?: () => number): { src: MicrosoftFootprints; urls: string[] } {
  const urls: string[] = [];
  const f = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url === `${BASE}dataset-links.csv`) return new Response(INDEX);
    const make = files[url];
    return make ? make() : new Response('missing', { status: 404 });
  }) as unknown as typeof fetch;
  return { src: new MicrosoftFootprints({ baseUrl: BASE, fetch: f, ...(now ? { now } : {}) }), urls };
}
const gz = (text: string) => () => new Response(new Uint8Array(gzipSync(text)));

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('parseDatasetLinks', () => {
  it('keeps only UnitedStates rows, grouped by quadkey, every row of a quadkey', () => {
    const index = parseDatasetLinks(INDEX);
    expect(index.get(Q)).toEqual(['https://x.test/g/a.csv.gz', 'https://x.test/g/b.csv.gz']);
    expect(index.get('021332332')).toEqual(['https://x.test/g/c.csv.gz']);
    expect(index.size).toBe(2);
  });
});

describe('ringOfLine', () => {
  it('reads the outer ring of a Polygon line', () => {
    expect(ringOfLine(polygon(RING))).toEqual(RING);
  });
  it('skips blank lines, bad JSON, other geometry and unclosed rings', () => {
    expect(ringOfLine('')).toBeNull();
    expect(ringOfLine('{not json')).toBeNull();
    expect(ringOfLine(line({ type: 'Point', coordinates: [-96, 41] }))).toBeNull();
    expect(ringOfLine(line({ type: 'MultiPolygon', coordinates: [[RING]] }))).toBeNull();
    expect(ringOfLine(polygon(RING.slice(0, 4)))).toBeNull();
  });
});

describe('MicrosoftFootprints', () => {
  it('tileUrls reads the index once and answers every file of the tile; an unknown tile has none', async () => {
    const { src, urls } = source({});
    expect(await src.tileUrls(Q)).toEqual(['https://x.test/g/a.csv.gz', 'https://x.test/g/b.csv.gz']);
    expect(await src.tileUrls('000000000')).toEqual([]);
    expect(urls).toEqual([`${BASE}dataset-links.csv`]);
  });

  it('reads the index again after a day', async () => {
    let now = 0;
    const { src, urls } = source({}, () => now);
    await src.tileUrls(Q);
    now = INDEX_TTL_MS + 1;
    await src.tileUrls(Q);
    expect(urls).toEqual([`${BASE}dataset-links.csv`, `${BASE}dataset-links.csv`]);
  });

  it('features streams the polygons of every file of the tile, skipping what is not one', async () => {
    const { src, urls } = source({
      'https://x.test/g/a.csv.gz': gz([polygon(RING), line({ type: 'Point', coordinates: [-96, 41] }), ''].join('\n')),
      'https://x.test/g/b.csv.gz': gz([polygon(RING), polygon(RING.slice(0, 4)), polygon(RING)].join('\n')),
    });
    const got = await collect(src.features(Q));
    expect(urls).toEqual([`${BASE}dataset-links.csv`, 'https://x.test/g/a.csv.gz', 'https://x.test/g/b.csv.gz']);
    expect(got.map((g) => g.sourceRef)).toEqual([`${Q}-0-1`, `${Q}-1-1`, `${Q}-1-3`]);
    for (const g of got) expect(g.ring).toEqual(RING);
  });

  it('a failed index download throws with the status and no response text, and is tried again next time', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return calls === 1 ? new Response('SECRET PROVIDER TEXT', { status: 409 }) : new Response(INDEX);
    }) as unknown as typeof fetch;
    const src = new MicrosoftFootprints({ baseUrl: BASE, fetch: f });
    const err = await src.tileUrls(Q).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toContain('409');
    expect(err?.message).not.toContain('SECRET');
    expect(await src.tileUrls(Q)).toHaveLength(2);
  });

  it('a non-ok file response throws an error whose message has no response text', async () => {
    const { src } = source({ 'https://x.test/g/a.csv.gz': () => new Response('SECRET PROVIDER TEXT', { status: 503 }) });
    const err = await collect(src.features(Q)).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).not.toContain('SECRET');
    expect(err?.message).toContain('503');
  });

  it('a corrupt file throws a plain error', async () => {
    const { src } = source({ 'https://x.test/g/a.csv.gz': () => new Response('this is not gzip at all') });
    const err = await collect(src.features(Q)).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe('The footprint file could not be read.');
  });

  it('a consumer may stop early', async () => {
    const { src } = source({
      'https://x.test/g/a.csv.gz': gz([polygon(RING), polygon(RING)].join('\n')),
      'https://x.test/g/b.csv.gz': gz(polygon(RING)),
    });
    const it = src.features(Q)[Symbol.asyncIterator]();
    expect((await it.next()).done).toBe(false);
    await it.return?.(undefined);
  });
});
