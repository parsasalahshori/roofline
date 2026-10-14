import type { LngLat, SolarBuilding } from '@roofline/shared';
import type { Config } from '../config.ts';
import { FakeSolar } from './fakes/solar.ts';
import { googleSolarFor } from './google-solar.ts';

/**
 * Google Solar building insights (buildingInsights:findClosest): the building nearest a point (within about 50 m)
 * and its roof segments, each with its pitch and the way it faces. The estimator takes the roof's pitch from it, and
 * an outline when no building footprint is found. Null: Google has no building there (NOT_FOUND), which is not an
 * error. A paid call (about 1 cent past the free monthly allowance): callers keep the answer (estimator/solar.ts).
 */
export interface SolarApi {
  readonly configured: boolean;
  buildingInsights(point: LngLat, opts?: { timeoutMs?: number }): Promise<SolarBuilding | null>;
}

/** Google Solar did not answer (network, timeout, quota, a bad key): the caller carries on without it. */
export class SolarUnavailableError extends Error {}

/** Used when no Solar key is configured: every lookup says so. */
export class UnconfiguredSolar implements SolarApi {
  readonly configured = false;
  buildingInsights(): Promise<SolarBuilding | null> {
    return Promise.reject(new SolarUnavailableError("Google Solar isn't set up."));
  }
}

/**
 * The Solar API the app uses: in DEMO_MODE the real one when GOOGLE_SOLAR_API_KEY is set (like address lookups),
 * else the fake; the fake under FAKE_PROVIDERS; otherwise the real one when configured.
 */
export function createSolarApi(config: Config): SolarApi {
  if (config.DEMO_MODE) return googleSolarFor(config) ?? new FakeSolar();
  if (config.FAKE_PROVIDERS) return new FakeSolar();
  return googleSolarFor(config) ?? new UnconfiguredSolar();
}
