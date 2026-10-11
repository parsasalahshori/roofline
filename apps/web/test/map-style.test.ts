import type { StyleSpecification } from 'maplibre-gl';
import { tokens } from '@roofline/ui';
import { describe, expect, it } from 'vitest';
import { legal } from '../src/copy/legal.ts';
import { mapStyle, satelliteAvailable } from '../src/shell/map/mapStyle.ts';

/** The style as an object; fails the test when it came back as a URL. */
function asObject(style: StyleSpecification | string): StyleSpecification {
  if (typeof style === 'string') throw new Error(`expected a style object, got the URL ${style}`);
  return style;
}

const OSM_TILES = ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'];

describe('mapStyle', () => {
  it('asks MapTiler for the streets style with the key', () => {
    expect(mapStyle({ maptilerKey: 'abc' }, 'streets')).toBe('https://api.maptiler.com/maps/streets-v2/style.json?key=abc');
  });

  it('asks MapTiler for the hybrid style with the key in satellite mode', () => {
    expect(mapStyle({ maptilerKey: 'abc' }, 'satellite')).toBe('https://api.maptiler.com/maps/hybrid/style.json?key=abc');
  });

  it('encodes the key in the URL', () => {
    expect(mapStyle({ maptilerKey: 'a b' }, 'streets')).toBe('https://api.maptiler.com/maps/streets-v2/style.json?key=a%20b');
  });

  it('draws the free OpenStreetMap tiles when asked, in both modes, with the attribution', () => {
    const streets = asObject(mapStyle({ tiles: 'osm' }, 'streets'));
    expect(streets).toMatchObject({
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: OSM_TILES,
          tileSize: 256,
          maxzoom: 19,
          attribution: legal.mapAttribution,
        },
      },
      layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
    });
    expect(legal.mapAttribution).toBe('© OpenStreetMap contributors');
    expect(asObject(mapStyle({ tiles: 'osm' }, 'satellite'))).toEqual(streets);
  });

  it('falls back to a blank style with one background layer and no sources', () => {
    const blank = asObject(mapStyle({}, 'streets'));
    expect(Object.keys(blank.sources)).toHaveLength(0);
    expect(blank.layers).toEqual([{ id: 'background', type: 'background', paint: { 'background-color': tokens.bg } }]);
  });

  it('keeps the blank style free of glyphs, so no text layer needs a font', () => {
    expect(asObject(mapStyle({}, 'streets'))).not.toHaveProperty('glyphs');
    expect(asObject(mapStyle({ tiles: 'osm' }, 'streets'))).not.toHaveProperty('glyphs');
  });

  it('treats an empty or blank key as no key', () => {
    for (const maptilerKey of ['', '   ']) {
      const style = mapStyle({ maptilerKey }, 'streets');
      expect(typeof style).toBe('object');
      expect(asObject(style).layers).toEqual([{ id: 'background', type: 'background', paint: { 'background-color': tokens.bg } }]);
    }
  });

  it('prefers the key over the OpenStreetMap tiles', () => {
    expect(mapStyle({ maptilerKey: 'abc', tiles: 'osm' }, 'streets')).toBe(
      'https://api.maptiler.com/maps/streets-v2/style.json?key=abc',
    );
  });
});

describe('satelliteAvailable', () => {
  it('is true only when there is a key', () => {
    expect(satelliteAvailable({})).toBe(false);
    expect(satelliteAvailable({ tiles: 'osm' })).toBe(false);
    expect(satelliteAvailable({ maptilerKey: '' })).toBe(false);
    expect(satelliteAvailable({ maptilerKey: '   ' })).toBe(false);
    expect(satelliteAvailable({ maptilerKey: 'abc' })).toBe(true);
  });
});
