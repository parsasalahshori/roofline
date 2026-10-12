import { instantEstimate, type Ring } from '@roofline/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { legal } from '../src/copy/legal.ts';
import { measure } from '../src/copy/measure.ts';
import { closeDrawing, deleteCorner, insertCorner, moveCorner, nudgeCorner } from '../src/features/measure/OutlineEditor.ts';
import { MeasureWindow } from '../src/features/measure/MeasureWindow.tsx';
import type { MeasurementView } from '../src/features/measure/types.ts';

/* A stand-in for MapLibre (jsdom has no WebGL): records what the app adds and lets a test emit map events. */
const fake = vi.hoisted(() => {
  type Handler = (payload?: unknown) => void;
  class FakeMap {
    static instances: FakeMap[] = [];
    readonly options: Record<string, unknown>;
    private sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
    private layers = new Map<string, unknown>();
    private listeners: { type: string; fn: Handler }[] = [];
    private canvas = Object.assign(document.createElement('canvas'), {
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
    });
    doubleClickZoom = { enable: vi.fn(), disable: vi.fn() };
    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeMap.instances.push(this);
    }
    addSource = vi.fn((id: string) => void this.sources.set(id, { setData: vi.fn() }));
    getSource = (id: string) => this.sources.get(id);
    addLayer = vi.fn((spec: { id: string }) => void this.layers.set(spec.id, spec));
    getLayer = (id: string) => this.layers.get(id);
    removeLayer = (id: string) => void this.layers.delete(id);
    removeSource = (id: string) => void this.sources.delete(id);
    // A pixel maps to a spot near the house: 10 pixels are about one metre.
    unproject = ([x, y]: [number, number]) => ({ lng: -96.8002 + x * 1e-5, lat: 32.7998 + y * 1e-5 });
    project = ([lng, lat]: [number, number]) => ({ x: lng, y: lat });
    getCanvas = () => this.canvas;
    isStyleLoaded = () => true;
    setStyle = vi.fn();
    addControl = vi.fn();
    remove = vi.fn();
    getBounds = () => ({ getWest: () => -97, getSouth: () => 32, getEast: () => -96, getNorth: () => 33 });
    on(type: string, fn: Handler) {
      this.listeners.push({ type, fn });
    }
    once(type: string, fn: Handler) {
      this.on(type, fn);
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
    on() {
      return this;
    }
    off() {
      return this;
    }
  }
  class FakeNavigationControl {}
  return { FakeMap, FakeMarker, FakeNavigationControl };
});

vi.mock('maplibre-gl', () => ({ Map: fake.FakeMap, Marker: fake.FakeMarker, NavigationControl: fake.FakeNavigationControl }));

const LNG = -96.8;
const LAT = 32.8;
const M_PER_DEG = 111320;
const FT = 0.3048;
/** A rectangle ring of width x height feet, centred near the house (counter-clockwise from the south-west). */
function rect(widthFt: number, heightFt: number): Ring {
  const dx = (widthFt * FT) / (M_PER_DEG * Math.cos((LAT * Math.PI) / 180)) / 2;
  const dy = (heightFt * FT) / M_PER_DEG / 2;
  return [
    [LNG - dx, LAT - dy],
    [LNG + dx, LAT - dy],
    [LNG + dx, LAT + dy],
    [LNG - dx, LAT + dy],
  ];
}
/** A spot in a small square grid (1e-4 degrees per step) for the pure reducer tests. */
const p = (x: number, y: number): [number, number] => [LNG + x * 1e-4, LAT + y * 1e-4];

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
    structures: [{ footprintId: 's1', ring, areaSqFt: 1200, included: true }],
    overhangFt: 1,
    center: [LNG, LAT],
    estimate: instantEstimate({ outline: [ring], pitchX12: 6, overhangFt: 1, valleyFt: 0 }),
    facets: null,
    providerRef: null,
    notes: null,
    createdAt: '2026-10-12T12:00:00.000Z',
    locked: false,
    ...over,
  };
}

type Call = { key: string; body: unknown };
let calls: Call[];
let current: MeasurementView;
let patchStatus: number;
const sent = (key: string) => calls.filter((c) => c.key === key).map((c) => c.body as Record<string, unknown>);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderWindow() {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createMemoryRouter(
    [
      { path: 'estimator/measure/:measurementId', element: <MeasureWindow /> },
      { path: 'estimator/proposals/:id', element: <p>Proposal page</p> },
    ],
    { initialEntries: ['/estimator/measure/m1'] },
  );
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return router;
}

/** Renders, waits for the numbers, and starts the map (a real map emits load once). */
async function open(over: Partial<MeasurementView> = {}) {
  current = view(over);
  const router = renderWindow();
  await screen.findByText(measure.numbersTitle);
  await waitFor(() => expect(fake.FakeMap.instances.length).toBeGreaterThan(0));
  mapEmit('load');
  return router;
}
const lastMap = () => fake.FakeMap.instances[fake.FakeMap.instances.length - 1] as InstanceType<typeof fake.FakeMap>;
const mapEmit = (type: string, payload?: unknown) => lastMap().emit(type, payload);
const area = () => screen.getByText(measure.area).nextElementSibling?.textContent ?? '';
const handles = () => document.querySelectorAll('[data-handle="corner"]');
const corner = (i: number) => document.querySelector(`[data-handle="corner"][data-corner-index="${i}"]`) as HTMLElement;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pitchButton = (x: number) => screen.getByRole('button', { name: new RegExp(`${x}/12`) });
function mouse(target: EventTarget, type: string, x: number, y: number) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
}

beforeEach(() => {
  calls = [];
  patchStatus = 200;
  fake.FakeMap.instances.length = 0;
  vi.stubEnv('VITE_MAPTILER_KEY', '');
  vi.stubEnv('VITE_MAP_TILES', '');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ key, body });
      if (key === 'GET /api/measurements/m1') return json(current);
      if (key === 'PATCH /api/measurements/m1') {
        if (patchStatus !== 200) return json({ error: 'This measurement was already sent.' }, patchStatus);
        current = { ...current, ...(body as object) } as MeasurementView;
        return json(current);
      }
      if (key === 'POST /api/measurements/m1/exact-report') return json({ taskId: 't1' }, 201);
      if (key === 'POST /api/proposals') return json({ id: 'pr1' }, 201);
      return json({ error: `Unexpected ${key}` }, 500);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('outline reducers (pure)', () => {
  const square: Ring = [p(0, 0), p(1, 0), p(1, 1), p(0, 1)];

  it('moveCorner moves exactly one corner and does not touch the input', () => {
    const copy = JSON.stringify(square);
    const res = moveCorner(square, 2, p(1.2, 1.1));
    expect(res.problem).toBeNull();
    expect(res.ring[2]).toEqual(p(1.2, 1.1));
    expect([res.ring[0], res.ring[1], res.ring[3]]).toEqual([square[0], square[1], square[3]]);
    expect(JSON.stringify(square)).toBe(copy);
  });

  it('moveCorner across the shape makes a bow-tie and says so', () => {
    const res = moveCorner(square, 0, p(2, 0.5));
    expect(res.problem).toBe('self_intersecting');
    expect(measure.problems.self_intersecting).toBe('Corners must form a closed shape without crossing lines.');
  });

  it('deleteCorner keeps a valid ring, or says too few corners', () => {
    const three = deleteCorner(square, 1);
    expect(three.ring).toHaveLength(3);
    expect(three.problem).toBeNull();
    const two = deleteCorner(three.ring, 0);
    expect(two.problem).toBe('too_few_corners');
    expect(measure.problems.too_few_corners).toBe('Add at least three corners.');
  });

  it('insertCorner adds after the given corner, or at the end', () => {
    const mid = p(0.5, -0.1);
    const res = insertCorner(square, 0, mid);
    expect(res.ring[1]).toEqual(mid);
    expect(res.ring).toHaveLength(5);
    const end = p(-0.2, 0.5);
    expect(insertCorner(square, square.length - 1, end).ring[4]).toEqual(end);
  });

  it('closeDrawing drops a doubled last point and checks the count', () => {
    expect(closeDrawing([...square, square[3] as [number, number]]).ring).toHaveLength(4);
    expect(closeDrawing([...square, square[3] as [number, number]]).problem).toBeNull();
    expect(closeDrawing([p(0, 0), p(1, 0)]).problem).toBe('too_few_corners');
  });

  it('nudgeCorner moves east by metres of longitude and leaves latitude', () => {
    const ring = rect(30, 40);
    const res = nudgeCorner(ring, 0, 0.5, 0);
    const [lng0, lat0] = ring[0] as [number, number];
    const [lng1, lat1] = res.ring[0] as [number, number];
    expect(lng1 - lng0).toBeCloseTo(0.5 / (M_PER_DEG * Math.cos((lat0 * Math.PI) / 180)), 9);
    expect(lat1).toBe(lat0);
  });

  it('an outline over 200000 sq ft is too large', () => {
    const big: Ring = [p(0, 0), p(40, 0), p(40, 40), p(0, 40)];
    expect(moveCorner(big, 0, p(0, 0)).problem).toBe('too_large');
    expect(measure.problems.too_large).toBe('That outline is too large for a house.');
  });
});

describe('measure window', () => {
  it('shows the Estimate label and the attribution line', async () => {
    await open();
    expect(screen.getByText('Estimate')).toBeTruthy();
    expect(screen.getByText(legal.footprintAttribution)).toBeTruthy();
    expect(legal.footprintAttribution).toBe('Building outlines © Microsoft, ODbL');
  });

  it('uses the satellite style', async () => {
    vi.stubEnv('VITE_MAPTILER_KEY', 'k');
    await open();
    expect(String(lastMap().options.style)).toContain('/hybrid/');
  });

  it('numbers update when pitch changes and a pitch PATCH is sent', async () => {
    await open();
    const before = area();
    fireEvent.click(pitchButton(9));
    await waitFor(() => expect(sent('PATCH /api/measurements/m1')).toEqual([{ pitchX12: 9 }]));
    expect(area()).not.toBe(before);
  });

  it('dragging a corner updates the numbers live and saves once after 500 ms', async () => {
    await open();
    const before = area();
    mouse(corner(0), 'pointerdown', 50, 50);
    mouse(window, 'pointermove', 0, 0);
    mouse(window, 'pointerup', 0, 0);
    await waitFor(() => expect(area()).not.toBe(before));
    expect(sent('PATCH /api/measurements/m1')).toHaveLength(0);
    await wait(300);
    expect(sent('PATCH /api/measurements/m1')).toHaveLength(0);
    await waitFor(() => expect(sent('PATCH /api/measurements/m1')).toHaveLength(1), { timeout: 2000 });
    const body = sent('PATCH /api/measurements/m1')[0] as { outline: Ring[] };
    expect(body.outline[0]).toHaveLength(4);
  });

  it('arrow keys nudge a corner by half a metre', async () => {
    await open();
    const start = (rect(30, 40)[0] as [number, number])[0];
    fireEvent.keyDown(corner(0), { key: 'ArrowRight' });
    await waitFor(() => expect(sent('PATCH /api/measurements/m1')).toHaveLength(1), { timeout: 2000 });
    const body = sent('PATCH /api/measurements/m1')[0] as { outline: Ring[] };
    const moved = (body.outline[0]?.[0] as [number, number])[0] - start;
    expect(moved).toBeCloseTo(0.5 / (M_PER_DEG * Math.cos((LAT * Math.PI) / 180)), 8);
  });

  it('Delete removes a corner, and going under three corners warns and saves nothing', async () => {
    await open();
    expect(handles()).toHaveLength(4);
    fireEvent.keyDown(corner(0), { key: 'Delete' });
    await waitFor(() => expect(handles()).toHaveLength(3));
    fireEvent.keyDown(corner(0), { key: 'Delete' });
    const text = await screen.findByText(measure.problems.too_few_corners);
    expect(text.closest('[role="alert"]')).not.toBeNull();
    await wait(800);
    expect(sent('PATCH /api/measurements/m1')).toHaveLength(0);
  });

  it('draw mode: three clicks then Enter saves a three-corner outline', async () => {
    await open({ outline: null, drawMode: true });
    for (const [x, y] of [p(0, 0), p(1, 0), p(0, 1)] as [number, number][]) mapEmit('click', { lngLat: { lng: x, lat: y } });
    fireEvent.keyDown(document, { key: 'Enter' });
    await waitFor(() => expect(sent('PATCH /api/measurements/m1')).toHaveLength(1), { timeout: 2000 });
    expect((sent('PATCH /api/measurements/m1')[0] as { outline: Ring[] }).outline[0]).toHaveLength(3);
  });

  it('draw mode: Enter with too few corners keeps drawing, then saves once a third is added', async () => {
    await open({ outline: null, drawMode: true });
    for (const [x, y] of [p(0, 0), p(1, 0)] as [number, number][]) mapEmit('click', { lngLat: { lng: x, lat: y } });
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(await screen.findByText(measure.problems.too_few_corners)).toBeTruthy();
    const [x, y] = p(0, 1) as [number, number];
    mapEmit('click', { lngLat: { lng: x, lat: y } });
    fireEvent.keyDown(document, { key: 'Enter' });
    await waitFor(() => expect(sent('PATCH /api/measurements/m1')).toHaveLength(1), { timeout: 2000 });
    expect((sent('PATCH /api/measurements/m1')[0] as { outline: Ring[] }).outline[0]).toHaveLength(3);
  });

  it('draw mode: the Finish outline button saves the drawn corners', async () => {
    await open({ outline: null, drawMode: true });
    for (const [x, y] of [p(0, 0), p(1, 0), p(0, 1)] as [number, number][]) mapEmit('click', { lngLat: { lng: x, lat: y } });
    fireEvent.click(screen.getByRole('button', { name: measure.finishDrawing }));
    await waitFor(() => expect(sent('PATCH /api/measurements/m1')).toHaveLength(1), { timeout: 2000 });
    expect((sent('PATCH /api/measurements/m1')[0] as { outline: Ring[] }).outline[0]).toHaveLength(3);
  });

  it('draw mode: Enter inside a form field does not finish the outline', async () => {
    await open({ outline: null, drawMode: true });
    for (const [x, y] of [p(0, 0), p(1, 0), p(0, 1)] as [number, number][]) mapEmit('click', { lngLat: { lng: x, lat: y } });
    fireEvent.keyDown(screen.getByLabelText(measure.overhangTitle), { key: 'Enter' });
    await wait(800);
    expect(sent('PATCH /api/measurements/m1')).toHaveLength(0);
    fireEvent.keyDown(document, { key: 'Enter' });
    await waitFor(() => expect(sent('PATCH /api/measurements/m1')).toHaveLength(1), { timeout: 2000 });
    expect((sent('PATCH /api/measurements/m1')[0] as { outline: Ring[] }).outline[0]).toHaveLength(3);
  });

  it('draw mode: a double-click finishes the outline too', async () => {
    await open({ outline: null, drawMode: true });
    const pts = [p(0, 0), p(1, 0), p(0, 1)] as [number, number][];
    for (const [x, y] of pts) mapEmit('click', { lngLat: { lng: x, lat: y } });
    mapEmit('click', { lngLat: { lng: pts[2]?.[0], lat: pts[2]?.[1] } });
    mapEmit('dblclick', { lngLat: { lng: pts[2]?.[0], lat: pts[2]?.[1] }, preventDefault: () => {} });
    await waitFor(() => expect(sent('PATCH /api/measurements/m1')).toHaveLength(1), { timeout: 2000 });
    expect((sent('PATCH /api/measurements/m1')[0] as { outline: Ring[] }).outline[0]).toHaveLength(3);
  });

  it('Get exact report posts and shows Waiting for your OK', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: measure.getExactReport }));
    await waitFor(() => expect(sent('POST /api/measurements/m1/exact-report')).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByText('Waiting for your OK').length).toBeGreaterThan(0));
  });

  it('a locked measurement disables editing and says why', async () => {
    await open({ locked: true });
    expect(screen.getByText('Make a new measurement to change a sent proposal.')).toBeTruthy();
    expect((pitchButton(9) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Make proposal right after a drag saves the outline first', async () => {
    await open();
    mouse(corner(0), 'pointerdown', 50, 50);
    mouse(window, 'pointermove', 0, 0);
    mouse(window, 'pointerup', 0, 0);
    fireEvent.click(screen.getByRole('button', { name: measure.makeProposal }));
    await waitFor(() => expect(sent('POST /api/proposals')).toHaveLength(1));
    const patchAt = calls.findIndex((c) => c.key === 'PATCH /api/measurements/m1');
    expect(patchAt).toBeGreaterThanOrEqual(0);
    expect(patchAt).toBeLessThan(calls.findIndex((c) => c.key === 'POST /api/proposals'));
  });

  it('unmounting right after a drag still sends the pending outline', async () => {
    await open();
    mouse(corner(0), 'pointerdown', 50, 50);
    mouse(window, 'pointermove', 0, 0);
    mouse(window, 'pointerup', 0, 0);
    cleanup();
    await waitFor(() => expect(sent('PATCH /api/measurements/m1')).toHaveLength(1));
  });

  it('a save refused with 409 shows the locked message', async () => {
    await open();
    patchStatus = 409;
    fireEvent.click(pitchButton(9));
    expect(await screen.findByText(measure.locked)).toBeTruthy();
  });

  it('Make proposal posts the measurement id and opens the proposal', async () => {
    const router = await open();
    fireEvent.click(screen.getByRole('button', { name: measure.makeProposal }));
    await waitFor(() => expect(sent('POST /api/proposals')).toEqual([{ measurementId: 'm1' }]));
    await waitFor(() => expect(router.state.location.pathname).toBe('/estimator/proposals/pr1'));
  });
});
