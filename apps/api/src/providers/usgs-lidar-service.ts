import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LngLat } from '@roofline/shared';
import { lngLatToUtm, utmToLngLat } from '@roofline/shared/roof-reconstruct';
import type { Clock } from '../clock.ts';
import type { Config } from '../config.ts';
import type { ObjectStore } from './object-store.ts';
import { cropEpt, lngLatToMercator, mercatorToLngLat } from './usgs-lidar-ept.ts';
import { cropLas, gpsDate, type LasCrop, LasError, lasCrs, parseLasHeader } from './usgs-lidar-las.ts';
import { chooseUnit, createUsgsLidarApi, type LidarUnit, type UsgsLidarApi, UsgsLidarError } from './usgs-lidar.ts';

/*
 * Leaf-off USGS 3DEP lidar round a house, ready at Measure time. The slow work (finding the project, downloading a
 * 60-300 MB LAZ tile, decompressing millions of points) happens when an address is searched (prefetch) or in an area
 * job; Measure only reads the DERIVED product (the classified points of an 80 m square round the house, a few MB, kept
 * in the object store) within a strict budget. When it is not ready Measure goes on with Google alone and records why
 * (LidarNone): 'lidar-pending' (being fetched: the next Measure uses it), 'no-coverage', 'leaf-on-only', 'too-sparse',
 * 'error'. Raw tiles live only in a bounded disk cache (USGS_LIDAR_TILE_DIR) with a download ledger, never in the
 * database. Credit: USGS 3D Elevation Program, public domain.
 */

export const LIDAR_NONE_REASONS = ['lidar-pending', 'no-coverage', 'leaf-on-only', 'too-sparse', 'error'] as const;
export type LidarNone = (typeof LIDAR_NONE_REASONS)[number];

export const USGS_CREDIT = 'Lidar: USGS 3D Elevation Program (3DEP), public domain';

/** Where the points came from, kept with them and shown wherever they are used. */
export type LidarSource = {
  workunit: string;
  project: string;
  ql: number | null;
  collectStart: string | null;
  collectEnd: string | null;
  leafOff: boolean | null;
  /** First, median and last flight day of the points themselves (their GPS times), when recorded. */
  pointDates: [string | null, string | null, string | null] | null;
  kind: 'tile' | 'ept';
  files: string[];
  points: number;
  /** Last returns per square metre over the crop. */
  lastPerM2: number;
  credit: string;
};

/**
 * The crop in UTM (the house's zone, NAD83 269zz or WGS84 326zz as the source has it): offsets from the cell centre,
 * z metres in the lidar's vertical datum, flags bit 0 last return, bit 1 ground. Same shape as roof-3d's LidarPointsUtm.
 */
export type LidarCropUtm = {
  epsg: number;
  originE: number;
  originN: number;
  dx: Float32Array;
  dy: Float32Array;
  z: Float32Array;
  flags: Uint8Array;
  cls: Uint8Array;
  source: LidarSource;
};

export type LidarEvidence = { crop: LidarCropUtm } | { none: LidarNone; detail?: string };

export type UsgsLidarLimits = {
  /** Measure waits at most this long for the lidar, ms. */
  measureWaitMs: number;
  /** One index request, ms. */
  indexTimeoutMs: number;
  /** One byte range, ms. */
  rangeTimeoutMs: number;
  /** Byte-range size and how many at once (the USGS server gives about 0.3 MB/s per connection). */
  rangeBytes: number;
  rangeParallel: number;
  /** A failed range is tried 3 times, waiting this long times the attempt number between tries, ms. */
  retryDelayMs: number;
  /**
   * After a tile download fails (the USGS file server stops accepting connections for a while after heavy use, seen
   * on Oct 15 2026), no tile download is started for this long, ms: the fetch fails fast as 'usgs:cooldown'.
   */
  cooldownMs: number;
  /** The largest tile read, bytes (AR QL1 tiles are 60-70 MB; a dense QL0 tile a few hundred). */
  maxTileBytes: number;
  /** Most tiles one house reads (a house on a tile corner needs four). */
  maxTilesPerHouse: number;
  /** Points decoded per tile at most, and kept per house at most. */
  maxPointsScanned: number;
  maxPointsKept: number;
  /** The disk tile cache's size limit, bytes (oldest tiles are dropped first). */
  maxCacheBytes: number;
  /** At most this many bytes downloaded from USGS in any 24 hours by this process (a runaway guard), bytes. */
  maxDownloadBytesPerDay: number;
  /** Below this many last returns per m2 over the crop the lidar is 'too-sparse' (half the QL2 minimum of 2). */
  minLastPerM2: number;
  /** How long a 'no-coverage' / 'leaf-on-only' / 'too-sparse' answer is kept before asking USGS again, ms. */
  noneTtlMs: number;
};

export const DEFAULT_USGS_LIDAR_LIMITS: UsgsLidarLimits = {
  measureWaitMs: 1500,
  // TNM Access sometimes takes 10+ s to answer; this runs in the background (Measure has its own budget).
  indexTimeoutMs: 20_000,
  // A 4 MB range at the 0.14 MB/s per connection measured on Oct 15 2026 takes about 30 s.
  rangeTimeoutMs: 120_000,
  rangeBytes: 4 << 20,
  // 8 connections: 16 got this machine's connections refused by rockyweb for minutes after ~230 MB (Oct 15 2026).
  rangeParallel: 8,
  retryDelayMs: 2000,
  cooldownMs: 5 * 60_000,
  maxTileBytes: 400 << 20,
  maxTilesPerHouse: 4,
  maxPointsScanned: 60_000_000,
  maxPointsKept: 2_000_000,
  maxCacheBytes: 20 * 1024 ** 3,
  // About 150 QL1 tiles: far beyond a day of searches by an internal team, small next to what USGS serves.
  maxDownloadBytesPerDay: 10 * 1024 ** 3,
  minLastPerM2: 1,
  noneTtlMs: 30 * 86_400_000,
};

/** The crop's cell: houses are cropped on a 10 m grid, 40 m each side of the cell centre (>= 35 m round any point in it). */
const CELL_M = 10;
const HALF_M = 40;
/** The derived product's layout; a new layout is a new key (old products are simply not read). */
const PRODUCT_VERSION = 1;
const MAGIC = 'RLC1';

export type LidarCell = { zone: number; e: number; n: number; key: string };

export function cellOf(point: LngLat): LidarCell {
  const zone = Math.floor((point[0] + 180) / 6) + 1;
  const { easting, northing } = lngLatToUtm({ zone, south: false }, point[0], point[1]);
  const e = (Math.floor(easting / CELL_M) + 0.5) * CELL_M;
  const n = (Math.floor(northing / CELL_M) + 0.5) * CELL_M;
  return { zone, e, n, key: `${zone}N/${e.toFixed(0)}_${n.toFixed(0)}` };
}

/** The derived product as bytes: magic, JSON header length, JSON header, then dx, dy, z (float32), flags, cls. */
export function encodeCrop(c: LidarCropUtm): Uint8Array {
  const n = c.dx.length;
  const head = new TextEncoder().encode(JSON.stringify({ v: PRODUCT_VERSION, epsg: c.epsg, originE: c.originE, originN: c.originN, n, source: c.source }));
  const pad = (4 - ((8 + head.byteLength) % 4)) % 4;
  const off = 8 + head.byteLength + pad;
  const out = new Uint8Array(off + n * 14);
  out.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(out.buffer).setUint32(4, head.byteLength + pad, true);
  out.set(head, 8);
  out.fill(0x20, 8 + head.byteLength, off);
  const f32 = new Float32Array(out.buffer, off, 3 * n);
  f32.set(c.dx, 0);
  f32.set(c.dy, n);
  f32.set(c.z, 2 * n);
  out.set(c.flags, off + 12 * n);
  out.set(c.cls, off + 13 * n);
  return out;
}

/** encodeCrop's bytes back, or null for anything else (an older layout, a truncated object). */
export function decodeCrop(bytes: Uint8Array): LidarCropUtm | null {
  try {
    if (bytes.byteLength < 8 || new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const hl = dv.getUint32(4, true);
    const head = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hl))) as { v: number; epsg: number; originE: number; originN: number; n: number; source: LidarSource };
    const n = head.n;
    const off = 8 + hl;
    if (head.v !== PRODUCT_VERSION || !Number.isInteger(n) || n < 0 || bytes.byteLength !== off + 14 * n) return null;
    const body = bytes.slice(off);
    const f32 = new Float32Array(body.buffer, 0, 3 * n);
    return {
      epsg: head.epsg,
      originE: head.originE,
      originN: head.originN,
      dx: f32.slice(0, n),
      dy: f32.slice(n, 2 * n),
      z: f32.slice(2 * n, 3 * n),
      flags: body.slice(12 * n, 13 * n),
      cls: body.slice(13 * n, 14 * n),
      source: head.source,
    };
  } catch {
    return null;
  }
}

/** A raw-tile cache on disk with a download ledger (ledger.jsonl): bounded in total size, oldest dropped first. */
export class LidarTileCache {
  constructor(
    private readonly dir: string | null,
    private readonly maxBytes: number,
    private readonly now: () => Date,
  ) {}

  private fileOf(url: string): string | null {
    if (this.dir === null) return null;
    const base = url.slice(url.lastIndexOf('/') + 1).replace(/[^A-Za-z0-9._-]/g, '_');
    const h = createHash('sha256').update(url).digest('hex').slice(0, 12);
    return path.join(this.dir, `${h}-${base}`);
  }

  async get(url: string): Promise<Uint8Array | null> {
    const f = this.fileOf(url);
    if (f === null) return null;
    try {
      return new Uint8Array(await readFile(f));
    } catch {
      return null;
    }
  }

  async put(url: string, bytes: Uint8Array, ms: number): Promise<void> {
    if (this.dir === null) return;
    await mkdir(this.dir, { recursive: true });
    await this.makeRoom(bytes.byteLength);
    const f = this.fileOf(url)!;
    await writeFile(`${f}.part`, bytes);
    await rename(`${f}.part`, f);
    await this.log({ what: 'laz-tile', url, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), ms });
  }

  /** One line in the download ledger (every download, its size and checksum: what was taken from USGS and when). */
  async log(entry: Record<string, unknown>): Promise<void> {
    if (this.dir === null) return;
    await mkdir(this.dir, { recursive: true });
    await appendFile(path.join(this.dir, 'ledger.jsonl'), `${JSON.stringify({ at: this.now().toISOString(), ...entry })}\n`);
  }

  private async makeRoom(incoming: number): Promise<void> {
    if (this.dir === null) return;
    const names = (await readdir(this.dir)).filter((n) => n.endsWith('.laz'));
    const files = await Promise.all(names.map(async (n) => ({ n, s: await stat(path.join(this.dir!, n)) })));
    files.sort((a, b) => a.s.mtimeMs - b.s.mtimeMs || (a.n < b.n ? -1 : 1));
    let total = files.reduce((t, f) => t + f.s.size, 0) + incoming;
    for (const f of files) {
      if (total <= this.maxBytes) break;
      await unlink(path.join(this.dir, f.n)).catch(() => undefined);
      total -= f.s.size;
      await this.log({ what: 'evict', file: f.n, bytes: f.s.size });
    }
  }
}

type NoneRecord = { reason: LidarNone; at: number; workunit?: string };

/** Fixed message text per failure (never a URL or a cause). */
function detailOf(err: unknown): string {
  if (err instanceof UsgsLidarError) return `usgs:${err.reason}`;
  if (err instanceof LasError) return `las:${err.reason}`;
  return 'internal';
}

export class UsgsLidarService {
  private readonly inFlight = new Map<string, Promise<LidarEvidence>>();
  private readonly tileFlight = new Map<string, Promise<Uint8Array>>();
  private readonly memory = new Map<string, Uint8Array>();
  /** No tile download starts before this time (ms): set when one fails. */
  private coolUntil = 0;
  /** Downloads in the last 24 hours (time ms, bytes): the daily budget. */
  private readonly downloads: { at: number; bytes: number }[] = [];
  /** Derivations run one at a time: each holds a whole tile in memory and decodes millions of points. */
  private chain: Promise<unknown> = Promise.resolve();
  readonly limits: UsgsLidarLimits;

  constructor(
    readonly api: UsgsLidarApi,
    private readonly store: ObjectStore,
    readonly tiles: LidarTileCache,
    private readonly now: () => Date,
    limits: Partial<UsgsLidarLimits> = {},
  ) {
    this.limits = { ...DEFAULT_USGS_LIDAR_LIMITS, ...limits };
  }

  get configured(): boolean {
    return this.api.configured;
  }

  private async getObject(key: string): Promise<Uint8Array | null> {
    if (!this.store.configured) return this.memory.get(key) ?? null;
    return this.store.get(key);
  }

  private async putObject(key: string, bytes: Uint8Array, type: string): Promise<void> {
    if (!this.store.configured) {
      this.memory.set(key, bytes);
      while (this.memory.size > 64) this.memory.delete(this.memory.keys().next().value!);
      return;
    }
    await this.store.put(key, bytes, type);
  }

  private cropKey(cell: LidarCell): string {
    return `lidar/v${PRODUCT_VERSION}/crop/${cell.key}.rlc`;
  }

  private noneKey(cell: LidarCell): string {
    return `lidar/v${PRODUCT_VERSION}/none/${cell.key}.json`;
  }

  /** What is already known for the point, without any network: the crop, a kept 'none', or null (not fetched yet). */
  async known(point: LngLat): Promise<LidarEvidence | null> {
    const cell = cellOf(point);
    const bytes = await this.getObject(this.cropKey(cell)).catch(() => null);
    if (bytes !== null) {
      const crop = decodeCrop(bytes);
      if (crop !== null) return { crop };
    }
    const none = await this.getObject(this.noneKey(cell)).catch(() => null);
    if (none !== null) {
      try {
        const rec = JSON.parse(new TextDecoder().decode(none)) as NoneRecord;
        if ((LIDAR_NONE_REASONS as readonly string[]).includes(rec.reason) && this.now().getTime() - rec.at < this.limits.noneTtlMs) return { none: rec.reason };
      } catch {
        // A garbled record is ignored: the lidar is fetched again.
      }
    }
    return null;
  }

  /**
   * The lidar for Measure: what is known now, else the fetch is started (or joined) and awaited for at most
   * `waitMs` (default limits.measureWaitMs); past that 'lidar-pending' (the fetch carries on, the next Measure gets it).
   * Never rejects.
   */
  async forMeasure(point: LngLat, waitMs = this.limits.measureWaitMs): Promise<LidarEvidence> {
    try {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<'late'>((r) => {
        timer = setTimeout(() => r('late'), Math.max(0, waitMs));
      });
      const work = (async () => (await this.known(point)) ?? (await this.prefetch(point)))();
      const got = await Promise.race([work, late]);
      clearTimeout(timer);
      return got === 'late' ? { none: 'lidar-pending' } : got;
    } catch {
      return { none: 'error' };
    }
  }

  /** Fetches and keeps the lidar round the point (one fetch per cell at a time). Never rejects. */
  prefetch(point: LngLat): Promise<LidarEvidence> {
    const cell = cellOf(point);
    const running = this.inFlight.get(cell.key);
    if (running !== undefined) return running;
    const p = (async (): Promise<LidarEvidence> => {
      const known = await this.known(point);
      if (known !== null) return known;
      try {
        const units = await this.api.coverage(point, { timeoutMs: this.limits.indexTimeoutMs });
        const choice = chooseUnit(units);
        if ('none' in choice) {
          await this.keepNone(cell, { reason: choice.none, at: this.now().getTime() });
          return { none: choice.none };
        }
        const crop = await this.serial(() => this.derive(cell, choice.unit));
        if (crop.source.lastPerM2 < this.limits.minLastPerM2) {
          await this.keepNone(cell, { reason: 'too-sparse', at: this.now().getTime(), workunit: choice.unit.workunit });
          return { none: 'too-sparse' };
        }
        await this.putObject(this.cropKey(cell), encodeCrop(crop), 'application/octet-stream');
        return { crop };
      } catch (err) {
        // Not kept: an outage or a damaged download is tried again by the next search or Measure.
        await this.tiles.log({ what: 'error', cell: cell.key, detail: detailOf(err) }).catch(() => undefined);
        return { none: 'error', detail: detailOf(err) };
      }
    })().finally(() => {
      this.inFlight.delete(cell.key);
    });
    this.inFlight.set(cell.key, p);
    return p;
  }

  private async keepNone(cell: LidarCell, rec: NoneRecord): Promise<void> {
    await this.putObject(this.noneKey(cell), new TextEncoder().encode(JSON.stringify(rec)), 'application/json').catch(() => undefined);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** A tile's bytes: the disk cache, else downloaded once over parallel byte ranges (and cached, and logged). */
  tile(url: string): Promise<Uint8Array> {
    const running = this.tileFlight.get(url);
    if (running !== undefined) return running;
    const p = (async () => {
      const cached = await this.tiles.get(url);
      if (cached !== null) return cached;
      if (this.now().getTime() < this.coolUntil) throw new UsgsLidarError('cooldown', 'USGS downloads are paused after a failure.');
      try {
        return await this.download(url);
      } catch (err) {
        if (err instanceof UsgsLidarError && (err.reason === 'http' || err.reason === 'timeout')) {
          this.coolUntil = this.now().getTime() + this.limits.cooldownMs;
          await this.tiles.log({ what: 'cooldown', url, until: new Date(this.coolUntil).toISOString(), detail: detailOf(err) }).catch(() => undefined);
        }
        throw err;
      }
    })().finally(() => {
      this.tileFlight.delete(url);
    });
    this.tileFlight.set(url, p);
    return p;
  }

  /** One tile over parallel byte ranges, into the cache and the ledger. */
  private async download(url: string): Promise<Uint8Array> {
    const t0 = Date.now();
    const size = await this.api.size(url, { timeoutMs: this.limits.indexTimeoutMs });
    if (size > this.limits.maxTileBytes) throw new UsgsLidarError('too-large', 'A lidar tile is larger than allowed.');
    const now = this.now().getTime();
    while (this.downloads.length > 0 && now - this.downloads[0]!.at > 86_400_000) this.downloads.shift();
    const today = this.downloads.reduce((t, d) => t + d.bytes, 0);
    if (today + size > this.limits.maxDownloadBytesPerDay) {
      await this.tiles.log({ what: 'refused', url, bytes: size, reason: 'daily-budget', today });
      throw new UsgsLidarError('budget', 'The daily lidar download budget is spent.');
    }
    this.downloads.push({ at: now, bytes: size });
    const out = new Uint8Array(size);
    const spans: [number, number][] = [];
    for (let a = 0; a < size; a += this.limits.rangeBytes) spans.push([a, Math.min(size, a + this.limits.rangeBytes) - 1]);
    let next = 0;
    // One range failing for good stops the others (no point downloading the rest of a tile that will not be kept).
    let failed = false;
    const worker = async () => {
      while (!failed && next < spans.length) {
        const span = spans[next++]!;
        let last: unknown;
        for (let k = 0; k < 3; k++) {
          try {
            out.set(await this.api.getBytes(url, { timeoutMs: this.limits.rangeTimeoutMs, maxBytes: span[1] - span[0] + 1, range: span }), span[0]);
            last = null;
            break;
          } catch (err) {
            last = err;
            if (err instanceof UsgsLidarError && (err.reason === 'host' || err.reason === 'too-large')) break;
            if (k < 2 && this.limits.retryDelayMs > 0) await new Promise((r) => setTimeout(r, this.limits.retryDelayMs * (k + 1)));
          }
        }
        if (last !== null) {
          failed = true;
          throw last;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.limits.rangeParallel, spans.length) }, worker));
    await this.tiles.put(url, out, Date.now() - t0);
    return out;
  }

  /** The crop round the cell: from the unit's EPT nodes when the bucket has them, else (or when that fails) its tiles. */
  private async derive(cell: LidarCell, unit: LidarUnit): Promise<LidarCropUtm> {
    const ept = await this.api.eptOf(unit, { timeoutMs: this.limits.indexTimeoutMs }).catch(() => null);
    if (ept !== null) {
      try {
        return await this.deriveEpt(cell, unit, ept);
      } catch (err) {
        await this.tiles.log({ what: 'ept-fallback', cell: cell.key, detail: detailOf(err) }).catch(() => undefined);
      }
    }
    return this.deriveTiles(cell, unit);
  }

  private async deriveEpt(cell: LidarCell, unit: LidarUnit, eptUrl: string): Promise<LidarCropUtm> {
    const zone = { zone: cell.zone, south: false };
    const corners = [
      [cell.e - HALF_M, cell.n - HALF_M],
      [cell.e + HALF_M, cell.n - HALF_M],
      [cell.e - HALF_M, cell.n + HALF_M],
      [cell.e + HALF_M, cell.n + HALF_M],
    ].map(([e, n]) => lngLatToMercator(...utmToLngLat(zone, e!, n!)));
    const box = { x0: Math.min(...corners.map((c) => c[0])), x1: Math.max(...corners.map((c) => c[0])), y0: Math.min(...corners.map((c) => c[1])), y1: Math.max(...corners.map((c) => c[1])) };
    const t0 = Date.now();
    const got = await cropEpt(this.api, eptUrl, box, { timeoutMs: this.limits.rangeTimeoutMs, maxNodes: 256, maxHierarchyFiles: 32, maxNodeBytes: 32 << 20, maxPointsKept: this.limits.maxPointsKept, parallel: 8 });
    await this.tiles.log({ what: 'ept-nodes', url: eptUrl, nodes: got.nodes, bytes: got.bytes, ms: Date.now() - t0 });
    // Web Mercator to the cell's UTM zone, so the crop is the same product whichever way it was read.
    const c = got.crop;
    for (let i = 0; i < c.x.length; i++) {
      const [lng, lat] = mercatorToLngLat(c.x[i]!, c.y[i]!);
      const u = lngLatToUtm(zone, lng, lat);
      c.x[i] = u.easting;
      c.y[i] = u.northing;
    }
    // The Mercator box is a little larger than the square: keep the square.
    const keep: number[] = [];
    for (let i = 0; i < c.x.length; i++) if (Math.abs(c.x[i]! - cell.e) <= HALF_M && Math.abs(c.y[i]! - cell.n) <= HALF_M) keep.push(i);
    const pick = <T extends Float64Array | Float32Array | Uint8Array>(a: T, make: (n: number) => T): T => {
      const out = make(keep.length);
      keep.forEach((j, k) => {
        out[k] = a[j]!;
      });
      return out;
    };
    const square: LasCrop = {
      x: pick(c.x, (n) => new Float64Array(n)),
      y: pick(c.y, (n) => new Float64Array(n)),
      z: pick(c.z, (n) => new Float32Array(n)),
      flags: pick(c.flags, (n) => new Uint8Array(n)),
      cls: pick(c.cls, (n) => new Uint8Array(n)),
      gpsTime: c.gpsTime,
      scanned: c.scanned,
    };
    const name = eptUrl.slice(0, -'/ept.json'.length).slice(eptUrl.slice(0, -'/ept.json'.length).lastIndexOf('/') + 1);
    // EPT is WGS84 Web Mercator: the crop is labelled WGS84 UTM.
    return assemble(cell, unit, [`${name} (${got.nodes} EPT nodes)`], [{ crop: square, zone: cell.zone }], 'ept');
  }

  /** The crop of the unit's tiles round the cell. */
  private async deriveTiles(cell: LidarCell, unit: LidarUnit): Promise<LidarCropUtm> {
    const urls = unit.tiles.slice(0, this.limits.maxTilesPerHouse).map((t) => t.url);
    const parts: { crop: LasCrop; zone: number }[] = [];
    let kept = 0;
    for (const url of urls) {
      const bytes = await this.tile(url);
      const crs = lasCrs(parseLasHeader(bytes.subarray(0, Math.min(bytes.byteLength, 1 << 16))));
      // The cell's square in the tile's own zone (the same zone nearly always; a zone edge converts the corners).
      const corners: [number, number][] = [
        [cell.e - HALF_M, cell.n - HALF_M],
        [cell.e + HALF_M, cell.n - HALF_M],
        [cell.e - HALF_M, cell.n + HALF_M],
        [cell.e + HALF_M, cell.n + HALF_M],
      ].map(([e, n]) => {
        if (crs.zone === cell.zone) return [e!, n!] as [number, number];
        const [lng, lat] = utmToLngLat({ zone: cell.zone, south: false }, e!, n!);
        const u = lngLatToUtm({ zone: crs.zone, south: false }, lng, lat);
        return [u.easting, u.northing] as [number, number];
      });
      const box = { x0: Math.min(...corners.map((c) => c[0])), x1: Math.max(...corners.map((c) => c[0])), y0: Math.min(...corners.map((c) => c[1])), y1: Math.max(...corners.map((c) => c[1])) };
      const crop = await cropLas(bytes, box, { maxBytes: this.limits.maxTileBytes, maxPointsScanned: this.limits.maxPointsScanned, maxPointsKept: this.limits.maxPointsKept - kept });
      kept += crop.x.length;
      parts.push({ crop, zone: crs.zone });
    }
    return assemble(cell, unit, urls.map((u) => u.slice(u.lastIndexOf('/') + 1)), parts, 'tile');
  }

  /**
   * The area job: the tiles of every leaf-off unit over a box (sampled every 500 m, at most `maxPoints` samples and
   * `maxTiles` tiles) downloaded into the tile cache, so each house's crop there is derived without a download.
   */
  async prefetchArea(sw: LngLat, ne: LngLat, o: { maxPoints?: number; maxTiles?: number } = {}): Promise<{ tiles: number; failed: number; none: Partial<Record<LidarNone, number>> }> {
    const maxPoints = o.maxPoints ?? 25;
    const maxTiles = o.maxTiles ?? 16;
    const midLat = (sw[1] + ne[1]) / 2;
    const stepLat = 500 / 111_320;
    const stepLng = 500 / (111_320 * Math.cos((midLat * Math.PI) / 180));
    const pts: LngLat[] = [];
    for (let lat = sw[1]; lat <= ne[1] + 1e-12 && pts.length < maxPoints; lat += stepLat) {
      for (let lng = sw[0]; lng <= ne[0] + 1e-12 && pts.length < maxPoints; lng += stepLng) pts.push([lng, lat]);
    }
    const urls = new Set<string>();
    const none: Partial<Record<LidarNone, number>> = {};
    for (const p of pts) {
      try {
        const choice = chooseUnit(await this.api.coverage(p, { timeoutMs: this.limits.indexTimeoutMs }));
        if ('none' in choice) none[choice.none] = (none[choice.none] ?? 0) + 1;
        else for (const t of choice.unit.tiles) if (urls.size < maxTiles) urls.add(t.url);
      } catch {
        none.error = (none.error ?? 0) + 1;
      }
    }
    let tiles = 0;
    let failed = 0;
    for (const url of [...urls].sort()) {
      try {
        await this.tile(url);
        tiles++;
      } catch {
        failed++;
      }
    }
    return { tiles, failed, none };
  }
}

function assemble(cell: LidarCell, unit: LidarUnit, files: string[], parts: { crop: LasCrop; zone: number }[], kind: 'tile' | 'ept'): LidarCropUtm {
  const n = parts.reduce((t, p) => t + p.crop.x.length, 0);
  const dx = new Float32Array(n);
  const dy = new Float32Array(n);
  const z = new Float32Array(n);
  const flags = new Uint8Array(n);
  const cls = new Uint8Array(n);
  let at = 0;
  let last = 0;
  const times: number[] = [];
  for (const { crop, zone } of parts) {
    for (let i = 0; i < crop.x.length; i++) {
      let e = crop.x[i]!;
      let nn = crop.y[i]!;
      if (zone !== cell.zone) {
        const [lng, lat] = utmToLngLat({ zone, south: false }, e, nn);
        const u = lngLatToUtm({ zone: cell.zone, south: false }, lng, lat);
        e = u.easting;
        nn = u.northing;
      }
      dx[at] = e - cell.e;
      dy[at] = nn - cell.n;
      z[at] = crop.z[i]!;
      flags[at] = crop.flags[i]!;
      cls[at] = crop.cls[i]!;
      if ((crop.flags[i]! & 1) !== 0 && Math.abs(e - cell.e) <= HALF_M && Math.abs(nn - cell.n) <= HALF_M) last++;
      at++;
    }
    if (crop.gpsTime !== null) times.push(...crop.gpsTime);
  }
  times.sort((a, b) => a - b);
  const pointDates: LidarSource['pointDates'] = times.length === 0 ? null : [gpsDate(times[0]!), gpsDate(times[Math.floor(times.length / 2)]!), gpsDate(times[times.length - 1]!)];
  return {
    // Tiles: NAD83(2011) UTM as 3DEP delivers them; EPT: WGS84. The reconstruction registers the cloud onto Google's frame itself.
    epsg: (kind === 'tile' ? 26900 : 32600) + cell.zone,
    originE: cell.e,
    originN: cell.n,
    dx,
    dy,
    z,
    flags,
    cls,
    source: {
      workunit: unit.workunit,
      project: unit.project,
      ql: unit.ql,
      collectStart: unit.collectStart,
      collectEnd: unit.collectEnd,
      leafOff: unit.leafOff,
      pointDates,
      kind,
      files,
      points: n,
      lastPerM2: Math.round((last / (4 * HALF_M * HALF_M)) * 100) / 100,
      credit: USGS_CREDIT,
    },
  };
}

/** The service for this config: null when USGS_LIDAR_MODE is off (nothing is ever asked of USGS). */
export function createUsgsLidarService(config: Config, store: ObjectStore, clock: Clock): UsgsLidarService | null {
  const api = createUsgsLidarApi(config);
  if (!api.configured) return null;
  const c = config as { USGS_LIDAR_TILE_DIR?: string; USGS_LIDAR_MEASURE_WAIT_MS?: number; USGS_LIDAR_TILE_CACHE_GB?: number };
  const maxCacheBytes = Math.round((c.USGS_LIDAR_TILE_CACHE_GB ?? 20) * 1024 ** 3);
  return new UsgsLidarService(api, store, new LidarTileCache(c.USGS_LIDAR_TILE_DIR ?? null, maxCacheBytes, () => clock.now()), () => clock.now(), {
    measureWaitMs: c.USGS_LIDAR_MEASURE_WAIT_MS ?? DEFAULT_USGS_LIDAR_LIMITS.measureWaitMs,
    maxCacheBytes,
  });
}
