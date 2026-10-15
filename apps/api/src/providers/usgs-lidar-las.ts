import { createLazPerf, type LazPerf } from 'laz-perf';

/*
 * Reading USGS 3DEP point clouds (LAS 1.2-1.4, LAZ-compressed) without native code: the header and CRS are parsed
 * here, the points decompressed by laz-perf (WebAssembly). Only what the roof needs is kept: the points inside a box,
 * their height, return flags and class. Every read is bounded (bytes in, points out) and failures are typed
 * (LasError.reason), never a crash of the process. USGS 3DEP lidar is public domain.
 */

export const LAS_FAILURES = ['not-las', 'unsupported-format', 'no-crs', 'not-utm', 'too-large', 'decode'] as const;
export type LasFailure = (typeof LAS_FAILURES)[number];

export class LasError extends Error {
  readonly reason: LasFailure;
  constructor(reason: LasFailure, message: string) {
    super(message);
    this.name = 'LasError';
    this.reason = reason;
  }
}

export type LasHeader = {
  versionMinor: number;
  pointFormat: number;
  pointLength: number;
  pointOffset: number;
  pointCount: number;
  compressed: boolean;
  scale: [number, number, number];
  offset: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  /** OGC WKT from the LASF_Projection VLR (record 2112), when present. */
  wkt: string | null;
  /** ProjectedCSTypeGeoKey (3072) from the GeoKeyDirectory VLR (record 34735), when present. */
  geoKeyEpsg: number | null;
  /** Vertical unit from the GeoKeys (4099 VerticalUnitsGeoKey) or the WKT: metres per z unit. */
  zUnitM: number;
};

/** A horizontal CRS the reconstruction can use: a UTM zone (north), as EPSG 269zz (NAD83) or 326zz (WGS84). */
export type LasCrs = { epsg: number; zone: number; zUnitM: number };

const US_SURVEY_FOOT_M = 1200 / 3937;
const FOOT_M = 0.3048;

/** The LAS header (and the VLRs inside the first `bytes`). Throws LasError('not-las') on anything else. */
export function parseLasHeader(bytes: Uint8Array): LasHeader {
  if (bytes.byteLength < 227 || String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) !== 'LASF') throw new LasError('not-las', 'Not a LAS file.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const versionMinor = bytes[25]!;
  const headerSize = dv.getUint16(94, true);
  const pointOffset = dv.getUint32(96, true);
  const nVlr = dv.getUint32(100, true);
  const fmtByte = bytes[104]!;
  const compressed = (fmtByte & 0x80) !== 0 || (fmtByte & 0x40) !== 0;
  const pointFormat = fmtByte & 0x3f;
  const pointLength = dv.getUint16(105, true);
  let pointCount = dv.getUint32(107, true);
  if (versionMinor >= 4 && bytes.byteLength >= 255) {
    const big = Number(dv.getBigUint64(247, true));
    if (big > 0) pointCount = big;
  }
  const f = (o: number) => dv.getFloat64(o, true);
  const header: LasHeader = {
    versionMinor,
    pointFormat,
    pointLength,
    pointOffset,
    pointCount,
    compressed,
    scale: [f(131), f(139), f(147)],
    offset: [f(155), f(163), f(171)],
    max: [f(179), f(195), f(211)],
    min: [f(187), f(203), f(219)],
    wkt: null,
    geoKeyEpsg: null,
    zUnitM: 1,
  };
  let at = headerSize;
  let zUnitFromKeys: number | null = null;
  for (let v = 0; v < nVlr && at + 54 <= bytes.byteLength && v < 64; v++) {
    const user = String.fromCharCode(...bytes.subarray(at + 2, at + 18)).replace(/\0.*$/s, '');
    const record = dv.getUint16(at + 18, true);
    const len = dv.getUint16(at + 20, true);
    const body = at + 54;
    if (body + len > bytes.byteLength) break;
    if (user === 'LASF_Projection' && record === 2112) {
      header.wkt = new TextDecoder().decode(bytes.subarray(body, body + len)).replace(/\0+$/, '');
    } else if (user === 'LASF_Projection' && record === 34735 && len >= 8) {
      const nKeys = dv.getUint16(body + 6, true);
      for (let k = 0; k < nKeys && body + 8 + 8 * k + 8 <= body + len; k++) {
        const o = body + 8 + 8 * k;
        const id = dv.getUint16(o, true);
        const loc = dv.getUint16(o + 2, true);
        const value = dv.getUint16(o + 6, true);
        if (loc !== 0) continue;
        if (id === 3072) header.geoKeyEpsg = value;
        if (id === 4099) zUnitFromKeys = value === 9001 ? 1 : value === 9003 ? US_SURVEY_FOOT_M : value === 9002 ? FOOT_M : null;
      }
    }
    at = body + len;
  }
  header.zUnitM = zUnitFromKeys ?? zUnitOfWkt(header.wkt) ?? 1;
  return header;
}

/** Metres per vertical unit named in a WKT's vertical CRS (VERT_CS / VERTCRS), or null when it names none. */
function zUnitOfWkt(wkt: string | null): number | null {
  if (wkt === null) return null;
  const i = Math.max(wkt.indexOf('VERT_CS'), wkt.indexOf('VERTCRS'));
  if (i < 0) return null;
  const v = wkt.slice(i);
  if (/US survey foot|foot_survey_us|Foot_US/i.test(v)) return US_SURVEY_FOOT_M;
  if (/"foot"|international foot|"ft"/i.test(v)) return FOOT_M;
  return 1;
}

/**
 * The header's horizontal CRS as a UTM zone, or a LasError: 'no-crs' (none recorded), 'not-utm' (state plane, feet,
 * anything else: not read rather than guessed). NAD83 / NAD83(2011) / NAD83(HARN) / WGS84 UTM north zones are taken;
 * their differences (about a metre) are taken out by the reconstruction's own registration.
 */
export function lasCrs(h: LasHeader): LasCrs {
  const zone = utmZoneOf(h.geoKeyEpsg) ?? utmZoneOfWkt(h.wkt);
  if (zone === null) throw new LasError(h.wkt === null && h.geoKeyEpsg === null ? 'no-crs' : 'not-utm', 'The point cloud is not in a UTM zone in metres.');
  return { epsg: 26900 + zone, zone, zUnitM: h.zUnitM };
}

/** UTM north zone of an EPSG code (NAD83 269zz, NAD83(2011) 6330-6348, NAD83(HARN) 3740-3759 range partly, WGS84 326zz). */
export function utmZoneOf(epsg: number | null): number | null {
  if (epsg === null) return null;
  if (epsg >= 26901 && epsg <= 26923) return epsg - 26900;
  if (epsg >= 32601 && epsg <= 32660) return epsg - 32600;
  if (epsg >= 6330 && epsg <= 6348) return epsg - 6329;
  return null;
}

function utmZoneOfWkt(wkt: string | null): number | null {
  if (wkt === null) return null;
  const horiz = wkt.split(/VERT_CS|VERTCRS/)[0]!;
  const m = /UTM[ _]zone[ _](\d{1,2})N/i.exec(horiz);
  if (m === null) return null;
  // Metres only: a UTM grid in feet is not one the reconstruction reads.
  if (/UNIT\["(US survey foot|foot|Foot_US)/i.test(horiz.split('PROJECTION')[1] ?? '')) return null;
  const zone = Number(m[1]);
  return zone >= 1 && zone <= 60 ? zone : null;
}

/** A crop of the cloud: absolute coordinates in the source CRS units, z in metres. */
export type LasCrop = {
  x: Float64Array;
  y: Float64Array;
  z: Float32Array;
  /** Bit 0: last return of its pulse. Bit 1: classified ground (class 2). */
  flags: Uint8Array;
  cls: Uint8Array;
  /** GPS time quantiles (min, median, max) of the points kept, adjusted standard GPS seconds; null when absent. */
  gpsTime: [number, number, number] | null;
  scanned: number;
};

export type LasCropLimits = { maxBytes: number; maxPointsScanned: number; maxPointsKept: number };

let lazPerf: Promise<LazPerf> | null = null;
function lazModule(): Promise<LazPerf> {
  if (lazPerf === null) lazPerf = createLazPerf() as Promise<LazPerf>;
  return lazPerf;
}

/** Points decoded between yields to the event loop (about 30 ms of work). */
const YIELD_EVERY = 100_000;

/** Classes never used: 7 low noise, 18 high noise. */
const NOISE = new Set([7, 18]);

/**
 * The points of a LAS/LAZ file inside [x0, x1] x [y0, y1] (source CRS units), noise dropped. Reads the whole file
 * (USGS LAZ chunks are in flight order, not spatial), within `limits`. Throws LasError.
 */
export async function cropLas(bytes: Uint8Array, box: { x0: number; x1: number; y0: number; y1: number }, limits: LasCropLimits): Promise<LasCrop> {
  if (bytes.byteLength > limits.maxBytes) throw new LasError('too-large', 'The point cloud file is too large.');
  const h = parseLasHeader(bytes);
  if (h.pointCount > limits.maxPointsScanned) throw new LasError('too-large', 'The point cloud has too many points.');
  const fmt = h.pointFormat;
  if (!(fmt <= 3 || (fmt >= 6 && fmt <= 8))) throw new LasError('unsupported-format', `Point format ${fmt} is not read.`);
  const extended = fmt >= 6;
  const gpsAt = extended ? 22 : fmt === 1 || fmt === 3 ? 20 : -1;
  const [sx, sy, sz] = h.scale;
  const [ox, oy, oz] = h.offset;
  // Integer bounds of the box, so the per-point test needs no float maths.
  const ix0 = Math.floor((box.x0 - ox) / sx);
  const ix1 = Math.ceil((box.x1 - ox) / sx);
  const iy0 = Math.floor((box.y0 - oy) / sy);
  const iy1 = Math.ceil((box.y1 - oy) / sy);
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const fl: number[] = [];
  const cl: number[] = [];
  const ts: number[] = [];
  const keep = (rec: DataView, b0: number): void => {
    const X = rec.getInt32(b0, true);
    if (X < ix0 || X > ix1) return;
    const Y = rec.getInt32(b0 + 4, true);
    if (Y < iy0 || Y > iy1) return;
    let rn: number, nr: number, c: number;
    if (extended) {
      const b = rec.getUint8(b0 + 14);
      rn = b & 0x0f;
      nr = b >> 4;
      c = rec.getUint8(b0 + 16);
    } else {
      const b = rec.getUint8(b0 + 14);
      rn = b & 0x07;
      nr = (b >> 3) & 0x07;
      c = rec.getUint8(b0 + 15) & 0x1f;
    }
    if (NOISE.has(c) || (extended && (rec.getUint8(b0 + 15) & 0x08) !== 0)) return; // noise, or the withheld flag
    if (xs.length >= limits.maxPointsKept) throw new LasError('too-large', 'Too many points round the house.');
    xs.push(X * sx + ox);
    ys.push(Y * sy + oy);
    zs.push((rec.getInt32(b0 + 8, true) * sz + oz) * h.zUnitM);
    fl.push((rn === nr && nr > 0 ? 1 : 0) | (c === 2 ? 2 : 0));
    cl.push(c);
    if (gpsAt >= 0) ts.push(rec.getFloat64(b0 + gpsAt, true));
  };
  if (!h.compressed) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (h.pointLength < (extended ? 30 : 20)) throw new LasError('decode', 'The point records are too short.');
    for (let i = 0; i < h.pointCount; i++) {
      if (i % YIELD_EVERY === YIELD_EVERY - 1) await new Promise<void>((r) => setImmediate(r));
      const o = h.pointOffset + i * h.pointLength;
      if (o + h.pointLength > bytes.byteLength) throw new LasError('decode', 'The point cloud is truncated.');
      keep(dv, o);
    }
  } else {
    const L = await lazModule();
    const filePtr = L._malloc(bytes.byteLength);
    const pointPtr = L._malloc(h.pointLength);
    const zip = new L.LASZip();
    try {
      L.HEAPU8.set(bytes, filePtr);
      try {
        zip.open(filePtr, bytes.byteLength);
      } catch {
        throw new LasError('decode', 'The compressed point cloud could not be opened.');
      }
      const n = zip.getCount();
      if (n > limits.maxPointsScanned) throw new LasError('too-large', 'The point cloud has too many points.');
      if (zip.getPointLength() < (extended ? 30 : 20)) throw new LasError('decode', 'The point records are too short.');
      let view = new DataView(L.HEAPU8.buffer);
      for (let i = 0; i < n; i++) {
        // Hand the event loop back now and then: a 15 million point tile takes seconds, and the API keeps answering.
        if (i % YIELD_EVERY === YIELD_EVERY - 1) await new Promise<void>((r) => setImmediate(r));
        try {
          zip.getPoint(pointPtr);
        } catch {
          throw new LasError('decode', 'The compressed point cloud is damaged.');
        }
        // The heap's buffer is replaced when it grows: take a new view only then.
        if (view.buffer !== L.HEAPU8.buffer) view = new DataView(L.HEAPU8.buffer);
        keep(view, pointPtr);
      }
    } finally {
      zip.delete();
      L._free(pointPtr);
      L._free(filePtr);
    }
  }
  return {
    x: Float64Array.from(xs),
    y: Float64Array.from(ys),
    z: Float32Array.from(zs),
    flags: Uint8Array.from(fl),
    cls: Uint8Array.from(cl),
    gpsTime: quantiles(ts),
    scanned: h.pointCount,
  };
}

function quantiles(t: number[]): [number, number, number] | null {
  if (t.length === 0) return null;
  const s = Float64Array.from(t).sort();
  return [s[0]!, s[Math.floor(s.length / 2)]!, s[s.length - 1]!];
}

/** GPS week-adjusted standard time (LAS 1.4 global encoding bit 0) as a YYYY-MM-DD date, or null when implausible. */
export function gpsDate(t: number): string | null {
  // Adjusted standard GPS time is GPS seconds minus 1e9; GPS epoch 1980-01-06.
  const ms = Date.UTC(1980, 0, 6) + (t + 1e9) * 1000;
  if (!Number.isFinite(ms) || ms < Date.UTC(1995, 0, 1) || ms > Date.UTC(2100, 0, 1)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}
