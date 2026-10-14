import type { Ring } from '@roofline/shared';
import type { Config } from '../config.ts';
import { FakeFootprintSource } from './fakes/footprints.ts';
import { msFootprintsFor } from './ms-footprints.ts';

export type FootprintFeature = { sourceRef: string; ring: Ring };
export interface FootprintSource {
  readonly configured: boolean;
  stateFileUrl(state: string): string;
  features(state: string): AsyncIterable<FootprintFeature>;
}

export class FootprintsUnavailableError extends Error {}

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
  if (config.FAKE_PROVIDERS && !config.DEMO_REAL_FOOTPRINTS) return new FakeFootprintSource();
  return msFootprintsFor(config) ?? new UnconfiguredFootprintSource();
}
