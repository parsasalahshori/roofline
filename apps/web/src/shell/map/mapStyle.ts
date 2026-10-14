import { tokens } from '@roofline/ui';
import type { StyleSpecification } from 'maplibre-gl';
import { legal } from '../../copy/legal.ts';
import type { MapEnv, MapMode } from './types.ts';

/** The MapTiler key, trimmed, or `undefined` when there is none (an empty or blank key is no key). */
function keyOf(env: MapEnv): string | undefined {
  const key = env.maptilerKey;
  if (typeof key !== 'string') return undefined;
  const trimmed = key.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** The plain page colour, with no sources: it asks the network for nothing and needs no glyphs. */
function blankStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': tokens.bg } }],
  };
}

/** The free OpenStreetMap raster tiles, with the attribution the licence asks for. */
function osmStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: legal.mapAttribution,
      },
    },
    layers: [{
      id: 'osm',
      type: 'raster',
      source: 'osm',
      // Muted geographic context lets real job pins and hail remain legible.
      paint: { 'raster-saturation': -0.7, 'raster-contrast': -0.15, 'raster-brightness-min': 0.12 },
    }],
  };
}

/**
 * The style the map loads. With a MapTiler key it is a URL (streets, or hybrid for satellite), and
 * the key beats `tiles`. Without one it is the OpenStreetMap style when `tiles` is `osm`, and the
 * blank style otherwise.
 */
export function mapStyle(env: MapEnv, mode: MapMode): StyleSpecification | string {
  const key = keyOf(env);
  if (key !== undefined) {
    const style = mode === 'satellite' ? 'hybrid' : 'streets-v2';
    return `https://api.maptiler.com/maps/${style}/style.json?key=${encodeURIComponent(key)}`;
  }
  if (env.tiles === 'osm') return osmStyle();
  return blankStyle();
}

/** Satellite needs the MapTiler hybrid style, so it is offered only when there is a key. */
export function satelliteAvailable(env: MapEnv): boolean {
  return keyOf(env) !== undefined;
}
