import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type { Ring } from '@roofline/shared';
import type { Config } from '../config.ts';
import type { FootprintFeature, FootprintSource } from './footprints.ts';

/*
 * Microsoft Global ML Building Footprints (ODbL), tiled by zoom-9 Bing quadkey. The dataset's index,
 * `<base>dataset-links.csv` (Location,QuadKey,Url,Size,UploadDate), names each tile's files; a quadkey
 * may have several rows. Each file is a gzipped text file with one GeoJSON Feature per line
 * (a Polygon in lng/lat, no id). Only Location=UnitedStates rows are used.
 */

/** The index's Location for US tiles. */
export const US_LOCATION = 'UnitedStates';
/** The index is read again after this long, so a long-running worker sees newly published tiles. */
export const INDEX_TTL_MS = 24 * 60 * 60 * 1000;
const INDEX_TIMEOUT_MS = 60_000;

type TileIndex = Map<string, string[]>;

/** The US rows of the index text, grouped by quadkey (in file order). */
export function parseDatasetLinks(text: string): TileIndex {
  const index: TileIndex = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(`${US_LOCATION},`)) continue;
    const [, quadkey, url] = line.split(',');
    if (!quadkey || !url || !/^https?:\/\//.test(url)) continue;
    const urls = index.get(quadkey) ?? [];
    urls.push(url);
    index.set(quadkey, urls);
  }
  return index;
}

function isRing(v: unknown): v is Ring {
  if (
    !(
      Array.isArray(v) &&
      v.length >= 4 &&
      v.every(
        (p) =>
          Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]),
      )
    )
  )
    return false;
  const a = v[0] as number[];
  const b = v[v.length - 1] as number[];
  return a[0] === b[0] && a[1] === b[1];
}

/** The outer ring of one line's Polygon feature, or null for anything else (blank, bad JSON, other geometry). */
export function ringOfLine(line: string): Ring | null {
  const text = line.trim();
  if (text === '') return null;
  let f: { geometry?: { type?: string; coordinates?: unknown[] } | null } | null;
  try {
    f = JSON.parse(text) as typeof f;
  } catch {
    return null;
  }
  if (f?.geometry?.type !== 'Polygon') return null;
  const ring = f.geometry.coordinates?.[0];
  if (!isRing(ring)) return null;
  return ring.map((p) => [p[0], p[1]] as [number, number]);
}

export class MicrosoftFootprints implements FootprintSource {
  readonly configured = true;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private index: { at: number; value: Promise<TileIndex> } | null = null;

  constructor(o: { baseUrl: string; fetch?: typeof fetch; now?: () => number }) {
    this.baseUrl = o.baseUrl.endsWith('/') ? o.baseUrl : `${o.baseUrl}/`;
    this.fetchImpl = o.fetch ?? ((...a) => fetch(...a));
    this.now = o.now ?? (() => Date.now());
  }

  get indexUrl(): string {
    return `${this.baseUrl}dataset-links.csv`;
  }

  /** The tile index, downloaded once per process (and again after INDEX_TTL_MS). A failed download is not kept. */
  private tileIndex(): Promise<TileIndex> {
    const now = this.now();
    if (this.index !== null && now - this.index.at < INDEX_TTL_MS) return this.index.value;
    const value = (async () => {
      const res = await this.fetchImpl(this.indexUrl, { signal: AbortSignal.timeout(INDEX_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`The footprint index download failed with status ${res.status}.`);
      return parseDatasetLinks(await res.text());
    })();
    const entry = { at: now, value };
    this.index = entry;
    value.catch(() => {
      if (this.index === entry) this.index = null;
    });
    return value;
  }

  async tileUrls(quadkey: string): Promise<string[]> {
    return [...((await this.tileIndex()).get(quadkey) ?? [])];
  }

  async *features(quadkey: string): AsyncGenerator<FootprintFeature> {
    const urls = await this.tileUrls(quadkey);
    for (const [fileNo, url] of urls.entries()) {
      const res = await this.fetchImpl(url);
      if (!res.ok) throw new Error(`The footprint download failed with status ${res.status}.`);
      if (!res.body) throw new Error('The footprint download came back empty.');
      const body = Readable.fromWeb(res.body as never);
      const gunzip = createGunzip();
      // A gunzip error (a corrupt file) must reach the reader below, not crash the process.
      body.on('error', (err) => gunzip.destroy(err));
      const lines = createInterface({ input: body.pipe(gunzip), crlfDelay: Infinity });
      try {
        let lineNo = 0;
        for await (const line of lines) {
          lineNo++;
          const ring = ringOfLine(line);
          if (ring === null) continue;
          yield { sourceRef: `${quadkey}-${fileNo}-${lineNo}`, ring };
        }
      } catch (err) {
        throw new Error('The footprint file could not be read.', { cause: err });
      } finally {
        lines.close();
        gunzip.destroy();
        body.destroy();
      }
    }
  }
}

export function msFootprintsFor(config: Config): FootprintSource | null {
  if (!config.FOOTPRINTS_BASE_URL) return null;
  return new MicrosoftFootprints({ baseUrl: config.FOOTPRINTS_BASE_URL });
}
