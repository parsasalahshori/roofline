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

/** Explicit, key-free historical aerial imagery; the verified cache ends at zoom 16. */
function usgsStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      usgs: {
        type: 'raster',
        tiles: ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 16,
        attribution: legal.usgsAttribution,
      },
    },
    layers: [{ id: 'usgs', type: 'raster', source: 'usgs' }],
  };
}

export function imagerySource(env: MapEnv): 'maptiler' | 'usgs' | 'streets' | 'none' {
  if (keyOf(env) !== undefined) return 'maptiler';
  if (env.tiles === 'usgs') return 'usgs';
  return env.tiles === 'osm' ? 'streets' : 'none';
}

/**
 * The style the map loads. With a MapTiler key it is a URL (streets, or hybrid for satellite), and
 * the key beats `tiles`. Explicit `usgs` enables historical aerial imagery in satellite mode and
 * streets otherwise; `osm` enables streets only. An unset tile choice stays network-free.
 */
export function mapStyle(env: MapEnv, mode: MapMode): StyleSpecification | string {
  const key = keyOf(env);
  if (key !== undefined) {
    const style = mode === 'satellite' ? 'hybrid' : 'streets-v2';
    return `https://api.maptiler.com/maps/${style}/style.json?key=${encodeURIComponent(key)}`;
  }
  if (env.tiles === 'usgs') return mode === 'satellite' ? usgsStyle() : osmStyle();
  if (env.tiles === 'osm') return osmStyle();
  return blankStyle();
}

/** Satellite is available with a MapTiler key or explicit public-imagery opt-in. */
export function satelliteAvailable(env: MapEnv): boolean {
  return keyOf(env) !== undefined || env.tiles === 'usgs';
}
