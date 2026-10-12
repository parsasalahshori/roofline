import { describe, expect, it, vi } from 'vitest';
import type { FeatureCollection } from 'geojson';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { tokens } from '@roofline/ui';
import { emptyMapData, installMapLayers, removeMapLayers } from '../src/shell/map/layers.ts';
import { applyStormData, HAIL_LEVEL_SIZES_IN, setStormVisible } from '../src/shell/map/stormLayer.ts';
import type { StormLayerResponse } from '../src/features/storm/layerTypes.ts';

type Spec = Record<string, unknown>;

/* A small stand-in for the MapLibre style API: sources and layers by id, in insertion order. */
function styleMap() {
  const sources = new Map<string, Spec>();
  const layers = new Map<string, Spec>();
  const map = {
    getStyle: () => ({}),
    getSource: (id: string) => sources.get(id),
    getLayer: (id: string) => layers.get(id),
    addSource: (id: string, spec: Spec) => {
      sources.set(id, spec);
    },
    addLayer: (spec: Spec) => {
      layers.set(String(spec.id), spec);
    },
    removeLayer: (id: string) => {
      layers.delete(id);
    },
    removeSource: (id: string) => {
      sources.delete(id);
    },
  };
  return { map: map as unknown as MapLibreMap, sources, layers };
}

function empty(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

const data: StormLayerResponse = { swaths: empty(), spots: empty(), newestRunAt: null, stale: false };

describe('storm layers', () => {
  it('colours swaths by contour level (a step on thresholdIn)', () => {
    const fake = styleMap();
    installMapLayers(fake.map, emptyMapData());
    const fill = fake.layers.get('storm-swath-fill') as { paint: Spec };
    const color = fill.paint['fill-color'] as unknown[];

    expect(color).toEqual([
      'step',
      ['get', 'thresholdIn'],
      tokens['hail-1'],
      1.25,
      tokens['hail-2'],
      1.75,
      tokens['hail-3'],
      2.5,
      tokens['hail-4'],
      3,
      tokens['hail-5'],
    ]);
  });

  it('colours a 2.5 in contour with the hail-4 colour', () => {
    const fake = styleMap();
    installMapLayers(fake.map, emptyMapData());
    const fill = fake.layers.get('storm-swath-fill') as { paint: Spec };
    const color = fill.paint['fill-color'] as unknown[];
    expect(color[color.indexOf(2.5) + 1]).toBe(tokens['hail-4']);
  });

  it('does not throw on a malformed body', () => {
    const swathSource = { setData: vi.fn() };
    const spotSource = { setData: vi.fn() };
    const map = {
      getSource: vi.fn((id: string) => (id === 'storm-swath' ? swathSource : spotSource)),
    } as unknown as MapLibreMap;
    const bad = { newestRunAt: null, stale: false } as unknown as StormLayerResponse;
    expect(() => applyStormData(map, bad)).not.toThrow();
    expect(swathSource.setData).toHaveBeenCalledWith({ type: 'FeatureCollection', features: [] });
    expect(spotSource.setData).toHaveBeenCalledWith({ type: 'FeatureCollection', features: [] });
  });

  it('adds the spots layer and outline', () => {
    const fake = styleMap();
    installMapLayers(fake.map, emptyMapData());

    expect(fake.layers.get('storm-spots')).toMatchObject({ type: 'circle', source: 'storm-spots' });
    expect(fake.layers.get('storm-swath-outline')).toMatchObject({ type: 'line', source: 'storm-swath' });
    expect(fake.sources.has('storm-spots')).toBe(true);

    removeMapLayers(fake.map);
    expect(fake.layers.has('storm-spots')).toBe(false);
    expect(fake.layers.has('storm-swath-outline')).toBe(false);
    expect(fake.layers.has('storm-swath-fill')).toBe(false);
    expect(fake.sources.has('storm-spots')).toBe(false);
    expect(fake.sources.has('storm-swath')).toBe(false);
  });

  it('applyStormData and setStormVisible', () => {
    const swathSource = { setData: vi.fn() };
    const spotSource = { setData: vi.fn() };
    const setLayoutProperty = vi.fn();
    const present = new Set(['storm-swath-fill', 'storm-spots']);
    const map = {
      getSource: vi.fn((id: string) => (id === 'storm-swath' ? swathSource : id === 'storm-spots' ? spotSource : undefined)),
      getLayer: vi.fn((id: string) => (present.has(id) ? { id } : undefined)),
      setLayoutProperty,
    } as unknown as MapLibreMap;

    applyStormData(map, data);
    expect(swathSource.setData).toHaveBeenCalledWith(data.swaths);
    expect(spotSource.setData).toHaveBeenCalledWith(data.spots);

    // Undefined data is a no-op.
    swathSource.setData.mockClear();
    spotSource.setData.mockClear();
    applyStormData(map, undefined);
    expect(swathSource.setData).not.toHaveBeenCalled();
    expect(spotSource.setData).not.toHaveBeenCalled();

    // Missing sources are a no-op and do not throw.
    const bare = { getSource: vi.fn(() => undefined) } as unknown as MapLibreMap;
    expect(() => applyStormData(bare, data)).not.toThrow();

    // Only layers that exist are touched.
    setStormVisible(map, false);
    expect(setLayoutProperty).toHaveBeenCalledTimes(2);
    expect(setLayoutProperty).toHaveBeenCalledWith('storm-swath-fill', 'visibility', 'none');
    expect(setLayoutProperty).toHaveBeenCalledWith('storm-spots', 'visibility', 'none');
    setLayoutProperty.mockClear();
    setStormVisible(map, true);
    expect(setLayoutProperty).toHaveBeenCalledWith('storm-swath-fill', 'visibility', 'visible');
    expect(setLayoutProperty).not.toHaveBeenCalledWith('storm-swath-outline', expect.anything(), expect.anything());
  });

  it('documents the size of each hail level', () => {
    expect(HAIL_LEVEL_SIZES_IN).toEqual([0.75, 1.25, 1.75, 2.5, 3]);
  });
});
