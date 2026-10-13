import type { PropertyDataSource, PropertyRecordView, Ring } from '@roofline/shared';
import type { Config } from '../config.ts';
import { arkansasParcelsFor } from './arkansas-parcels.ts';
import { FakePropertyData } from './fakes/property-data.ts';
import { regridFor } from './regrid.ts';

/*
 * The property data seam: who owns a house, its parcel, when it was built and last sold. One normalized
 * record whatever the provider. Regrid (nationwide, paid, REGRID_API_TOKEN) is the main one; the Arkansas
 * GIS Office's statewide parcel layer (free, no key, owner name but no mailing address, year built or sale)
 * is the fallback, chosen with PROPERTY_DATA_PROVIDER=arkansas-gis. Owner names are public record. The app
 * shows them to the roofer and never texts, calls or emails anyone from them (TCPA and Do Not Call).
 */

export type PropertyLookup = {
  /** The house's point, when the app has one. Preferred: a point names one parcel. */
  point: { lat: number; lng: number } | null;
  /** The street address, for providers that can search by it when there is no point. */
  address: { line: string; city: string; state: string; zip: string } | null;
};

export interface PropertyData {
  readonly configured: boolean;
  /** Who answers, or null when nothing is set up. */
  readonly source: PropertyDataSource | null;
  /** The parcel record for the house, or null when the provider has none. Throws PropertyDataUnavailableError. */
  lookup(query: PropertyLookup, opts?: { timeoutMs?: number }): Promise<PropertyRecordView | null>;
}

/** The provider could not be reached, refused the key, or is not set up. The message never carries provider text. */
export class PropertyDataUnavailableError extends Error {}

export class UnconfiguredPropertyData implements PropertyData {
  readonly configured = false;
  readonly source = null;
  async lookup(): Promise<PropertyRecordView | null> {
    throw new PropertyDataUnavailableError("Owner records aren't set up.");
  }
}

/**
 * The property data the app uses: the fake under FAKE_PROVIDERS (and so in DEMO_MODE); else the provider
 * PROPERTY_DATA_PROVIDER names; else Regrid when REGRID_API_TOKEN is set; else an unconfigured one.
 */
export function createPropertyData(config: Config): PropertyData {
  if (config.FAKE_PROVIDERS) return new FakePropertyData();
  const choice = config.PROPERTY_DATA_PROVIDER ?? (config.REGRID_API_TOKEN ? 'regrid' : undefined);
  if (choice === 'arkansas-gis') return arkansasParcelsFor(config);
  if (choice === 'regrid') return regridFor(config) ?? new UnconfiguredPropertyData();
  return new UnconfiguredPropertyData();
}

// ---- Helpers the clients share -------------------------------------------------------------------

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Trimmed text, or null for anything empty or not text (a number is written out). */
export function text(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const t = value.replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
}

/** A finite number from a number or numeric text, or null. */
export function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Whole dollars (or dollar text) as whole cents; null for missing, negative or zero. */
export function cents(value: unknown): number | null {
  const n = num(value);
  return n === null || n <= 0 ? null : Math.round(n * 100);
}

/** A plausible year built (1700 to next year), or null. */
export function year(value: unknown, now: Date): number | null {
  const n = num(value);
  if (n === null || !Number.isInteger(n)) return null;
  return n >= 1700 && n <= now.getUTCFullYear() + 1 ? n : null;
}

/** `YYYY-MM-DD` from date text or epoch milliseconds, or null. */
export function isoDay(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString().slice(0, 10);
  const t = text(value);
  if (t === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** An ISO timestamp from date text or epoch milliseconds, or null. */
export function isoTime(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  const t = text(value);
  if (t === null) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The parts that are present, joined by `, `; null when none are. */
export function oneLine(...parts: (string | null)[]): string | null {
  const kept = parts.filter((p): p is string => p !== null && p !== '');
  return kept.length === 0 ? null : kept.join(', ');
}

/** The parts that are present, joined by a space (`AR 72201`); null when none are. */
export function spaced(...parts: (string | null)[]): string | null {
  const kept = parts.filter((p): p is string => p !== null && p !== '');
  return kept.length === 0 ? null : kept.join(' ');
}

/** Street and ZIP made comparable: upper case, letters and digits only, common words shortened. */
function streetKey(street: string): string {
  const words: Record<string, string> = {
    STREET: 'ST', AVENUE: 'AVE', ROAD: 'RD', DRIVE: 'DR', LANE: 'LN', COURT: 'CT', CIRCLE: 'CIR', PLACE: 'PL',
    BOULEVARD: 'BLVD', TERRACE: 'TER', PARKWAY: 'PKWY', HIGHWAY: 'HWY', NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  };
  return street
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w !== '')
    .map((w) => words[w] ?? w)
    .join(' ');
}

/**
 * Whether the owner gets their mail at the house: true on a homestead exemption; otherwise the mailing street
 * and ZIP compared with the house's; null when either is missing.
 */
export function ownerOccupied(o: {
  homestead: boolean | null;
  mailStreet: string | null;
  mailZip: string | null;
  siteStreet: string | null;
  siteZip: string | null;
}): boolean | null {
  if (o.homestead === true) return true;
  if (o.mailStreet === null || o.siteStreet === null) return null;
  const sameStreet = streetKey(o.mailStreet) === streetKey(o.siteStreet);
  const mailZip = o.mailZip?.slice(0, 5) ?? null;
  const siteZip = o.siteZip?.slice(0, 5) ?? null;
  const sameZip = mailZip === null || siteZip === null || mailZip === siteZip;
  return sameStreet && sameZip;
}

const MAX_RING_POINTS = 2000;

/** One valid [lng, lat] pair, or null. */
function lngLat(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const [lng, lat] = value as unknown[];
  if (typeof lng !== 'number' || typeof lat !== 'number') return null;
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) return null;
  return [lng, lat];
}

/** A list of [lng, lat] pairs as a ring (3 to MAX_RING_POINTS points), or null. */
export function ringOf(points: unknown): Ring | null {
  if (!Array.isArray(points) || points.length < 3 || points.length > MAX_RING_POINTS) return null;
  const ring: Ring = [];
  for (const p of points) {
    const pair = lngLat(p);
    if (pair === null) return null;
    ring.push(pair);
  }
  return ring;
}

/** The outer ring of a GeoJSON Polygon, or of a MultiPolygon's first polygon, or null. */
export function outerRingOfGeoJson(geometry: unknown): Ring | null {
  if (!isRecord(geometry)) return null;
  const coords = geometry.coordinates;
  if (!Array.isArray(coords)) return null;
  if (geometry.type === 'Polygon') return ringOf(coords[0]);
  if (geometry.type === 'MultiPolygon') return Array.isArray(coords[0]) ? ringOf((coords[0] as unknown[])[0]) : null;
  return null;
}

type RequestFn = (input: string, init: RequestInit) => Promise<Response>;

/**
 * One GET with a timeout, answering the JSON body, or null on a 404. Any other failure throws
 * PropertyDataUnavailableError with `message` and no cause (a fetch error can carry the URL, and a URL can carry a key).
 */
export async function getJson(
  fetchFn: RequestFn,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  message: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { method: 'GET', headers: { accept: 'application/json', ...headers }, signal: controller.signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new PropertyDataUnavailableError(message);
    return (await response.json()) as unknown;
  } catch (err) {
    if (err instanceof PropertyDataUnavailableError) throw err;
    throw new PropertyDataUnavailableError(message);
  } finally {
    clearTimeout(timer);
  }
}

/** The injected fetch as a plain function, so a fake and the native one both work. */
export function fetchOf(impl: typeof fetch | undefined): RequestFn {
  const f = impl ?? globalThis.fetch;
  return (input, init) => f(input, init);
}
