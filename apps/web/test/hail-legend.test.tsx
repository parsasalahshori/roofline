import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Feature } from 'geojson';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { mapCopy } from '../src/copy/map.ts';
import type { StormLayerResponse } from '../src/features/storm/layerTypes.ts';
import { MapView } from '../src/shell/map/MapView.tsx';
import { HailLegend } from '../src/shell/map/HailLegend.tsx';

/* A stand-in for MapLibre's Map, as in map-view.test.tsx (jsdom has no WebGL), plus setLayoutProperty. */
const fake = vi.hoisted(() => {
  type Handler = (payload?: unknown) => void;
  type Listener = { type: string; layer: string | undefined; fn: Handler };
  type FakeSource = { spec: Record<string, unknown>; setData: ReturnType<typeof vi.fn> };
  type FakeLayer = Record<string, unknown> & { id: string };

  class FakeMap {
    static instances: FakeMap[] = [];
    static bounds = { west: -97.123456, south: 32.5, east: -96.4, north: 33.1 };
    readonly options: Record<string, unknown>;
    private sources = new Map<string, FakeSource>();
    private layers = new Map<string, FakeLayer>();
    private listeners: Listener[] = [];
    rendered: unknown[] = [];
    queryRenderedFeatures = vi.fn(() => this.rendered);
    project = ([lng, lat]: [number, number]) => ({ x: lng, y: lat });

    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeMap.instances.push(this);
    }

    addSource = vi.fn((id: string, spec: Record<string, unknown>) => {
      if (this.sources.has(id)) throw new Error(`There is already a source with this ID: ${id}`);
      this.sources.set(id, { spec, setData: vi.fn() });
    });
    removeSource(id: string): void {
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
    setLayoutProperty = vi.fn();
    getStyle = vi.fn(() => ({}));
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

let stormBody: Body;
let stormStatus: number;
let requests: string[];
let unexpected: string[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function swath(thresholdIn: number): Feature {
  return {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-96.9, 32.8],
          [-96.7, 32.8],
          [-96.7, 33],
          [-96.9, 32.8],
        ],
      ],
    },
    properties: { thresholdIn },
  };
}

function spot(): Feature {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [-96.8, 32.9] }, properties: { sizeIn: 1.75 } };
}

function answer(swaths: Feature[], spots: Feature[]): StormLayerResponse {
  return {
    swaths: { type: 'FeatureCollection', features: swaths },
    spots: { type: 'FeatureCollection', features: spots },
    newestRunAt: '2026-10-11T12:00:00.000Z',
    stale: false,
  };
}

function stormRequests(): string[] {
  return requests.filter((url) => url.startsWith('/api/map/storm-layer?'));
}

function lastMap() {
  const map = fake.FakeMap.instances.at(-1);
  if (!map) throw new Error('MapView did not create a map');
  return map;
}

function renderMap() {
  return render(
    <Providers client={createQueryClient()}>
      <MapView onOpen={vi.fn()} />
    </Providers>,
  );
}

/** Emits the events a real map sends once it is ready; the box is read after the 300 ms debounce. */
function loadMap(map: ReturnType<typeof lastMap>) {
  act(() => {
    map.emit('style.load');
  });
  act(() => {
    map.emit('load');
  });
}

beforeEach(() => {
  stormBody = answer([], []);
  stormStatus = 200;
  requests = [];
  unexpected = [];
  vi.stubEnv('VITE_MAPTILER_KEY', '');
  vi.stubEnv('VITE_MAP_TILES', '');
  fake.FakeMap.instances.length = 0;
  fake.FakeMap.bounds = { west: -97.123456, south: 32.5, east: -96.4, north: 33.1 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === '/api/map/area') return json({ serviceArea: null, bounds: null });
      if (url.startsWith('/api/map/pins?')) return json({ mode: 'points', customers: [], jobs: [] });
      if (url.startsWith('/api/map/storm-layer?')) {
        return stormStatus === 200 ? json(stormBody) : json({ error: 'Nope' }, stormStatus);
      }
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

describe('HailLegend', () => {
  it('shows the legend only when swaths are present', () => {
    const { rerender } = render(<HailLegend visible={false} />);
    expect(screen.queryByTestId('hail-legend')).toBeNull();

    rerender(<HailLegend visible />);
    const legend = screen.getByTestId('hail-legend');
    expect(legend).toHaveTextContent('Radar-estimated hail');
    expect(legend).toHaveAccessibleName(mapCopy.hailLegend);
    const swatches = Array.from(legend.querySelectorAll('[data-level]'));
    expect(swatches.map((node) => node.getAttribute('data-level'))).toEqual(['1', '2', '3', '4', '5']);
    for (const size of mapCopy.hailSizeLevels) expect(within(legend).getByText(size)).toBeInTheDocument();
  });
});

describe('HailLegend on the map', () => {
  it('is absent when the answer has no swaths', async () => {
    stormBody = answer([], [spot()]);
    renderMap();
    loadMap(lastMap());

    await waitFor(() => expect(stormRequests()).toHaveLength(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByTestId('hail-legend')).toBeNull();
  });

  it('is present with a swath and goes when the layer is switched off', async () => {
    const user = userEvent.setup();
    stormBody = answer([swath(1.25)], []);
    renderMap();
    loadMap(lastMap());

    expect(await screen.findByTestId('hail-legend')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: mapCopy.hailLayer }));
    expect(screen.queryByTestId('hail-legend')).toBeNull();
    await user.click(screen.getByRole('button', { name: mapCopy.hailLayer }));
    expect(await screen.findByTestId('hail-legend')).toBeInTheDocument();
  });
});
