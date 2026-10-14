import type { LngLat } from '@roofline/shared';
import type { RoofRaster } from '@roofline/shared/roof-reconstruct';
import type { Config } from '../config.ts';
import { FakeSolarLayers } from './fakes/solar-layers.ts';
import { googleSolarLayersFor } from './google-solar-layers.ts';

/**
 * Google Solar Data Layers around a point: the roofs' height map (DSM) and roof mask, 0.1 m a pixel where Google has
 * HIGH imagery and 0.25 m where it has MEDIUM, on a UTM grid. The estimator reconstructs the roof in 3D from them
 * (estimator/roof-3d.ts). Null: Google has no HIGH or MEDIUM imagery there (not an error). A paid call (an Enterprise
 * SKU: about 7.5 cents past the free monthly allowance): callers keep what they make of it.
 */
export type RoofLayers = {
  raster: RoofRaster;
  /** EPSG code of the grid's UTM zone (326zz north, 327zz south). */
  epsg: number;
  /** UTM easting and northing of the grid's top-left corner. */
  originX: number;
  originY: number;
  /** HIGH or MEDIUM. */
  imageryQuality: string | null;
  /** YYYY-MM-DD. */
  imageryDate: string | null;
};

export interface SolarLayersApi {
  readonly configured: boolean;
  roofLayers(center: LngLat, radiusM: number, opts?: { timeoutMs?: number }): Promise<RoofLayers | null>;
}

/** Google's Data Layers did not answer (network, timeout, quota, a bad key, a file it could not read). */
export class SolarLayersUnavailableError extends Error {}

/** Used when no Solar key is configured. */
export class UnconfiguredSolarLayers implements SolarLayersApi {
  readonly configured = false;
  roofLayers(): Promise<RoofLayers | null> {
    return Promise.reject(new SolarLayersUnavailableError("Google Solar isn't set up."));
  }
}

/**
 * The Data Layers API the app uses, like createSolarApi: in DEMO_MODE the real one when GOOGLE_SOLAR_API_KEY is set,
 * else the fake (no imagery anywhere); the fake under FAKE_PROVIDERS; otherwise the real one when configured.
 * GOOGLE_SOLAR_DATA_LAYERS=off turns the real one off (the estimator then guesses the roof from its outline).
 */
export function createSolarLayersApi(config: Config): SolarLayersApi {
  if (config.DEMO_MODE) return googleSolarLayersFor(config) ?? new FakeSolarLayers();
  if (config.FAKE_PROVIDERS) return new FakeSolarLayers();
  return googleSolarLayersFor(config) ?? new UnconfiguredSolarLayers();
}
