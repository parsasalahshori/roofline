import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { LngLat, SolarBuilding } from '@roofline/shared';
import { parseBuildingInsights } from '../../providers/google-solar.ts';
import { layersFrom, readGeoTiff, readRgbGeoTiff } from '../../providers/google-solar-layers.ts';
import type { RoofLayers, RoofPhoto } from '../../providers/solar-layers.ts';
import { type EagleViewTruth, EagleViewTruthSchema, type VisualTruth, VisualTruthSchema } from './truth.ts';
import type { HouseEntry } from './manifest.ts';
import { type LidarTruth, readLidarTruth } from './lidar.ts';
import { benchDir, houseDir } from './paths.ts';
import type { LidarPointsUtm } from '../../estimator/roof-3d.ts';

/** Google's own whole-roof numbers for the building (buildingInsights), an independent source for the proxy checks. */
export type GoogleFacts = {
  /** Square metres of ground under the roof Google saw, and the roof's sloped area. */
  groundM2: number | null;
  slopedM2: number | null;
  /** Segments of 2 square metres or more of ground (what the estimator counts as roof planes). */
  segments: number;
  box: { sw: LngLat; ne: LngLat } | null;
};

export type LoadedHouse = {
  entry: HouseEntry;
  dir: string;
  layers: RoofLayers;
  building: SolarBuilding | null;
  google: GoogleFacts;
  eagleview: EagleViewTruth | null;
  visual: VisualTruth | null;
  /** An independent building outline (OpenStreetMap, ODbL) when the house has one: a proxy, never truth. */
  osm: LngLat[] | null;
  /** The house's accepted lidar truth (lidar.ts) when its lidar grade is 'lidar', and the file's short sha1. */
  lidar?: LidarTruth | null;
  lidarSha1?: string | null;
  /** The lidar crop the hidden-edge step reads (lidar-edges.ts), only on runs with --lidar-edges. Input, never truth. */
  lidarPoints?: LidarPointsUtm | null;
  /**
   * The lidar crop the fusion step reads (roof-reconstruct/lidar-fusion.ts), only on runs with --lidar-fusion: the same
   * metadata-picked flight as --lidar-edges. Input, never truth: a run that reads it is scored on EagleView and on
   * cross-flight lidar truth (a different flight), never on the lidar truth from this flight.
   */
  lidarFusionPoints?: LidarPointsUtm | null;
};

/** Google's files are a few hundred kilobytes each; the server refuses anything near 40 MB, and so does the benchmark. */
export const MAX_FILE_BYTES = 40 * 1024 * 1024;

function bytes(file: string): ArrayBuffer {
  if (statSync(file).size > MAX_FILE_BYTES) throw new Error(`${path.basename(file)} is over ${MAX_FILE_BYTES} bytes`);
  const b = readFileSync(file);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function numberAt(o: unknown, ...keys: string[]): number | null {
  let v: unknown = o;
  for (const k of keys) v = typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[k] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * ROOF3D_BENCH_RESAMPLE_M=0.25 runs the benchmark on Google MEDIUM-like layers: the height map, the mask AND the photo
 * resampled to that pixel size with an area-weighted box filter on each file's own grid (heights: the weighted mean of
 * the finite heights, no data when under half the area has one; mask: roof when at least half the area is; photo: the
 * weighted mean colour), imagery quality MEDIUM. No benchmark house has MEDIUM imagery of its own, and a check that
 * resampled only the heights left the photo method on 0.1 m pixels (verification of the outline round). Unset or 0:
 * the files as they are.
 */
export function resampleFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.ROOF3D_BENCH_RESAMPLE_M ?? '');
  if (env.ROOF3D_BENCH_RESAMPLE_M === undefined || env.ROOF3D_BENCH_RESAMPLE_M === '' || v === 0) return 0;
  if (!(Number.isFinite(v) && v > 0 && v <= 1)) throw new Error(`ROOF3D_BENCH_RESAMPLE_M: ${JSON.stringify(env.ROOF3D_BENCH_RESAMPLE_M)} is not a pixel size in metres (0-1]`);
  return v;
}

/** For each output cell along one axis, the input cells it covers and by how much (metres). */
function axisWeights(nOut: number, nIn: number, s0: number, s: number): { j: number; w: number }[][] {
  const out: { j: number; w: number }[][] = [];
  for (let i = 0; i < nOut; i++) {
    const a = i * s;
    const b = (i + 1) * s;
    const ws: { j: number; w: number }[] = [];
    for (let j = Math.floor(a / s0); j < nIn && j * s0 < b; j++) {
      const w = Math.min(b, (j + 1) * s0) - Math.max(a, j * s0);
      if (w > 1e-9) ws.push({ j, w });
    }
    out.push(ws);
  }
  return out;
}

type Grid = Awaited<ReturnType<typeof readGeoTiff>>;

/** A height grid or a mask grid resampled to `s` metres (see resampleFromEnv). */
export function resampleGrid(g: Grid, s: number, kind: 'height' | 'mask'): Grid {
  const w = Math.floor((g.width * g.pixelX) / s);
  const h = Math.floor((g.height * g.pixelY) / s);
  const wx = axisWeights(w, g.width, g.pixelX, s);
  const wy = axisWeights(h, g.height, g.pixelY, s);
  const data = new Float32Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      let sw = 0;
      let sv = 0;
      let tot = 0;
      for (const y of wy[r]!) {
        for (const x of wx[c]!) {
          const wt = y.w * x.w;
          tot += wt;
          const v = Number(g.data[y.j * g.width + x.j]);
          if (kind === 'mask') {
            if (v > 0) sv += wt;
          } else if (Number.isFinite(v) && v !== g.noData && v > -1000) {
            sw += wt;
            sv += wt * v;
          }
        }
      }
      data[r * w + c] = kind === 'mask' ? (sv >= 0.5 * tot ? 1 : 0) : sw >= 0.5 * tot ? sv / sw : Number.NaN;
    }
  }
  return { ...g, width: w, height: h, pixelX: s, pixelY: s, data, noData: null };
}

/** The photo resampled to `s` metres (see resampleFromEnv). */
export function resamplePhoto(p: RoofPhoto, s: number): RoofPhoto {
  const w = Math.floor((p.width * p.pixelSizeM) / s);
  const h = Math.floor((p.height * p.pixelSizeM) / s);
  const wx = axisWeights(w, p.width, p.pixelSizeM, s);
  const wy = axisWeights(h, p.height, p.pixelSizeM, s);
  const rgb = new Uint8Array(w * h * 3);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      for (let k = 0; k < 3; k++) {
        let sw = 0;
        let sv = 0;
        for (const y of wy[r]!) {
          for (const x of wx[c]!) {
            const wt = y.w * x.w;
            sw += wt;
            sv += wt * p.rgb[(y.j * p.width + x.j) * 3 + k]!;
          }
        }
        rgb[(r * w + c) * 3 + k] = Math.round(sv / sw);
      }
    }
  }
  return { ...p, width: w, height: h, pixelSizeM: s, rgb };
}

/** Reads the layers the way the roof-3d-check script does: heights and mask on one grid, the photo, the quality. */
export async function readLayers(dir: string, resampleM: number = resampleFromEnv()): Promise<RoofLayers> {
  let dsm = await readGeoTiff(bytes(path.join(dir, 'dsm.tif')));
  let mask = await readGeoTiff(bytes(path.join(dir, 'mask.tif')));
  const metaFile = path.join(dir, 'meta.json');
  const meta = existsSync(metaFile) ? (JSON.parse(readFileSync(metaFile, 'utf8')) as { imageryQuality?: string | null }) : {};
  let quality = meta.imageryQuality ?? null;
  if (resampleM > 0) {
    dsm = resampleGrid(dsm, resampleM, 'height');
    mask = resampleGrid(mask, resampleM, 'mask');
    quality = 'MEDIUM';
  }
  const layers = layersFrom(dsm, mask, { imageryQuality: quality, imageryDate: null });
  const rgb = path.join(dir, 'rgb.tif');
  let photo = existsSync(rgb) ? await readRgbGeoTiff(bytes(rgb)) : null;
  if (photo !== null && resampleM > 0) photo = resamplePhoto(photo, resampleM);
  return { ...layers, photo };
}

export function readInsights(dir: string): { building: SolarBuilding | null; google: GoogleFacts } {
  const file = path.join(dir, 'bi.json');
  if (!existsSync(file)) return { building: null, google: { groundM2: null, slopedM2: null, segments: 0, box: null } };
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const building = 'segments' in raw ? (raw as unknown as SolarBuilding) : parseBuildingInsights(raw);
  const whole = (raw.solarPotential as Record<string, unknown> | undefined)?.wholeRoofStats;
  return {
    building,
    google: {
      groundM2: numberAt(whole, 'groundAreaMeters2'),
      slopedM2: numberAt(whole, 'areaMeters2'),
      segments: building.segments.filter((s) => s.groundAreaM2 >= 2).length,
      box: building.box,
    },
  };
}

/** Everything the benchmark needs about one house. Throws when its files are missing or unreadable. */
export async function loadHouse(entry: HouseEntry, bench?: string, fallback?: string): Promise<LoadedHouse> {
  const dir = houseDir(entry.dir, bench, fallback);
  if (dir === null) throw new Error(`no data for ${entry.slug} (looked for ${entry.dir}/dsm.tif)`);
  const layers = await readLayers(dir);
  const { building, google } = readInsights(dir);
  const ev = path.join(dir, 'eagleview.json');
  const vis = path.join(dir, 'visual.json');
  const osm = path.join(dir, 'osm.json');
  const lidar = entry.lidar?.grade === 'lidar' || entry.truth === 'lidar' ? readLidarTruth(bench ?? benchDir(), entry.slug) : null;
  if ((entry.lidar?.grade === 'lidar' || entry.truth === 'lidar') && lidar === null) throw new Error(`no lidar truth for ${entry.slug} (graded 'lidar' in lidar/index.json)`);
  return {
    entry,
    dir,
    layers,
    building,
    google,
    eagleview: existsSync(ev) ? EagleViewTruthSchema.parse(JSON.parse(readFileSync(ev, 'utf8'))) : null,
    visual: existsSync(vis) ? VisualTruthSchema.parse(JSON.parse(readFileSync(vis, 'utf8'))) : null,
    osm: existsSync(osm) ? ((JSON.parse(readFileSync(osm, 'utf8')) as { ring: LngLat[] }).ring ?? null) : null,
    lidar: lidar?.truth ?? null,
    lidarSha1: lidar?.sha1 ?? null,
  };
}
