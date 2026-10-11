import { type GeocodeResult, type Geocoder, GeocoderUnavailableError } from '../geocoder.ts';

const STATE_TIMEZONES: Record<string, string> = {
  NE: 'America/Chicago', IA: 'America/Chicago', KS: 'America/Chicago', MO: 'America/Chicago', TX: 'America/Chicago',
  NY: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', OH: 'America/New_York', MA: 'America/New_York',
  CO: 'America/Denver',
  AZ: 'America/Phoenix',
  CA: 'America/Los_Angeles', WA: 'America/Los_Angeles',
};

/** FNV-1a 32-bit hash of the text (lowercased and trimmed by the caller). */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** Parses `street, city, ST zip`. Missing parts come back as null. */
function parseAddress(address: string): Pick<GeocodeResult, 'street' | 'city' | 'state' | 'zip' | 'timezone'> {
  const parts = address.split(',').map((p) => p.trim());
  const street = parts[0] || null;
  const city = parts.length >= 3 && parts[1] ? parts[1] : null;
  const tail = parts.length >= 2 ? (parts[parts.length - 1] ?? '') : '';
  const m = /\b([A-Za-z]{2})\s+(\d{5})\b/.exec(tail);
  const state = m?.[1] ? m[1].toUpperCase() : null;
  const zip = m?.[2] ?? null;
  const timezone = state ? (STATE_TIMEZONES[state] ?? 'America/Chicago') : null;
  return { street, city, state, zip, timezone };
}

/** Deterministic geocoder: no network, same address gives the same position. */
export class FakeGeocoder implements Geocoder {
  readonly configured = true;
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly batches: string[][] = [];
  private failures = 0;

  /** Makes the next `n` calls throw GeocoderUnavailableError (a geocodeMany call counts as one). */
  failNext(n = 1): void {
    this.failures += n;
  }

  private takeFailure(): void {
    if (this.failures > 0) {
      this.failures--;
      throw new GeocoderUnavailableError('Fake geocoder is unavailable.');
    }
  }

  private resolve(address: string): GeocodeResult | null {
    if (/nowhere/i.test(address)) return null;
    const text = address.trim().toLowerCase();
    const h = fnv1a(text);
    const lng = round6(-95.9345 + (h % 1000) / 20000);
    const lat = round6(41.2565 + (Math.floor(h / 1000) % 1000) / 20000);
    return { lng, lat, ...parseAddress(address.trim()), accuracy: 1, accuracyType: 'rooftop', source: 'fake' };
  }

  async geocode(address: string): Promise<GeocodeResult | null> {
    this.calls.push({ method: 'geocode', args: [address] });
    this.takeFailure();
    if (/outage/i.test(address)) throw new GeocoderUnavailableError('Fake geocoder is unavailable.');
    return this.resolve(address);
  }

  async geocodeMany(addresses: readonly string[]): Promise<(GeocodeResult | null)[]> {
    this.calls.push({ method: 'geocodeMany', args: [addresses] });
    this.batches.push([...addresses]);
    this.takeFailure();
    return addresses.map((a) => (/outage|nowhere/i.test(a) ? null : this.resolve(a)));
  }
}
