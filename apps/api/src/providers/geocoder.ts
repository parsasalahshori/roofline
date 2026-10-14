import type { Config } from '../config.ts';
import { DemoGeocoder, FakeGeocoder } from './fakes/geocoder.ts';
import { geocodioFor } from './geocodio.ts';

export type GeocodeResult = { lng: number; lat: number; street: string | null; city: string | null; state: string | null; zip: string | null;
  timezone: string | null; accuracy: number; accuracyType: string; source: 'geocodio' | 'fake' };
export interface Geocoder { readonly configured: boolean;
  geocode(address: string, opts?: { timeoutMs?: number }): Promise<GeocodeResult | null>;
  geocodeMany(addresses: readonly string[]): Promise<(GeocodeResult | null)[]>;
  /**
   * Batch reverse geocode (Geocodio POST /v1.7/reverse, at most 1000 points per call, chunked by the adapter).
   * The output has the same length and order as the input; a point with no usable address is null.
   */
  reverseMany(points: { lat: number; lng: number }[]): Promise<({ street: string; city: string; state: string; zip: string } | null)[]> }
export class GeocoderUnavailableError extends Error {}

/** Used when no real geocoder is configured: every lookup fails with a setup message. */
export class UnconfiguredGeocoder implements Geocoder {
  readonly configured = false;
  async geocode(): Promise<GeocodeResult | null> {
    throw new GeocoderUnavailableError("Address lookup isn't set up.");
  }
  async geocodeMany(): Promise<(GeocodeResult | null)[]> {
    throw new GeocoderUnavailableError("Address lookup isn't set up.");
  }
  async reverseMany(): Promise<({ street: string; city: string; state: string; zip: string } | null)[]> {
    throw new GeocoderUnavailableError("Address lookup isn't set up.");
  }
}

/** The geocoder the app uses: the demo one in DEMO_MODE, the fake under FAKE_PROVIDERS, else the real one when configured. */
export function createGeocoder(config: Config): Geocoder {
  if (config.DEMO_MODE) {
    // With a Geocodio key the demo looks typed addresses up for real; reverse lookups stay demo ones (free, fictional).
    const real = geocodioFor(config);
    if (!real) return new DemoGeocoder();
    const demo = new DemoGeocoder();
    return {
      configured: true,
      geocode: (address, opts) => real.geocode(address, opts),
      geocodeMany: (addresses) => real.geocodeMany(addresses),
      reverseMany: (points) => demo.reverseMany(points),
    };
  }
  if (config.FAKE_PROVIDERS) return new FakeGeocoder();
  return geocodioFor(config) ?? new UnconfiguredGeocoder();
}
