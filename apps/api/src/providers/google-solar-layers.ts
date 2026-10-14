import { fromArrayBuffer } from 'geotiff';
import type { LngLat } from '@roofline/shared';
import { utmZoneOfEpsg } from '@roofline/shared/roof-reconstruct';
import type { Config } from '../config.ts';
import { type RoofLayers, type SolarLayersApi, SolarLayersUnavailableError } from './solar-layers.ts';

const BASE_URL = 'https://solar.googleapis.com/v1';
const DEFAULT_TIMEOUT_MS = 12_000;
/** The finest grid Google serves; MEDIUM imagery comes at its own 0.25 m whatever is asked. */
const PIXEL_SIZE_M = 0.1;
/**
 * The lowest imagery quality accepted. requiredQuality is a floor (exactQualityRequired defaults to false), so one
 * call returns HIGH (0.1 m) where Google has it and MEDIUM (0.25 m) otherwise: never two paid calls for one roof.
 * LOW (0.5 m) is too coarse to find roof planes in.
 */
const REQUIRED_QUALITY = 'MEDIUM';
/** The two files are a few hundred kilobytes each; anything near this is not what was asked for. */
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const UNAVAILABLE_MESSAGE = "Google Solar's height map didn't come.";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dateText(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const { year, month, day } = value;
  if (typeof year !== 'number' || typeof month !== 'number' || typeof day !== 'number') return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

type Grid = { width: number; height: number; originX: number; originY: number; pixelX: number; pixelY: number; epsg: number; data: ArrayLike<number>; noData: number | null };

/** The first band of a GeoTIFF with its UTM grid. Throws SolarLayersUnavailableError for anything unreadable. */
export async function readGeoTiff(bytes: ArrayBuffer): Promise<Grid> {
  try {
    const tiff = await fromArrayBuffer(bytes);
    const image = await tiff.getImage();
    const [originX, originY] = image.getOrigin();
    const [pixelX, pixelY] = image.getResolution();
    const keys = (image.getGeoKeys() ?? {}) as Record<string, unknown>;
    const epsg = Number(keys.ProjectedCSTypeGeoKey);
    const rasters = await image.readRasters({ samples: [0] });
    const data = (rasters as unknown as ArrayLike<number>[])[0]!;
    const noData = image.getGDALNoData();
    if (!(Number.isFinite(originX) && Number.isFinite(originY) && pixelX! > 0 && Math.abs(pixelY!) > 0)) throw new Error('no grid');
    return { width: image.getWidth(), height: image.getHeight(), originX: originX!, originY: originY!, pixelX: pixelX!, pixelY: Math.abs(pixelY!), epsg, data, noData };
  } catch {
    throw new SolarLayersUnavailableError(UNAVAILABLE_MESSAGE);
  }
}

/**
 * The height map and mask as one grid (the height map's): heights in metres (no-data as NaN), the mask resampled
 * onto the height map's pixels when Google sent it on another grid.
 */
export function layersFrom(dsm: Grid, mask: Grid, meta: { imageryQuality: string | null; imageryDate: string | null }): RoofLayers {
  if (utmZoneOfEpsg(dsm.epsg) === null) throw new SolarLayersUnavailableError(UNAVAILABLE_MESSAGE);
  const n = dsm.width * dsm.height;
  const heights = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const z = Number(dsm.data[i]);
    heights[i] = Number.isFinite(z) && z !== dsm.noData && z > -1000 ? z : Number.NaN;
  }
  const roof = new Uint8Array(n);
  const same =
    mask.width === dsm.width && mask.height === dsm.height && Math.abs(mask.originX - dsm.originX) < 1e-6 && Math.abs(mask.originY - dsm.originY) < 1e-6;
  for (let r = 0; r < dsm.height; r++) {
    for (let c = 0; c < dsm.width; c++) {
      let v: number;
      if (same) v = Number(mask.data[r * dsm.width + c]);
      else {
        // The mask pixel under this height map pixel's centre.
        const x = dsm.originX + (c + 0.5) * dsm.pixelX;
        const y = dsm.originY - (r + 0.5) * dsm.pixelY;
        const mc = Math.floor((x - mask.originX) / mask.pixelX);
        const mr = Math.floor((mask.originY - y) / mask.pixelY);
        v = mc >= 0 && mr >= 0 && mc < mask.width && mr < mask.height ? Number(mask.data[mr * mask.width + mc]) : 0;
      }
      roof[r * dsm.width + c] = v > 0 ? 1 : 0;
    }
  }
  return {
    raster: { width: dsm.width, height: dsm.height, pixelSizeM: dsm.pixelX, dsm: heights, mask: roof },
    epsg: dsm.epsg,
    originX: dsm.originX,
    originY: dsm.originY,
    ...meta,
  };
}

export class GoogleSolarLayers implements SolarLayersApi {
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

  /** One GET with its own timeout; any failure becomes SolarLayersUnavailableError with no cause (URLs hold the key). */
  private async get(url: string, timeoutMs: number): Promise<Response | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchFn(url, { method: 'GET', signal: controller.signal });
      if (response.status === 404) return null;
      if (!response.ok) throw new SolarLayersUnavailableError(UNAVAILABLE_MESSAGE);
      return response;
    } catch (error) {
      if (error instanceof SolarLayersUnavailableError) throw error;
      throw new SolarLayersUnavailableError(UNAVAILABLE_MESSAGE);
    } finally {
      clearTimeout(timer);
    }
  }

  private async file(url: string, timeoutMs: number): Promise<ArrayBuffer> {
    // geoTiff:get needs the key too; the URL Google gives already has its own query (the file id).
    const withKey = `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(this.apiKey)}`;
    const response = await this.get(withKey, timeoutMs);
    if (response === null) throw new SolarLayersUnavailableError(UNAVAILABLE_MESSAGE);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) throw new SolarLayersUnavailableError(UNAVAILABLE_MESSAGE);
    try {
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('too big');
      return bytes;
    } catch {
      throw new SolarLayersUnavailableError(UNAVAILABLE_MESSAGE);
    }
  }

  /**
   * dataLayers:get (view IMAGERY_LAYERS: height map, photo and mask; only the height map and mask are downloaded),
   * then the two GeoTIFFs. Null when Google has no HIGH or MEDIUM imagery for the point (its NOT_FOUND).
   */
  async roofLayers(center: LngLat, radiusM: number, opts?: { timeoutMs?: number }): Promise<RoofLayers | null> {
    const [lng, lat] = center;
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || !(radiusM > 0)) return null;
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    const radius = Math.min(100, Math.max(10, Math.ceil(radiusM)));
    const url =
      `${this.baseUrl}/dataLayers:get?location.latitude=${lat.toFixed(7)}&location.longitude=${lng.toFixed(7)}` +
      `&radiusMeters=${radius}&view=IMAGERY_LAYERS&requiredQuality=${REQUIRED_QUALITY}&pixelSizeMeters=${PIXEL_SIZE_M}` +
      `&key=${encodeURIComponent(this.apiKey)}`;
    const response = await this.get(url, timeoutMs);
    if (response === null) return null;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new SolarLayersUnavailableError(UNAVAILABLE_MESSAGE);
    }
    const root = isRecord(body) ? body : {};
    const dsmUrl = typeof root.dsmUrl === 'string' ? root.dsmUrl : null;
    const maskUrl = typeof root.maskUrl === 'string' ? root.maskUrl : null;
    if (dsmUrl === null || maskUrl === null) return null;
    const [dsmBytes, maskBytes] = await Promise.all([this.file(dsmUrl, timeoutMs * 2), this.file(maskUrl, timeoutMs * 2)]);
    const [dsm, mask] = await Promise.all([readGeoTiff(dsmBytes), readGeoTiff(maskBytes)]);
    return layersFrom(dsm, mask, {
      imageryQuality: typeof root.imageryQuality === 'string' ? root.imageryQuality : null,
      imageryDate: dateText(root.imageryDate),
    });
  }
}

export function googleSolarLayersFor(config: Config): SolarLayersApi | null {
  const apiKey = config.GOOGLE_SOLAR_API_KEY;
  return apiKey && config.GOOGLE_SOLAR_DATA_LAYERS ? new GoogleSolarLayers({ apiKey }) : null;
}
