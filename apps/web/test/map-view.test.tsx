import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { mapCopy } from '../src/copy/map.ts';
import { MapView } from '../src/shell/map/MapView.tsx';

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
      return 10;
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

type Body = Record<string, unknown>;

let areaBody: Body;
let pinsBody: Body;
/** The status /api/map/pins answers with. Anything but 200 answers with an error body. */
let pinsStatus: number;
let requests: string[];
let unexpected: string[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A 'points' answer: `customers` customers and `jobs` jobs, all at one spot. */
function points({ customers, jobs }: { customers: number; jobs: number }): Body {
  return {
    mode: 'points',
    customers: Array.from({ length: customers }, (_, index) => ({
      propertyId: `p${index}`,
      customerId: `c${index}`,
      lng: -96.8,
      lat: 32.9,
      name: `Customer ${index}`,
      addressLine: `${index} Elm St`,
    })),
    jobs: Array.from({ length: jobs }, (_, index) => ({
      jobId: `j${index}`,
      customerId: `c${index}`,
      propertyId: `p${index}`,
      stage: 'proposal',
      stageLabel: 'Proposal',
      lng: -96.8,
      lat: 32.9,
      name: `Job ${index}`,
      addressLine: `${index} Oak St`,
    })),
  };
}

function pinRequests(): string[] {
  return requests.filter((url) => url.startsWith('/api/map/pins?'));
}

function lastMap() {
  const map = fake.FakeMap.instances.at(-1);
  if (!map) throw new Error('MapView did not create a map');
  return map;
}

function renderMap() {
  const onOpen = vi.fn();
  const view = render(
    <Providers client={createQueryClient()}>
      <MapView onOpen={onOpen} />
    </Providers>,
  );
  return { ...view, onOpen };
}

beforeEach(() => {
  areaBody = { serviceArea: null, bounds: null };
  pinsBody = points({ customers: 0, jobs: 0 });
  pinsStatus = 200;
  requests = [];
  unexpected = [];
  vi.stubEnv('VITE_MAPTILER_KEY', '');
  vi.stubEnv('VITE_MAP_TILES', '');
  fake.FakeMap.instances.length = 0;
  fake.FakeMap.failToCreate = false;
  fake.FakeMap.bounds = { west: -97.123456, south: 32.5, east: -96.4, north: 33.1 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === '/api/map/area') return json(areaBody);
      if (url.startsWith('/api/map/pins?')) return pinsStatus === 200 ? json(pinsBody) : json({ error: 'Nope' }, pinsStatus);
      if (url.startsWith('/api/map/storm-layer?')) return json({ swaths: { type: 'FeatureCollection', features: [] }, spots: { type: 'FeatureCollection', features: [] }, newestRunAt: null, stale: false });
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

describe('MapView', () => {
  it('fits the service area', async () => {
    areaBody = { serviceArea: null, bounds: [-97.1, 32.5, -96.4, 33.1] };
    renderMap();
    const map = lastMap();

    await waitFor(() =>
      expect(map.fitBounds).toHaveBeenCalledWith([-97.1, 32.5, -96.4, 33.1], { padding: 40, maxZoom: 14 }),
    );
  });

  it('starts at the US view without bounds', async () => {
    areaBody = { serviceArea: null, bounds: null };
    renderMap();
    const map = lastMap();

    expect(map.options.center).toEqual([-96.5, 39.5]);
    expect(map.options.zoom).toBe(3.5);
    await waitFor(() => expect(requests).toContain('/api/map/area'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(map.fitBounds).not.toHaveBeenCalled();
  });

  it('asks for the storm layer at a whole-number zoom when the map is at 3.5', async () => {
    renderMap();
    const map = lastMap();
    map.getZoom = () => 3.5;
    act(() => {
      map.emit('style.load');
    });
    act(() => {
      map.emit('load');
    });

    await waitFor(() => expect(requests.some((url) => url.startsWith('/api/map/storm-layer?'))).toBe(true));
    const url = requests.find((entry) => entry.startsWith('/api/map/storm-layer?')) ?? '';
    expect(url).toContain('zoom=4');
    expect(url).not.toContain('zoom=3.5');
  });

  it('turns on client clustering above 200 points', async () => {
    pinsBody = points({ customers: 201, jobs: 0 });
    renderMap();
    const map = lastMap();

    act(() => {
      map.emit('style.load');
    });
    act(() => {
      map.emit('load');
    });

    await waitFor(() =>
      expect(map.addSource).toHaveBeenCalledWith('customers', expect.objectContaining({ cluster: true, clusterRadius: 40 })),
    );
  });

  it('shows the banner on a tile error and keeps working', async () => {
    const { container } = renderMap();
    const map = lastMap();

    // The status region is on the page from the start, empty. The banner text is inserted into it when the map fails.
    const region = container.querySelector('[role="status"][data-state]');
    expect(region).toBeInTheDocument();
    expect(region).toHaveAttribute('data-state', 'idle');
    expect(region).toBeEmptyDOMElement();
    expect(screen.queryByText(mapCopy.error)).toBeNull();

    act(() => {
      map.emit('error', { error: new Error('tile failed'), sourceId: 'basemap' });
    });
    act(() => {
      map.emit('error', { error: new Error('tile failed'), sourceId: 'basemap' });
    });

    expect(container.querySelector('[role="status"][data-state]')).toBe(region);
    expect(region).toHaveAttribute('data-state', 'error');
    expect(region).toHaveTextContent(mapCopy.error);
    expect(screen.getByText(mapCopy.error)).toBeVisible();
    expect(screen.getAllByText(mapCopy.error)).toHaveLength(1);

    pinsBody = points({ customers: 3, jobs: 1 });
    act(() => {
      map.emit('style.load');
    });
    act(() => {
      map.emit('moveend');
    });

    expect(await screen.findByText('Map showing 3 customers and 1 open job.')).toBeInTheDocument();
  });

  it('summarizes what is on the map', async () => {
    pinsBody = points({ customers: 70, jobs: 25 });
    renderMap();
    const map = lastMap();

    act(() => {
      map.emit('style.load');
    });
    act(() => {
      map.emit('load');
    });

    expect(await screen.findByText('Map showing 70 customers and 25 open jobs.')).toBeInTheDocument();
  });

  it('summarizes and draws server clusters', async () => {
    pinsBody = {
      mode: 'clusters',
      clusters: [
        { layer: 'customers', lng: -96.8, lat: 32.9, count: 120 },
        { layer: 'jobs', lng: -96.7, lat: 32.8, count: 30 },
      ],
      total: 150,
    };
    renderMap();
    const map = lastMap();

    act(() => {
      map.emit('style.load');
    });
    act(() => {
      map.emit('load');
    });

    expect(await screen.findByText(mapCopy.summaryClusters(150))).toBeInTheDocument();
    await waitFor(() =>
      expect(map.getSource('clusters')?.setData).toHaveBeenLastCalledWith(
        expect.objectContaining({
          features: expect.arrayContaining([
            expect.objectContaining({ properties: expect.objectContaining({ count: 120 }) }),
          ]),
        }),
      ),
    );
    expect(map.getSource('customers')?.spec).not.toHaveProperty('cluster');
  });

  it('keeps the last pins on the map when a pins request fails', async () => {
    pinsBody = points({ customers: 3, jobs: 1 });
    renderMap();
    const map = lastMap();

    act(() => {
      map.emit('style.load');
    });
    act(() => {
      map.emit('load');
    });
    expect(await screen.findByText('Map showing 3 customers and 1 open job.')).toBeInTheDocument();
    const customers = map.getSource('customers');
    const jobs = map.getSource('jobs');
    if (!customers || !jobs) throw new Error('The pin sources were not added');
    customers.setData.mockClear();
    jobs.setData.mockClear();

    // The person pans; the next box is refused (a 4xx is not asked again).
    fake.FakeMap.bounds = { west: -97.5, south: 32.5, east: -96.4, north: 33.1 };
    pinsStatus = 400;
    act(() => {
      map.emit('moveend');
    });

    await waitFor(() => expect(pinRequests()).toHaveLength(2));
    expect((await screen.findByText(mapCopy.error)).closest('[role="status"][data-state="error"]')).not.toBeNull();
    expect(screen.getByText('Map showing 3 customers and 1 open job.')).toBeInTheDocument();
    expect(customers.setData).not.toHaveBeenCalledWith(expect.objectContaining({ features: [] }));
    expect(jobs.setData).not.toHaveBeenCalledWith(expect.objectContaining({ features: [] }));
  });

  it('opens the pin card and Open calls onOpen', async () => {
    const user = userEvent.setup();
    const { onOpen } = renderMap();
    const map = lastMap();

    act(() => {
      map.emit('style.load');
    });
    map.rendered = [
      {
        properties: {
          kind: 'job',
          id: 'job-1',
          name: 'Ada Lovelace',
          addressLine: '12 Oak St',
          stage: 'proposal',
          stageLabel: 'Proposal',
        },
        geometry: { type: 'Point', coordinates: [-96.8, 32.9] },
      },
    ];
    act(() => {
      map.emit('click', { point: { x: -96.8, y: 32.9 }, lngLat: { lng: -96.8, lat: 32.9 } });
    });

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Proposal')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: mapCopy.open }));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith({ kind: 'job', id: 'job-1' });
    expect(screen.queryByText('Ada Lovelace')).toBeNull();
  });

  it('asks for the visible area once after a burst of moves', async () => {
    pinsBody = points({ customers: 1, jobs: 0 });
    renderMap();
    const map = lastMap();

    act(() => {
      map.emit('load');
    });
    act(() => {
      map.emit('moveend');
    });
    act(() => {
      map.emit('moveend');
    });
    act(() => {
      map.emit('moveend');
    });

    await waitFor(() => expect(pinRequests()).toHaveLength(1));
    expect(pinRequests()[0]).toBe('/api/map/pins?bbox=-97.1235,32.5,-96.4,33.1&layers=customers,jobs');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    expect(pinRequests()).toHaveLength(1);
  });

  it('adds the pin layers after the style loads and again after it is swapped', () => {
    renderMap();
    const map = lastMap();

    act(() => {
      map.emit('style.load');
    });

    for (const id of ['storm-swath', 'service-area', 'clusters', 'customers', 'jobs']) {
      expect(map.addSource).toHaveBeenCalledWith(id, expect.anything());
    }
    expect(map.addLayer).toHaveBeenCalledWith(expect.objectContaining({ id: 'customers' }));
    expect(map.addLayer).toHaveBeenCalledWith(expect.objectContaining({ id: 'jobs' }));
    // The blank style has no glyphs, so a count label (a symbol layer) must not be added.
    const types = map.addLayer.mock.calls.map(([spec]) => spec.type);
    expect(types).not.toContain('symbol');
  });

  it('shows the satellite switch only with a map key', async () => {
    const user = userEvent.setup();

    // Without a key there is no satellite style, so there is no switch.
    renderMap();
    expect(screen.queryByRole('button', { name: mapCopy.satellite })).toBeNull();
    cleanup();

    vi.stubEnv('VITE_MAPTILER_KEY', 'test-key');
    renderMap();
    const map = lastMap();
    expect(screen.getByRole('button', { name: mapCopy.satellite })).toHaveAttribute('aria-pressed', 'false');

    act(() => {
      map.emit('style.load');
    });
    expect(map.addSource.mock.calls.filter(([id]) => id === 'customers')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: mapCopy.satellite }));

    expect(map.setStyle).toHaveBeenCalledWith('https://api.maptiler.com/maps/hybrid/style.json?key=test-key', {
      diff: false,
    });
    expect(screen.getByRole('button', { name: mapCopy.satellite })).toHaveAttribute('aria-pressed', 'true');

    // The swap dropped the sources; the next style.load adds them again.
    act(() => {
      map.emit('style.load');
    });
    expect(map.addSource.mock.calls.filter(([id]) => id === 'customers')).toHaveLength(2);
  });

  it('shows the banner instead of breaking when the map cannot start', async () => {
    fake.FakeMap.failToCreate = true;
    renderMap();

    expect((await screen.findByText(mapCopy.error)).closest('[role="status"][data-state="error"]')).not.toBeNull();
    expect(screen.getByRole('region', { name: mapCopy.label })).toBeInTheDocument();
  });

  it('removes the map when it unmounts', () => {
    const { unmount } = renderMap();
    const map = lastMap();

    unmount();

    expect(map.remove).toHaveBeenCalledTimes(1);
  });
});
