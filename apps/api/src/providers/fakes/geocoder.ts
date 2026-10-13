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

/**
 * Parses `street, city, ST zip`. Missing parts come back as null. With two parts, the last one is the state
 * and zip when it looks like `ST` or `ST zip`; otherwise it is the city.
 */
function parseAddress(address: string): Pick<GeocodeResult, 'street' | 'city' | 'state' | 'zip' | 'timezone'> {
  const parts = address.split(',').map((p) => p.trim());
  const street = parts[0] || null;
  const last = parts.length >= 2 ? (parts[parts.length - 1] ?? '') : '';
  let city: string | null = null;
  let state: string | null = null;
  let zip: string | null = null;
  if (parts.length >= 3) {
    city = parts[1] || null;
    const m = /\b([A-Za-z]{2})\s+(\d{5})\b/.exec(last);
    state = m?.[1] ? m[1].toUpperCase() : null;
    zip = m?.[2] ?? null;
  } else if (parts.length === 2) {
    const m = /^([A-Za-z]{2})(?:\s+(\d{5}))?$/.exec(last);
    if (m) {
      state = m[1]!.toUpperCase();
      zip = m[2] ?? null;
    } else {
      city = last || null;
    }
  }
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

  protected resolve(address: string): GeocodeResult | null {
    if (/nowhere/i.test(address)) return null;
    const text = address.trim().toLowerCase();
    const h = fnv1a(text);
    const lng = round6(-95.9345 + (h % 1000) / 20000);
    const lat = round6(41.2565 + (Math.floor(h / 1000) % 1000) / 20000);
    return { lng, lat, ...parseAddress(address.trim()), accuracy: 1, accuracyType: 'rooftop', source: 'fake' };
  }

  async geocode(address: string, opts?: { timeoutMs?: number }): Promise<GeocodeResult | null> {
    this.calls.push({ method: 'geocode', args: [address, opts] });
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

  async reverseMany(
    points: { lat: number; lng: number }[],
  ): Promise<({ street: string; city: string; state: string; zip: string } | null)[]> {
    this.calls.push({ method: 'reverseMany', args: [points] });
    this.takeFailure();
    return points.map((p, i) =>
      p.lat < 0 ? null : { street: `${i + 1} Fake St`, city: 'Omaha', state: 'NE', zip: '68102' },
    );
  }
}

/** Fictional street names for the demo's Omaha neighbourhoods (no real address is ever produced on purpose). */
const DEMO_STREETS: readonly string[] = [
  'Ridgeview Dr', 'Prairie Wind Ln', 'Summit Oak Ct', 'Hailstone Ave', 'Copper Ridge Rd', 'Bluestem Cir',
  'Meadowlark Way', 'Cottonwood Pl', 'Harvest Hill Dr', 'Shingle Creek Rd', 'Gable Point Ln', 'Windbreak St',
];

const DEMO_ZIPS: readonly string[] = ['68114', '68124', '68130', '68144', '68154', '68164'];

const LOT_COLUMNS = 8;
const LOT_ROWS = 6;
/** Where the lookup lots start (south-west corner), and how far apart they sit, in metres. */
const LOT_ORIGIN: readonly [number, number] = [-96.03, 41.3];
const LOT_STEP_M = { east: 45, north: 55 } as const;

/**
 * The demo's empty lots: a fixed grid of points that the demo world seeds a house-sized footprint on (nobody lives
 * there), so any address typed into Measure finds a roof with no network. The demo geocoder maps every address
 * to one of these, always the same one for the same text.
 */
export const DEMO_LOOKUP_LOTS: readonly (readonly [number, number])[] = Array.from({ length: LOT_COLUMNS * LOT_ROWS }, (_, i) => [
  round6(LOT_ORIGIN[0] + ((i % LOT_COLUMNS) * LOT_STEP_M.east) / 83_700),
  round6(LOT_ORIGIN[1] + (Math.floor(i / LOT_COLUMNS) * LOT_STEP_M.north) / 111_320),
]);

/**
 * The demo's geocoder (DEMO_MODE): the fake geocoder, except that a reverse lookup answers a plausible, fictional
 * Omaha address for the point (`4217 Prairie Wind Ln, Omaha, NE 68144`), the same one every time for the same
 * spot (rounded to about a metre), so clicking a roof on the demo map reads like a real house. No network.
 */
export class DemoGeocoder extends FakeGeocoder {
  /**
   * Any address (except the fake's `nowhere` and `outage` words) lands on one of the demo's empty lots, with the
   * missing city, state and ZIP filled in as Omaha, NE, so a bare `410 Truss Ave` is still a whole address.
   */
  protected override resolve(address: string): GeocodeResult | null {
    const found = super.resolve(address);
    if (found === null) return null;
    const h = fnv1a(address.trim().toLowerCase());
    const [lng, lat] = DEMO_LOOKUP_LOTS[h % DEMO_LOOKUP_LOTS.length]!;
    return {
      ...found,
      lng,
      lat,
      city: found.city ?? 'Omaha',
      state: found.state ?? 'NE',
      zip: found.zip ?? DEMO_ZIPS[Math.floor(h / 97) % DEMO_ZIPS.length]!,
      timezone: found.timezone ?? 'America/Chicago',
    };
  }

  override async reverseMany(
    points: { lat: number; lng: number }[],
  ): Promise<({ street: string; city: string; state: string; zip: string } | null)[]> {
    this.calls.push({ method: 'reverseMany', args: [points] });
    return points.map((p) => {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || p.lat < 0) return null;
      const h = fnv1a(`${p.lat.toFixed(5)},${p.lng.toFixed(5)}`);
      const number = 1000 + (h % 8900);
      const street = DEMO_STREETS[Math.floor(h / 8900) % DEMO_STREETS.length]!;
      const zip = DEMO_ZIPS[Math.floor(h / 97) % DEMO_ZIPS.length]!;
      return { street: `${number} ${street}`, city: 'Omaha', state: 'NE', zip };
    });
  }
}
