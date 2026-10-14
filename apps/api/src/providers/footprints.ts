import type { Ring } from '@roofline/shared';
import type { Config } from '../config.ts';
import { FakeFootprintSource } from './fakes/footprints.ts';
import { msFootprintsFor } from './ms-footprints.ts';

export type FootprintFeature = { sourceRef: string; ring: Ring };
/**
 * Building outlines, one zoom-9 quadkey tile at a time (Microsoft Global ML Building Footprints).
 * `tileUrls` names the tile's files (none: the tile has no US buildings, which is not an error);
 * `features` streams every building in them.
 */
export interface FootprintSource {
  readonly configured: boolean;
  tileUrls(quadkey: string): Promise<string[]>;
  features(quadkey: string): AsyncIterable<FootprintFeature>;
}

export class FootprintsUnavailableError extends Error {}

export class UnconfiguredFootprintSource implements FootprintSource {
  readonly configured = false;
  tileUrls(): Promise<string[]> {
    return Promise.reject(new FootprintsUnavailableError("Building footprints aren't set up."));
  }
  // eslint-disable-next-line require-yield
  async *features(): AsyncGenerator<FootprintFeature> {
    throw new FootprintsUnavailableError("Building footprints aren't set up.");
  }
}

export function createFootprintSource(config: Config): FootprintSource {
  if (config.FAKE_PROVIDERS && !config.DEMO_REAL_FOOTPRINTS) return new FakeFootprintSource();
  return msFootprintsFor(config) ?? new UnconfiguredFootprintSource();
}
