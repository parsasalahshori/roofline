import type { Config } from '../config.ts';
import { type GeocodeResult, type Geocoder, GeocoderUnavailableError } from './geocoder.ts';

// Geocodio's docs were not reachable from the build box, so the version stays v1.7 until checked.
const DEFAULT_BASE_URL = 'https://api.geocod.io/v1.7';
const DEFAULT_TIMEOUT_MS = 8000;
const BATCH_SIZE = 1000;
const MIN_ACCURACY = 0.8;
const ACCEPTED_ACCURACY_TYPES: ReadonlySet<string> = new Set([
  'rooftop',
  'point',
  'range_interpolation',
  'nearest_rooftop_match',
  'intersection',
  'street_center',
]);

const UNAVAILABLE_MESSAGE = "Geocodio didn't answer.";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function listOf(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** Text of a street part; Geocodio sends the house number as a string, but tolerate a number. */
function partText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function unavailable(): GeocoderUnavailableError {
  return new GeocoderUnavailableError(UNAVAILABLE_MESSAGE);
}

/** Maps one Geocodio result entry to a GeocodeResult, or null when it is missing or not trustworthy. */
function accept(entry: unknown): GeocodeResult | null {
  if (!isRecord(entry)) return null;

  const accuracy = finiteNumber(entry.accuracy);
  if (accuracy === null || accuracy < MIN_ACCURACY) return null;

  const accuracyType = optionalString(entry.accuracy_type);
  if (accuracyType === null || !ACCEPTED_ACCURACY_TYPES.has(accuracyType)) return null;

  const location: unknown = entry.location;
  if (!isRecord(location)) return null;
  const lng = finiteNumber(location.lng);
  const lat = finiteNumber(location.lat);
  if (lng === null || lat === null) return null;

  const parts: JsonRecord = isRecord(entry.address_components) ? entry.address_components : {};
  const streetText = `${partText(parts.number)} ${partText(parts.formatted_street)}`.trim();

  const fields: JsonRecord = isRecord(entry.fields) ? entry.fields : {};
  const timezone: unknown = fields.timezone;
  const timezoneName = isRecord(timezone) ? optionalString(timezone.name) : null;

  return {
    lng,
    lat,
    street: streetText === '' ? null : streetText,
    city: optionalString(parts.city),
    state: optionalString(parts.state),
    zip: optionalString(parts.zip),
    timezone: timezoneName,
    accuracy,
    accuracyType,
    source: 'geocodio',
  };
}

/** Street, city, state and zip of one reverse-geocode result, or null when any part is missing. */
function reverseAddress(entry: unknown): { street: string; city: string; state: string; zip: string } | null {
  if (!isRecord(entry)) return null;
  const parts: JsonRecord = isRecord(entry.address_components) ? entry.address_components : {};
  const street = `${partText(parts.number)} ${partText(parts.formatted_street)}`.trim();
  const city = optionalString(parts.city);
  const state = optionalString(parts.state);
  const zip = optionalString(parts.zip);
  if (street === '' || !city || !state || !zip) return null;
  return { street, city, state, zip };
}

type RequestInitLike = Pick<RequestInit, 'method' | 'headers' | 'body'>;

export class GeocodioGeocoder implements Geocoder {
  readonly configured = true;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: (input: string, init: RequestInit) => Promise<Response>;

  constructor(o: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number; baseUrl?: string }) {
    this.apiKey = o.apiKey;
    this.baseUrl = (o.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Called as a plain function, so an injected fake and the native fetch both work.
    const impl = o.fetch ?? globalThis.fetch;
    this.fetchFn = (input, init) => impl(input, init);
  }

  async geocode(address: string, opts?: { timeoutMs?: number }): Promise<GeocodeResult | null> {
    const url =
      `${this.baseUrl}/geocode?q=${encodeURIComponent(address)}` +
      `&fields=timezone&limit=1&api_key=${encodeURIComponent(this.apiKey)}`;
    const { status, body } = await this.request(url, { method: 'GET' }, opts?.timeoutMs ?? this.timeoutMs);
    if (status === 422) return null;
    const results = listOf(isRecord(body) ? body.results : undefined);
    if (results === null) throw unavailable();
    return accept(results[0]);
  }

  async geocodeMany(addresses: readonly string[]): Promise<(GeocodeResult | null)[]> {
    if (addresses.length === 0) return [];
    const out: (GeocodeResult | null)[] = [];
    for (let start = 0; start < addresses.length; start += BATCH_SIZE) {
      const chunk = addresses.slice(start, start + BATCH_SIZE);
      for (const result of await this.geocodeChunk(chunk)) out.push(result);
    }
    return out;
  }

  private async geocodeChunk(chunk: readonly string[]): Promise<(GeocodeResult | null)[]> {
    const url = `${this.baseUrl}/geocode?fields=timezone&limit=1&api_key=${encodeURIComponent(this.apiKey)}`;
    const { status, body } = await this.request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chunk) },
      this.timeoutMs,
    );
    if (status === 422) return chunk.map(() => null);
    const results = listOf(isRecord(body) ? body.results : undefined);
    if (results === null) throw unavailable();
    return chunk.map((_, i) => {
      const entry: unknown = results[i];
      const response: unknown = isRecord(entry) ? entry.response : undefined;
      const list = listOf(isRecord(response) ? response.results : undefined);
      return accept(list?.[0]);
    });
  }

  async reverseMany(
    points: { lat: number; lng: number }[],
  ): Promise<({ street: string; city: string; state: string; zip: string } | null)[]> {
    if (points.length === 0) return [];
    const out: ({ street: string; city: string; state: string; zip: string } | null)[] = [];
    for (let start = 0; start < points.length; start += BATCH_SIZE) {
      const chunk = points.slice(start, start + BATCH_SIZE);
      for (const result of await this.reverseChunk(chunk)) out.push(result);
    }
    return out;
  }

  private async reverseChunk(
    chunk: { lat: number; lng: number }[],
  ): Promise<({ street: string; city: string; state: string; zip: string } | null)[]> {
    const url = `${this.baseUrl}/reverse?api_key=${encodeURIComponent(this.apiKey)}`;
    const { status, body } = await this.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chunk.map((p) => `${p.lat},${p.lng}`)),
      },
      this.timeoutMs,
    );
    if (status === 422) return chunk.map(() => null);
    const results = listOf(isRecord(body) ? body.results : undefined);
    if (results === null) throw unavailable();
    return chunk.map((_, i) => {
      const entry: unknown = results[i];
      const response: unknown = isRecord(entry) ? entry.response : undefined;
      const list = listOf(isRecord(response) ? response.results : undefined);
      return reverseAddress(list?.[0]);
    });
  }

  /** One HTTP call with timeout. Returns 422 as a status; any other non-2xx, network or timeout error throws. */
  private async request(
    url: string,
    init: RequestInitLike,
    timeoutMs: number,
  ): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchFn(url, { ...init, signal: controller.signal });
      if (response.status === 422) return { status: 422, body: null };
      if (!response.ok) throw unavailable();
      const body: unknown = await response.json();
      return { status: response.status, body };
    } catch (error) {
      if (error instanceof GeocoderUnavailableError) throw error;
      // Fresh error with no cause: a fetch error can carry the URL, which holds the key.
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
  }
}

export function geocodioFor(config: Config): Geocoder | null {
  const apiKey = config.GEOCODIO_API_KEY;
  return apiKey ? new GeocodioGeocoder({ apiKey }) : null;
}
