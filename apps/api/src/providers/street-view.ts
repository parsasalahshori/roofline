import type { LngLat } from '@roofline/shared';
import type { Config } from '../config.ts';
import { FakeStreetView } from './fakes/street-view.ts';

/*
 * Google Street View (Static API): the panorama nearest a house (metadata: free) and a photo from it (Static image:
 * paid, about $7 per 1,000). Measure windows aims the photo at the house's front wall. The key is never logged and
 * never part of an error: a failed fetch is a fresh error that carries neither the URL nor the cause.
 */

/**
 * The panorama: its id, where the camera stood, when it was captured ('YYYY-MM', null if not said), and whether it is
 * Google's own (copyright "© Google": a Street View car or trekker) rather than a photo sphere someone uploaded
 * (source=outdoor still returns those). A person's upload has no known camera height or level, and its id can hold a '.'.
 */
export type StreetViewPano = { panoId: string; location: LngLat; capturedOn: string | null; byGoogle: boolean };
/** A panorama id as Google gives it: letters, digits, '_', '-' and, for people's uploads, '.'. */
export const PANO_ID = /^[\w.-]{1,200}$/;
export type StreetViewImageRequest = { panoId: string; heading: number; fov: number; pitch: number; widthPx: number; heightPx: number };

export interface StreetView {
  readonly configured: boolean;
  /**
   * The outdoor panorama nearest `where` within `radiusM`: a point, or an address (Google finds the address itself and
   * answers with a panorama on its street); null when Google has none there (ZERO_RESULTS / NOT_FOUND).
   */
  metadata(where: LngLat | string, opts?: { radiusM?: number }): Promise<StreetViewPano | null>;
  /** A JPEG from that panorama. Throws StreetViewUnavailableError on any failure. */
  image(req: StreetViewImageRequest): Promise<Uint8Array>;
}

export const STREET_VIEW_FAILURES = ['unconfigured', 'timeout', 'http', 'denied', 'bad-answer', 'too-large', 'no-image'] as const;
export type StreetViewFailure = (typeof STREET_VIEW_FAILURES)[number];

export class StreetViewUnavailableError extends Error {
  constructor(
    readonly reason: StreetViewFailure,
    message = "Street View didn't answer.",
  ) {
    super(message);
    this.name = 'StreetViewUnavailableError';
  }
}

export class UnconfiguredStreetView implements StreetView {
  readonly configured = false;
  metadata(): Promise<StreetViewPano | null> {
    return Promise.reject(new StreetViewUnavailableError('unconfigured', "Street View isn't set up."));
  }
  image(): Promise<Uint8Array> {
    return Promise.reject(new StreetViewUnavailableError('unconfigured', "Street View isn't set up."));
  }
}

const BASE_URL = 'https://maps.googleapis.com/maps/api/streetview';
const METADATA_TIMEOUT_MS = 8_000;
const IMAGE_TIMEOUT_MS = 15_000;
/** Static images are at most 640 x 640; a JPEG that size is well under 1 MB. */
export const MAX_IMAGE_PX = 640;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_RADIUS_M = 60;

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Reads a body up to `limit` bytes; null past it. */
async function readCapped(res: Response, limit: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > limit) return null;
  if (res.body === null) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

export class GoogleStreetView implements StreetView {
  readonly configured = true;
  private readonly key: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(o: { key: string; fetch?: typeof fetch; baseUrl?: string }) {
    this.key = o.key;
    this.baseUrl = (o.baseUrl ?? BASE_URL).replace(/\/+$/, '');
    const impl = o.fetch ?? globalThis.fetch;
    this.fetchFn = (input, init) => impl(input, init);
  }

  private async get(url: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchFn(url, { method: 'GET', signal: controller.signal });
    } catch {
      // A fresh error with no cause: a fetch error can carry the URL, which holds the key.
      throw new StreetViewUnavailableError(controller.signal.aborted ? 'timeout' : 'http');
    } finally {
      clearTimeout(timer);
    }
  }

  async metadata(where: LngLat | string, opts?: { radiusM?: number }): Promise<StreetViewPano | null> {
    let location: string;
    if (typeof where === 'string') {
      const address = where.trim();
      if (address === '' || address.length > 300) return null;
      location = encodeURIComponent(address);
    } else {
      const [lng, lat] = where;
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
      location = `${lat.toFixed(7)},${lng.toFixed(7)}`;
    }
    const radius = Math.round(Math.min(200, Math.max(10, opts?.radiusM ?? DEFAULT_RADIUS_M)));
    const url = `${this.baseUrl}/metadata?location=${location}&radius=${radius}&source=outdoor&key=${encodeURIComponent(this.key)}`;
    const res = await this.get(url, METADATA_TIMEOUT_MS);
    if (!res.ok) throw new StreetViewUnavailableError('http');
    let body: unknown;
    try {
      const bytes = await readCapped(res, 64 * 1024);
      if (bytes === null) throw new Error('too large');
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new StreetViewUnavailableError('bad-answer');
    }
    const root = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const status = root.status;
    if (status === 'ZERO_RESULTS' || status === 'NOT_FOUND') return null;
    if (status === 'REQUEST_DENIED' || status === 'OVER_QUERY_LIMIT') throw new StreetViewUnavailableError('denied');
    if (status !== 'OK') throw new StreetViewUnavailableError('bad-answer');
    const loc = typeof root.location === 'object' && root.location !== null ? (root.location as Record<string, unknown>) : {};
    const pLat = num(loc.lat);
    const pLng = num(loc.lng);
    const panoId = typeof root.pano_id === 'string' && PANO_ID.test(root.pano_id) ? root.pano_id : null;
    if (pLat === null || pLng === null || panoId === null) throw new StreetViewUnavailableError('bad-answer');
    const date = typeof root.date === 'string' && /^\d{4}-\d{2}$/.test(root.date) ? root.date : null;
    const byGoogle = typeof root.copyright === 'string' && /google/i.test(root.copyright);
    return { panoId, location: [pLng, pLat], capturedOn: date, byGoogle };
  }

  async image(req: StreetViewImageRequest): Promise<Uint8Array> {
    const w = Math.round(Math.min(MAX_IMAGE_PX, Math.max(64, req.widthPx)));
    const h = Math.round(Math.min(MAX_IMAGE_PX, Math.max(64, req.heightPx)));
    const fov = Math.min(120, Math.max(10, req.fov));
    const pitch = Math.min(90, Math.max(-90, req.pitch));
    const heading = ((req.heading % 360) + 360) % 360;
    if (!PANO_ID.test(req.panoId)) throw new StreetViewUnavailableError('bad-answer');
    const url =
      `${this.baseUrl}?size=${w}x${h}&pano=${encodeURIComponent(req.panoId)}&heading=${heading.toFixed(2)}` +
      `&fov=${fov.toFixed(1)}&pitch=${pitch.toFixed(1)}&source=outdoor&return_error_code=true&key=${encodeURIComponent(this.key)}`;
    const res = await this.get(url, IMAGE_TIMEOUT_MS);
    // return_error_code: no imagery is a 404, not a grey "no image" picture.
    if (res.status === 404) throw new StreetViewUnavailableError('no-image');
    if (res.status === 403) throw new StreetViewUnavailableError('denied');
    if (!res.ok) throw new StreetViewUnavailableError('http');
    if (!(res.headers.get('content-type') ?? '').startsWith('image/jpeg')) throw new StreetViewUnavailableError('bad-answer');
    let bytes: Uint8Array | null;
    try {
      bytes = await readCapped(res, MAX_IMAGE_BYTES);
    } catch {
      throw new StreetViewUnavailableError('http');
    }
    if (bytes === null) throw new StreetViewUnavailableError('too-large');
    // A JPEG starts FF D8.
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new StreetViewUnavailableError('bad-answer');
    return bytes;
  }
}

/** In DEMO_MODE the real one with a key, else the fake; the fake under FAKE_PROVIDERS; otherwise real or unconfigured. */
export function createStreetView(config: Config): StreetView {
  const key = config.GOOGLE_MAPS_API_KEY;
  const real = key ? new GoogleStreetView({ key }) : null;
  if (config.DEMO_MODE) return real ?? new FakeStreetView();
  if (config.FAKE_PROVIDERS) return new FakeStreetView();
  return real ?? new UnconfiguredStreetView();
}
