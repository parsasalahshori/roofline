import type { LngLat, SolarBuilding, SolarSegment } from '@roofline/shared';
import type { Config } from '../config.ts';
import { type SolarApi, SolarUnavailableError } from './solar.ts';

const BASE_URL = 'https://solar.googleapis.com/v1';
const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * The lowest imagery quality accepted. Google treats requiredQuality as a floor (exactQualityRequired defaults to
 * false), so one call with LOW returns HIGH imagery where Google has it, else MEDIUM, else LOW: the best there is.
 */
const REQUIRED_QUALITY = 'LOW';
const UNAVAILABLE_MESSAGE = "Google Solar didn't answer.";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A LatLng ({ latitude, longitude }) as [lng, lat], or null. */
function lngLat(value: unknown): LngLat | null {
  if (!isRecord(value)) return null;
  const lat = num(value.latitude);
  const lng = num(value.longitude);
  return lat === null || lng === null ? null : [lng, lat];
}

/** A LatLngBox ({ sw, ne }) as [lng, lat] corners, or null. */
function box(value: unknown): { sw: LngLat; ne: LngLat } | null {
  if (!isRecord(value)) return null;
  const sw = lngLat(value.sw);
  const ne = lngLat(value.ne);
  return sw === null || ne === null ? null : { sw, ne };
}

/** A Date ({ year, month, day }) as YYYY-MM-DD, or null. */
function dateText(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const y = num(value.year);
  const m = num(value.month);
  const d = num(value.day);
  if (y === null || m === null || d === null) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function segment(value: unknown): SolarSegment | null {
  if (!isRecord(value)) return null;
  const stats = isRecord(value.stats) ? value.stats : {};
  const pitchDeg = num(value.pitchDegrees);
  // Google leaves azimuth out (0) for flat segments.
  const azimuthDeg = num(value.azimuthDegrees) ?? 0;
  const areaM2 = num(stats.areaMeters2);
  const groundAreaM2 = num(stats.groundAreaMeters2);
  const center = lngLat(value.center);
  if (pitchDeg === null || areaM2 === null || groundAreaM2 === null || center === null) return null;
  return { pitchDeg, azimuthDeg, areaM2, groundAreaM2, center, box: box(value.boundingBox) };
}

/** The parts of a buildingInsights answer the estimator uses. Anything missing or malformed is left out. */
export function parseBuildingInsights(body: unknown): SolarBuilding {
  const root = isRecord(body) ? body : {};
  const potential = isRecord(root.solarPotential) ? root.solarPotential : {};
  const raw = Array.isArray(potential.roofSegmentStats) ? potential.roofSegmentStats : [];
  return {
    center: lngLat(root.center),
    box: box(root.boundingBox),
    imageryQuality: typeof root.imageryQuality === 'string' ? root.imageryQuality : null,
    imageryDate: dateText(root.imageryDate),
    segments: raw.map(segment).filter((s): s is SolarSegment => s !== null),
  };
}

export class GoogleSolar implements SolarApi {
  readonly configured = true;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: (input: string, init: RequestInit) => Promise<Response>;

  constructor(o: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number; baseUrl?: string }) {
    this.apiKey = o.apiKey;
    this.baseUrl = (o.baseUrl ?? BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const impl = o.fetch ?? globalThis.fetch;
    this.fetchFn = (input, init) => impl(input, init);
  }

  async buildingInsights(point: LngLat, opts?: { timeoutMs?: number }): Promise<SolarBuilding | null> {
    const [lng, lat] = point;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    const url =
      `${this.baseUrl}/buildingInsights:findClosest?location.latitude=${lat.toFixed(7)}` +
      `&location.longitude=${lng.toFixed(7)}&requiredQuality=${REQUIRED_QUALITY}&key=${encodeURIComponent(this.apiKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? this.timeoutMs);
    try {
      const response = await this.fetchFn(url, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal });
      // No building within about 50 m of the point (Google's NOT_FOUND).
      if (response.status === 404) return null;
      if (!response.ok) throw new SolarUnavailableError(UNAVAILABLE_MESSAGE);
      return parseBuildingInsights(await response.json());
    } catch (error) {
      if (error instanceof SolarUnavailableError) throw error;
      // A fresh error with no cause: a fetch error can carry the URL, which holds the key.
      throw new SolarUnavailableError(UNAVAILABLE_MESSAGE);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function googleSolarFor(config: Config): SolarApi | null {
  const apiKey = config.GOOGLE_SOLAR_API_KEY;
  return apiKey ? new GoogleSolar({ apiKey }) : null;
}
