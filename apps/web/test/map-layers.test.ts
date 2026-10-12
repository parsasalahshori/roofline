import { describe, expect, it, vi } from 'vitest';
import type { Feature, FeatureCollection, MultiPolygon } from 'geojson';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { tokens } from '@roofline/ui';
import { emptyMapData, HAIL_FILL_OPACITY, installMapLayers, removeMapLayers, updateMapData } from '../src/shell/map/layers.ts';
import type { MapData } from '../src/shell/map/layers.ts';

type Spec = Record<string, unknown>;

/*
 * A hand-made stand-in for the MapLibre style API. It keeps sources and layers in insertion order,
 * throws on duplicates and on a layer whose source is missing, and refuses to remove a source that a
 * layer still uses, as MapLibre does.
 */
function fakeMap() {
  const sources = new Map<string, { spec: Spec; setData: ReturnType<typeof vi.fn> }>();
  const layers = new Map<string, Spec>();
  const style: { glyphs?: string } = {};

  const addSource = vi.fn((id: string, spec: Spec) => {
    if (sources.has(id)) throw new Error(`Source ${id} already exists`);
    sources.set(id, { spec, setData: vi.fn() });
  });
  const addLayer = vi.fn((spec: Spec) => {
    const id = String(spec.id);
    if (layers.has(id)) throw new Error(`Layer ${id} already exists`);
    if (spec.source !== undefined && !sources.has(String(spec.source))) {
      throw new Error(`Layer ${id} needs missing source ${String(spec.source)}`);
    }
    layers.set(id, spec);
  });
  const removeLayer = vi.fn((id: string) => {
    layers.delete(id);
  });
  const removeSource = vi.fn((id: string) => {
    for (const layer of layers.values()) {
      if (layer.source === id) throw new Error(`Source ${id} is still used by a layer`);
    }
    sources.delete(id);
  });

  const map = {
    getStyle: () => style,
    getSource: (id: string) => sources.get(id),
    getLayer: (id: string) => layers.get(id),
    addSource,
    addLayer,
    removeLayer,
    removeSource,
  };

  return {
    map: map as unknown as MapLibreMap,
    sources,
    layers,
    style,
    addSource,
    addLayer,
    removeLayer,
    removeSource,
  };
}

function layerSpec(fake: ReturnType<typeof fakeMap>, id: string): Spec {
  const spec = fake.layers.get(id);
  if (!spec) throw new Error(`Layer ${id} is missing`);
  return spec;
}

function sourceSpec(fake: ReturnType<typeof fakeMap>, id: string): Spec {
  const source = fake.sources.get(id);
  if (!source) throw new Error(`Source ${id} is missing`);
  return source.spec;
}

function collection(features: Feature[]): FeatureCollection {
  return { type: 'FeatureCollection', features };
}

function pin(id: string, kind: 'customer' | 'job', lng: number, lat: number): Feature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    properties: { kind, id, name: `Name ${id}`, addressLine: `${id} Oak St` },
  };
}

const AREA: MultiPolygon = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [-97, 32],
        [-96, 32],
        [-96, 33],
        [-97, 32],
      ],
    ],
  ],
};

const BASE_SOURCES = ['storm-swath', 'storm-spots', 'service-area', 'clusters', 'customers', 'jobs'];
const BASE_LAYERS = [
  'storm-swath-fill',
  'storm-swath-outline',
  'storm-spots',
  'service-area',
  'clusters',
  'customers-clusters',
  'jobs-clusters',
  'customers',
  'customers-hit',
  'jobs',
  'jobs-hit',
];
const COUNT_LAYERS = ['clusters-count', 'customers-clusters-count', 'jobs-clusters-count'];

function sampleData(overrides: Partial<MapData> = {}): MapData {
  return {
    ...emptyMapData(),
    serviceArea: AREA,
    customers: collection([pin('c1', 'customer', -96.8, 32.9)]),
    jobs: collection([pin('j1', 'job', -96.7, 32.8)]),
    clusters: collection([
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-96.6, 32.7] },
        properties: { kind: 'cluster', layer: 'customers', count: 12 },
      },
    ]),
    ...overrides,
  };
}

describe('emptyMapData', () => {
  it('starts with no features, no service area and no client clustering', () => {
    const data = emptyMapData();
    expect(data).toEqual({
      serviceArea: null,
      customers: { type: 'FeatureCollection', features: [] },
      jobs: { type: 'FeatureCollection', features: [] },
      clusters: { type: 'FeatureCollection', features: [] },
      clustering: false,
    });
  });
});

describe('installMapLayers', () => {
  it('adds the six sources and the eleven layers in order, with no count labels when the style has no glyphs', () => {
    const fake = fakeMap();
    installMapLayers(fake.map, sampleData());

    expect([...fake.sources.keys()]).toEqual(BASE_SOURCES);
    expect([...fake.layers.keys()]).toEqual(BASE_LAYERS);
    for (const id of COUNT_LAYERS) expect(fake.layers.has(id)).toBe(false);
  });

  it('leaves the customers and jobs sources unclustered when clustering is off', () => {
    const fake = fakeMap();
    installMapLayers(fake.map, sampleData({ clustering: false }));

    for (const id of ['customers', 'jobs']) {
      expect(sourceSpec(fake, id)).not.toHaveProperty('cluster');
      expect(sourceSpec(fake, id)).not.toHaveProperty('clusterRadius');
    }
  });

  it('clusters the customers and jobs sources in the browser when clustering is on', () => {
    const fake = fakeMap();
    installMapLayers(fake.map, sampleData({ clustering: true }));

    for (const id of ['customers', 'jobs']) {
      expect(sourceSpec(fake, id)).toMatchObject({ type: 'geojson', cluster: true, clusterRadius: 40 });
    }
  });

  it('starts the storm swath source empty and draws it with a fill layer', () => {
    const fake = fakeMap();
    installMapLayers(fake.map, sampleData());

    expect(sourceSpec(fake, 'storm-swath')).toEqual({ type: 'geojson', data: collection([]) });
    expect(layerSpec(fake, 'storm-swath-fill')).toMatchObject({
      type: 'fill',
      source: 'storm-swath',
      paint: { 'fill-color': expect.arrayContaining(['step', tokens['hail-3']]), 'fill-opacity': HAIL_FILL_OPACITY },
    });
  });

  it('draws the service area as a line, holding one feature for a MultiPolygon and none for null', () => {
    const withArea = fakeMap();
    installMapLayers(withArea.map, sampleData({ serviceArea: AREA }));

    expect(layerSpec(withArea, 'service-area')).toMatchObject({
      type: 'line',
      source: 'service-area',
      paint: { 'line-color': tokens.text, 'line-opacity': 0.5, 'line-width': 2 },
    });
    expect(sourceSpec(withArea, 'service-area')).toEqual({
      type: 'geojson',
      data: collection([{ type: 'Feature', geometry: AREA, properties: {} }]),
    });

    const withoutArea = fakeMap();
    installMapLayers(withoutArea.map, sampleData({ serviceArea: null }));
    expect(sourceSpec(withoutArea, 'service-area')).toEqual({ type: 'geojson', data: collection([]) });
  });

  it('paints single customers with the customer token and single jobs by stage', () => {
    const fake = fakeMap();
    installMapLayers(fake.map, sampleData());

    expect(layerSpec(fake, 'customers')).toMatchObject({
      type: 'circle',
      source: 'customers',
      filter: ['!', ['has', 'point_count']],
      paint: { 'circle-color': tokens['pin-customer'], 'circle-radius': 7 },
    });

    const jobs = layerSpec(fake, 'jobs');
    expect(jobs).toMatchObject({ type: 'circle', source: 'jobs', filter: ['!', ['has', 'point_count']] });
    expect(jobs.paint).toMatchObject({ 'circle-radius': 7 });
    const color = (jobs.paint as Record<string, unknown>)['circle-color'];
    expect(color).toEqual([
      'match',
      ['get', 'stage'],
      'lead',
      tokens['stage-lead'],
      'inspection',
      tokens['stage-inspection'],
      'proposal',
      tokens['stage-proposal'],
      'won',
      tokens['stage-won'],
      'installed',
      tokens['stage-won'],
      'lost',
      tokens.text,
      tokens['stage-lead'],
    ]);
  });

  it('adds the three count labels only when the style has glyphs', () => {
    const fake = fakeMap();
    fake.style.glyphs = 'https://example.com/{fontstack}/{range}.pbf';
    installMapLayers(fake.map, sampleData());

    expect([...fake.layers.keys()]).toEqual([
      'storm-swath-fill',
      'storm-swath-outline',
      'storm-spots',
      'service-area',
      'clusters',
      'clusters-count',
      'customers-clusters',
      'jobs-clusters',
      'customers',
      'customers-hit',
      'jobs',
      'jobs-hit',
      'customers-clusters-count',
      'jobs-clusters-count',
    ]);
    expect(layerSpec(fake, 'clusters-count')).toMatchObject({
      type: 'symbol',
      source: 'clusters',
      layout: { 'text-field': ['to-string', ['get', 'count']], 'text-size': 14 },
    });
    expect(layerSpec(fake, 'customers-clusters-count')).toMatchObject({
      type: 'symbol',
      source: 'customers',
      filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'] },
    });
    expect(layerSpec(fake, 'jobs-clusters-count')).toMatchObject({
      type: 'symbol',
      source: 'jobs',
      filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'] },
    });
  });

  it('can run twice without throwing or adding anything the second time', () => {
    const fake = fakeMap();
    const data = sampleData();
    installMapLayers(fake.map, data);
    const sourcesAdded = fake.addSource.mock.calls.length;
    const layersAdded = fake.addLayer.mock.calls.length;

    expect(() => installMapLayers(fake.map, data)).not.toThrow();
    expect(fake.addSource).toHaveBeenCalledTimes(sourcesAdded);
    expect(fake.addLayer).toHaveBeenCalledTimes(layersAdded);
    expect([...fake.layers.keys()]).toEqual(BASE_LAYERS);
  });
});

describe('updateMapData', () => {
  it('feeds new data to the service area, cluster, customer and job sources and leaves the storm swath alone', () => {
    const fake = fakeMap();
    installMapLayers(fake.map, sampleData({ clustering: false }));
    const before = {
      sources: fake.addSource.mock.calls.length,
      layers: fake.addLayer.mock.calls.length,
      removedLayers: fake.removeLayer.mock.calls.length,
      removedSources: fake.removeSource.mock.calls.length,
    };
    const stormSwath = fake.sources.get('storm-swath');

    const next = sampleData({
      clustering: false,
      serviceArea: null,
      customers: collection([pin('c2', 'customer', -96.1, 32.1)]),
      jobs: collection([pin('j2', 'job', -96.2, 32.2)]),
    });
    updateMapData(fake.map, next);

    expect(fake.sources.get('service-area')?.setData).toHaveBeenCalledWith(collection([]));
    expect(fake.sources.get('clusters')?.setData).toHaveBeenCalledWith(next.clusters);
    expect(fake.sources.get('customers')?.setData).toHaveBeenCalledWith(next.customers);
    expect(fake.sources.get('jobs')?.setData).toHaveBeenCalledWith(next.jobs);
    expect(stormSwath?.setData).not.toHaveBeenCalled();

    expect(fake.addSource).toHaveBeenCalledTimes(before.sources);
    expect(fake.addLayer).toHaveBeenCalledTimes(before.layers);
    expect(fake.removeLayer).toHaveBeenCalledTimes(before.removedLayers);
    expect(fake.removeSource).toHaveBeenCalledTimes(before.removedSources);
  });

  it('rebuilds only the customer and job sources and layers when clustering turns on', () => {
    const fake = fakeMap();
    installMapLayers(fake.map, sampleData({ clustering: false }));
    const stormSwath = fake.sources.get('storm-swath');
    const serviceArea = fake.sources.get('service-area');

    const next = sampleData({
      clustering: true,
      customers: collection([pin('c3', 'customer', -96.3, 32.3)]),
      jobs: collection([pin('j3', 'job', -96.4, 32.4)]),
    });
    updateMapData(fake.map, next);

    expect(fake.removeLayer.mock.calls.map((call) => call[0])).toEqual([
      'customers-clusters',
      'jobs-clusters',
      'customers',
      'customers-hit',
      'jobs',
      'jobs-hit',
    ]);
    expect(fake.removeSource.mock.calls.map((call) => call[0])).toEqual(['customers', 'jobs']);

    expect(sourceSpec(fake, 'customers')).toMatchObject({
      type: 'geojson',
      data: next.customers,
      cluster: true,
      clusterRadius: 40,
    });
    expect(sourceSpec(fake, 'jobs')).toMatchObject({
      type: 'geojson',
      data: next.jobs,
      cluster: true,
      clusterRadius: 40,
    });
    expect([...fake.layers.keys()]).toEqual(BASE_LAYERS);
    expect(fake.sources.get('storm-swath')).toBe(stormSwath);
    expect(fake.sources.get('service-area')).toBe(serviceArea);
  });

  it('after a clustering flip, later updates with the same flag only call setData', () => {
    const fake = fakeMap();
    installMapLayers(fake.map, sampleData({ clustering: false }));
    updateMapData(fake.map, sampleData({ clustering: true }));

    const addedSources = fake.addSource.mock.calls.length;
    const addedLayers = fake.addLayer.mock.calls.length;
    const removedLayers = fake.removeLayer.mock.calls.length;
    const removedSources = fake.removeSource.mock.calls.length;

    const next = sampleData({
      clustering: true,
      customers: collection([pin('c4', 'customer', -96.5, 32.5)]),
      jobs: collection([]),
    });
    updateMapData(fake.map, next);

    expect(fake.sources.get('customers')?.setData).toHaveBeenCalledWith(next.customers);
    expect(fake.sources.get('jobs')?.setData).toHaveBeenCalledWith(next.jobs);
    expect(fake.addSource).toHaveBeenCalledTimes(addedSources);
    expect(fake.addLayer).toHaveBeenCalledTimes(addedLayers);
    expect(fake.removeLayer).toHaveBeenCalledTimes(removedLayers);
    expect(fake.removeSource).toHaveBeenCalledTimes(removedSources);
  });

  it('does nothing before anything is installed', () => {
    const fake = fakeMap();
    updateMapData(fake.map, sampleData({ clustering: true }));

    expect(fake.addSource).not.toHaveBeenCalled();
    expect(fake.addLayer).not.toHaveBeenCalled();
    expect(fake.removeLayer).not.toHaveBeenCalled();
    expect(fake.removeSource).not.toHaveBeenCalled();
    expect(fake.sources.size).toBe(0);
    expect(fake.layers.size).toBe(0);
  });
});

describe('removeMapLayers', () => {
  it('removes every layer and source this module added, and a later install works again', () => {
    const fake = fakeMap();
    fake.style.glyphs = 'https://example.com/{fontstack}/{range}.pbf';
    installMapLayers(fake.map, sampleData({ clustering: true }));
    expect(fake.layers.size).toBe(14);
    expect(fake.sources.size).toBe(6);

    removeMapLayers(fake.map);
    expect(fake.layers.size).toBe(0);
    expect(fake.sources.size).toBe(0);

    installMapLayers(fake.map, sampleData({ clustering: false }));
    expect(fake.layers.size).toBe(14);
    expect(fake.sources.size).toBe(6);
    expect(sourceSpec(fake, 'customers')).not.toHaveProperty('cluster');
  });

  it('does not throw when nothing was installed', () => {
    const fake = fakeMap();
    expect(() => removeMapLayers(fake.map)).not.toThrow();
    expect(fake.removeLayer).not.toHaveBeenCalled();
    expect(fake.removeSource).not.toHaveBeenCalled();
  });
});
