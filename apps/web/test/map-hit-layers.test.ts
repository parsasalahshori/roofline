import { describe, expect, it, vi } from 'vitest';
import type { Feature, FeatureCollection, MultiPolygon } from 'geojson';
import type { Map as MapLibreMap, MapGeoJSONFeature } from 'maplibre-gl';
import { tokens } from '@roofline/ui';
import { bindMapInteractions, nearestFeature } from '../src/shell/map/interactions.ts';
import { emptyMapData, installMapLayers, removeMapLayers, updateMapData } from '../src/shell/map/layers.ts';
import type { MapData } from '../src/shell/map/layers.ts';
import type { PickedPin } from '../src/shell/map/types.ts';

type Spec = Record<string, unknown>;

/*
 * A stand-in for the MapLibre style API, as in map-layers.test.ts: sources and layers kept in insertion
 * order, duplicates and orphaned layers refused.
 */
function fakeLayersMap() {
  const sources = new Map<string, { spec: Spec }>();
  const layers = new Map<string, Spec>();
  const style: { glyphs?: string } = {};

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
  const addSource = vi.fn((id: string, spec: Spec) => {
    if (sources.has(id)) throw new Error(`Source ${id} already exists`);
    sources.set(id, { spec });
  });

  const map = {
    getStyle: () => style,
    getSource: (id: string) => (sources.has(id) ? { setData: vi.fn() } : undefined),
    getLayer: (id: string) => layers.get(id),
    addSource,
    addLayer,
    removeLayer,
    removeSource,
  };

  return { map: map as unknown as MapLibreMap, sources, layers, style, addLayer, removeLayer, removeSource };
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

function sampleData(overrides: Partial<MapData> = {}): MapData {
  return {
    ...emptyMapData(),
    serviceArea: AREA,
    customers: collection([pin('c1', 'customer', -96.8, 32.9)]),
    jobs: collection([pin('j1', 'job', -96.7, 32.8)]),
    clusters: collection([]),
    ...overrides,
  };
}

function layerIds(fake: ReturnType<typeof fakeLayersMap>): string[] {
  return [...fake.layers.keys()];
}

describe('hit layers in installMapLayers', () => {
  it('adds customers-hit and jobs-hit as 40px transparent circles on the same sources and filters', () => {
    const fake = fakeLayersMap();
    installMapLayers(fake.map, sampleData());

    expect(fake.layers.get('customers-hit')).toMatchObject({
      type: 'circle',
      source: 'customers',
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-radius': 20,
        'circle-opacity': 0,
        'circle-stroke-opacity': 0,
        'circle-color': tokens['pin-customer'],
      },
    });
    expect(fake.layers.get('jobs-hit')).toMatchObject({
      type: 'circle',
      source: 'jobs',
      filter: ['!', ['has', 'point_count']],
      paint: { 'circle-radius': 20, 'circle-opacity': 0, 'circle-stroke-opacity': 0 },
    });
  });

  it('adds each hit layer right after its visible pin layer, in add order', () => {
    const fake = fakeLayersMap();
    installMapLayers(fake.map, sampleData());

    const added = fake.addLayer.mock.calls.map((call) => String(call[0].id));
    expect(added.indexOf('customers-hit')).toBe(added.indexOf('customers') + 1);
    expect(added.indexOf('jobs-hit')).toBe(added.indexOf('jobs') + 1);

    const keys = layerIds(fake);
    expect(keys.indexOf('customers-hit')).toBe(keys.indexOf('customers') + 1);
    expect(keys.indexOf('jobs-hit')).toBe(keys.indexOf('jobs') + 1);
  });

  it('keeps the hit layers on the clustered sources too, filtered to single pins', () => {
    const fake = fakeLayersMap();
    installMapLayers(fake.map, sampleData({ clustering: true }));

    expect(fake.layers.get('customers-hit')).toMatchObject({ source: 'customers', filter: ['!', ['has', 'point_count']] });
    expect(fake.layers.get('jobs-hit')).toMatchObject({ source: 'jobs', filter: ['!', ['has', 'point_count']] });
  });
});

describe('hit layers in removeMapLayers', () => {
  it('removes both hit layers with the rest of the map', () => {
    const fake = fakeLayersMap();
    installMapLayers(fake.map, sampleData());
    expect(fake.layers.has('customers-hit')).toBe(true);
    expect(fake.layers.has('jobs-hit')).toBe(true);

    removeMapLayers(fake.map);

    expect(fake.removeLayer.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining(['customers-hit', 'jobs-hit']));
    expect(fake.layers.has('customers-hit')).toBe(false);
    expect(fake.layers.has('jobs-hit')).toBe(false);
    expect(fake.layers.size).toBe(0);
    expect(fake.sources.size).toBe(0);
  });
});

describe('hit layers across a clustering rebuild', () => {
  it('removes them with the pin group and adds them back after the rebuild', () => {
    const fake = fakeLayersMap();
    installMapLayers(fake.map, sampleData({ clustering: false }));

    updateMapData(fake.map, sampleData({ clustering: true }));

    expect(fake.removeLayer.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining(['customers-hit', 'jobs-hit']),
    );
    expect(fake.layers.has('customers-hit')).toBe(true);
    expect(fake.layers.has('jobs-hit')).toBe(true);

    const keys = layerIds(fake);
    expect(keys.indexOf('customers-hit')).toBe(keys.indexOf('customers') + 1);
    expect(keys.indexOf('jobs-hit')).toBe(keys.indexOf('jobs') + 1);
    expect(fake.layers.get('customers-hit')).toMatchObject({ source: 'customers' });
    expect(fake.layers.get('jobs-hit')).toMatchObject({ source: 'jobs' });
  });
});

describe('nearestFeature', () => {
  /** Identity projection: the coordinates already are the pixels. */
  const identity = (lngLat: [number, number]) => ({ x: lngLat[0], y: lngLat[1] });

  function point(lng: number, lat: number, id: string): MapGeoJSONFeature {
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: { id },
    } as unknown as MapGeoJSONFeature;
  }

  it('returns the feature whose projected point is nearest the click', () => {
    const a = point(0, 0, 'a');
    const b = point(5, 5, 'b');
    expect(nearestFeature([a, b], { x: 4, y: 4 }, identity)).toBe(b);
    expect(nearestFeature([b, a], { x: 0.5, y: 0.5 }, identity)).toBe(a);
  });

  it('returns undefined for an empty list', () => {
    expect(nearestFeature([], { x: 1, y: 1 }, identity)).toBeUndefined();
  });

  it('skips features that are not points', () => {
    const line = {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[4, 4], [4, 4]] },
      properties: {},
    } as unknown as MapGeoJSONFeature;
    const far = point(9, 9, 'far');
    expect(nearestFeature([line, far], { x: 4, y: 4 }, identity)).toBe(far);
    expect(nearestFeature([line], { x: 4, y: 4 }, identity)).toBeUndefined();
  });

  it('lets the first feature win a tie', () => {
    const a = point(1, 0, 'a');
    const b = point(-1, 0, 'b');
    expect(nearestFeature([a, b], { x: 0, y: 0 }, identity)).toBe(a);
  });
});

/*
 * A stand-in for the map's events: the unlayered click listener and the layer listeners are recorded
 * separately, and queryRenderedFeatures returns whatever the test put under the click.
 */
function fakeInteractionMap(existingLayers: string[] = ['customers-hit', 'jobs-hit']) {
  type Handler = (event: unknown) => void;
  const handlers: { type: string; layer: string | undefined; handler: Handler }[] = [];
  const rendered: MapGeoJSONFeature[] = [];

  const on = vi.fn((type: string, layerOrHandler: string | Handler, maybe?: Handler) => {
    if (typeof layerOrHandler === 'function') handlers.push({ type, layer: undefined, handler: layerOrHandler });
    else if (maybe) handlers.push({ type, layer: layerOrHandler, handler: maybe });
  });
  const off = vi.fn((type: string, layerOrHandler: string | Handler, maybe?: Handler) => {
    const layer = typeof layerOrHandler === 'function' ? undefined : layerOrHandler;
    const handler = typeof layerOrHandler === 'function' ? layerOrHandler : maybe;
    const index = handlers.findIndex((entry) => entry.type === type && entry.layer === layer && entry.handler === handler);
    if (index >= 0) handlers.splice(index, 1);
  });
  const queryRenderedFeatures = vi.fn<(point: unknown, options: unknown) => MapGeoJSONFeature[]>(() => rendered);
  const project = vi.fn((lngLat: [number, number]) => ({ x: lngLat[0], y: lngLat[1] }));

  const map = {
    on,
    off,
    getLayer: (id: string) => (existingLayers.includes(id) ? { id } : undefined),
    queryRenderedFeatures,
    project,
    getCanvas: () => ({ style: { cursor: '' } }),
    getSource: () => undefined,
    easeTo: vi.fn(),
    getZoom: () => 10,
  };

  function handlerFor(type: string, layer?: string): Handler {
    const entry = handlers.find((item) => item.type === type && item.layer === layer);
    if (!entry) throw new Error(`No ${type} handler for ${layer ?? 'the map'}`);
    return entry.handler;
  }

  return {
    map: map as unknown as MapLibreMap,
    rendered,
    handlers,
    on,
    off,
    queryRenderedFeatures,
    project,
    handlerFor,
  };
}

function pinFeature(properties: Record<string, unknown>, lng: number, lat: number): MapGeoJSONFeature {
  return {
    type: 'Feature',
    properties,
    geometry: { type: 'Point', coordinates: [lng, lat] },
  } as unknown as MapGeoJSONFeature;
}

const CUSTOMER_NEAR = { kind: 'customer', id: 'cust-near', name: 'Near Customer', addressLine: '1 Near St' };
const JOB_FAR = {
  kind: 'job',
  id: 'job-far',
  name: 'Far Job',
  addressLine: '9 Far Rd',
  stage: 'lead',
  stageLabel: 'Lead',
};

describe('a click on overlapping pin hit layers', () => {
  it('queries both hit layers and calls onPick exactly once with the nearer pin', () => {
    const fake = fakeInteractionMap();
    const onPick = vi.fn<(pin: PickedPin) => void>();
    bindMapInteractions(fake.map, onPick);

    fake.rendered.push(pinFeature(JOB_FAR, 0, 0), pinFeature(CUSTOMER_NEAR, 5, 5));
    const click = fake.handlerFor('click');
    click({ point: { x: 4, y: 4 }, lngLat: { lng: 4, lat: 4 } });

    expect(fake.queryRenderedFeatures).toHaveBeenCalledTimes(1);
    expect(fake.queryRenderedFeatures.mock.calls[0]?.[1]).toEqual({ layers: ['customers-hit', 'jobs-hit'] });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]?.[0]).toMatchObject({ kind: 'customer', id: 'cust-near', lngLat: [5, 5] });
  });

  it('does nothing when no pin is under the click', () => {
    const fake = fakeInteractionMap();
    const onPick = vi.fn<(pin: PickedPin) => void>();
    bindMapInteractions(fake.map, onPick);

    fake.handlerFor('click')({ point: { x: 4, y: 4 }, lngLat: { lng: 4, lat: 4 } });

    expect(onPick).not.toHaveBeenCalled();
  });

  it('does not query at all while the hit layers are absent', () => {
    const fake = fakeInteractionMap([]);
    const onPick = vi.fn<(pin: PickedPin) => void>();
    bindMapInteractions(fake.map, onPick);

    fake.rendered.push(pinFeature(CUSTOMER_NEAR, 5, 5));
    fake.handlerFor('click')({ point: { x: 4, y: 4 }, lngLat: { lng: 4, lat: 4 } });

    expect(fake.queryRenderedFeatures).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('removes the unlayered click listener on unbind', () => {
    const fake = fakeInteractionMap();
    const onPick = vi.fn<(pin: PickedPin) => void>();
    const unbind = bindMapInteractions(fake.map, onPick);
    const click = fake.handlerFor('click');

    unbind();

    expect(fake.handlers.some((entry) => entry.type === 'click' && entry.layer === undefined)).toBe(false);
    expect(fake.off).toHaveBeenCalledWith('click', click);
  });
});
