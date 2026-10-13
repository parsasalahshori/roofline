import { instantEstimate, type Ring } from '@roofline/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liftMeasure } from '../src/copy/liftMeasure.ts';
import { RoofView, ringCenter, scaleBarFor } from '../src/features/measure/lift/RoofView.tsx';
import { StatsPanel, statCells } from '../src/features/measure/lift/StatsPanel.tsx';
import type { MeasurementView } from '../src/features/measure/types.ts';

/* A stand-in for MapLibre (jsdom has no WebGL): records what the view adds and lets a test emit map events. */
const fake = vi.hoisted(() => {
  type Handler = (payload?: unknown) => void;
  class FakeMap {
    static instances: FakeMap[] = [];
    sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
    layers = new Map<string, unknown>();
    private listeners: { type: string; fn: Handler }[] = [];
    private canvas = Object.assign(document.createElement('canvas'), {
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
    });
    doubleClickZoom = { enable: vi.fn(), disable: vi.fn() };
    zoom = 20;
    constructor() {
      FakeMap.instances.push(this);
    }
    addSource = vi.fn((id: string) => void this.sources.set(id, { setData: vi.fn() }));
    getSource = (id: string) => this.sources.get(id);
    addLayer = vi.fn((spec: { id: string }) => void this.layers.set(spec.id, spec));
    getLayer = (id: string) => this.layers.get(id);
    removeLayer = (id: string) => void this.layers.delete(id);
    removeSource = (id: string) => void this.sources.delete(id);
    unproject = ([x, y]: [number, number]) => ({ lng: -96.8002 + x * 1e-5, lat: 32.7998 + y * 1e-5 });
    project = ([lng, lat]: [number, number]) => ({ x: lng, y: lat });
    getCanvas = () => this.canvas;
    getZoom = () => this.zoom;
    isStyleLoaded = () => true;
    remove = vi.fn();
    on(type: string, fn: Handler) {
      this.listeners.push({ type, fn });
    }
    off(type: string, fn: Handler) {
      this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn));
    }
    emit(type: string, payload?: unknown) {
      for (const l of [...this.listeners]) if (l.type === type) l.fn(payload);
    }
  }
  class FakeMarker {
    private el: HTMLElement;
    constructor(options?: { element?: HTMLElement }) {
      this.el = options?.element ?? document.createElement('div');
    }
    setLngLat() {
      return this;
    }
    addTo() {
      document.body.appendChild(this.el);
      return this;
    }
    remove() {
      this.el.remove();
      return this;
    }
    getElement() {
      return this.el;
    }
  }
  return { FakeMap, FakeMarker };
});

vi.mock('maplibre-gl', () => ({ Map: fake.FakeMap, Marker: fake.FakeMarker }));

const LNG = -96.8;
const LAT = 32.8;
const M_PER_DEG = 111320;
const FT = 0.3048;
function rect(widthFt: number, heightFt: number, shiftFt = 0): Ring {
  const dx = (widthFt * FT) / (M_PER_DEG * Math.cos((LAT * Math.PI) / 180)) / 2;
  const dy = (heightFt * FT) / M_PER_DEG / 2;
  const sx = (shiftFt * FT) / (M_PER_DEG * Math.cos((LAT * Math.PI) / 180));
  return [
    [LNG + sx - dx, LAT - dy],
    [LNG + sx + dx, LAT - dy],
    [LNG + sx + dx, LAT + dy],
    [LNG + sx - dx, LAT + dy],
  ];
}

function view(over: Partial<MeasurementView> = {}): MeasurementView {
  const ring = rect(30, 40);
  return {
    id: 'm1',
    propertyId: 'p1',
    jobId: null,
    kind: 'estimate',
    method: 'outline',
    drawMode: false,
    outline: [ring],
    structures: [
      { footprintId: 's1', ring, areaSqFt: 1200, included: true },
      { footprintId: 's2', ring: rect(20, 20, 80), areaSqFt: 400, included: false },
    ],
    overhangFt: 1,
    center: [LNG, LAT],
    estimate: { ...instantEstimate({ outline: [ring], pitchX12: 6, overhangFt: 1, valleyFt: 12 }) },
    facets: 6,
    providerRef: null,
    notes: null,
    createdAt: '2026-10-12T12:00:00.000Z',
    locked: false,
    hasCustomer: true,
    roof: null,
    ...over,
  };
}

let current: MeasurementView;
let patches: unknown[];
let holdLoad: boolean;
let releaseLoad: () => void;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function mount(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}
const lastMap = () => fake.FakeMap.instances[fake.FakeMap.instances.length - 1] as InstanceType<typeof fake.FakeMap>;

beforeEach(() => {
  patches = [];
  holdLoad = false;
  fake.FakeMap.instances.length = 0;
  vi.stubEnv('VITE_MAPTILER_KEY', '');
  vi.stubEnv('VITE_MAP_TILES', '');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      if (key === 'GET /api/measurements/m1') {
        if (holdLoad) await new Promise<void>((resolve) => (releaseLoad = resolve));
        return json(current);
      }
      if (key === 'PATCH /api/measurements/m1') {
        const body = JSON.parse(String(init?.body)) as object;
        patches.push(body);
        current = { ...current, ...body } as MeasurementView;
        return json(current);
      }
      return json({ error: `Unexpected ${key}` }, 500);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('StatsPanel', () => {
  it('shows the squares, the square feet and the fields the measurement has, with the actions at the bottom', async () => {
    current = view();
    mount(<StatsPanel measurementId="m1" actions={<p>Panel actions</p>} />);
    await screen.findByText(liftMeasure.statsTracing(6));
    expect(screen.getByText(liftMeasure.squaresUnit)).toBeTruthy();
    expect(screen.getByText(liftMeasure.roofArea(current.estimate.surfaceSqFt))).toBeTruthy();
    const cells = [...document.querySelectorAll('[data-stat]')].map((el) => el.getAttribute('data-stat'));
    expect(cells).toEqual(['pitch', 'facets', 'ridges', 'valleys', 'edges']);
    expect(screen.getByText(liftMeasure.pitchValue(6))).toBeTruthy();
    expect(screen.getByText(liftMeasure.feet(12))).toBeTruthy();
    const actions = screen.getByText('Panel actions');
    expect(actions.parentElement?.lastElementChild).toBe(actions);
  });

  it('leaves out what the measurement does not have and never invents hips, rakes or hip waste', async () => {
    const base = view();
    current = view({ facets: null, estimate: { ...base.estimate, valleyFt: 0, ridgeFt: 0 } });
    mount(<StatsPanel measurementId="m1" />);
    await screen.findByText(liftMeasure.statsTracingPlain);
    expect(statCells(current).map((c) => c.key)).toEqual(['pitch', 'edges']);
    expect(screen.queryByText(liftMeasure.facets)).toBeNull();
    expect(screen.queryByText(liftMeasure.valleys)).toBeNull();
    expect(screen.queryByText(/hip|rake/i)).toBeNull();
  });
});

describe('RoofView', () => {
  it('shows the measuring pill while the measurement loads', async () => {
    current = view();
    holdLoad = true;
    mount(<RoofView measurementId="m1" />);
    expect(screen.getByText(liftMeasure.measuring)).toBeTruthy();
    await waitFor(() => expect(releaseLoad).toBeTypeOf('function'));
    releaseLoad();
    await screen.findByRole('region', { name: liftMeasure.mapLabel });
    expect(screen.queryByText(liftMeasure.measuring)).toBeNull();
  });

  it('tints the structures, dims the ones left out, labels each and draws the scale bar and north arrow', async () => {
    current = view();
    mount(<RoofView measurementId="m1" />);
    await screen.findByRole('region', { name: liftMeasure.mapLabel });
    await waitFor(() => expect(fake.FakeMap.instances.length).toBeGreaterThan(0));
    lastMap().emit('load');
    await waitFor(() => expect(document.querySelectorAll('[data-structure-label]').length).toBe(2));
    expect(lastMap().layers.has('lift-structures-fill')).toBe(true);
    expect(lastMap().layers.has('outline-fill')).toBe(true);
    expect(document.querySelector('[data-structure-label="s1"]')?.getAttribute('data-included')).toBe('true');
    expect(document.querySelector('[data-structure-label="s2"]')?.getAttribute('data-included')).toBe('false');
    expect(screen.getByText(liftMeasure.structureLabel(1200))).toBeTruthy();
    expect(screen.getByRole('img', { name: liftMeasure.north })).toBeTruthy();
    expect(screen.getByRole('img', { name: /Scale/ })).toBeTruthy();
    expect(handles()).toBe(4);
  });

  it('saves an edited corner after the debounce and shows the measuring pill while it goes out', async () => {
    current = view();
    mount(<RoofView measurementId="m1" />);
    await screen.findByRole('region', { name: liftMeasure.mapLabel });
    await waitFor(() => expect(fake.FakeMap.instances.length).toBeGreaterThan(0));
    lastMap().emit('load');
    const corner = await waitFor(() => {
      const el = document.querySelector('[data-handle="corner"][data-corner-index="0"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.keyDown(corner, { key: 'ArrowRight' });
    await waitFor(() => expect(patches.length).toBe(1), { timeout: 3000 });
    const body = patches[0] as { outline: Ring[] };
    expect(body.outline[0]).toHaveLength(4);
  });
});

function handles(): number {
  return document.querySelectorAll('[data-handle="corner"]').length;
}

describe('map helpers', () => {
  it('picks a round number of feet that fits the bar', () => {
    const { feet, widthPx } = scaleBarFor(LAT, 20);
    expect(feet).toBe(10);
    expect(widthPx).toBeGreaterThan(0);
    expect(widthPx).toBeLessThanOrEqual(96);
    expect(scaleBarFor(LAT, 18).feet).toBeGreaterThan(feet);
  });

  it('puts a label at the average of the corners', () => {
    expect(ringCenter([[0, 0], [2, 0], [2, 2], [0, 2]])).toEqual([1, 1]);
  });
});
