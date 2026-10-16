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

const AERIAL_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

/** The plain page colour, with no sources: it asks the network for nothing and needs no glyphs. */
function blankStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': tokens['map-land'] } }],
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
    // Washed out to a light, low-contrast gray so the hail layer carries the colour.
    layers: [
      {
        id: 'osm',
        type: 'raster',
        source: 'osm',
        paint: { 'raster-saturation': -1, 'raster-contrast': -0.35, 'raster-brightness-min': 0.35, 'raster-brightness-max': 1 },
      },
    ],
  };
}

/**
 * Aerial photos from Esri World Imagery (no key), sharp to zoom 19; `maxzoom: 19` makes MapLibre stretch that last
 * level for the closer zooms the roof view uses. The URL order is z/y/x. A tile that fails to load leaves a gap in
 * the picture and nothing else.
 *
 * Demo and development only. Esri's terms do not cover a paid product, so production needs a licensed imagery
 * provider (a MapTiler key already switches satellite to its hybrid style, and beats this).
 */
function aerialStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      aerial: {
        type: 'raster',
        tiles: [AERIAL_TILES],
        tileSize: 256,
        maxzoom: 19,
        attribution: legal.imageryAttribution,
      },
    },
    layers: [{ id: 'aerial', type: 'raster', source: 'aerial' }],
  };
}

/**
 * The style the map loads. With a MapTiler key it is a URL (the light gray dataviz style, or hybrid for satellite), and
 * the key beats `tiles` and `imagery`. Without one, `tiles` of `aerial` draws the Esri aerial photos in both modes,
 * `imagery` of `aerial` draws them in satellite mode only (the demo build: streets stay on OpenStreetMap), `tiles` of
 * `osm` draws OpenStreetMap, and anything else is the blank style.
 */
export function mapStyle(env: MapEnv, mode: MapMode): StyleSpecification | string {
  const key = keyOf(env);
  if (key !== undefined) {
    const style = mode === 'satellite' ? 'hybrid' : 'dataviz-light';
    return `https://api.maptiler.com/maps/${style}/style.json?key=${encodeURIComponent(key)}`;
  }
  if (env.tiles === 'aerial' || (mode === 'satellite' && env.imagery === 'aerial')) return aerialStyle();
  if (env.tiles === 'osm') return osmStyle();
  return blankStyle();
}

/** Satellite needs the MapTiler hybrid style or the free aerial photos, so it is offered only with a key or `aerial`. */
export function satelliteAvailable(env: MapEnv): boolean {
  return keyOf(env) !== undefined || env.tiles === 'aerial' || env.imagery === 'aerial';
}
