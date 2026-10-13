import { createHash } from 'node:crypto';
import { Readable, pipeline } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip } from 'node:zlib';
import type { LngLat, Ring } from '@roofline/shared';
import type { Config } from '../config.ts';
import { FootprintIndexError, FootprintsUnavailableError, FootprintTileError } from './footprints.ts';
import type { FootprintFeature, FootprintSource } from './footprints.ts';
import { bboxContains, bboxesIntersect, stateBbox, type BBox } from './us-state-bboxes.ts';

/*
 * Microsoft Global ML Building Footprints (ODbL). The dataset is listed in one CSV index
 * (`Location,QuadKey,Url,Size,UploadDate`); each row is a gzip of GeoJSON lines (one Feature per line)
 * for one country and one zoom-9 quadkey tile. A state's load reads every UnitedStates tile whose
 * box meets the state's box, and keeps the buildings whose centre lies in that box. Tiles and boxes
 * cross state lines, so a building can be offered to two states: its sourceRef is a hash of its
 * outline, and insertFootprints skips one that is already stored.
 */

/** The index rows that hold US buildings. */
export const US_LOCATION = 'UnitedStates';
/** The index changes rarely (a new release every few months): re-read it once a day. */
export const INDEX_TTL_MS = 24 * 60 * 60 * 1000;
/** A download that sends nothing for this long is abandoned (the tile, and so the state, fails). */
export const IDLE_TIMEOUT_MS = 2 * 60 * 1000;
/** A line longer than this is not a building: the file is treated as broken. */
export const MAX_LINE_CHARS = 8 * 1024 * 1024;

export type IndexRow = { location: string; quadkey: string; url: string };

/**
 * Parses the index CSV (header row first; columns found by name). Rows with a quadkey that is not
 * base-4 digits or a URL that is not http(s) are skipped. Relative URLs resolve against `baseUrl`.
 */
export function parseIndexCsv(text: string, baseUrl: string): IndexRow[] {
  const lines = text.split(/\r?\n/);
  const header = (lines[0] ?? '').split(',').map((h) => h.trim().toLowerCase());
  const loc = header.indexOf('location');
  const qk = header.indexOf('quadkey');
  const u = header.indexOf('url');
  if (loc < 0 || qk < 0 || u < 0) throw new FootprintIndexError('The footprint index has an unexpected layout.');
  const rows: IndexRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const cells = line.split(',');
    const location = cells[loc]?.trim() ?? '';
    const quadkey = cells[qk]?.trim() ?? '';
    const raw = cells[u]?.trim() ?? '';
    if (!/^[0-3]{1,23}$/.test(quadkey) || location === '' || raw === '') continue;
    let url: URL;
    try {
      url = new URL(raw, baseUrl);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    rows.push({ location, quadkey, url: url.toString() });
  }
  return rows;
}

/** The tile's box, [west, south, east, north] (Web Mercator tiling, as Bing quadkeys use). */
export function quadkeyBbox(quadkey: string): BBox {
  let x = 0;
  let y = 0;
  const z = quadkey.length;
  for (let i = 0; i < z; i++) {
    const digit = Number(quadkey[i]);
    const bit = 1 << (z - i - 1);
    if (digit & 1) x |= bit;
    if (digit & 2) y |= bit;
  }
  const n = 2 ** z;
  const lng = (tx: number) => (tx / n) * 360 - 180;
  const lat = (ty: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI;
  return [lng(x), lat(y + 1), lng(x + 1), lat(y)];
}

/** The UnitedStates rows whose tile meets `box`, ordered by quadkey (each URL once). */
export function tilesForBbox(rows: readonly IndexRow[], box: BBox): IndexRow[] {
  const seen = new Set<string>();
  return rows
    .filter((r) => r.location === US_LOCATION && bboxesIntersect(quadkeyBbox(r.quadkey), box))
    .filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)))
    .sort((a, b) => (a.quadkey < b.quadkey ? -1 : a.quadkey > b.quadkey ? 1 : a.url.localeCompare(b.url)));
}

/** Splits a byte (or text) stream into non-blank lines without holding more than one line plus one chunk. */
export async function* readLines(chunks: AsyncIterable<Buffer | Uint8Array | string>): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let rest = '';
  for await (const chunk of chunks) {
    rest += typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk));
    let start = 0;
    let nl: number;
    while ((nl = rest.indexOf('\n', start)) >= 0) {
      const line = rest.slice(start, nl);
      start = nl + 1;
      if (line.trim() !== '') yield line;
    }
    rest = rest.slice(start);
    if (rest.length > MAX_LINE_CHARS) throw new Error('A footprint line is too long.');
  }
  rest += decoder.end();
  if (rest.trim() !== '') yield rest;
}

function toPoint(p: unknown): LngLat | null {
  if (!Array.isArray(p) || p.length < 2) return null;
  const [lng, lat] = p as unknown[];
  if (typeof lng !== 'number' || typeof lat !== 'number' || !Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

/**
 * The outer ring of a GeoJSON line holding a Polygon Feature (closed if the file left it open), or
 * null for anything else: bad JSON, another geometry type, fewer than three distinct corners.
 */
export function parseFeatureLine(line: string): Ring | null {
  let f: { geometry?: { type?: unknown; coordinates?: unknown } | null } | null;
  try {
    f = JSON.parse(line) as typeof f;
  } catch {
    return null;
  }
  if (f?.geometry?.type !== 'Polygon' || !Array.isArray(f.geometry.coordinates)) return null;
  const outer: unknown = f.geometry.coordinates[0];
  if (!Array.isArray(outer)) return null;
  const ring: Ring = [];
  for (const p of outer) {
    const pt = toPoint(p);
    if (pt === null) return null;
    ring.push(pt);
  }
  if (ring.length < 3) return null;
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return ring.length >= 4 ? ring : null;
}

/** The mean of the ring's corners (the closing corner counted once): a cheap centre for the state-box test. */
export function ringCentre(ring: Ring): LngLat {
  const n = ring.length - 1;
  let lng = 0;
  let lat = 0;
  for (let i = 0; i < n; i++) {
    lng += ring[i]![0];
    lat += ring[i]![1];
  }
  return [lng / n, lat / n];
}

/**
 * A stable key for a building: a hash of its outline. The same building read from the same tile
 * for two states (or twice) gets the same key, which is what insertFootprints dedupes on.
 */
export function footprintKey(ring: Ring): string {
  return `gml:${createHash('sha1').update(JSON.stringify(ring)).digest('hex')}`;
}

/** The buildings of a stream of GeoJSON lines whose centre lies in `box`. */
export async function* featuresFromLines(lines: AsyncIterable<string>, box: BBox): AsyncGenerator<FootprintFeature> {
  for await (const line of lines) {
    const ring = parseFeatureLine(line);
    if (ring === null) continue;
    const [lng, lat] = ringCentre(ring);
    if (!bboxContains(box, lng, lat)) continue;
    yield { sourceRef: footprintKey(ring), ring };
  }
}

export class GlobalMlFootprints implements FootprintSource {
  readonly configured = true;
  private readonly indexUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private index: { at: number; rows: Promise<IndexRow[]> } | null = null;

  constructor(o: { indexUrl: string; fetch?: typeof fetch; now?: () => number; idleTimeoutMs?: number }) {
    this.indexUrl = o.indexUrl;
    this.fetchImpl = o.fetch ?? ((...a) => fetch(...a));
    this.now = o.now ?? Date.now;
    this.idleTimeoutMs = o.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  }

  stateFileUrl(state: string): string {
    const s = state.trim().toUpperCase();
    if (stateBbox(s) === null) throw new FootprintsUnavailableError("Building footprints aren't available for that state.");
    return `${this.indexUrl}#${s}`;
  }

  /** The UnitedStates index rows, fetched once and kept for INDEX_TTL_MS. A failed fetch is not kept. */
  usRows(): Promise<IndexRow[]> {
    if (this.index === null || this.now() - this.index.at > INDEX_TTL_MS) {
      const rows = this.fetchIndex();
      const entry = { at: this.now(), rows };
      this.index = entry;
      rows.catch(() => {
        if (this.index === entry) this.index = null;
      });
    }
    return this.index.rows;
  }

  private async fetchIndex(): Promise<IndexRow[]> {
    let text: string;
    try {
      const res = await this.fetchImpl(this.indexUrl, { signal: AbortSignal.timeout(this.idleTimeoutMs) });
      if (!res.ok) throw new FootprintIndexError(`The footprint index download failed with status ${res.status}.`);
      text = await res.text();
    } catch (err) {
      if (err instanceof FootprintIndexError) throw err;
      throw new FootprintIndexError('The footprint index could not be downloaded.');
    }
    const rows = parseIndexCsv(text, this.indexUrl).filter((r) => r.location === US_LOCATION);
    if (rows.length === 0) throw new FootprintIndexError('The footprint index lists no US files.');
    return rows;
  }

  /** The tiles a state's load reads. */
  async tilesFor(state: string): Promise<IndexRow[]> {
    const box = stateBbox(state);
    if (box === null) throw new FootprintsUnavailableError("Building footprints aren't available for that state.");
    return tilesForBbox(await this.usRows(), box);
  }

  async *features(state: string): AsyncGenerator<FootprintFeature> {
    const box = stateBbox(state);
    if (box === null) throw new FootprintsUnavailableError("Building footprints aren't available for that state.");
    const tiles = await this.tilesFor(state);
    if (tiles.length === 0) throw new FootprintIndexError('The footprint index lists no files for this state.');
    for (const tile of tiles) yield* this.tileFeatures(tile, box);
  }

  /** One tile's buildings in `box`, streamed: download, gunzip and line split never hold the whole file. */
  async *tileFeatures(tile: IndexRow, box: BBox): AsyncGenerator<FootprintFeature> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.idleTimeoutMs);
    let source: Readable | null = null;
    const gunzip = createGunzip();
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(tile.url, { signal: abort.signal });
      } catch {
        throw new FootprintTileError(tile.quadkey, `Footprint tile ${tile.quadkey} could not be downloaded.`);
      }
      if (!res.ok) throw new FootprintTileError(tile.quadkey, `Footprint tile ${tile.quadkey} download failed with status ${res.status}.`);
      if (!res.body) throw new FootprintTileError(tile.quadkey, `Footprint tile ${tile.quadkey} came back empty.`);
      source = Readable.fromWeb(res.body as never);
      pipeline(source, gunzip, () => {});
      const unzipped = gunzip;
      async function* watched(): AsyncGenerator<Buffer> {
        for await (const chunk of unzipped) {
          timer.refresh();
          yield chunk as Buffer;
        }
      }
      try {
        yield* featuresFromLines(readLines(watched()), box);
      } catch (err) {
        if (abort.signal.aborted) throw new FootprintTileError(tile.quadkey, `Footprint tile ${tile.quadkey} stopped sending data.`);
        if (err instanceof Error && err.message === 'A footprint line is too long.') throw new FootprintTileError(tile.quadkey, err.message);
        throw new FootprintTileError(tile.quadkey, `Footprint tile ${tile.quadkey} could not be read.`);
      }
    } finally {
      clearTimeout(timer);
      source?.destroy();
      gunzip.destroy();
    }
  }
}

export function globalFootprintsFor(config: Config): FootprintSource | null {
  if (!config.FOOTPRINTS_INDEX_URL) return null;
  return new GlobalMlFootprints({ indexUrl: config.FOOTPRINTS_INDEX_URL });
}
