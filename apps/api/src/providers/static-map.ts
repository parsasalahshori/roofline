import type { Config } from '../config.ts';
import { FakeStaticMap } from './fakes/static-map.ts';

/** A still map image (PNG bytes) for the claim packet. */
export interface StaticMap {
  /** `center` is [lng, lat]; `path` is an optional ring or line of [lng, lat] points to draw. Null when no image can be made (no key, a failed call). Never throws. */
  image(input: { center: [number, number]; path?: [number, number][] }): Promise<Uint8Array | null>;
}

/** Answers null for every call (no MAPTILER_SERVER_KEY). */
export class UnconfiguredStaticMap implements StaticMap {
  async image(): Promise<Uint8Array | null> {
    return null;
  }
}

const ZOOM = 15;
const WIDTH = 640;
const HEIGHT = 360;
const TIMEOUT_MS = 8000;

/** MapTiler static maps. Never logs or returns the key; every failure answers null. */
export class MapTilerStaticMap implements StaticMap {
  private readonly key: string;
  private readonly fetchImpl: typeof fetch;

  constructor(o: { key: string; fetch?: typeof fetch }) {
    this.key = o.key;
    this.fetchImpl = o.fetch ?? fetch;
  }

  async image(input: { center: [number, number]; path?: [number, number][] }): Promise<Uint8Array | null> {
    if (this.key === '') return null;
    try {
      const [lng, lat] = input.center;
      let url = `https://api.maptiler.com/maps/streets-v2/static/${lng},${lat},${ZOOM}/${WIDTH}x${HEIGHT}.png?key=${encodeURIComponent(this.key)}`;
      if (input.path && input.path.length >= 2) {
        const pts = input.path.map(([x, y]) => `${x},${y}`).join('|');
        url += `&path=${encodeURIComponent(`fill:rgba(245,179,36,0.25)|stroke:#f5b324|width:2|${pts}`)}`;
      }
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return null;
      if (!(res.headers.get('content-type') ?? '').startsWith('image/')) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      return null;
    }
  }
}

/**
 * The MapTiler one whenever MAPTILER_SERVER_KEY is set (the demo sets it from its MapTiler key, so its claim
 * packets show the real street map, like its real address lookups), else the fake with FAKE_PROVIDERS,
 * otherwise the unconfigured one. Tests and CI set no key, so they never call MapTiler.
 */
export function createStaticMap(config: Config): StaticMap {
  const key = config.MAPTILER_SERVER_KEY;
  if (key !== undefined && key !== '') return new MapTilerStaticMap({ key });
  if (config.FAKE_PROVIDERS) return new FakeStaticMap();
  return new UnconfiguredStaticMap();
}
