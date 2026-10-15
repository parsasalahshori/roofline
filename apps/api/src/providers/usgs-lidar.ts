import type { LngLat } from '@roofline/shared';
import type { Config } from '../config.ts';

/*
 * USGS 3D Elevation Program (3DEP) airborne lidar, the network side: which lidar projects cover a point (the 3DEP
 * Elevation Index, WESM, for project, quality level and flight dates; TNM Access for the LAZ tiles), and bounded reads
 * of the files (whole tiles over parallel byte ranges, or the few Entwine EPT nodes round a house). Only public USGS
 * and AWS open-data hosts are ever asked; no key is involved. The data is public domain (credit: USGS 3DEP).
 * Variants: RealUsgsLidarApi (network), FakeUsgsLidarApi (tests and the demo: fixture answers), and
 * UnconfiguredUsgsLidarApi (USGS_LIDAR_MODE=off). Every failure is a UsgsLidarError with a typed reason.
 */

export const USGS_LIDAR_FAILURES = ['timeout', 'http', 'bad-answer', 'too-large', 'host', 'budget', 'unconfigured'] as const;
export type UsgsLidarFailure = (typeof USGS_LIDAR_FAILURES)[number];

export class UsgsLidarError extends Error {
  readonly reason: UsgsLidarFailure;
  constructor(reason: UsgsLidarFailure, message: string) {
    super(message);
    this.name = 'UsgsLidarError';
    this.reason = reason;
  }
}

/** One lidar work unit (a flight block of a 3DEP project) over the point. */
export type LidarUnit = {
  workunit: string;
  project: string;
  /** Quality level 0 (best) .. 3; null when the index does not say. QL1 is 8+ pulses/m2, QL2 2+. */
  ql: number | null;
  /** First and last flight day, YYYY-MM-DD (the index's collect_start / collect_end); null when unknown. */
  collectStart: string | null;
  collectEnd: string | null;
  /** Every flight day in November..April (leaves off in the US south and east); null when the dates are unknown. */
  leafOff: boolean | null;
  /** The unit's LAZ tiles that hold the point (TNM Access), with their size when TNM gives it. */
  tiles: { url: string; bytes: number | null }[];
};

export interface UsgsLidarApi {
  readonly configured: boolean;
  /** Work units over the point, with the tiles that hold it. [] when 3DEP has none there. */
  coverage(point: LngLat, o: { timeoutMs: number }): Promise<LidarUnit[]>;
  /** The Entwine EPT root (ept.json URL) of a work unit, or null when it has none. */
  eptOf(unit: LidarUnit, o: { timeoutMs: number }): Promise<string | null>;
  /** A file, or a byte range of it [start, end] inclusive, never more than maxBytes. */
  getBytes(url: string, o: { timeoutMs: number; maxBytes: number; range?: [number, number] }): Promise<Uint8Array>;
  /** A file's size in bytes (HEAD). */
  size(url: string, o: { timeoutMs: number }): Promise<number>;
}

/** The only hosts ever asked (a URL in an answer pointing anywhere else is refused: 'host'). */
export const USGS_LIDAR_HOSTS = ['index.nationalmap.gov', 'tnmaccess.nationalmap.gov', 'rockyweb.usgs.gov', 'prd-tnm.s3.amazonaws.com', 's3-us-west-2.amazonaws.com'] as const;

export function allowedLidarUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (USGS_LIDAR_HOSTS as readonly string[]).includes(u.hostname) && u.username === '' && u.password === '';
  } catch {
    return false;
  }
}

const WESM = 'https://index.nationalmap.gov/arcgis/rest/services/3DEPElevationIndex/MapServer/8/query';
const TNM = 'https://tnmaccess.nationalmap.gov/api/v1/products';
const EPT_BUCKET = 'https://s3-us-west-2.amazonaws.com/usgs-lidar-public';
/** Index answers are small: a few hundred KB at most. */
const MAX_INDEX_BYTES = 4 << 20;
/** November..April: leaves are off across the lidar-covered US south and east (USGS's own leaf-off windows). */
const LEAF_OFF_MONTHS = new Set([11, 12, 1, 2, 3, 4]);

/** Whether every day from start to end (YYYY-MM-DD) falls in a leaf-off month; null when a date is missing. */
export function leafOffSpan(start: string | null, end: string | null): boolean | null {
  if (start === null || end === null) return null;
  const d0 = Date.parse(`${start}T00:00:00Z`);
  const d1 = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(d0) || !Number.isFinite(d1) || d1 < d0) return null;
  // A span longer than the six leaf-off months always enters a leaf-on month.
  if (d1 - d0 > 183 * 86_400_000) return false;
  for (let t = d0; t <= d1; t += 86_400_000) {
    if (!LEAF_OFF_MONTHS.has(new Date(t).getUTCMonth() + 1)) return false;
  }
  return true;
}

function qlOf(v: unknown): number | null {
  const m = /(\d)/.exec(typeof v === 'string' ? v : '');
  return m === null ? null : Number(m[1]);
}

function dayOf(ms: unknown): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

/** WESM features and TNM items into work units with their tiles (pure; the real API's parsing, tested on fixtures). */
export function unitsFromIndex(wesm: unknown, tnm: unknown): LidarUnit[] {
  const features = (wesm as { features?: { attributes?: Record<string, unknown> }[] } | null)?.features;
  const items = (tnm as { items?: { downloadURL?: unknown; sizeInBytes?: unknown }[] } | null)?.items;
  if (!Array.isArray(features)) throw new UsgsLidarError('bad-answer', 'The 3DEP index answer could not be read.');
  const tiles = (Array.isArray(items) ? items : [])
    .map((i) => ({ url: typeof i.downloadURL === 'string' ? i.downloadURL : '', bytes: typeof i.sizeInBytes === 'number' ? i.sizeInBytes : null }))
    .filter((t) => t.url.endsWith('.laz') && allowedLidarUrl(t.url));
  const units: LidarUnit[] = [];
  for (const f of features) {
    const a = f.attributes ?? {};
    const workunit = typeof a.workunit === 'string' ? a.workunit : null;
    const project = typeof a.project === 'string' ? a.project : '';
    if (workunit === null || !/^[A-Za-z0-9_-]+$/.test(workunit)) continue;
    const collectStart = dayOf(a.collect_start);
    const collectEnd = dayOf(a.collect_end);
    units.push({
      workunit,
      project,
      ql: qlOf(a.ql),
      collectStart,
      collectEnd,
      leafOff: leafOffSpan(collectStart, collectEnd),
      tiles: tiles.filter((t) => t.url.includes(`/${workunit}/`)).sort((p, q) => (p.url < q.url ? -1 : p.url > q.url ? 1 : 0)),
    });
  }
  return units.sort((p, q) => (p.workunit < q.workunit ? -1 : p.workunit > q.workunit ? 1 : 0));
}

/** Why no work unit is worth reading: none over the point, or only leaf-on (or undated) ones. */
export type UnitChoice = { unit: LidarUnit } | { none: 'no-coverage' | 'leaf-on-only' };

/**
 * The work unit to read: quality QL2 or better with tiles published; leaf-off before leaf-on or undated; then the
 * newest flight; ties by name (deterministic). Only a leaf-off unit is chosen: leaf-on lidar is blocked by the same
 * crowns that block Google's photogrammetry ('leaf-on-only').
 */
export function chooseUnit(units: readonly LidarUnit[]): UnitChoice {
  const usable = units.filter((u) => u.ql !== null && u.ql <= 2 && u.tiles.length > 0);
  if (usable.length === 0) return { none: 'no-coverage' };
  const ranked = usable.slice().sort((p, q) => {
    const lp = p.leafOff === true ? 0 : 1;
    const lq = q.leafOff === true ? 0 : 1;
    if (lp !== lq) return lp - lq;
    const ep = p.collectEnd ?? '';
    const eq = q.collectEnd ?? '';
    if (ep !== eq) return ep < eq ? 1 : -1;
    return p.workunit < q.workunit ? -1 : p.workunit > q.workunit ? 1 : 0;
  });
  const best = ranked[0]!;
  return best.leafOff === true ? { unit: best } : { none: 'leaf-on-only' };
}

/** fetch with a deadline and a byte cap; the URL must be on an allowed host. Errors carry no URL. */
async function boundedGet(url: string, o: { timeoutMs: number; maxBytes: number; method?: 'GET' | 'HEAD'; range?: [number, number] }): Promise<{ ok: boolean; headers: Headers; body: Uint8Array }> {
  if (!allowedLidarUrl(url)) throw new UsgsLidarError('host', 'A lidar URL is not on a USGS host.');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs);
  try {
    const headers: Record<string, string> = { 'User-Agent': 'roofline-estimator/1 (USGS 3DEP reader)' };
    if (o.range !== undefined) headers.Range = `bytes=${o.range[0]}-${o.range[1]}`;
    const res = await fetch(url, { method: o.method ?? 'GET', headers, signal: ctl.signal, redirect: 'error' });
    if (o.method === 'HEAD') return { ok: res.ok, headers: res.headers, body: new Uint8Array(0) };
    if (!res.ok) throw new UsgsLidarError('http', `USGS answered ${res.status}.`);
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > o.maxBytes) throw new UsgsLidarError('too-large', 'A lidar file is larger than allowed.');
    const reader = res.body?.getReader();
    const parts: Uint8Array[] = [];
    let n = 0;
    if (reader !== undefined) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.byteLength;
        if (n > o.maxBytes) {
          await reader.cancel();
          throw new UsgsLidarError('too-large', 'A lidar file is larger than allowed.');
        }
        parts.push(value);
      }
    }
    const bytes = new Uint8Array(n);
    let at = 0;
    for (const p of parts) {
      bytes.set(p, at);
      at += p.byteLength;
    }
    return { ok: true, headers: res.headers, body: bytes };
  } catch (err) {
    if (err instanceof UsgsLidarError) throw err;
    if (ctl.signal.aborted) throw new UsgsLidarError('timeout', 'USGS did not answer in time.');
    throw new UsgsLidarError('http', 'USGS could not be reached.');
  } finally {
    clearTimeout(timer);
  }
}

export class RealUsgsLidarApi implements UsgsLidarApi {
  readonly configured = true;

  async coverage(point: LngLat, o: { timeoutMs: number }): Promise<LidarUnit[]> {
    const [lng, lat] = point;
    const wesmUrl = `${WESM}?${new URLSearchParams({ geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: 'workunit,project,ql,collect_start,collect_end', returnGeometry: 'false', f: 'json' })}`;
    // About 40 m round the point: the tiles under the house and the yard round it.
    const d = 0.0004;
    const tnmUrl = `${TNM}?${new URLSearchParams({ datasets: 'Lidar Point Cloud (LPC)', bbox: `${lng - d},${lat - d},${lng + d},${lat + d}`, max: '200', outputFormat: 'JSON' })}`;
    const [w, t] = await Promise.all([boundedGet(wesmUrl, { timeoutMs: o.timeoutMs, maxBytes: MAX_INDEX_BYTES }), boundedGet(tnmUrl, { timeoutMs: o.timeoutMs, maxBytes: MAX_INDEX_BYTES })]);
    return unitsFromIndex(parseJson(w.body), parseJson(t.body));
  }

  private readonly eptKnown = new Map<string, string | null>();

  async eptOf(unit: LidarUnit, o: { timeoutMs: number }): Promise<string | null> {
    const hit = this.eptKnown.get(unit.workunit);
    if (hit !== undefined) return hit;
    let found: string | null = null;
    for (const name of eptNames(unit)) {
      const url = `${EPT_BUCKET}/${encodeURIComponent(name)}/ept.json`;
      try {
        const res = await boundedGet(url, { timeoutMs: o.timeoutMs, maxBytes: 0, method: 'HEAD' });
        if (res.ok) {
          found = url;
          break;
        }
      } catch {
        // Not there (or S3 slow): try the next name; the tiles are the fallback.
      }
    }
    if (this.eptKnown.size > 1000) this.eptKnown.clear();
    this.eptKnown.set(unit.workunit, found);
    return found;
  }

  async getBytes(url: string, o: { timeoutMs: number; maxBytes: number; range?: [number, number] }): Promise<Uint8Array> {
    const res = await boundedGet(url, o);
    const bytes = res.body;
    if (o.range !== undefined && bytes.byteLength !== o.range[1] - o.range[0] + 1) throw new UsgsLidarError('bad-answer', 'USGS sent a short byte range.');
    return bytes;
  }

  async size(url: string, o: { timeoutMs: number }): Promise<number> {
    const res = await boundedGet(url, { timeoutMs: o.timeoutMs, maxBytes: 0, method: 'HEAD' });
    const n = Number(res.headers.get('content-length') ?? NaN);
    if (!res.ok || !Number.isFinite(n) || n <= 0) throw new UsgsLidarError('bad-answer', 'USGS did not give the file size.');
    return n;
  }
}

/**
 * The names the usgs-lidar-public bucket may hold a work unit under: its own name, or USGS's LPC delivery name
 * (USGS_LPC_<workunit>_LAS_<year>, the year the point cloud was published, usually 0-3 years after the flight).
 */
export function eptNames(unit: LidarUnit): string[] {
  const names = [unit.workunit];
  const year = unit.collectEnd === null ? null : Number(unit.collectEnd.slice(0, 4));
  if (year !== null && Number.isInteger(year)) for (let y = year; y <= year + 3; y++) names.push(`USGS_LPC_${unit.workunit}_LAS_${y}`);
  return names;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new UsgsLidarError('bad-answer', 'The 3DEP index answer is not JSON.');
  }
}

/** USGS_LIDAR_MODE=off: nothing is asked. */
export class UnconfiguredUsgsLidarApi implements UsgsLidarApi {
  readonly configured = false;
  async coverage(): Promise<LidarUnit[]> {
    throw new UsgsLidarError('unconfigured', 'USGS lidar is off.');
  }
  async eptOf(): Promise<string | null> {
    return null;
  }
  async getBytes(): Promise<Uint8Array> {
    throw new UsgsLidarError('unconfigured', 'USGS lidar is off.');
  }
  async size(): Promise<number> {
    throw new UsgsLidarError('unconfigured', 'USGS lidar is off.');
  }
}

/**
 * USGS lidar without the network: units answered by `coverageAt` (a test sets it; default none anywhere) and files
 * from `files` (URL to bytes), with byte ranges, a per-call delay (`delayMs`, on an injected sleeper so tests stay
 * hermetic) and `failNext`. Every call is recorded.
 */
export class FakeUsgsLidarApi implements UsgsLidarApi {
  readonly configured = true;
  readonly calls: { kind: 'coverage' | 'ept' | 'get' | 'size'; url?: string; range?: [number, number] }[] = [];
  readonly files = new Map<string, Uint8Array>();
  readonly epts = new Map<string, string>();
  coverageAt: (point: LngLat) => LidarUnit[] = () => [];
  /** Awaited before every answer (tests hold a read open with it). */
  gate: () => Promise<void> = async () => {};
  private failures = 0;
  private getFailures = 0;

  failNext(n = 1): void {
    this.failures += n;
  }

  /** The next n file reads (getBytes) fail, whatever else is asked in between. */
  failGets(n = 1): void {
    this.getFailures += n;
  }

  private async step(): Promise<void> {
    await this.gate();
    if (this.failures > 0) {
      this.failures--;
      throw new UsgsLidarError('http', 'Fake USGS is unavailable.');
    }
  }

  async coverage(point: LngLat): Promise<LidarUnit[]> {
    this.calls.push({ kind: 'coverage' });
    await this.step();
    return this.coverageAt(point);
  }

  async eptOf(unit: LidarUnit): Promise<string | null> {
    this.calls.push({ kind: 'ept' });
    return this.epts.get(unit.workunit) ?? null;
  }

  async getBytes(url: string, o: { timeoutMs: number; maxBytes: number; range?: [number, number] }): Promise<Uint8Array> {
    this.calls.push({ kind: 'get', url, ...(o.range !== undefined ? { range: o.range } : {}) });
    await this.step();
    if (this.getFailures > 0) {
      this.getFailures--;
      throw new UsgsLidarError('http', 'Fake USGS dropped the connection.');
    }
    if (!allowedLidarUrl(url)) throw new UsgsLidarError('host', 'A lidar URL is not on a USGS host.');
    const f = this.files.get(url);
    if (f === undefined) throw new UsgsLidarError('http', 'USGS answered 404.');
    const out = o.range === undefined ? f : f.subarray(o.range[0], Math.min(f.byteLength, o.range[1] + 1));
    if (out.byteLength > o.maxBytes) throw new UsgsLidarError('too-large', 'A lidar file is larger than allowed.');
    return out.slice();
  }

  async size(url: string): Promise<number> {
    this.calls.push({ kind: 'size', url });
    await this.step();
    const f = this.files.get(url);
    if (f === undefined) throw new UsgsLidarError('http', 'USGS answered 404.');
    return f.byteLength;
  }
}

export function createUsgsLidarApi(config: Config): UsgsLidarApi {
  const mode = (config as { USGS_LIDAR_MODE?: string }).USGS_LIDAR_MODE ?? 'off';
  if (mode === 'off') return new UnconfiguredUsgsLidarApi();
  if (config.FAKE_PROVIDERS) return new FakeUsgsLidarApi();
  return new RealUsgsLidarApi();
}
