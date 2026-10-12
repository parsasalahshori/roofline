import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router';
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

let pinsBody: Body;
let unexpected: string[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const customerPin = {
  propertyId: 'p1',
  customerId: 'c1',
  lng: -96.8,
  lat: 32.7,
  name: 'Maria Lopez',
  addressLine: '12 Oak St',
};

function lastMap() {
  const map = fake.FakeMap.instances.at(-1);
  if (!map) throw new Error('MapView did not create a map');
  return map;
}

function renderMap(path: string) {
  return render(
    <Providers client={createQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <MapView onOpen={vi.fn()} />
      </MemoryRouter>
    </Providers>,
  );
}

beforeEach(() => {
  pinsBody = { mode: 'points', customers: [customerPin], jobs: [] };
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
      if (url === '/api/map/area') return json({ serviceArea: null, bounds: null });
      if (url.startsWith('/api/map/pins?')) return json(pinsBody);
      // S1 Task 13: the map also reads the storm layer
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

describe('MapView focus', () => {
  it('flies to the focused pin and opens its card', async () => {
    renderMap('/?focus=p1');
    const map = lastMap();
    act(() => {
      map.emit('style.load');
    });
    act(() => {
      map.emit('load');
    });

    await waitFor(() => expect(map.easeTo).toHaveBeenCalledWith({ center: [-96.8, 32.7], zoom: 16 }));
    expect(await screen.findByText('Maria Lopez')).toBeInTheDocument();
    expect(screen.getByText('12 Oak St')).toBeInTheDocument();
  });

  it('does nothing for an unknown id', async () => {
    renderMap('/?focus=nope');
    const map = lastMap();
    act(() => {
      map.emit('load');
    });

    await waitFor(() => expect(screen.getByText(mapCopy.summary(1, 0))).toBeInTheDocument());
    expect(map.easeTo).not.toHaveBeenCalled();
    expect(screen.queryByText('Maria Lopez')).toBeNull();
  });

  it('flies again when the same focus link is followed a second time', async () => {
    let go: (to: string) => void = () => undefined;
    function Nav() {
      const navigate = useNavigate();
      go = (to) => {
        void navigate(to);
      };
      return null;
    }
    render(
      <Providers client={createQueryClient()}>
        <MemoryRouter initialEntries={['/?focus=p1']}>
          <Nav />
          <MapView onOpen={vi.fn()} />
        </MemoryRouter>
      </Providers>,
    );
    const map = lastMap();
    act(() => {
      map.emit('load');
    });
    await waitFor(() => expect(map.easeTo).toHaveBeenCalledTimes(1));

    act(() => {
      go('/jobs/j1');
    });
    act(() => {
      go('/?focus=p1');
    });
    await waitFor(() => expect(map.easeTo).toHaveBeenCalledTimes(2));
  });

  it('does not fly again when pins refresh', async () => {
    renderMap('/?focus=p1');
    const map = lastMap();
    act(() => {
      map.emit('load');
    });
    await waitFor(() => expect(map.easeTo).toHaveBeenCalledTimes(1));

    pinsBody = { mode: 'points', customers: [customerPin, { ...customerPin, propertyId: 'p2', customerId: 'c2' }], jobs: [] };
    fake.FakeMap.bounds = { west: -97.5, south: 32.5, east: -96.4, north: 33.1 };
    act(() => {
      map.emit('moveend');
    });
    await waitFor(() => expect(screen.getByText(mapCopy.summary(2, 0))).toBeInTheDocument());
    expect(map.easeTo).toHaveBeenCalledTimes(1);
  });
});
