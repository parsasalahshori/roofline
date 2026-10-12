import type { Config } from '../config.ts';
import { FakeGeocoder } from './fakes/geocoder.ts';
import { geocodioFor } from './geocodio.ts';

export type GeocodeResult = { lng: number; lat: number; street: string | null; city: string | null; state: string | null; zip: string | null;
  timezone: string | null; accuracy: number; accuracyType: string; source: 'geocodio' | 'fake' };
export interface Geocoder { readonly configured: boolean;
  geocode(address: string, opts?: { timeoutMs?: number }): Promise<GeocodeResult | null>;
  geocodeMany(addresses: readonly string[]): Promise<(GeocodeResult | null)[]> }
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
}

/** The geocoder the app uses: the fake under FAKE_PROVIDERS, else the real one when configured. */
export function createGeocoder(config: Config): Geocoder {
  if (config.FAKE_PROVIDERS) return new FakeGeocoder();
  return geocodioFor(config) ?? new UnconfiguredGeocoder();
}
