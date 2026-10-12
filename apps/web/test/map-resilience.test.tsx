import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../src/api/types.ts';
import { keys } from '../src/api/keys.ts';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { dock } from '../src/copy/dock.ts';
import { mapCopy } from '../src/copy/map.ts';
import { SOURCE } from '../src/shell/map/layers.ts';
import type { MapViewProps } from '../src/shell/map/MapView.tsx';
import { ACCOUNT, COMPANY, SHELL_ROUTES, type Reply } from './helpers.tsx';

/*
 * The map's failure and the company switch, seen from the shell. The map is a lazy chunk: a failed
 * chunk must leave the top bar and the dock usable behind a banner (spec 4.3). A company switch must
 * drop the old company's pins and open pin card (Ruling O).
 */

// Switches the map chunk to a failing one for the test that needs it. A lazy import caches its result for the whole file,
// so the failure is raised where the map renders: the shell's error boundary catches it the same way.
const mapState = vi.hoisted(() => ({ fail: false }));

vi.mock('../src/shell/map/MapView.tsx', async () => {
  const actual = await vi.importActual<typeof import('../src/shell/map/MapView.tsx')>('../src/shell/map/MapView.tsx');
  return {
    MapView: (props: MapViewProps) => {
      if (mapState.fail) throw new Error('The map chunk failed to load');
      return createElement(actual.MapView, props);
    },
  };
});

// The real MapView (test B) runs on a stand-in for MapLibre, as in map-view.test.tsx. It records every source the app adds and every setData.
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
    static failToCreate = false;
    static bounds = { west: -97.123456, south: 32.5, east: -96.4, north: 33.1 };
    readonly options: Record<string, unknown>;
    private sources = new Map<string, FakeSource>();
    private layers = new Map<string, FakeLayer>();
    private listeners: Listener[] = [];
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
      this.sources.set(id, { spec, setData: vi.fn(), getClusterExpansionZoom: vi.fn().mockResolvedValue(12) });
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
      return { getWest: () => west, getSouth: () => south, getEast: () => east, getNorth: () => north };
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

const COMPANY_B: Account['company'] = { id: 'c2', name: 'Ridge Roofing', slug: 'ridge-roofing', status: 'active' };
const ACCOUNT_B: Account = { ...ACCOUNT, company: COMPANY_B, companies: [{ id: 'c1', name: 'Summit Roofing' }, { id: 'c2', name: 'Ridge Roofing' }] };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A 'points' answer with one customer, named for the test. */
function customerPoints(name: string, id: string) {
  return {
    mode: 'points',
    customers: [{ propertyId: `p-${id}`, customerId: id, lng: -96.8, lat: 32.9, name, addressLine: '1 Elm St' }],
    jobs: [],
  };
}

let unexpected: string[];
/** Who is signed in now: the account /api/auth/me answers with. */
let signedIn: Account;
/** Pins requests answer with this, or never answer when `pending` (a switch whose pins are still on their way). */
let pins: { body: unknown; pending: boolean };
let pinRequests: string[];

beforeEach(() => {
  mapState.fail = false;
  unexpected = [];
  signedIn = ACCOUNT;
  pins = { body: customerPoints('Acme Customer A', 'a-cust-1'), pending: false };
  pinRequests = [];
  fake.FakeMap.instances.length = 0;
  fake.FakeMap.failToCreate = false;
  vi.stubEnv('VITE_MAPTILER_KEY', '');
  vi.stubEnv('VITE_MAP_TILES', '');
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/map/pins?')) {
        pinRequests.push(url);
        if (pins.pending) return new Promise<Response>(() => {});
        return Promise.resolve(json(pins.body));
      }
      if (url === '/api/map/area') return Promise.resolve(json({ serviceArea: null, bounds: null }));
      if (url === '/api/auth/me') return Promise.resolve(json(signedIn));
      if (url.startsWith('/api/map/storm-layer?')) return Promise.resolve(json({ swaths: { type: 'FeatureCollection', features: [] }, spots: { type: 'FeatureCollection', features: [] }, newestRunAt: null, stale: false }));
      const key = `${init?.method ?? 'GET'} ${url}`;
      const handler = SHELL_ROUTES[key];
      if (!handler) unexpected.push(key);
      const reply: Reply = handler ? handler() : { status: 500, body: { error: `Unexpected ${key}` } };
      return Promise.resolve(json(reply.body ?? {}, reply.status ?? 200));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  expect(unexpected).toEqual([]);
});

function renderApp(path: string) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: [path] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, queryClient };
}

function lastMap() {
  const map = fake.FakeMap.instances.at(-1);
  if (!map) throw new Error('MapView did not create a map');
  return map;
}

it('a failed map chunk keeps the app usable', async () => {
  mapState.fail = true;
  // The error boundary logs the failure; the test checks what the person sees, not the log
  vi.spyOn(console, 'error').mockImplementation(() => {});
  renderApp('/');

  expect(await screen.findByText(mapCopy.error)).toBeInTheDocument();
  // The top bar (the company's name) and the dock are still there
  expect(screen.getByText(COMPANY.name)).toBeInTheDocument();
  expect(await screen.findByRole('navigation', { name: dock.label })).toBeInTheDocument();
});

it('switching company does not keep the old company pins or PinCard', async () => {
  const { queryClient } = renderApp('/');
  await waitFor(() => expect(fake.FakeMap.instances).toHaveLength(1));
  const first = lastMap();
  act(() => {
    first.emit('style.load');
  });
  act(() => {
    first.emit('load');
  });
  expect(await screen.findByText(mapCopy.summary(1, 0))).toBeInTheDocument();

  // Company A's customer is picked: the pin card opens
  first.rendered = [
    {
      properties: { kind: 'customer', id: 'a-cust-1', name: 'Acme Customer A', addressLine: '1 Elm St' },
      geometry: { type: 'Point', coordinates: [-96.8, 32.9] },
    },
  ];
  act(() => {
    first.emit('click', { point: { x: -96.8, y: 32.9 }, lngLat: { lng: -96.8, lat: 32.9 } });
  });
  expect(await screen.findByText('Acme Customer A')).toBeInTheDocument();

  // Switch to company B. Its pins request is left pending.
  const requestsBefore = pinRequests.length;
  signedIn = ACCOUNT_B;
  pins = { body: undefined, pending: true };
  act(() => {
    queryClient.setQueryData(keys.me, ACCOUNT_B);
    void queryClient.resetQueries({ predicate: (query) => query.queryKey[0] !== keys.me[0] });
  });

  // The map is new for company B, and asks for its own pins
  await waitFor(() => expect(fake.FakeMap.instances).toHaveLength(2));
  const second = lastMap();
  act(() => {
    second.emit('style.load');
  });
  act(() => {
    second.emit('load');
  });
  await waitFor(() => expect(pinRequests.length).toBeGreaterThan(requestsBefore));

  // No pin card for company A, and no company A feature reached any layer of the new map
  expect(screen.queryByText('Acme Customer A')).not.toBeInTheDocument();
  const sent = Object.values(SOURCE).flatMap((id) => second.getSource(id)?.setData.mock.calls ?? []);
  expect(JSON.stringify(sent)).not.toContain('Acme Customer A');
  expect(JSON.stringify(sent)).not.toContain('a-cust-1');
});
