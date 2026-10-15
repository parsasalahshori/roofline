// The lidar point crops the hidden-edge method reads (outline-lidar.ts), exported by
// scripts/roof-bench-lidar/edge_points.py into ROOF_BENCH_DIR/lidar-edges/<slug>.{bin,json}. These are the method's
// INPUT, not truth: the project per house is picked from metadata alone (leaf-off, latest flight, most points), and a
// method that reads them is scored on EagleView only, never on the lidar truth built from the same returns.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { LidarPointsUtm } from '../../estimator/roof-3d.ts';

/** A crop is a few MB (a 70 m QL1 square is about 150 000 points, 13 bytes each); refuse anything far past that. */
export const MAX_EDGE_POINTS_BYTES = 16 * 1024 * 1024;
const RECORD = 13;

export const LidarEdgeInfoSchema = z.object({
  slug: z.string(),
  workunit: z.string(),
  project: z.string(),
  ql: z.string().nullable().optional(),
  utmEpsg: z.number().int(),
  originE: z.number(),
  originN: z.number(),
  count: z.number().int().nonnegative(),
  leafOff: z.boolean(),
  flightEnd: z.string().nullable(),
  fetchKind: z.string(),
  fetchBytes: z.number().nullable(),
  eptNodes: z.number().nullable().optional(),
  cropBytes: z.number(),
});
export type LidarEdgeInfo = z.infer<typeof LidarEdgeInfoSchema>;

export function lidarEdgesDir(bench: string): string {
  return path.join(bench, 'lidar-edges');
}

/** Whole years between two ISO dates (absolute); null when either is missing. */
export function yearsBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  const ya = a == null ? Number.NaN : Number(a.slice(0, 4));
  const yb = b == null ? Number.NaN : Number(b.slice(0, 4));
  return Number.isFinite(ya) && Number.isFinite(yb) ? Math.abs(ya - yb) : null;
}

/** The house's lidar crop as the reconstruction takes it, with its metadata; null when it has none. Throws on a malformed file. */
export function readLidarEdgePoints(bench: string, slug: string, imageryDate: string | null, dirName = 'lidar-edges'): { points: LidarPointsUtm; info: LidarEdgeInfo } | null {
  const base = path.join(bench, dirName, slug);
  if (!existsSync(`${base}.json`) || !existsSync(`${base}.bin`)) return null;
  const info = LidarEdgeInfoSchema.parse(JSON.parse(readFileSync(`${base}.json`, 'utf8')));
  const size = statSync(`${base}.bin`).size;
  if (size > MAX_EDGE_POINTS_BYTES) throw new Error(`${slug}.bin is over ${MAX_EDGE_POINTS_BYTES} bytes`);
  if (size !== info.count * RECORD) throw new Error(`${slug}.bin holds ${size} bytes, expected ${info.count} records`);
  const buf = readFileSync(`${base}.bin`);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = info.count;
  const dx = new Float32Array(n);
  const dy = new Float32Array(n);
  const zz = new Float32Array(n);
  const flags = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * RECORD;
    dx[i] = view.getFloat32(o, true);
    dy[i] = view.getFloat32(o + 4, true);
    zz[i] = view.getFloat32(o + 8, true);
    flags[i] = view.getUint8(o + 12);
  }
  return {
    points: { epsg: info.utmEpsg, originE: info.originE, originN: info.originN, dx, dy, z: zz, flags, leafOff: info.leafOff, ageYears: yearsBetween(info.flightEnd, imageryDate) },
    info,
  };
}
