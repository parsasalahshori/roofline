import { existsSync } from 'node:fs';
import path from 'node:path';

/** Where the benchmark's manifest, gates, baseline and data live (override with ROOF_BENCH_DIR). */
export const DEFAULT_BENCH_DIR = '/Users/parsasalahshori-a/RooflineWork/roof-bench';
/** Where the houses came from before the benchmark folder existed: used when a house is not found in the bench folder. */
export const FALLBACK_DATA_DIR = '/Users/parsasalahshori-a/RooflineWork/saved-testdata';

export function benchDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.ROOF_BENCH_DIR ?? DEFAULT_BENCH_DIR);
}

/** The folder holding a house's files: the bench folder's, else the fallback's; null when neither has dsm.tif. */
export function houseDir(rel: string, bench: string = benchDir(), fallback: string = FALLBACK_DATA_DIR): string | null {
  for (const root of [bench, fallback]) {
    const dir = path.join(root, rel);
    if (existsSync(path.join(dir, 'dsm.tif'))) return dir;
  }
  return null;
}
