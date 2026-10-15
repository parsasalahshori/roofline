import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { LngLat, SolarBuilding } from '@roofline/shared';
import { parseBuildingInsights } from '../../providers/google-solar.ts';
import { layersFrom, readGeoTiff, readRgbGeoTiff } from '../../providers/google-solar-layers.ts';
import type { RoofLayers } from '../../providers/solar-layers.ts';
import { type EagleViewTruth, EagleViewTruthSchema, type VisualTruth, VisualTruthSchema } from './truth.ts';
import type { HouseEntry } from './manifest.ts';
import { type LidarTruth, readLidarTruth } from './lidar.ts';
import { benchDir, houseDir } from './paths.ts';

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

/** Reads the layers the way the roof-3d-check script does: heights and mask on one grid, the photo, the quality. */
export async function readLayers(dir: string): Promise<RoofLayers> {
  const dsm = await readGeoTiff(bytes(path.join(dir, 'dsm.tif')));
  const mask = await readGeoTiff(bytes(path.join(dir, 'mask.tif')));
  const metaFile = path.join(dir, 'meta.json');
  const meta = existsSync(metaFile) ? (JSON.parse(readFileSync(metaFile, 'utf8')) as { imageryQuality?: string | null }) : {};
  const layers = layersFrom(dsm, mask, { imageryQuality: meta.imageryQuality ?? null, imageryDate: null });
  const rgb = path.join(dir, 'rgb.tif');
  return { ...layers, photo: existsSync(rgb) ? await readRgbGeoTiff(bytes(rgb)) : null };
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
