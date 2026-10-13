import type { StreetImageView } from '@roofline/shared';
import type { Config } from '../config.ts';
import { FakeStreetImagery } from './fakes/street-imagery.ts';
import { fetchOf, getJson, isoTime, isRecord, PropertyDataUnavailableError, text } from './property-data.ts';

/*
 * Street-level photos of a house: Mapillary's Graph API v4 (https://www.mapillary.com/developer/api-documentation),
 * free with a client access token (MAPILLARY_TOKEN, `MLY|...`). Images are CC BY-SA 4.0: the app links each
 * one to its Mapillary page. Coverage is crowd-sourced, so many Arkansas side streets have none, or old ones.
 * - GET https://graph.mapillary.com/images?bbox=west,south,east,north&fields=id,thumb_1024_url,captured_at,
 *   computed_geometry,geometry&limit=20, with `Authorization: OAuth <token>` (kept out of the URL).
 * - The answer is `{ data: [{ id, thumb_1024_url, captured_at (epoch ms), computed_geometry: { coordinates } }] }`.
 *   Thumbnail URLs expire, so they are fetched fresh with each record and never stored.
 */

export interface StreetImagery {
  readonly configured: boolean;
  /** The photo taken nearest the point (within about 60 m), or null. Throws PropertyDataUnavailableError. */
  nearest(point: { lat: number; lng: number }, opts?: { timeoutMs?: number }): Promise<StreetImageView | null>;
}

export class UnconfiguredStreetImagery implements StreetImagery {
  readonly configured = false;
  async nearest(): Promise<StreetImageView | null> {
    return null;
  }
}

const DEFAULT_BASE_URL = 'https://graph.mapillary.com';
const DEFAULT_TIMEOUT_MS = 6000;
const UNAVAILABLE = "Mapillary didn't answer.";
/** Half the search box, in degrees of latitude (about 55 m). */
const HALF_BOX_DEG = 0.0005;

/** Squared distance in metres-ish (longitude scaled by the latitude), good enough to rank nearby points. */
function distance2(a: { lat: number; lng: number }, b: [number, number]): number {
  const k = Math.cos((a.lat * Math.PI) / 180);
  const dx = (b[0] - a.lng) * k;
  const dy = b[1] - a.lat;
  return dx * dx + dy * dy;
}

function pointOf(geometry: unknown): [number, number] | null {
  if (!isRecord(geometry) || !Array.isArray(geometry.coordinates)) return null;
  const [lng, lat] = geometry.coordinates as unknown[];
  return typeof lng === 'number' && typeof lat === 'number' && Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
}

export class MapillaryStreetImagery implements StreetImagery {
  readonly configured = true;
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: ReturnType<typeof fetchOf>;

  constructor(o: { token: string; fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number }) {
    this.token = o.token;
    this.baseUrl = (o.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = fetchOf(o.fetch);
  }

  async nearest(point: { lat: number; lng: number }, opts?: { timeoutMs?: number }): Promise<StreetImageView | null> {
    const dLng = HALF_BOX_DEG / Math.max(0.2, Math.cos((point.lat * Math.PI) / 180));
    const r = (x: number) => x.toFixed(6);
    const params = new URLSearchParams({
      bbox: [r(point.lng - dLng), r(point.lat - HALF_BOX_DEG), r(point.lng + dLng), r(point.lat + HALF_BOX_DEG)].join(','),
      fields: 'id,thumb_1024_url,captured_at,computed_geometry,geometry',
      limit: '20',
    });
    const body = await getJson(
      this.fetchFn,
      `${this.baseUrl}/images?${params.toString()}`,
      { authorization: `OAuth ${this.token}` },
      opts?.timeoutMs ?? this.timeoutMs,
      UNAVAILABLE,
    );
    if (body === null) return null;
    if (!isRecord(body) || !Array.isArray(body.data)) throw new PropertyDataUnavailableError(UNAVAILABLE);

    let best: { view: StreetImageView; d: number } | null = null;
    for (const item of body.data) {
      if (!isRecord(item)) continue;
      const id = text(item.id);
      const thumbUrl = text(item.thumb_1024_url);
      const at = pointOf(item.computed_geometry) ?? pointOf(item.geometry);
      if (id === null || !/^\d+$/.test(id) || thumbUrl === null || !thumbUrl.startsWith('https://') || at === null) continue;
      const d = distance2(point, at);
      if (best === null || d < best.d) {
        best = {
          d,
          view: { id, thumbUrl, capturedAt: isoTime(item.captured_at), pageUrl: `https://www.mapillary.com/app/?pKey=${id}` },
        };
      }
    }
    return best?.view ?? null;
  }
}

/** Street imagery: the fake under FAKE_PROVIDERS (and DEMO_MODE), Mapillary when MAPILLARY_TOKEN is set, else none. */
export function createStreetImagery(config: Config): StreetImagery {
  if (config.FAKE_PROVIDERS) return new FakeStreetImagery();
  return config.MAPILLARY_TOKEN ? new MapillaryStreetImagery({ token: config.MAPILLARY_TOKEN }) : new UnconfiguredStreetImagery();
}
