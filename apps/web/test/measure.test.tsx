import { readFileSync } from 'node:fs';
import { instantEstimate, measureRoof, quotedTotals, type Ring } from '@roofline/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { estimator } from '../src/copy/estimator.ts';
import { legal } from '../src/copy/legal.ts';
import { paidReports } from '../src/copy/billing.ts';
import { liftMeasure, liftProposal } from '../src/copy/liftMeasure.ts';
import { measure } from '../src/copy/measure.ts';
import { common } from '../src/copy/common.ts';
import { wholeDollars } from '../src/features/measure/lift/proposalLines.ts';
import { forgetRevealed } from '../src/features/measure/lift/scan.ts';
import { closeDrawing, deleteCorner, insertCorner, moveCorner, nudgeCorner } from '../src/features/measure/OutlineEditor.ts';
import { MeasureWindow, roofPadding } from '../src/features/measure/MeasureWindow.tsx';
import type { MeasurementPreview, MeasurementView } from '../src/features/measure/types.ts';
import { gableRoof } from './roof-model-fixture.ts';

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
    dragPan = { enable: vi.fn(), disable: vi.fn(), isEnabled: vi.fn(() => true) };
    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeMap.instances.push(this);
    }
    addSource = vi.fn((id: string) => void this.sources.set(id, { setData: vi.fn() }));
    getSource = (id: string) => this.sources.get(id);
    addLayer = vi.fn((spec: { id: string }) => void this.layers.set(spec.id, spec));
    getLayer = (id: string) => this.layers.get(id);
    removeLayer = (id: string) => void this.layers.delete(id);
    setLayoutProperty = vi.fn();
    removeSource = (id: string) => void this.sources.delete(id);
    // A pixel maps to a spot near the house: 10 pixels are about one metre.
    unproject = ([x, y]: [number, number]) => ({ lng: -96.8002 + x * 1e-5, lat: 32.7998 + y * 1e-5 });
    project = ([lng, lat]: [number, number]) => ({ x: lng, y: lat });
    getCanvas = () => this.canvas;
    fitBounds = vi.fn();
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

function previewOption(tier: 'good' | 'better' | 'best', totalCents: number) {
  return {
    tier,
    name: `${tier} shingles`,
    highlights: ['Shingles', 'Synthetic underlayment'],
    material: 'architectural' as const,
    wastePercent: 12,
    enabled: true,
    calculation: {
      surfaceAreaSqFt: 1200, roofSquares: 12, materialBundles: 41, orderedSquares: 13.67, subtotalCents: 600000, markupCents: 150000, taxCents: 0, totalCents,
      lines: [
        { code: 'material', name: 'Architectural shingles', quantity: 41, unit: 'bundle', unitCents: 4200, totalCents: 172200, taxable: true },
        { code: 'labor', name: 'Roof installation', quantity: 12, unit: 'sq', unitCents: 13500, totalCents: 162000, taxable: false },
      ],
    },
    addOnLines: [],
    totalCents,
    monthlyEstimateCents: Math.round(totalCents / 76),
  };
}
const PREVIEW: MeasurementPreview = {
  addressLine: '410 Truss Ave',
  city: 'Omaha',
  state: 'NE',
  customerName: 'Carmen Castellano',
  hailIn: null,
  options: [previewOption('good', 1900000), previewOption('better', 2300000), previewOption('best', 3700000)],
  financing: { aprBps: 999, months: 120 },
};

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
    hasCustomer: true,
    roof: null,
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
let buildStatus: number;
let buildField: string | undefined;
let role: string;
let patchDelay: number;
/** Set: the preview prices the saved roof at this many cents per sloped sq ft (else the fixed PREVIEW). */
let pricePerSqFtCents: number | null;
const sent = (key: string) => calls.filter((c) => c.key === key).map((c) => c.body as Record<string, unknown>);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * What the server does with a PATCH, for the parts these tests look at: the body is kept; a roof with facets is
 * worked out again with the sections left out (as the API's measureRoof does), and a new outline or other buildings
 * put every section back in the quote.
 */
function serverPatch(before: MeasurementView, body: Record<string, unknown>): MeasurementView {
  const next = { ...before, ...body } as MeasurementView;
  if (before.roof === null || before.roof === undefined) return next;
  const roofChanged = 'outline' in body || 'includedStructures' in body;
  const out = roofChanged ? [] : ((body.excludedFacets as string[] | undefined) ?? before.excludedFacets ?? []);
  const measured = measureRoof({ outline: next.outline ?? [], pitchX12: next.estimate.pitchX12, overhangFt: next.overhangFt, excludedFacets: out });
  return { ...next, roof: measured.roof, estimate: measured.estimate, excludedFacets: measured.roof?.excluded ?? [] };
}

/** The three options priced from the saved roof's sloped area. */
function pricedBy(m: MeasurementView, centsPerSqFt: number): MeasurementPreview {
  const total = Math.round(m.estimate.surfaceSqFt * centsPerSqFt);
  return { ...PREVIEW, options: [previewOption('good', total), previewOption('better', Math.round(total * 1.2)), previewOption('best', Math.round(total * 1.9))] };
}

function renderWindow(state?: unknown) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createMemoryRouter(
    [
      { path: 'estimator/measure/:measurementId', element: <MeasureWindow /> },
      { path: 'approvals/:id', element: <p>Approval page</p> },
    ],
    { initialEntries: [{ pathname: '/estimator/measure/m1', state }] },
  );
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return router;
}

/** Renders, waits for the numbers, and starts the map (a real map emits load once). */
async function open(over: Partial<MeasurementView> = {}, state?: unknown) {
  current = view(over);
  const router = renderWindow(state);
  await waitFor(() => expect(fake.FakeMap.instances.length).toBeGreaterThan(0));
  mapEmit('load');
  // An editable roof is revealed by the scan first; the numbers come after it
  await waitFor(() =>
    expect(
      screen.queryByText(measure.numbersTitle) ??
        screen.queryByRole('button', { name: liftMeasure.adjust }) ??
        screen.queryByRole('button', { name: liftMeasure.scanButton }),
    ).toBeTruthy(),
  );
  const scanButton = screen.queryByRole('button', { name: liftMeasure.scanButton });
  if (scanButton) fireEvent.click(scanButton);
  // The controls that change the estimate sit under the card's Adjust row, folded away until it is opened
  const adjust = await screen.findByRole('button', { name: liftMeasure.adjust });
  if (adjust.getAttribute('aria-expanded') !== 'true') fireEvent.click(adjust);
  await screen.findByText(measure.numbersTitle);
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
  forgetRevealed();
  calls = [];
  patchStatus = 200;
  buildStatus = 201;
  buildField = undefined;
  role = 'owner';
  patchDelay = 0;
  pricePerSqFtCents = null;
  fake.FakeMap.instances.length = 0;
  vi.stubEnv('VITE_MAPTILER_KEY', '');
  vi.stubEnv('VITE_MAP_TILES', '');
  vi.stubEnv('VITE_MEASURE_SCAN_MS', '0');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ key, body });
      if (key === 'GET /api/auth/me') return json({ user: { id: 'u1', email: 'a@b.c', name: 'A', emailVerified: true }, company: { id: 'c1', name: 'C', slug: 'c', status: 'active' }, role, companies: [] });
      if (key === 'GET /api/measurements/m1') return json(current);
      if (key.startsWith('GET /api/measurements/m1/preview')) return json(pricePerSqFtCents === null ? PREVIEW : pricedBy(current, pricePerSqFtCents));
      if (key === 'PATCH /api/measurements/m1') {
        if (patchStatus !== 200) return json({ error: 'This measurement was already sent.' }, patchStatus);
        if (patchDelay > 0) await wait(patchDelay);
        current = serverPatch(current, body as Record<string, unknown>);
        return json(current);
      }
      if (key === 'POST /api/estimator/from-footprint') return json({ measurementId: 'm2' }, 201);
      if (key === 'POST /api/estimator/from-point') return json({ measurementId: 'm3' }, 201);
      if (key === 'POST /api/measurements/m1/exact-report') return json({ taskId: 't1' }, 201);
      if (key === 'POST /api/proposals') return buildStatus === 201 ? json({ id: 'pr1' }, 201) : json({ error: 'boom', ...(buildField !== undefined && { field: buildField }) }, buildStatus);
      if (key === 'POST /api/proposals/pr1/send') return json({ taskId: 't9' });
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
    expect(two.refused).toBe(true);
    expect(two.ring).toEqual(three.ring);
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

  it('an outline past the pricing limit (35,777 sq ft) is too large', () => {
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

  it('grabbing a corner holds the map still: the map does not pan until the corner is let go', async () => {
    await open();
    const map = lastMap();
    const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 });
    const reachedMap = vi.fn();
    const mapNode = corner(0).parentElement ?? document.body;
    mapNode.addEventListener('pointerdown', reachedMap);
    const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 });
    mapNode.addEventListener('mousedown', reachedMap);
    corner(0).dispatchEvent(down);
    corner(0).dispatchEvent(mousedown);
    // The map's own pan handler never sees the press, and panning is off for the whole drag.
    expect(reachedMap).not.toHaveBeenCalled();
    expect(map.dragPan.disable).toHaveBeenCalledTimes(1);
    mouse(window, 'pointermove', 0, 0);
    expect(map.dragPan.enable).not.toHaveBeenCalled();
    mouse(window, 'pointerup', 0, 0);
    expect(map.dragPan.enable).toHaveBeenCalledTimes(1);
  });

  it('pressing the add-a-corner handle does not pan the map either', async () => {
    await open();
    const mid = document.querySelector('[data-handle="mid"]') as HTMLElement;
    const reachedMap = vi.fn();
    const mapNode = mid.parentElement ?? document.body;
    mapNode.addEventListener('mousedown', reachedMap);
    mapNode.addEventListener('pointerdown', reachedMap);
    mid.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    mid.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    expect(reachedMap).not.toHaveBeenCalled();
  });

  it('where corners crowd together, a press lands on the corner, not on the add-a-corner dot beside it', async () => {
    await open();
    const c = corner(0);
    const mid = document.querySelector('[data-handle="mid"]') as HTMLElement;
    expect(Number(c.style.zIndex)).toBeGreaterThan(Number(mid.style.zIndex));
    expect(parseFloat(mid.style.width)).toBeLessThan(parseFloat(c.style.width));
  });

  it('dragging an add-a-corner dot adds a corner and moves it with the pointer', async () => {
    await open();
    const map = lastMap();
    const before = document.querySelectorAll('[data-handle="corner"]').length;
    const mid = document.querySelector('[data-handle="mid"][data-mid-index="0"]') as HTMLElement;
    mid.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    // Pulled south of the south wall's middle, so the outline stays a simple shape.
    mouse(window, 'pointermove', 15, -10);
    mouse(window, 'pointermove', 20, -20);
    expect(document.querySelectorAll('[data-handle="corner"]')).toHaveLength(before + 1);
    mouse(window, 'pointerup', 20, -20);
    expect(map.dragPan.enable).toHaveBeenCalled();
    await waitFor(() => expect(sent('PATCH /api/measurements/m1')).toHaveLength(1), { timeout: 2000 });
    const body = sent('PATCH /api/measurements/m1')[0] as { outline: Ring[] };
    expect(body.outline[0]).toHaveLength(before + 1);
    // The new corner sits where the pointer let go (the fake map turns a pixel into 1e-5 degrees).
    expect(body.outline[0]![1]![0]).toBeCloseTo(-96.8002 + 20 * 1e-5, 8);
    expect(body.outline[0]![1]![1]).toBeCloseTo(32.7998 - 20 * 1e-5, 8);
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
    // The refused delete changes nothing: three corners stay, and the three-corner outline is still saved
    expect(handles()).toHaveLength(3);
    await waitFor(() => expect(sent('PATCH /api/measurements/m1')).toHaveLength(1), { timeout: 2000 });
    expect((sent('PATCH /api/measurements/m1')[0] as { outline: Ring[] }).outline[0]).toHaveLength(3);
  });

  it('a long press on the third corner is refused too', async () => {
    await open({ outline: [rect(30, 40).slice(0, 3)] });
    expect(handles()).toHaveLength(3);
    fireEvent.keyDown(corner(1), { key: 'Backspace' });
    expect(await screen.findByText(measure.problems.too_few_corners)).toBeTruthy();
    expect(handles()).toHaveLength(3);
  });

  it('Draw the outline again re-enters draw mode', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: measure.redraw }));
    expect(screen.getByText(measure.drawHint)).toBeTruthy();
    expect(handles()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: measure.redraw })).toBeNull();
  });

  it('a locked measurement has no corner handles and no redraw', async () => {
    await open({ locked: true });
    expect(handles()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: measure.redraw })).toBeNull();
  });

  it('a save refused as locked turns the outline read-only', async () => {
    await open();
    expect(handles()).toHaveLength(4);
    patchStatus = 409;
    fireEvent.click(pitchButton(9));
    expect(await screen.findByText(measure.locked)).toBeTruthy();
    await waitFor(() => expect(handles()).toHaveLength(0));
  });

  it('Make proposal waits for a pitch change that is still saving', async () => {
    patchDelay = 200;
    await open();
    fireEvent.click(pitchButton(9));
    const make = screen.getByRole('button', { name: measure.makeProposal }) as HTMLButtonElement;
    fireEvent.click(make);
    await waitFor(() => expect(make.disabled).toBe(true));
    await waitFor(() => expect(sent('POST /api/proposals')).toHaveLength(1), { timeout: 3000 });
    expect(calls.findIndex((c) => c.key === 'PATCH /api/measurements/m1')).toBeLessThan(
      calls.findIndex((c) => c.key === 'POST /api/proposals'),
    );
  });

  it('a building toggle saves at once', async () => {
    const shed = { footprintId: 's2', ring: rect(14, 16).map(([lng, lat]) => [lng + 0.00012, lat] as [number, number]), areaSqFt: 224, included: false };
    await open({ structures: [{ footprintId: 's1', ring: rect(30, 40), areaSqFt: 1200, included: true, main: true }, shed] });
    fireEvent.click(screen.getByLabelText(/^Detached building/));
    await waitFor(() => expect(sent('PATCH /api/measurements/m1')).toEqual([{ includedStructures: ['s1', 's2'] }]));
  });

  it('Get exact report is not offered to a rep', async () => {
    role = 'rep';
    await open();
    await wait(100);
    expect(screen.queryByRole('button', { name: paidReports.exactRequest })).toBeNull();
  });

  it('Get exact report is not offered on an exact measurement', async () => {
    await open({ kind: 'exact' });
    await wait(100);
    expect(screen.queryByRole('button', { name: paidReports.exactRequest })).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: new RegExp(paidReports.exactChoice.replace(/[()]/g, '\\$&')) }));
    fireEvent.click(await screen.findByRole('button', { name: paidReports.exactRequest }));
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

  it('Make proposal builds, sends and lands on the approval', async () => {
    const router = await open();
    fireEvent.click(screen.getByRole('button', { name: measure.makeProposal }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/approvals/t9'));
    expect(sent('POST /api/proposals')).toEqual([{ measurementId: 'm1' }]);
    expect(sent('POST /api/proposals/pr1/send')).toHaveLength(1);
  });

  it('a double click builds and sends once', async () => {
    const router = await open();
    const button = screen.getByRole('button', { name: measure.makeProposal });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(router.state.location.pathname).toBe('/approvals/t9'));
    expect(sent('POST /api/proposals')).toHaveLength(1);
    expect(sent('POST /api/proposals/pr1/send')).toHaveLength(1);
  });

  it('router state with a job id sends it with the build', async () => {
    const router = await open({}, { jobId: 'j1' });
    fireEvent.click(screen.getByRole('button', { name: measure.makeProposal }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/approvals/t9'));
    expect(sent('POST /api/proposals')).toEqual([{ measurementId: 'm1', jobId: 'j1' }]);
  });

  it('router state with a customer sends it with the build', async () => {
    const customer = { name: 'Dana Fox', phone: '5125550100', askedByText: true };
    const router = await open({}, { customer });
    fireEvent.click(screen.getByRole('button', { name: measure.makeProposal }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/approvals/t9'));
    expect(sent('POST /api/proposals')).toEqual([{ measurementId: 'm1', customer }]);
  });

  it('router state of the wrong shape is ignored', async () => {
    const router = await open({}, { jobId: 7, customer: { name: 'Dana' } });
    fireEvent.click(screen.getByRole('button', { name: measure.makeProposal }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/approvals/t9'));
    expect(sent('POST /api/proposals')).toEqual([{ measurementId: 'm1' }]);
  });

  it('a failed build shows the failure copy and stays on the window', async () => {
    buildStatus = 500;
    const router = await open();
    fireEvent.click(screen.getByRole('button', { name: measure.makeProposal }));
    expect(await screen.findByText(estimator.makeFailed)).toBeTruthy();
    expect(router.state.location.pathname).toBe('/estimator/measure/m1');
  });

  it('the free estimate is the default; the exact report swaps Make proposal for Get exact report', async () => {
    await open();
    const free = screen.getByRole('button', { name: new RegExp(measure.choiceFree) });
    const exact = screen.getByRole('button', { name: new RegExp(paidReports.exactChoice.replace(/[()]/g, '\\$&')) });
    expect(free.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(measure.choiceExactNote)).toBeTruthy();
    expect(screen.queryByRole('button', { name: paidReports.exactRequest })).toBeNull();
    fireEvent.click(exact);
    expect(exact.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: paidReports.exactRequest })).toBeTruthy();
    expect(screen.queryByRole('button', { name: measure.makeProposal })).toBeNull();
    fireEvent.click(free);
    expect(screen.getByRole('button', { name: measure.makeProposal })).toBeTruthy();
  });

  it('a rep sees no price choice and keeps Make proposal', async () => {
    role = 'rep';
    await open();
    await wait(100);
    expect(screen.queryByText(measure.choiceTitle)).toBeNull();
    expect(screen.getByRole('button', { name: measure.makeProposal })).toBeTruthy();
  });

  it('a home with no customer asks for one, and Make proposal sends it', async () => {
    const router = await open({ hasCustomer: false });
    const make = screen.getByRole('button', { name: measure.makeProposal }) as HTMLButtonElement;
    expect(screen.getByText(measure.customerTitle)).toBeTruthy();
    expect(make.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(measure.customerName), { target: { value: ' Dana Fox ' } });
    expect(make.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(measure.customerPhone), { target: { value: '4025550142' } });
    fireEvent.click(screen.getByLabelText(measure.customerAskedByText));
    expect(make.disabled).toBe(false);
    fireEvent.click(make);
    await waitFor(() => expect(router.state.location.pathname).toBe('/approvals/t9'));
    expect(sent('POST /api/proposals')).toEqual([{ measurementId: 'm1', customer: { name: 'Dana Fox', phone: '4025550142', askedByText: true } }]);
  });

  it('a customer or job handed over skips the customer step', async () => {
    await open({ hasCustomer: false }, { jobId: 'j1' });
    expect(screen.queryByText(measure.customerTitle)).toBeNull();
    cleanup();
    await open({ hasCustomer: false }, { customer: { name: 'Dana Fox', phone: '4025550142', askedByText: false } });
    expect(screen.queryByText(measure.customerTitle)).toBeNull();
  });

  it('a build refused for want of a customer opens the customer step', async () => {
    buildStatus = 400;
    buildField = 'customer';
    await open();
    expect(screen.queryByText(measure.customerTitle)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: measure.makeProposal }));
    expect(await screen.findByText(measure.customerTitle)).toBeTruthy();
  });

  it('shows the server message when Make proposal is refused', async () => {
    buildStatus = 409;
    await open();
    fireEvent.click(screen.getByRole('button', { name: measure.makeProposal }));
    expect(await screen.findByText('boom')).toBeTruthy();
  });
});

describe('the Measure roof scan', () => {
  const structure = { footprintId: 'f1', included: true, areaSqFt: 2400, ring: [p(0, 0), p(1, 0), p(1, 1), p(0, 1)] as Ring };

  async function openUnscanned(over: Partial<MeasurementView> = {}) {
    current = view(over);
    renderWindow();
    await waitFor(() => expect(fake.FakeMap.instances.length).toBeGreaterThan(0));
    mapEmit('load');
    return screen.findByRole('button', { name: liftMeasure.scanButton });
  }

  it('shows the Measure roof bar first, with no numbers, and the imagery chip', async () => {
    await openUnscanned();
    expect(screen.getByText(liftMeasure.scanIntroName)).toBeTruthy();
    expect(screen.getByText(/measures every facet, pitch, and line/)).toBeTruthy();
    expect(screen.queryByText(measure.numbersTitle)).toBeNull();
    expect(screen.queryByRole('button', { name: measure.makeProposal })).toBeNull();
    expect(screen.getByText(/^Aerial imagery/)).toBeTruthy();
  });

  it('plays the scan: finding the roof, then tracing the real facet count, then the measured roof and its numbers', async () => {
    vi.stubEnv('VITE_MEASURE_SCAN_MS', '1200');
    const button = await openUnscanned({ facets: 7, structures: [structure] });
    fireEvent.click(button);
    expect(await screen.findByText(liftMeasure.stage.finding)).toBeTruthy();
    expect(screen.getByText(liftMeasure.measuring)).toBeTruthy();
    expect(await screen.findByText(liftMeasure.stage.tracing(7), {}, { timeout: 2000 })).toBeTruthy();
    expect(await screen.findByRole('button', { name: liftMeasure.adjust }, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText(liftMeasure.measuredBy)).toBeTruthy();
    expect(screen.queryByRole('button', { name: liftMeasure.scanButton })).toBeNull();
    expect(screen.getByRole('button', { name: measure.makeProposal })).toBeTruthy();
  });

  it('plays the scan without a second press when the window was opened by Measure (autoScan)', async () => {
    vi.stubEnv('VITE_MEASURE_SCAN_MS', '1200');
    current = view({ facets: 4, structures: [structure] });
    renderWindow({ autoScan: true });
    expect(await screen.findByText(liftMeasure.stage.finding)).toBeTruthy();
    expect(screen.queryByRole('button', { name: liftMeasure.scanButton })).toBeNull();
    expect(await screen.findByRole('button', { name: liftMeasure.adjust }, { timeout: 3000 })).toBeTruthy();
  });

  it('does not invent a facet count the measurement lacks', async () => {
    vi.stubEnv('VITE_MEASURE_SCAN_MS', '1200');
    fireEvent.click(await openUnscanned({ facets: null }));
    expect(await screen.findByText(liftMeasure.stage.tracing(null), {}, { timeout: 2000 })).toBeTruthy();
    expect(screen.queryByText(/Tracing \d/)).toBeNull();
  });

  it('draws the facets and lines on the photo, labels each facet and shows the legend once measured', async () => {
    const roof = gableRoof(view().outline![0] as [number, number][]);
    const button = await openUnscanned({ roof } as Partial<MeasurementView>);
    expect(lastMap().getLayer('roof-facets-fill')).toBeTruthy();
    expect(lastMap().getLayer('roof-lines')).toBeTruthy();
    expect(document.querySelector('[data-facet-label]')).toBeNull();
    fireEvent.click(button);
    const a = await screen.findByRole('button', { name: liftMeasure.facetToggle('A', 671, '6/12') });
    expect(a.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: liftMeasure.facetToggle('B', 671, '6/12') })).toBeTruthy();
    const legend = screen.getByRole('list', { name: liftMeasure.legendLabel });
    expect(legend.textContent).toBe('RidgeValleyEaveRake');
    expect(screen.getByText('13.4')).toBeTruthy();
    expect(screen.getByText(liftMeasure.feet(90))).toBeTruthy();
    expect(lastMap().setLayoutProperty).toHaveBeenCalledWith('roof-lines', 'visibility', 'visible');
  });

  it('a roof with no facets shows the outline only, and says so', async () => {
    fireEvent.click(await openUnscanned({ roof: null } as Partial<MeasurementView>));
    expect(await screen.findByText(liftMeasure.outlineOnly)).toBeTruthy();
    expect(screen.queryByRole('list', { name: liftMeasure.legendLabel })).toBeNull();
  });

  it('opens the proposal beside the measured roof, priced by the preview', async () => {
    fireEvent.click(await openUnscanned());
    const panel = await screen.findByRole('complementary', { name: liftProposal.label });
    expect(await within(panel).findByText(liftProposal.title('Carmen'))).toBeTruthy();
    const radios = within(panel).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(within(panel).getByText(liftProposal.totalFor('Better'))).toBeTruthy();
    expect(within(panel).getByRole('button', { name: measure.makeProposal })).toBeTruthy();
  });

  it('skips the scan for a sent (locked) measurement', async () => {
    current = view({ locked: true });
    renderWindow();
    expect(await screen.findByRole('button', { name: liftMeasure.adjust })).toBeTruthy();
    expect(screen.queryByRole('button', { name: liftMeasure.scanButton })).toBeNull();
  });

  it('folds the pitch, overhang and numbers under Adjust, closed until it is pressed', async () => {
    current = view({ locked: true });
    renderWindow();
    const adjust = await screen.findByRole('button', { name: liftMeasure.adjust });
    expect(adjust.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(measure.numbersTitle)).toBeNull();
    fireEvent.click(adjust);
    expect(adjust.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(measure.numbersTitle)).toBeTruthy();
  });
});

describe('the EagleView option after measuring', () => {
  it('is a secondary choice marked paid and ordered after the owner OK, and links to the approval once asked', async () => {
    await open();
    const order = screen.getByRole('button', { name: new RegExp(paidReports.exactChoice) });
    expect(order.textContent).toContain('Paid');
    expect(order.textContent).toContain(measure.choiceExactNote);
    expect(screen.getByRole('button', { name: measure.makeProposal })).toBeTruthy();
    fireEvent.click(order);
    fireEvent.click(await screen.findByRole('button', { name: paidReports.exactRequest }));
    const waiting = await screen.findByRole('link', { name: measure.waitingForOk });
    expect(waiting.getAttribute('href')).toBe('/approvals/t1');
    expect(sent('POST /api/measurements/m1/exact-report')).toHaveLength(1);
  });
});

/* ---------------------------------------------------------------------------------------------------------------
 * Sections, buildings and the card's room: an L-shaped house (four sections A to D) with buildings around it.
 */

const CARD_CSS_DIR = `${process.cwd().endsWith('web') ? '' : 'apps/web/'}src/features/measure/lift/`;

/** A spot `x` feet east and `y` feet north of the test origin. */
const at = (x: number, y: number): [number, number] => [LNG + (x * FT) / (M_PER_DEG * Math.cos((LAT * Math.PI) / 180)), LAT + (y * FT) / M_PER_DEG];
const box = (x: number, y: number, w: number, h: number): Ring => [at(x, y), at(x + w, y), at(x + w, y + h), at(x, y + h)];
const L_RING: Ring = [at(0, 0), at(60, 0), at(60, 25), at(25, 25), at(25, 55), at(0, 55)];
const SHED = { footprintId: 'shed', ring: box(80, 5, 14, 16), areaSqFt: 224, included: false };
const NEIGHBOUR = { footprintId: 'next', ring: box(95, 30, 45, 45), areaSqFt: 2025, included: false };
const FAR = { footprintId: 'far', ring: box(400, 0, 15, 20), areaSqFt: 300, included: false };
const MAIN = { footprintId: 'home', ring: L_RING, areaSqFt: 2475, included: true, main: true };
const middle = (ring: Ring): { lng: number; lat: number } => ({
  lng: ring.reduce((t, q) => t + q[0], 0) / ring.length,
  lat: ring.reduce((t, q) => t + q[1], 0) / ring.length,
});

/** The L-shaped house measured by the server, with `out` left out of the quote. */
function lHouse(out: string[] = [], over: Partial<MeasurementView> = {}): Partial<MeasurementView> {
  const measured = measureRoof({ outline: [L_RING], pitchX12: 6, overhangFt: 1, excludedFacets: out });
  return {
    outline: [L_RING],
    center: at(10, 10),
    roof: measured.roof,
    estimate: measured.estimate,
    facets: measured.roof?.facets.length ?? null,
    excludedFacets: measured.roof?.excluded ?? [],
    structures: [MAIN, SHED, NEIGHBOUR, FAR],
    ...over,
  };
}

/** Opens the measured house with Adjust closed (the facet labels show only then). */
async function openRoof(over: Partial<MeasurementView>) {
  const router = await open(over);
  fireEvent.click(screen.getByRole('button', { name: liftMeasure.adjust }));
  await waitFor(() => expect(document.querySelector('[data-facet-label]')).not.toBeNull());
  return router;
}
const label = (letter: string) => document.querySelector(`[data-facet-label="${letter}"]`) as HTMLButtonElement;
const facetOf = (over: Partial<MeasurementView>, id: string) => over.roof!.facets.find((f) => f.id === id)!;
/** A click on the photo, inside act so what it opens is set up (listeners too) before the test goes on. */
const clickMap = (lngLat: { lng: number; lat: number }) => act(() => mapEmit('click', { lngLat, originalEvent: { target: lastMap().getCanvas() } }));
const lastData = (source: string) => {
  const calls = (lastMap().getSource(source) as { setData: { mock: { calls: unknown[][] } } }).setData.mock.calls;
  return calls[calls.length - 1]?.[0] as { features: { properties: Record<string, unknown> }[] };
};
const betterTotal = (panel: HTMLElement) => within(panel).getByText(liftProposal.totalFor('Better')).nextElementSibling?.textContent;

describe('quoting only some sections of the roof', () => {
  it('a facet label is a button that leaves its section out: pressed state, "Left out", shaded on the photo, saved', async () => {
    await openRoof(lHouse());
    const a = label('A');
    expect(a.tagName).toBe('BUTTON');
    expect(a.getAttribute('aria-label')).toMatch(/^Section A in the quote, [\d,]+ sq ft, 6\/12 pitch$/);
    expect(a.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(liftMeasure.allSectionsInQuote(4))).toBeTruthy();
    expect(screen.getByText(liftMeasure.sectionsHint)).toBeTruthy();
    fireEvent.click(a);
    expect(a.getAttribute('aria-pressed')).toBe('false');
    expect(a.textContent).toContain(liftMeasure.facetLeftOut);
    expect(screen.getByText(liftMeasure.sectionsInQuote(3, 4))).toBeTruthy();
    await waitFor(() => expect(sent('PATCH /api/measurements/m1')).toEqual([{ excludedFacets: ['A'] }]));
    const shaded = lastData('roof-facets-src').features.map((f) => [f.properties.id, f.properties.excluded]);
    expect(shaded).toEqual([['A', true], ['B', false], ['C', false], ['D', false]]);
    // Focus stays on the pressed label: the labels are not made again
    expect(label('A')).toBe(a);
  });

  it('two sections left out: the card, the lines and Good/Better/Best are the other sections\' (a click on the photo toggles too)', async () => {
    pricePerSqFtCents = 1000;
    const house = lHouse();
    await openRoof(house);
    const panel = await screen.findByRole('complementary', { name: liftProposal.label });
    await waitFor(() => expect(betterTotal(panel)).toBe(wholeDollars(Math.round(house.estimate!.surfaceSqFt * 1000 * 1.2))));
    fireEvent.click(label('B'));
    await waitFor(() => expect(sent('PATCH /api/measurements/m1')).toHaveLength(1));
    // Section D by a click on the photo
    clickMap({ lng: facetOf(house, 'D').labelAt[0], lat: facetOf(house, 'D').labelAt[1] });
    await waitFor(() => expect(sent('PATCH /api/measurements/m1')).toEqual([{ excludedFacets: ['B'] }, { excludedFacets: ['B', 'D'] }]));
    const expected = measureRoof({ outline: [L_RING], pitchX12: 6, overhangFt: 1, excludedFacets: ['B', 'D'] });
    const t = quotedTotals(expected.roof!);
    expect(screen.getByText(liftMeasure.sectionsInQuote(2, 4))).toBeTruthy();
    const card = document.querySelector('[data-measure-card]') as HTMLElement;
    expect(within(card).getByText(t.squares.toFixed(1))).toBeTruthy();
    expect(within(card).getByText(liftMeasure.sloped(t.slopedSqFt))).toBeTruthy();
    // The ridge between B and D (both out) no longer counts; the one between A and C does
    expect(card.querySelector('[data-stat="ridges"] dd')?.textContent).toBe(liftMeasure.feet(t.ridgeFt));
    expect(card.querySelector('[data-stat="eaves"] dd')?.textContent).toBe(liftMeasure.feet(t.eaveFt));
    expect(card.querySelector('[data-stat="facets"] dd')?.textContent).toBe('2');
    // The prices are asked for again and are the two sections' (the server prices what it saved)
    await waitFor(() => expect(betterTotal(panel)).toBe(wholeDollars(Math.round(t.slopedSqFt * 1000 * 1.2))));
    expect(within(panel).getByText(liftProposal.sectionsOnly(['A', 'C'], 4))).toBeTruthy();
    // The lines of the left-out sections fade on the photo
    const faded = lastData('roof-lines-src').features.filter((f) => f.properties.quoted === false);
    expect(faded.length).toBeGreaterThan(0);
  });

  it('Include all puts every section back in the quote', async () => {
    await openRoof(lHouse(['A', 'C']));
    expect(label('A').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText(liftMeasure.sectionsInQuote(2, 4))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: liftMeasure.includeAll }));
    await waitFor(() => expect(sent('PATCH /api/measurements/m1')).toEqual([{ excludedFacets: [] }]));
    expect(label('A').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(liftMeasure.allSectionsInQuote(4))).toBeTruthy();
  });

  it('the last section in the quote cannot be left out', async () => {
    await openRoof(lHouse(['A', 'B', 'C']));
    fireEvent.click(label('D'));
    await wait(50);
    expect(sent('PATCH /api/measurements/m1')).toEqual([]);
    expect(label('D').getAttribute('aria-pressed')).toBe('true');
  });

  it('a sent (locked) roof keeps its sections: the labels are disabled and photo clicks change nothing', async () => {
    const house = lHouse(['B'], { locked: true });
    current = view(house);
    renderWindow();
    await waitFor(() => expect(fake.FakeMap.instances.length).toBeGreaterThan(0));
    mapEmit('load');
    await waitFor(() => expect(document.querySelector('[data-facet-label]')).not.toBeNull());
    expect(label('A').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: liftMeasure.includeAll })).toBeNull();
    clickMap({ lng: facetOf(house, 'A').labelAt[0], lat: facetOf(house, 'A').labelAt[1] });
    await wait(50);
    expect(sent('PATCH /api/measurements/m1')).toEqual([]);
  });

  it('a new outline that changes the sections puts them all back in the quote, and says so', async () => {
    await open(lHouse(['A']));
    expect(screen.getByText(liftMeasure.sectionsRule)).toBeTruthy();
    fireEvent.keyDown(corner(0), { key: 'ArrowRight' });
    await waitFor(() => expect(sent('PATCH /api/measurements/m1')).toHaveLength(1), { timeout: 2000 });
    expect(Object.keys(sent('PATCH /api/measurements/m1')[0]!)).toEqual(['outline']);
    expect(await screen.findByText(liftMeasure.sectionsReset)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: liftMeasure.adjust }));
    expect(screen.getByText(liftMeasure.allSectionsInQuote(4))).toBeTruthy();
  });
});

describe('the buildings around the home', () => {
  const row = (name: RegExp) => screen.getByLabelText(name).closest('li') as HTMLElement;

  it('names each building: the main house, a detached building, a probable neighbour\'s house; far ones are not listed', async () => {
    await open(lHouse());
    expect(screen.getByLabelText(/^Main house · 2,475 sq ft$/)).toBeTruthy();
    expect(screen.getByLabelText(/^Detached building · 224 sq ft · \d+ ft away$/)).toBeTruthy();
    expect(screen.getByLabelText(new RegExp(`^Another house · 2,025 sq ft · \\d+ ft away · ${liftMeasure.probablyNeighbours}$`))).toBeTruthy();
    expect(screen.queryByLabelText(/300 sq ft/)).toBeNull();
    expect(screen.getByText(liftMeasure.buildingsHint)).toBeTruthy();
  });

  it('the last building in the quote cannot be left out, so the roof never empties into draw mode', async () => {
    await open(lHouse());
    const main = screen.getByLabelText(/^Main house/) as HTMLInputElement;
    expect(main.disabled).toBe(true);
    expect(within(row(/^Main house/)).getByText(liftMeasure.lastBuilding)).toBeTruthy();
    fireEvent.click(main);
    await wait(50);
    expect(sent('PATCH /api/measurements/m1')).toEqual([]);
    expect(screen.queryByText(measure.drawHint)).toBeNull();
    // With the shed in too, either one may go
    fireEvent.click(screen.getByLabelText(/^Detached building/));
    await waitFor(() => expect(sent('PATCH /api/measurements/m1')).toEqual([{ includedStructures: ['home', 'shed'] }]));
    expect((screen.getByLabelText(/^Main house/) as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(screen.getByLabelText(/^Main house/));
    await waitFor(() => expect(sent('PATCH /api/measurements/m1')).toHaveLength(2));
    expect(sent('PATCH /api/measurements/m1')[1]).toEqual({ includedStructures: ['shed'] });
    expect((screen.getByLabelText(/^Detached building/) as HTMLInputElement).disabled).toBe(true);
  });

  it('hovering or focusing a building\'s row outlines that building on the photo', async () => {
    await open(lHouse());
    const shed = row(/^Detached building/);
    fireEvent.mouseEnter(shed);
    expect(shed.getAttribute('data-hovered')).toBe('true');
    await waitFor(() => expect(lastData('lift-structures-src').features.find((f) => f.properties.hovered)?.properties.id).toBe('shed'));
    expect(lastMap().getLayer('lift-structures-hover')).toBeTruthy();
    fireEvent.mouseLeave(shed);
    await waitFor(() => expect(lastData('lift-structures-src').features.some((f) => f.properties.hovered)).toBe(false));
  });
});

describe('clicking another building on the photo', () => {
  const dialog = () => screen.queryByRole('dialog', { name: liftMeasure.popoverLabel });

  it('a detached building offers Add to this quote first; adding it saves at once and closes the popover', async () => {
    await openRoof(lHouse());
    clickMap(middle(SHED.ring));
    const pop = await screen.findByRole('dialog', { name: liftMeasure.popoverLabel });
    expect(within(pop).getByText(liftMeasure.buildingRole.detached)).toBeTruthy();
    const actions = within(pop).getAllByRole('button').map((b) => b.textContent);
    expect(actions.slice(0, 2)).toEqual([liftMeasure.addToQuote, liftMeasure.measureThisHouse]);
    fireEvent.click(within(pop).getByRole('button', { name: liftMeasure.addToQuote }));
    await waitFor(() => expect(sent('PATCH /api/measurements/m1')).toEqual([{ includedStructures: ['home', 'shed'] }]));
    expect(dialog()).toBeNull();
    // Now in the quote, its popover offers to leave it out
    clickMap(middle(SHED.ring));
    expect(within(await screen.findByRole('dialog')).getByRole('button', { name: liftMeasure.leaveOutOfQuote })).toBeTruthy();
  });

  it('a probable neighbour\'s house offers Measure this house first: it measures that building and opens it with the scan playing', async () => {
    const router = await openRoof(lHouse());
    const spot = middle(NEIGHBOUR.ring);
    clickMap(spot);
    const pop = await screen.findByRole('dialog', { name: liftMeasure.popoverLabel });
    expect(within(pop).getByText(new RegExp(liftMeasure.probablyNeighbours))).toBeTruthy();
    const actions = within(pop).getAllByRole('button').map((b) => b.textContent);
    expect(actions.slice(0, 2)).toEqual([liftMeasure.measureThisHouse, liftMeasure.addToQuote]);
    fireEvent.click(within(pop).getByRole('button', { name: liftMeasure.measureThisHouse }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/estimator/measure/m2'));
    expect(sent('POST /api/estimator/from-footprint')).toEqual([{ footprintId: 'next', lat: spot.lat, lng: spot.lng }]);
    expect(router.state.location.state).toEqual({ autoScan: true });
    expect(sent('PATCH /api/measurements/m1')).toEqual([]);
  });

  it('a spot with no building outline offers to measure the roof there, from the point', async () => {
    const router = await openRoof(lHouse());
    const spot = { lng: at(-200, -200)[0], lat: at(-200, -200)[1] };
    clickMap(spot);
    const pop = await screen.findByRole('dialog', { name: liftMeasure.popoverLabel });
    expect(within(pop).getByText(liftMeasure.otherRoof)).toBeTruthy();
    expect(within(pop).queryByRole('button', { name: liftMeasure.addToQuote })).toBeNull();
    fireEvent.click(within(pop).getByRole('button', { name: liftMeasure.measureThisHouse }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/estimator/measure/m3'));
    expect(sent('POST /api/estimator/from-point')).toEqual([{ lat: spot.lat, lng: spot.lng }]);
  });

  it('Escape, Close and a click elsewhere close the popover (that click toggles nothing)', async () => {
    const house = lHouse();
    await openRoof(house);
    clickMap(middle(SHED.ring));
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(dialog()).toBeNull();
    clickMap(middle(SHED.ring));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: common.close }));
    expect(dialog()).toBeNull();
    clickMap(middle(SHED.ring));
    await screen.findByRole('dialog');
    clickMap({ lng: facetOf(house, 'A').labelAt[0], lat: facetOf(house, 'A').labelAt[1] });
    await waitFor(() => expect(dialog()).toBeNull());
    clickMap(middle(SHED.ring));
    await screen.findByRole('dialog');
    fireEvent.pointerDown(document.querySelector('[data-measure-card]') as HTMLElement);
    expect(dialog()).toBeNull();
    await wait(50);
    expect(sent('PATCH /api/measurements/m1')).toEqual([]);
  });

  it('a rep may add a building but not measure another house, and an empty spot opens nothing', async () => {
    role = 'rep';
    await openRoof(lHouse());
    await wait(50);
    clickMap(middle(NEIGHBOUR.ring));
    const pop = await screen.findByRole('dialog');
    expect(within(pop).queryByRole('button', { name: liftMeasure.measureThisHouse })).toBeNull();
    expect(within(pop).getByRole('button', { name: liftMeasure.addToQuote })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    clickMap({ lng: at(-200, -200)[0], lat: at(-200, -200)[1] });
    await wait(20);
    expect(dialog()).toBeNull();
  });

  it('hovering another building outlines it with a pointer; the main house\'s sections show a pointer too', async () => {
    const house = lHouse();
    await openRoof(house);
    const canvas = lastMap().getCanvas();
    act(() => mapEmit('mousemove', { lngLat: middle(SHED.ring) }));
    expect(canvas.style.cursor).toBe('pointer');
    await waitFor(() => expect(lastData('lift-structures-src').features.find((f) => f.properties.hovered)?.properties.id).toBe('shed'));
    act(() => mapEmit('mousemove', { lngLat: { lng: facetOf(house, 'C').labelAt[0], lat: facetOf(house, 'C').labelAt[1] } }));
    expect(canvas.style.cursor).toBe('pointer');
    await waitFor(() => expect(lastData('lift-structures-src').features.some((f) => f.properties.hovered)).toBe(false));
    act(() => mapEmit('mousemove', { lngLat: { lng: at(-200, -200)[0], lat: at(-200, -200)[1] } }));
    expect(canvas.style.cursor).toBe('');
  });

  it('draw mode keeps every click for the outline: no popover, no section toggled', async () => {
    await open({ drawMode: true, outline: null, structures: [MAIN, SHED] });
    clickMap(middle(SHED.ring));
    await wait(20);
    expect(dialog()).toBeNull();
  });
});

describe('the measure card never hides the roof', () => {
  it('Adjust opens a card capped at 45% of the photo that scrolls inside; the toggle stays outside the scroll, and Done closes it', async () => {
    await open(lHouse());
    const card = document.querySelector('[data-measure-card]') as HTMLElement;
    const toggle = screen.getByRole('button', { name: liftMeasure.adjust });
    expect(card.getAttribute('data-editing')).toBe('true');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const scroller = card.querySelector('[data-card-scroll]') as HTMLElement;
    expect(scroller.contains(screen.getByText(measure.numbersTitle))).toBe(true);
    expect(scroller.contains(toggle)).toBe(false);
    // Open, the numbers fold to one line (the controls list them)
    expect(card.querySelector('[data-compact="true"]')).not.toBeNull();
    const css = readFileSync(`${CARD_CSS_DIR}MeasureCard.module.css`, 'utf8');
    expect(css).toMatch(/\.card\[data-editing="true"\] \{\s*max-height: 45%;/);
    expect(css).toMatch(/\.scroll \{[^}]*overflow-y: auto;/);
    const done = within(scroller).getByRole('button', { name: liftMeasure.done });
    fireEvent.click(done);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(card.getAttribute('data-editing')).toBe('false');
    expect(screen.queryByText(measure.numbersTitle)).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(toggle));
    // The toggle opens and closes it again from the same place
    fireEvent.click(toggle);
    expect(card.getAttribute('data-editing')).toBe('true');
    fireEvent.click(toggle);
    expect(card.getAttribute('data-editing')).toBe('false');
  });

  it('the draw-mode notice and the card share one column (notices first), so they cannot overlap', async () => {
    await open({ drawMode: true, outline: null, structures: [] });
    const hint = screen.getByText(measure.drawHint);
    const notices = hint.closest('[data-notices]') as HTMLElement;
    const card = document.querySelector('[data-measure-card]') as HTMLElement;
    expect(notices.parentElement).toBe(card.parentElement);
    expect(notices.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('opening Adjust frames the roof again above the taller card, and closing it frames it back', async () => {
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 700 });
    try {
      await openRoof(lHouse());
      const fit = lastMap().fitBounds;
      const before = fit.mock.calls.length;
      fireEvent.click(screen.getByRole('button', { name: liftMeasure.adjust }));
      await waitFor(() => expect(fit.mock.calls.length).toBe(before + 1));
      const opened = (fit.mock.calls.at(-1)![1] as { padding: { top: number; bottom: number } }).padding;
      expect(opened).toEqual(roofPadding(800, 700, 0, true));
      fireEvent.click(screen.getByRole('button', { name: liftMeasure.adjust }));
      await waitFor(() => expect(fit.mock.calls.length).toBe(before + 2));
      expect((fit.mock.calls.at(-1)![1] as { padding: unknown }).padding).toEqual(roofPadding(800, 700, 0, false));
    } finally {
      if (width) Object.defineProperty(HTMLElement.prototype, 'clientWidth', width);
      if (height) Object.defineProperty(HTMLElement.prototype, 'clientHeight', height);
    }
  });

  it('the roof is framed again whenever the card changes size (the results card fills in after the first framing)', async () => {
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    const offset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    const realObserver = globalThis.ResizeObserver;
    const watchers: { cb: () => void; target: Element | null }[] = [];
    globalThis.ResizeObserver = class {
      private readonly w: { cb: () => void; target: Element | null };
      constructor(cb: () => void) {
        this.w = { cb, target: null };
        watchers.push(this.w);
      }
      observe(target: Element) {
        this.w.target = target;
      }
      unobserve() {}
      disconnect() {
        this.w.target = null;
      }
    } as unknown as typeof ResizeObserver;
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 700 });
    let cardHeight = 90;
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => cardHeight });
    try {
      await openRoof(lHouse());
      const fit = lastMap().fitBounds;
      const cardWatcher = watchers.find((w) => w.target !== null && (w.target as HTMLElement).hasAttribute('data-measure-card'));
      expect(cardWatcher, 'the card is watched for size changes').toBeDefined();
      const before = fit.mock.calls.length;
      // The review note and the cue make the card taller: the roof is framed above the taller card
      cardHeight = 360;
      cardWatcher!.cb();
      await waitFor(() => expect(fit.mock.calls.length).toBe(before + 1));
      const padding = (fit.mock.calls.at(-1)![1] as { padding: { bottom: number } }).padding;
      expect(padding).toEqual(roofPadding(800, 700, 360, false));
      expect(padding.bottom).toBeGreaterThanOrEqual(360 + 14);
    } finally {
      globalThis.ResizeObserver = realObserver;
      if (width) Object.defineProperty(HTMLElement.prototype, 'clientWidth', width);
      if (height) Object.defineProperty(HTMLElement.prototype, 'clientHeight', height);
      if (offset) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offset);
    }
  });

  it('roofPadding keeps the roof above the card: open, the card (up to 45%) is left out of the roof\'s room', () => {
    const open45 = roofPadding(800, 700, Math.round(700 * 0.45), true);
    expect(open45.bottom).toBeGreaterThanOrEqual(Math.round(700 * 0.45) + 14);
    expect(700 - open45.top - open45.bottom).toBeGreaterThanOrEqual(120);
    // A short photo still leaves the roof its room; the card then scrolls inside
    const short = roofPadding(800, 420, 300, true);
    expect(420 - short.top - short.bottom).toBeGreaterThanOrEqual(120);
    // Closed, with no card measured yet, the usual framing
    expect(roofPadding(800, 700, 0, false)).toEqual({ top: 126, bottom: 189, left: 176, right: 176 });
  });
});
