import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { legal } from '../src/copy/legal.ts';
import { mapCopy } from '../src/copy/map.ts';
import { MapView } from '../src/shell/map/MapView.tsx';
import { ROOF } from '../src/shell/map/roofLayer.ts';

/*
 * A stand-in for MapLibre's Map. jsdom has no WebGL, so the real map cannot run here. The fake
 * records every source and layer the app adds, answers the calls the app makes, and lets a test
 * emit the events a real map would (style.load, load, moveend, error, click on a layer).
 */
const fake = vi.hoisted(() => {
  type Handler = (payload?: unknown) => void;
  type Listener = { type: string; layer: string | undefined; fn: Handler };
  type FakeSource = {
    spec: Record<string, unknown>;
    setData: ReturnType<typeof vi.fn>;
    getClusterExpansionZoom: ReturnType<typeof vi.fn>;
  };
  type FakeLayer = Record<string, unknown> & { id: string };

  class FakeMap {
    static instances: FakeMap[] = [];
    /** True: the next new FakeMap throws, as MapLibre does when the browser has no WebGL. */
    static failToCreate = false;
    /** The box getBounds() answers with. A test changes it to make the next moveend ask for a new box. */
    static bounds = { west: -97.123456, south: 32.5, east: -96.4, north: 33.1 };
    /** What getZoom() answers. */
    static zoom = 10;
    readonly options: Record<string, unknown>;
    private sources = new Map<string, FakeSource>();
    private layers = new Map<string, FakeLayer>();
    private listeners: Listener[] = [];
    /** What queryRenderedFeatures answers (the features under a click). */
    rendered: unknown[] = [];
    queryRenderedFeatures = vi.fn(() => this.rendered);
    project = ([lng, lat]: [number, number]) => ({ x: lng, y: lat });

    constructor(options: Record<string, unknown>) {
      if (FakeMap.failToCreate) throw new Error('Failed to initialize WebGL');
      this.options = options;
      FakeMap.instances.push(this);
    }

    addSource = vi.fn((id: string, spec: Record<string, unknown>) => {
      if (this.sources.has(id)) throw new Error(`There is already a source with this ID: ${id}`);
      this.sources.set(id, {
        spec,
        setData: vi.fn(),
        getClusterExpansionZoom: vi.fn().mockResolvedValue(12),
      });
    });

    removeSource(id: string): void {
      if (!this.sources.has(id)) throw new Error(`There is no source with this ID: ${id}`);
      this.sources.delete(id);
    }

    getSource(id: string): FakeSource | undefined {
      return this.sources.get(id);
    }

    addLayer = vi.fn((spec: FakeLayer) => {
      if (this.layers.has(spec.id)) throw new Error(`Layer with id ${spec.id} already exists on this map`);
      this.layers.set(spec.id, spec);
    });

    removeLayer(id: string): void {
      this.layers.delete(id);
    }

    getLayer(id: string): FakeLayer | undefined {
      return this.layers.get(id);
    }

    // No glyphs: the blank and the hosted styles this fake stands for have none, so count labels stay off.
    getStyle = vi.fn(() => ({}));

    // A real swap drops every source and layer the app added; the app adds them back on style.load.
    setStyle = vi.fn(() => {
      this.sources.clear();
      this.layers.clear();
    });

    fitBounds = vi.fn();
    easeTo = vi.fn();
    addControl = vi.fn();
    remove = vi.fn();

    getZoom(): number {
      return FakeMap.zoom;
    }

    getBounds() {
      const { west, south, east, north } = FakeMap.bounds;
      return {
        getWest: () => west,
        getSouth: () => south,
        getEast: () => east,
        getNorth: () => north,
      };
    }

    getCanvas() {
      return { style: { cursor: '' } };
    }

    /** Two forms, as in MapLibre: (type, listener) for every event of that type, and (type, layerId, listener) for one layer. */
    on(type: string, layerOrListener: unknown, listener?: unknown): void {
      if (typeof layerOrListener === 'string') {
        this.listeners.push({ type, layer: layerOrListener, fn: listener as Handler });
      } else {
        this.listeners.push({ type, layer: undefined, fn: layerOrListener as Handler });
      }
    }

    off(type: string, layerOrListener: unknown, listener?: unknown): void {
      const layer = typeof layerOrListener === 'string' ? layerOrListener : undefined;
      const fn = typeof layerOrListener === 'string' ? listener : layerOrListener;
      this.listeners = this.listeners.filter((entry) => !(entry.type === type && entry.layer === layer && entry.fn === fn));
    }

    /** Calls the listeners for an event. emit('click', 'jobs', event) reaches only the listeners on that layer. */
    emit(type: string, layerOrPayload?: unknown, payload?: unknown): void {
      const layer = typeof layerOrPayload === 'string' ? layerOrPayload : undefined;
      const value = typeof layerOrPayload === 'string' ? payload : layerOrPayload;
      for (const entry of [...this.listeners]) {
        if (entry.type !== type) continue;
        if (entry.layer !== undefined && entry.layer !== layer) continue;
        entry.fn(value);
      }
    }
  }

  class FakeNavigationControl {
    readonly options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
    }
  }

  return { FakeMap, FakeNavigationControl };
});

vi.mock('maplibre-gl', () => ({
  Map: fake.FakeMap,
  NavigationControl: fake.FakeNavigationControl,
}));

let requests: { url: string; method: string; body: unknown }[];
let unexpected: string[];
/** What /api/map/building-at answers: a building, or null for the 404. */
let building: Record<string, unknown> | null;
/** When set, /api/map/building-at answers only once this resolves (an area whose outlines are loading). */
let buildingGate: Promise<void> | null;

const POLYGON = {
  type: 'Polygon',
  coordinates: [[[-96.8, 32.9], [-96.7999, 32.9], [-96.7999, 32.9001], [-96.8, 32.9001], [-96.8, 32.9]]],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function lastMap() {
  const map = fake.FakeMap.instances.at(-1);
  if (!map) throw new Error('MapView did not create a map');
  return map;
}

function renderMap(onEstimate?: (measurementId: string) => void) {
  return render(
    <Providers client={createQueryClient()}>
      <MapView onOpen={vi.fn()} onEstimate={onEstimate} />
    </Providers>,
  );
}

/** A click on the map where no pin or cluster is. */
function clickEmpty(map: ReturnType<typeof lastMap>) {
  map.rendered = [];
  map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: -96.79995, lat: 32.90005 } });
}

beforeEach(() => {
  requests = [];
  unexpected = [];
  building = { footprintId: 'fp-1', polygon: POLYGON, centroid: [-96.79995, 32.90005] };
  buildingGate = null;
  fake.FakeMap.zoom = 10;
  fake.FakeMap.bounds = { west: -97.123456, south: 32.5, east: -96.4, north: 33.1 };
  vi.stubEnv('VITE_MAPTILER_KEY', '');
  vi.stubEnv('VITE_MAP_TILES', '');
  fake.FakeMap.instances.length = 0;
  fake.FakeMap.failToCreate = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url === '/api/map/area') return json({ serviceArea: null, bounds: null });
      if (url.startsWith('/api/map/pins?')) return json({ mode: 'points', customers: [], jobs: [] });
      if (url.startsWith('/api/map/storm-layer?')) return json({ swaths: { type: 'FeatureCollection', features: [] }, spots: { type: 'FeatureCollection', features: [] }, newestRunAt: null, stale: false });
      if (url.startsWith('/api/map/building-at?')) {
        if (buildingGate !== null) await buildingGate;
        return building ? json(building) : json({ error: 'no_building' }, 404);
      }
      if (url === '/api/estimator/from-footprint' && method === 'POST') return json({ measurementId: 'm-42' });
      if (url === '/api/estimator/from-point' && method === 'POST') return json({ measurementId: 'm-77' });
      if (url.startsWith('/api/map/load-buildings?') && method === 'POST') return json({ tiles: 1 }, 202);
      unexpected.push(url);
      return json({ error: 'Unexpected request' }, 500);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  expect(unexpected).toEqual([]);
});

const buildingRequests = () => requests.filter((r) => r.url.startsWith('/api/map/building-at?'));

describe('Estimate this roof (map)', () => {
  it('a click on an empty spot shows the roof card for the building there', async () => {
    renderMap(vi.fn());
    const map = lastMap();
    map.emit('style.load');
    clickEmpty(map);

    expect(await screen.findByRole('heading', { name: mapCopy.roofTitle })).toBeVisible();
    expect(screen.getByText(mapCopy.roofHint)).toBeVisible();
    expect(screen.getByRole('button', { name: mapCopy.estimateRoof })).toBeEnabled();
    expect(buildingRequests().map((r) => r.url)).toEqual(['/api/map/building-at?lat=32.90005&lng=-96.79995']);
  });

  it('highlights the building outline', async () => {
    renderMap(vi.fn());
    const map = lastMap();
    map.emit('style.load');
    clickEmpty(map);

    await screen.findByRole('heading', { name: mapCopy.roofTitle });
    const source = map.getSource(ROOF.source);
    expect(source).toBeDefined();
    const data = source!.spec.data as { features: { geometry: unknown }[] };
    expect(data.features[0]!.geometry).toEqual(POLYGON);
    expect(map.getLayer(ROOF.fill)).toBeDefined();
    expect(map.getLayer(ROOF.line)).toBeDefined();
  });

  it('a click where there is no building shows a quiet toast and no card', async () => {
    building = null;
    renderMap(vi.fn());
    const map = lastMap();
    map.emit('style.load');
    clickEmpty(map);

    expect(await screen.findByText(mapCopy.noBuilding)).toBeVisible();
    expect(screen.queryByRole('heading', { name: mapCopy.roofTitle })).toBeNull();
    expect(map.getSource(ROOF.source)).toBeUndefined();
  });

  it('without the estimate permission (no onEstimate: reps) a click never looks for a roof', async () => {
    renderMap(undefined);
    const map = lastMap();
    map.emit('style.load');
    clickEmpty(map);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(buildingRequests()).toEqual([]);
    expect(screen.queryByRole('heading', { name: mapCopy.roofTitle })).toBeNull();
  });

  it('Estimate this roof starts a measurement from the outline and opens the measure window', async () => {
    const onEstimate = vi.fn();
    renderMap(onEstimate);
    const map = lastMap();
    map.emit('style.load');
    clickEmpty(map);

    await userEvent.click(await screen.findByRole('button', { name: mapCopy.estimateRoof }));

    await waitFor(() => expect(onEstimate).toHaveBeenCalledWith('m-42'));
    const post = requests.find((r) => r.url === '/api/estimator/from-footprint');
    expect(post).toMatchObject({ method: 'POST', body: { footprintId: 'fp-1', lat: 32.90005, lng: -96.79995 } });
    // The card closes and the highlight clears once the measure window is opening.
    await waitFor(() => expect(screen.queryByRole('heading', { name: mapCopy.roofTitle })).toBeNull());
  });

  it('a click on a pin still opens the pin, not a roof', async () => {
    renderMap(vi.fn());
    const map = lastMap();
    map.emit('style.load');
    map.rendered = [
      {
        geometry: { type: 'Point', coordinates: [10, 20] },
        properties: { kind: 'customer', id: 'c1', name: 'Nina Park', addressLine: '1 Elm St' },
      },
    ];
    map.emit('click', { point: { x: 10, y: 20 }, lngLat: { lng: 10, lat: 20 } });

    expect(await screen.findByRole('heading', { name: 'Nina Park' })).toBeVisible();
    expect(buildingRequests()).toEqual([]);
  });
});

describe('roofs anywhere on the map', () => {
  it("Google Solar's roof (no footprint) says so, and Estimate this roof starts from the clicked point", async () => {
    building = { footprintId: null, source: 'solar', polygon: POLYGON, centroid: { lat: 32.90005, lng: -96.79995 } };
    const onEstimate = vi.fn();
    renderMap(onEstimate);
    const map = lastMap();
    map.emit('style.load');
    clickEmpty(map);

    expect(await screen.findByText(legal.solarOutlineAttribution)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: mapCopy.estimateRoof }));

    await waitFor(() => expect(onEstimate).toHaveBeenCalledWith('m-77'));
    expect(requests.find((r) => r.url === '/api/estimator/from-point')).toMatchObject({ method: 'POST', body: { lat: 32.90005, lng: -96.79995 } });
    expect(requests.find((r) => r.url === '/api/estimator/from-footprint')).toBeUndefined();
  });

  it('a click that waits on a new area says it is finding the outline, then opens the roof', async () => {
    let open: () => void = () => undefined;
    buildingGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    renderMap(vi.fn());
    const map = lastMap();
    map.emit('style.load');
    clickEmpty(map);

    expect(await screen.findByText(mapCopy.findingRoof, {}, { timeout: 4000 })).toBeVisible();
    open();
    expect(await screen.findByRole('heading', { name: mapCopy.roofTitle })).toBeVisible();
    expect(screen.queryByText(mapCopy.findingRoof)).toBeNull();
  });

  it('zoomed in to building level, the outlines of the area in view start loading, once per area', async () => {
    fake.FakeMap.zoom = 16;
    fake.FakeMap.bounds = { west: -96.802, south: 32.899, east: -96.798, north: 32.901 };
    renderMap(vi.fn());
    const map = lastMap();
    map.emit('style.load');
    map.emit('load');

    await waitFor(() => expect(requests.filter((r) => r.url.startsWith('/api/map/load-buildings?'))).toHaveLength(1));
    expect(requests.find((r) => r.url.startsWith('/api/map/load-buildings?'))).toMatchObject({
      method: 'POST',
      url: '/api/map/load-buildings?bbox=-96.802,32.899,-96.798,32.901',
    });
    // A small pan inside the same area asks for nothing more.
    fake.FakeMap.bounds = { west: -96.803, south: 32.899, east: -96.799, north: 32.901 };
    map.emit('moveend');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(requests.filter((r) => r.url.startsWith('/api/map/load-buildings?'))).toHaveLength(1);
  });

  it('zoomed out, or for a rep, nothing is loaded', async () => {
    renderMap(vi.fn());
    const map = lastMap();
    map.emit('style.load');
    map.emit('load');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(requests.filter((r) => r.url.startsWith('/api/map/load-buildings?'))).toEqual([]);
    cleanup();

    fake.FakeMap.zoom = 16;
    fake.FakeMap.bounds = { west: -96.802, south: 32.899, east: -96.798, north: 32.901 };
    renderMap(undefined);
    const rep = lastMap();
    rep.emit('style.load');
    rep.emit('load');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(requests.filter((r) => r.url.startsWith('/api/map/load-buildings?'))).toEqual([]);
  });
});
