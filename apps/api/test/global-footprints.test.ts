import { gzipSync } from 'node:zlib';
import { US_STATE_CODES, type Ring } from '@roofline/shared';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.ts';
import { footprintFailurePlain, FOOTPRINT_INDEX_FAILED_PLAIN, FOOTPRINT_LOAD_FAILED_PLAIN } from '../src/estimator/footprints-load.ts';
import { createFootprintSource, FootprintIndexError, FootprintTileError } from '../src/providers/footprints.ts';
import {
  featuresFromLines,
  footprintKey,
  GlobalMlFootprints,
  INDEX_TTL_MS,
  parseFeatureLine,
  parseIndexCsv,
  quadkeyBbox,
  readLines,
  tilesForBbox,
} from '../src/providers/global-footprints.ts';
import { MicrosoftFootprints } from '../src/providers/ms-footprints.ts';
import { bboxContains, stateBbox, US_STATE_BBOXES } from '../src/providers/us-state-bboxes.ts';

/* The Global ML footprint source, with small inline fixtures and a fake fetch: no network. */

const INDEX_URL = 'https://idx.test/global-buildings/dataset-links.csv';
const tileUrl = (loc: string, qk: string) => `https://idx.test/global-buildings/RegionName=${loc}/quadkey=${qk}/part-0.csv.gz`;

/** Omaha NE and Council Bluffs IA share 021332333; 021323320 is Scottsbluff NE; 021333230 is Des Moines IA; 032023103 is Miami FL. */
const INDEX_CSV = [
  'Location,QuadKey,Url,Size,UploadDate',
  `Canada,021332333,${tileUrl('Canada', '021332333')},1KB,2026-02-23`,
  `UnitedStates,021332333,${tileUrl('UnitedStates', '021332333')},32.7MB,2026-02-23`,
  `UnitedStates,021323320,${tileUrl('UnitedStates', '021323320')},1.2MB,2026-02-23`,
  `UnitedStates,021333230,${tileUrl('UnitedStates', '021333230')},9.9MB,2026-02-23`,
  `UnitedStates,032023103,${tileUrl('UnitedStates', '032023103')},20MB,2026-02-23`,
  'UnitedStates,notakey,https://idx.test/bad.csv.gz,1KB,2026-02-23',
  'UnitedStates,021332332,ftp://idx.test/ftp.csv.gz,1KB,2026-02-23',
  '',
].join('\r\n');

/** A square about 40 m on a side with its corner at (lng, lat), closed. */
function square(lng: number, lat: number): Ring {
  const d = 0.0004;
  return [
    [lng, lat],
    [lng + d, lat],
    [lng + d, lat + d],
    [lng, lat + d],
    [lng, lat],
  ];
}
const featureLine = (ring: unknown, type = 'Polygon') =>
  JSON.stringify({ type: 'Feature', properties: { height: -1, confidence: -1 }, geometry: { type, coordinates: [ring] } });

const OMAHA = square(-95.94, 41.25);
const COUNCIL_BLUFFS = square(-95.85, 41.25);
/** Inside the shared tile but east of Nebraska's box (Iowa only). */
const EAST_IOWA_IN_TILE = square(-95.2, 41.0);
const SCOTTSBLUFF = square(-103.66, 41.86);

function gz(lines: string[]): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(lines.join('\n') + '\n')));
}

const TILES: Record<string, () => Response> = {
  [tileUrl('UnitedStates', '021332333')]: () =>
    new Response(gz([featureLine(OMAHA), featureLine(COUNCIL_BLUFFS), featureLine(EAST_IOWA_IN_TILE), 'not json', featureLine([[1, 2]], 'Point')])),
  [tileUrl('UnitedStates', '021323320')]: () => new Response(gz([featureLine(SCOTTSBLUFF)])),
};

function fakeFetch(tiles: Record<string, () => Response> = TILES, index: () => Response = () => new Response(INDEX_CSV)) {
  const urls: string[] = [];
  const f = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url === INDEX_URL) return index();
    const tile = tiles[url];
    return tile ? tile() : new Response('PROVIDER SECRET', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, urls };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

async function* chunks(...parts: (string | Uint8Array)[]): AsyncGenerator<string | Uint8Array> {
  for (const p of parts) yield p;
}

describe('US state boxes', () => {
  it('every state and DC has a box that is west-south to east-north', () => {
    for (const code of US_STATE_CODES) {
      const box = US_STATE_BBOXES[code];
      expect(box, code).toBeDefined();
      expect(box![0]).toBeLessThan(box![2]);
      expect(box![1]).toBeLessThan(box![3]);
    }
    expect(Object.keys(US_STATE_BBOXES).sort()).toEqual([...US_STATE_CODES].sort());
  });
  it('Lincoln is only in Nebraska; Omaha and Council Bluffs are in both boxes (they overlap at the river)', () => {
    expect(bboxContains(stateBbox('ne')!, -96.7, 40.8)).toBe(true);
    expect(bboxContains(stateBbox('IA')!, -96.7, 40.8)).toBe(false);
    expect(bboxContains(stateBbox('NE')!, -96.0, 41.26)).toBe(true);
    expect(bboxContains(stateBbox('IA')!, -96.0, 41.26)).toBe(true);
    expect(bboxContains(stateBbox('NE')!, -95.86, 41.26)).toBe(true);
    expect(bboxContains(stateBbox('IA')!, -95.86, 41.26)).toBe(true);
    expect(stateBbox('PR')).toBeNull();
  });
});

describe('parseIndexCsv', () => {
  it('reads Location, QuadKey and Url by header name, skipping bad keys, non-http URLs and blank lines', () => {
    const rows = parseIndexCsv(INDEX_CSV, INDEX_URL);
    expect(rows.map((r) => `${r.location}:${r.quadkey}`)).toEqual([
      'Canada:021332333',
      'UnitedStates:021332333',
      'UnitedStates:021323320',
      'UnitedStates:021333230',
      'UnitedStates:032023103',
    ]);
    expect(rows[1]!.url).toBe(tileUrl('UnitedStates', '021332333'));
  });
  it('finds the columns in any order and resolves relative URLs against the index', () => {
    const rows = parseIndexCsv('Url,QuadKey,Location\nparts/a.csv.gz,0213,UnitedStates\n', INDEX_URL);
    expect(rows).toEqual([{ location: 'UnitedStates', quadkey: '0213', url: 'https://idx.test/global-buildings/parts/a.csv.gz' }]);
  });
  it('an unexpected header is an index error', () => {
    expect(() => parseIndexCsv('<html>nope</html>', INDEX_URL)).toThrow(FootprintIndexError);
  });
});

describe('quadkeyBbox and tile selection', () => {
  it('maps quadkeys to Web Mercator tile boxes', () => {
    const world = quadkeyBbox('0');
    expect(world[0]).toBe(-180);
    expect(world[2]).toBe(0);
    expect(world[1]).toBeCloseTo(0, 9);
    expect(world[3]).toBeCloseTo(85.0511, 3);
    const omaha = quadkeyBbox('021332333');
    expect(bboxContains(omaha, -96.0, 41.26)).toBe(true);
    expect(bboxContains(omaha, -95.86, 41.26)).toBe(true);
    expect(omaha[2] - omaha[0]).toBeCloseTo(360 / 512, 9);
  });
  it("picks the UnitedStates tiles that meet the state's box, not other countries or far tiles", () => {
    const rows = parseIndexCsv(INDEX_CSV, INDEX_URL);
    expect(tilesForBbox(rows, stateBbox('NE')!).map((r) => r.quadkey)).toEqual(['021323320', '021332333']);
    expect(tilesForBbox(rows, stateBbox('NE')!).every((r) => r.location === 'UnitedStates')).toBe(true);
    // Iowa shares the Omaha tile with Nebraska.
    expect(tilesForBbox(rows, stateBbox('IA')!).map((r) => r.quadkey)).toEqual(['021332333', '021333230']);
    expect(tilesForBbox(rows, stateBbox('FL')!).map((r) => r.quadkey)).toEqual(['032023103']);
    expect(tilesForBbox(rows, stateBbox('WA')!)).toEqual([]);
  });
});

describe('gz line parsing', () => {
  it('readLines splits across chunk boundaries and multi-byte characters, skipping blank lines', async () => {
    const bytes = Buffer.from('é');
    const lines = await collect(readLines(chunks('a\nb', 'c\n\n', bytes.subarray(0, 1), bytes.subarray(1), '\r\nlast')));
    expect(lines).toEqual(['a', 'bc', 'é\r', 'last']);
  });
  it('parseFeatureLine keeps the outer ring of a Polygon, closes an open one, and rejects the rest', () => {
    expect(parseFeatureLine(featureLine(OMAHA))).toEqual(OMAHA);
    expect(parseFeatureLine(featureLine(OMAHA.slice(0, 4)))).toEqual(OMAHA);
    expect(parseFeatureLine(featureLine(OMAHA.map(([x, y]) => [x, y, 12])))).toEqual(OMAHA);
    expect(parseFeatureLine(featureLine(OMAHA, 'MultiPolygon'))).toBeNull();
    expect(parseFeatureLine(featureLine([[0, 0], [1, 1], [0, 0]]))).toBeNull();
    expect(parseFeatureLine(featureLine([[0, 0], ['x', 1], [1, 0], [0, 0]]))).toBeNull();
    expect(parseFeatureLine('{"type":"Feature","geometry":null}')).toBeNull();
    expect(parseFeatureLine('not json')).toBeNull();
  });
  it("featuresFromLines keeps the buildings whose centre is in the state's box, keyed by an outline hash", async () => {
    const lines = chunks(featureLine(OMAHA), featureLine(EAST_IOWA_IN_TILE), featureLine(COUNCIL_BLUFFS));
    async function* asLines() {
      for await (const l of lines) yield String(l);
    }
    const got = await collect(featuresFromLines(asLines(), stateBbox('NE')!));
    expect(got.map((g) => g.ring)).toEqual([OMAHA, COUNCIL_BLUFFS]);
    expect(got[0]!.sourceRef).toBe(footprintKey(OMAHA));
    expect(got[0]!.sourceRef).toMatch(/^gml:[0-9a-f]{40}$/);
  });
  it('footprintKey is stable for the same outline and differs for another', () => {
    expect(footprintKey(square(-96, 41))).toBe(footprintKey(square(-96, 41)));
    expect(footprintKey(square(-96, 41))).not.toBe(footprintKey(square(-96.0001, 41)));
  });
});

describe('GlobalMlFootprints', () => {
  it('stateFileUrl names the index and the state; an unknown state throws', () => {
    const src = new GlobalMlFootprints({ indexUrl: INDEX_URL, fetch: fakeFetch().f });
    expect(src.stateFileUrl('ne')).toBe(`${INDEX_URL}#NE`);
    expect(() => src.stateFileUrl('ZZ')).toThrow("Building footprints aren't available for that state.");
  });

  it("streams NE's buildings from its two tiles, fetching the index once for several states", async () => {
    const { f, urls } = fakeFetch();
    const src = new GlobalMlFootprints({ indexUrl: INDEX_URL, fetch: f });
    const ne = await collect(src.features('NE'));
    expect(ne.map((x) => x.ring)).toEqual([SCOTTSBLUFF, OMAHA, COUNCIL_BLUFFS]);
    expect(urls).toEqual([INDEX_URL, tileUrl('UnitedStates', '021323320'), tileUrl('UnitedStates', '021332333')]);

    // Iowa reads the shared tile again (its Des Moines tile is missing here, so it fails) without another index fetch.
    await expect(collect(src.features('IA'))).rejects.toBeInstanceOf(FootprintTileError);
    expect(urls.filter((u) => u === INDEX_URL)).toHaveLength(1);
  });

  it('re-reads the index after a day, and does not keep a failed index fetch', async () => {
    let now = 0;
    let fail = true;
    const { f, urls } = fakeFetch(TILES, () => (fail ? new Response('PROVIDER SECRET', { status: 503 }) : new Response(INDEX_CSV)));
    const src = new GlobalMlFootprints({ indexUrl: INDEX_URL, fetch: f, now: () => now });
    const err = await src.usRows().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(FootprintIndexError);
    expect(err!.message).toContain('503');
    expect(err!.message).not.toContain('SECRET');
    fail = false;
    expect(await src.usRows()).toHaveLength(4);
    expect(await src.usRows()).toHaveLength(4);
    expect(urls).toHaveLength(2);
    now = INDEX_TTL_MS + 1;
    await src.usRows();
    expect(urls).toHaveLength(3);
  });

  it('a missing tile fails the load with a tile error that names the quadkey and carries no provider text', async () => {
    const { f } = fakeFetch({ [tileUrl('UnitedStates', '021323320')]: TILES[tileUrl('UnitedStates', '021323320')]! });
    const src = new GlobalMlFootprints({ indexUrl: INDEX_URL, fetch: f });
    const err = await collect(src.features('NE')).then(
      () => null,
      (e: unknown) => e as FootprintTileError,
    );
    expect(err).toBeInstanceOf(FootprintTileError);
    expect(err!.quadkey).toBe('021332333');
    expect(err!.message).not.toContain('SECRET');
    expect(footprintFailurePlain(err)).toContain('021332333');
  });

  it('a corrupt gzip or a stalled download is a tile error', async () => {
    const corrupt = fakeFetch({
      [tileUrl('UnitedStates', '021323320')]: () => new Response(Buffer.from('this is not gzip at all')),
    });
    await expect(collect(new GlobalMlFootprints({ indexUrl: INDEX_URL, fetch: corrupt.f }).features('NE'))).rejects.toBeInstanceOf(
      FootprintTileError,
    );

    const stalled = (async (input: unknown, init?: RequestInit) => {
      if (String(input) === INDEX_URL) return new Response(INDEX_CSV);
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      });
      return new Response(body);
    }) as unknown as typeof fetch;
    const src = new GlobalMlFootprints({ indexUrl: INDEX_URL, fetch: stalled, idleTimeoutMs: 50 });
    const err = await collect(src.features('NE')).then(
      () => null,
      (e: unknown) => e as FootprintTileError,
    );
    expect(err).toBeInstanceOf(FootprintTileError);
    expect(err!.message).toContain('stopped sending data');
  });

  it('an index with no US rows, or no tiles for the state, is an index error rather than an empty ready state', async () => {
    const noUs = fakeFetch(TILES, () => new Response('Location,QuadKey,Url\nCanada,0213,https://idx.test/a.csv.gz\n'));
    await expect(collect(new GlobalMlFootprints({ indexUrl: INDEX_URL, fetch: noUs.f }).features('NE'))).rejects.toBeInstanceOf(
      FootprintIndexError,
    );
    await expect(collect(new GlobalMlFootprints({ indexUrl: INDEX_URL, fetch: fakeFetch().f }).features('WA'))).rejects.toBeInstanceOf(
      FootprintIndexError,
    );
  });
});

describe('footprintFailurePlain', () => {
  it('names the tile, the index, or falls back to the general sentence', () => {
    expect(footprintFailurePlain(new FootprintTileError('021332333', 'x'))).toBe(
      "We couldn't download part of the building outlines for this state (map tile 021332333). We'll try again.",
    );
    expect(footprintFailurePlain(new FootprintTileError('<b>', 'x'))).toBe(FOOTPRINT_LOAD_FAILED_PLAIN);
    expect(footprintFailurePlain(new FootprintIndexError('x'))).toBe(FOOTPRINT_INDEX_FAILED_PLAIN);
    expect(footprintFailurePlain(new Error('PROVIDER SECRET'))).toBe(FOOTPRINT_LOAD_FAILED_PLAIN);
  });
});

describe('createFootprintSource', () => {
  const cfg = (o: object) => ({ NODE_ENV: 'test', FAKE_PROVIDERS: false, ...o }) as unknown as Config;
  it('uses the Global ML index by default, and the legacy per-state zips only when FOOTPRINTS_BASE_URL is set', () => {
    expect(createFootprintSource(cfg({ FOOTPRINTS_INDEX_URL: INDEX_URL }))).toBeInstanceOf(GlobalMlFootprints);
    expect(createFootprintSource(cfg({ FOOTPRINTS_INDEX_URL: INDEX_URL, FOOTPRINTS_BASE_URL: 'https://m.test/' }))).toBeInstanceOf(
      MicrosoftFootprints,
    );
  });
});
