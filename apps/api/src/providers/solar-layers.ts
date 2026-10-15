import type { LngLat } from '@roofline/shared';
import type { RoofRaster } from '@roofline/shared/roof-reconstruct';
import type { Config } from '../config.ts';
import { FakeSolarLayers } from './fakes/solar-layers.ts';
import { googleSolarLayersFor } from './google-solar-layers.ts';

/** Google's own aerial photo of the layers (the one the height map was made from): RGB, 3 bytes a pixel, UTM grid. */
export type RoofPhoto = { width: number; height: number; pixelSizeM: number; originX: number; originY: number; rgb: Uint8Array };

/**
 * Google Solar Data Layers around a point: the roofs' height map (DSM), roof mask and aerial photo, 0.1 m a pixel
 * where Google has HIGH imagery and 0.25 m where it has MEDIUM, on a UTM grid. The estimator reconstructs the roof in
 * 3D from them (estimator/roof-3d.ts). Null: Google has no HIGH or MEDIUM imagery there (not an error). A paid call
 * (an Enterprise SKU: about 7.5 cents past the free monthly allowance): callers keep what they make of it.
 */
export type RoofLayers = {
  raster: RoofRaster;
  /** The photo, when it came (it is optional: the roof is reconstructed without it). */
  photo?: RoofPhoto | null;
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

/**
 * Why Data Layers gave nothing usable: 'timeout' (no answer in time), 'http' (network, quota, a bad key: any failed
 * request), 'bad-answer' (an answer that is not JSON, or file URLs off Google's host, which are never sent the key),
 * 'decode' (a file that is not a GeoTIFF, or truncated), 'too-large' (a file or grid bigger than asked for), 'bad-crs'
 * (not a UTM grid), 'mismatch' (the height map and mask in different zones or with skewed pixels), 'unconfigured'.
 */
export const SOLAR_LAYERS_FAILURES = ['timeout', 'http', 'bad-answer', 'decode', 'too-large', 'bad-crs', 'mismatch', 'unconfigured'] as const;
export type SolarLayersFailure = (typeof SOLAR_LAYERS_FAILURES)[number];

/**
 * Google's Data Layers did not answer (network, timeout, quota, a bad key, a file it could not read). The message is
 * fixed text and the error never carries a cause: the request URLs hold the API key.
 */
export class SolarLayersUnavailableError extends Error {
  readonly reason: SolarLayersFailure;
  constructor(message: string, reason: SolarLayersFailure = 'http') {
    super(message);
    this.name = 'SolarLayersUnavailableError';
    this.reason = reason;
  }
}

/** Used when no Solar key is configured. */
export class UnconfiguredSolarLayers implements SolarLayersApi {
  readonly configured = false;
  roofLayers(): Promise<RoofLayers | null> {
    return Promise.reject(new SolarLayersUnavailableError("Google Solar isn't set up.", 'unconfigured'));
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
