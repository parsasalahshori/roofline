import type { Ring } from '@roofline/shared';
import type { Config } from '../config.ts';
import { FakeFootprintSource } from './fakes/footprints.ts';
import { globalFootprintsFor } from './global-footprints.ts';
import { msFootprintsFor } from './ms-footprints.ts';

export type FootprintFeature = { sourceRef: string; ring: Ring };
export interface FootprintSource {
  readonly configured: boolean;
  /** What building_footprint_states.source_url records for the state's load. */
  stateFileUrl(state: string): string;
  features(state: string): AsyncIterable<FootprintFeature>;
}

export class FootprintsUnavailableError extends Error {}

/** The list of footprint files could not be fetched or read. The message never carries provider text. */
export class FootprintIndexError extends Error {}

/** One footprint tile failed to download or read. `quadkey` names the tile; the message never carries provider text. */
export class FootprintTileError extends Error {
  constructor(
    readonly quadkey: string,
    message: string,
  ) {
    super(message);
  }
}

export class UnconfiguredFootprintSource implements FootprintSource {
  readonly configured = false;
  stateFileUrl(): string {
    throw new FootprintsUnavailableError("Building footprints aren't set up.");
  }
  // eslint-disable-next-line require-yield
  async *features(): AsyncGenerator<FootprintFeature> {
    throw new FootprintsUnavailableError("Building footprints aren't set up.");
  }
}

export function createFootprintSource(config: Config): FootprintSource {
  if (config.FAKE_PROVIDERS) return new FakeFootprintSource();
  // FOOTPRINTS_BASE_URL (legacy per-state zips) wins when set; otherwise the Global ML index.
  return msFootprintsFor(config) ?? globalFootprintsFor(config) ?? new UnconfiguredFootprintSource();
}
