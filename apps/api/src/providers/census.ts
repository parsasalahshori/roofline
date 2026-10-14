import { type GeocodeResult, type Geocoder, GeocoderUnavailableError } from './geocoder.ts';

const ENDPOINT = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const UNAVAILABLE = 'Public address lookup is unavailable. Please try again.';
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** Census locations interpolate along street ranges: never claim rooftop accuracy or select a roof from this point. */
export function parseCensusResult(body: unknown): GeocodeResult | null {
  if (!record(body) || !record(body.result) || !Array.isArray(body.result.addressMatches)) {
    throw new GeocoderUnavailableError(UNAVAILABLE);
  }
  const matches: unknown[] = body.result.addressMatches;
  // Ambiguous matches require a more specific address, not a silent first-result choice.
  if (matches.length !== 1) return null;
  const match = matches[0];
  if (!record(match) || !record(match.coordinates) || !record(match.addressComponents)) return null;
  const { x: lng, y: lat } = match.coordinates;
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180 ||
      typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  const matched = text(match.matchedAddress);
  const street = matched?.split(',')[0]?.trim() || null;
  const city = text(match.addressComponents.city);
  const state = text(match.addressComponents.state);
  const zip = text(match.addressComponents.zip);
  if (!street || !city || !state || !zip) return null;
  return { lng, lat, street, city, state, zip, timezone: null, accuracy: 0.5, accuracyType: 'range_interpolation', source: 'census' };
}

/** Opt-in, read-only public address lookup for a local demo. No keys, reverse lookup, or paid adapters. */
export class CensusDemoGeocoder implements Geocoder {
  readonly configured = true;
  constructor(private readonly request: typeof fetch = globalThis.fetch) {}

  async geocode(address: string, opts?: { timeoutMs?: number }): Promise<GeocodeResult | null> {
    const url = new URL(ENDPOINT);
    url.searchParams.set('address', address);
    url.searchParams.set('benchmark', 'Public_AR_Current');
    url.searchParams.set('format', 'json');
    try {
      const response = await this.request(url, {
        signal: AbortSignal.timeout(opts?.timeoutMs ?? 10_000),
        redirect: 'error',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new GeocoderUnavailableError(UNAVAILABLE);
      return parseCensusResult(await response.json());
    } catch {
      // Neither the address nor upstream response/error text is logged or exposed.
      throw new GeocoderUnavailableError(UNAVAILABLE);
    }
  }

  async geocodeMany(addresses: readonly string[]): Promise<(GeocodeResult | null)[]> {
    const results: (GeocodeResult | null)[] = [];
    for (const address of addresses) results.push(await this.geocode(address));
    return results;
  }

  async reverseMany(points: { lat: number; lng: number }[]): Promise<null[]> {
    return points.map(() => null);
  }
}
