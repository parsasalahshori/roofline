import { fromArrayBuffer } from 'geotiff';
import type { LngLat } from '@roofline/shared';
import { MAX_RASTER_PIXELS, utmZoneOfEpsg } from '@roofline/shared/roof-reconstruct';
import type { Config } from '../config.ts';
import { type RoofLayers, type RoofPhoto, type SolarLayersApi, type SolarLayersFailure, SolarLayersUnavailableError } from './solar-layers.ts';

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
/** dataLayers:get's answer is a few hundred bytes of JSON (three URLs, dates, a quality word). */
const MAX_ANSWER_CHARS = 64 * 1024;
const UNAVAILABLE_MESSAGE = "Google Solar's height map didn't come.";
/**
 * A height map and mask must be on grids of the same pixel size within this share (and square pixels within it): a
 * mask resampled from a much coarser or finer grid, or a skewed one, is not the file asked for.
 */
const GRID_TOLERANCE = 0.01;

function unavailable(reason: SolarLayersFailure): SolarLayersUnavailableError {
  return new SolarLayersUnavailableError(UNAVAILABLE_MESSAGE, reason);
}

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
  let tooLarge = false;
  try {
    const tiff = await fromArrayBuffer(bytes);
    const image = await tiff.getImage();
    const width = image.getWidth();
    const height = image.getHeight();
    // Checked before any pixel is decoded: a small compressed file can declare a huge grid.
    if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) throw new Error('no size');
    if (width * height > MAX_RASTER_PIXELS) {
      tooLarge = true;
      throw new Error('too large');
    }
    const [originX, originY] = image.getOrigin();
    const [pixelX, pixelY] = image.getResolution();
    const keys = (image.getGeoKeys() ?? {}) as Record<string, unknown>;
    const epsg = Number(keys.ProjectedCSTypeGeoKey);
    if (!(Number.isFinite(originX) && Number.isFinite(originY) && pixelX! > 0 && Math.abs(pixelY!) > 0)) throw new Error('no grid');
    const rasters = await image.readRasters({ samples: [0] });
    const data = (rasters as unknown as ArrayLike<number>[])[0]!;
    if (data === undefined || data.length !== width * height) throw new Error('short');
    const noData = image.getGDALNoData();
    return { width, height, originX: originX!, originY: originY!, pixelX: pixelX!, pixelY: Math.abs(pixelY!), epsg, data, noData };
  } catch {
    throw unavailable(tooLarge ? 'too-large' : 'decode');
  }
}

/** An RGB GeoTIFF (Google's aerial photo) as 3 bytes a pixel on its UTM grid. Throws SolarLayersUnavailableError. */
export async function readRgbGeoTiff(bytes: ArrayBuffer): Promise<RoofPhoto> {
  try {
    const tiff = await fromArrayBuffer(bytes);
    const image = await tiff.getImage();
    const [originX, originY] = image.getOrigin();
    const [pixelX] = image.getResolution();
    if (image.getSamplesPerPixel() < 3) throw new Error('not RGB');
    if (!(image.getWidth() > 0 && image.getHeight() > 0 && image.getWidth() * image.getHeight() <= MAX_RASTER_PIXELS)) throw new Error('size');
    const data = (await image.readRasters({ samples: [0, 1, 2], interleave: true })) as unknown as ArrayLike<number>;
    if (data.length < image.getWidth() * image.getHeight() * 3) throw new Error('short');
    const rgb = new Uint8Array(image.getWidth() * image.getHeight() * 3);
    for (let i = 0; i < rgb.length; i++) rgb[i] = Math.max(0, Math.min(255, Math.round(Number(data[i]))));
    if (!(Number.isFinite(originX) && Number.isFinite(originY) && pixelX! > 0)) throw new Error('no grid');
    return { width: image.getWidth(), height: image.getHeight(), pixelSizeM: pixelX!, originX: originX!, originY: originY!, rgb };
  } catch {
    throw unavailable('decode');
  }
}

/**
 * The height map and mask as one grid (the height map's): heights in metres (no-data as NaN), the mask resampled
 * onto the height map's pixels when Google sent it on another grid.
 */
export function layersFrom(dsm: Grid, mask: Grid, meta: { imageryQuality: string | null; imageryDate: string | null }): RoofLayers {
  if (utmZoneOfEpsg(dsm.epsg) === null) throw unavailable('bad-crs');
  // The mask must be on the same UTM zone (it is resampled by coordinates), with square pixels like the height map's.
  if (mask.epsg !== dsm.epsg) throw unavailable('mismatch');
  if (Math.abs(dsm.pixelX - dsm.pixelY) > GRID_TOLERANCE * dsm.pixelX || Math.abs(mask.pixelX - mask.pixelY) > GRID_TOLERANCE * mask.pixelX) throw unavailable('mismatch');
  if (dsm.width * dsm.height > MAX_RASTER_PIXELS) throw unavailable('too-large');
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

  /**
   * One GET read whole within its own timeout (headers and body: a body that trickles in is cut off too). Null for
   * Google's 404. Any failure is SolarLayersUnavailableError with a reason and no cause (URLs hold the key).
   */
  private async get<T>(url: string, timeoutMs: number, read: (response: Response) => Promise<T>): Promise<T | null> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await this.fetchFn(url, { method: 'GET', signal: controller.signal });
      if (response.status === 404) return null;
      if (!response.ok) throw unavailable('http');
      return await read(response);
    } catch (error) {
      if (timedOut) throw unavailable('timeout');
      if (error instanceof SolarLayersUnavailableError) throw error;
      throw unavailable('http');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Whether a file URL from Google's answer may be sent the key: https on the API's own host. Anything else (an answer
   * tampered with, a misconfigured proxy) would hand the key to another server.
   */
  private trusted(url: string): boolean {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && u.host === new URL(this.baseUrl).host;
    } catch {
      return false;
    }
  }

  private async file(url: string, timeoutMs: number): Promise<ArrayBuffer> {
    if (!this.trusted(url)) throw unavailable('bad-answer');
    // geoTiff:get needs the key too; the URL Google gives already has its own query (the file id).
    const withKey = `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(this.apiKey)}`;
    const bytes = await this.get(withKey, timeoutMs, async (response) => {
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) throw unavailable('too-large');
      const body = await response.arrayBuffer();
      if (body.byteLength > MAX_FILE_BYTES) throw unavailable('too-large');
      return body;
    });
    if (bytes === null) throw unavailable('http');
    return bytes;
  }

  /**
   * dataLayers:get (view IMAGERY_LAYERS: height map, photo and mask), then the three GeoTIFFs (the files come with
   * the one billed request). Null when Google has no HIGH or MEDIUM imagery for the point (its NOT_FOUND).
   */
  async roofLayers(center: LngLat, radiusM: number, opts?: { timeoutMs?: number }): Promise<RoofLayers | null> {
    const [lng, lat] = center;
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || !(radiusM > 0)) return null;
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    const radius = Math.min(100, Math.max(10, Math.ceil(radiusM)));
    const url =
      `${this.baseUrl}/dataLayers:get?location.latitude=${lat.toFixed(7)}&location.longitude=${lng.toFixed(7)}` +
      `&radiusMeters=${radius}&view=IMAGERY_LAYERS&requiredQuality=${REQUIRED_QUALITY}&pixelSizeMeters=${PIXEL_SIZE_M}` +
      `&key=${encodeURIComponent(this.apiKey)}`;
    const body = await this.get(url, timeoutMs, async (response) => {
      const text = await response.text();
      if (text.length > MAX_ANSWER_CHARS) throw unavailable('too-large');
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw unavailable('bad-answer');
      }
    });
    if (body === null) return null;
    const root = isRecord(body) ? body : {};
    const dsmUrl = typeof root.dsmUrl === 'string' ? root.dsmUrl : null;
    const maskUrl = typeof root.maskUrl === 'string' ? root.maskUrl : null;
    if (dsmUrl === null || maskUrl === null) return null;
    const rgbUrl = typeof root.rgbUrl === 'string' ? root.rgbUrl : null;
    // The photo is a bonus (the roof view's true-ortho photo, and where the trees are): its failure costs nothing else.
    const photo = rgbUrl === null ? Promise.resolve(null) : this.file(rgbUrl, timeoutMs * 2).then(readRgbGeoTiff).catch(() => null);
    const [dsmBytes, maskBytes] = await Promise.all([this.file(dsmUrl, timeoutMs * 2), this.file(maskUrl, timeoutMs * 2)]);
    const [dsm, mask] = await Promise.all([readGeoTiff(dsmBytes), readGeoTiff(maskBytes)]);
    const layers = layersFrom(dsm, mask, {
      imageryQuality: typeof root.imageryQuality === 'string' ? root.imageryQuality.slice(0, 20) : null,
      imageryDate: dateText(root.imageryDate),
    });
    return { ...layers, photo: await photo };
  }
}

export function googleSolarLayersFor(config: Config): SolarLayersApi | null {
  const apiKey = config.GOOGLE_SOLAR_API_KEY;
  return apiKey && config.GOOGLE_SOLAR_DATA_LAYERS ? new GoogleSolarLayers({ apiKey }) : null;
}
