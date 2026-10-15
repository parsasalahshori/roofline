import { cropLas, type LasCrop, LasError } from './usgs-lidar-las.ts';
import { type UsgsLidarApi, UsgsLidarError } from './usgs-lidar.ts';

/*
 * Entwine Point Tiles (EPT): the USGS 3DEP point clouds that AWS's usgs-lidar-public bucket holds as an octree in Web
 * Mercator (EPSG 3857), laszip nodes. Unlike a LAZ tile (60-300 MB that must be read whole), a house needs only the
 * few nodes whose square meets it: a few MB from S3. Only older projects are there (2023-2025 QL1 Arkansas is not), so
 * this is the fast path when it exists and tiles are the fallback. Every read is bounded; failures are typed.
 */

export type EptLimits = { timeoutMs: number; maxNodes: number; maxHierarchyFiles: number; maxNodeBytes: number; maxPointsKept: number; parallel: number };

export const DEFAULT_EPT_LIMITS: EptLimits = { timeoutMs: 20_000, maxNodes: 256, maxHierarchyFiles: 32, maxNodeBytes: 32 << 20, maxPointsKept: 2_000_000, parallel: 8 };

const R = 6378137;

/** Web Mercator metres to lng/lat degrees. */
export function mercatorToLngLat(x: number, y: number): [number, number] {
  return [((x / R) * 180) / Math.PI, ((2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180) / Math.PI];
}

/** lng/lat degrees to Web Mercator metres. */
export function lngLatToMercator(lng: number, lat: number): [number, number] {
  return [(lng * Math.PI * R) / 180, R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))];
}

function json(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new UsgsLidarError('bad-answer', 'An EPT file is not JSON.');
  }
}

/**
 * The points of the EPT dataset at `eptUrl` inside the Web Mercator box, as absolute 3857 coordinates (cropLas's
 * LasCrop, x/y in 3857 metres, z metres). Nodes are listed from the hierarchy (with its -1 sub-files), read in
 * parallel, cropped, and concatenated in key order (deterministic).
 */
export async function cropEpt(api: UsgsLidarApi, eptUrl: string, box: { x0: number; x1: number; y0: number; y1: number }, limits: EptLimits = DEFAULT_EPT_LIMITS): Promise<{ crop: LasCrop; nodes: number; bytes: number }> {
  if (!eptUrl.endsWith('/ept.json')) throw new UsgsLidarError('bad-answer', 'Not an EPT root.');
  const root = eptUrl.slice(0, -'/ept.json'.length);
  const meta = json(await api.getBytes(eptUrl, { timeoutMs: limits.timeoutMs, maxBytes: 1 << 20 })) as { bounds?: unknown; dataType?: unknown; srs?: { horizontal?: unknown } };
  const b = meta.bounds;
  if (!Array.isArray(b) || b.length !== 6 || !b.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new UsgsLidarError('bad-answer', 'The EPT bounds could not be read.');
  if (meta.dataType !== 'laszip' || String(meta.srs?.horizontal ?? '') !== '3857') throw new UsgsLidarError('bad-answer', 'The EPT dataset is not laszip in Web Mercator.');
  const [bx0, by0, , bx1] = b as number[];
  const span = bx1! - bx0!;
  let hierarchyFiles = 0;
  const hierarchy = async (key: string): Promise<Record<string, number>> => {
    if (++hierarchyFiles > limits.maxHierarchyFiles) throw new UsgsLidarError('too-large', 'The EPT hierarchy is too deep.');
    const h = json(await api.getBytes(`${root}/ept-hierarchy/${key}.json`, { timeoutMs: limits.timeoutMs, maxBytes: 4 << 20 }));
    if (h === null || typeof h !== 'object') throw new UsgsLidarError('bad-answer', 'An EPT hierarchy could not be read.');
    return h as Record<string, number>;
  };
  const nodes: string[] = [];
  const walk = async (d: number, x: number, y: number, z: number, h: Record<string, number>): Promise<void> => {
    const key = `${d}-${x}-${y}-${z}`;
    let n = h[key];
    if (n === undefined) return;
    const size = span / 2 ** d;
    const x0 = bx0! + x * size;
    const y0 = by0! + y * size;
    if (x0 > box.x1 || x0 + size < box.x0 || y0 > box.y1 || y0 + size < box.y0) return;
    let hh = h;
    if (n === -1) {
      hh = await hierarchy(key);
      n = hh[key] ?? 0;
    }
    if (n > 0) {
      nodes.push(key);
      if (nodes.length > limits.maxNodes) throw new UsgsLidarError('too-large', 'Too many EPT nodes round the house.');
    }
    for (const dx of [0, 1]) for (const dy of [0, 1]) for (const dz of [0, 1]) await walk(d + 1, 2 * x + dx, 2 * y + dy, 2 * z + dz, hh);
  };
  await walk(0, 0, 0, 0, await hierarchy('0-0-0-0'));
  nodes.sort();
  const parts: LasCrop[] = new Array<LasCrop>(nodes.length);
  let bytes = 0;
  let kept = 0;
  let next = 0;
  const worker = async () => {
    while (next < nodes.length) {
      const i = next++;
      const data = await api.getBytes(`${root}/ept-data/${nodes[i]}.laz`, { timeoutMs: limits.timeoutMs, maxBytes: limits.maxNodeBytes });
      bytes += data.byteLength;
      const c = await cropLas(data, box, { maxBytes: limits.maxNodeBytes, maxPointsScanned: 50_000_000, maxPointsKept: limits.maxPointsKept });
      kept += c.x.length;
      if (kept > limits.maxPointsKept) throw new LasError('too-large', 'Too many points round the house.');
      parts[i] = c;
    }
  };
  await Promise.all(Array.from({ length: Math.min(limits.parallel, nodes.length) }, worker));
  return { crop: concat(parts), nodes: nodes.length, bytes };
}

function concat(parts: LasCrop[]): LasCrop {
  const n = parts.reduce((t, p) => t + p.x.length, 0);
  const out: LasCrop = { x: new Float64Array(n), y: new Float64Array(n), z: new Float32Array(n), flags: new Uint8Array(n), cls: new Uint8Array(n), gpsTime: null, scanned: 0 };
  let at = 0;
  const times: number[] = [];
  for (const p of parts) {
    out.x.set(p.x, at);
    out.y.set(p.y, at);
    out.z.set(p.z, at);
    out.flags.set(p.flags, at);
    out.cls.set(p.cls, at);
    at += p.x.length;
    out.scanned += p.scanned;
    if (p.gpsTime !== null) times.push(...p.gpsTime);
  }
  times.sort((a, b) => a - b);
  out.gpsTime = times.length === 0 ? null : [times[0]!, times[Math.floor(times.length / 2)]!, times[times.length - 1]!];
  return out;
}
