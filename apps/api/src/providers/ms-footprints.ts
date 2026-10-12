import type { Config } from '../config.ts';
import type { FootprintSource } from './footprints.ts';

/** The real source (config.FOOTPRINTS_BASE_URL) arrives in a later task; until then nothing is configured. */
export function msFootprintsFor(config: Config): FootprintSource | null {
  void config;
  return null;
}
