import { EMPTY_GUTTER_ADJUSTMENTS, eaveHeight, gutterView, instantEstimate, measureRoof, type GutterAdjustments, type GutterMeasurementView, type Ring } from '@roofline/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { liftProposal } from '../src/copy/liftMeasure.ts';
import { measureGutters as copy } from '../src/copy/measureGutters.ts';
import { GuttersWindow } from '../src/features/measure/gutters/GuttersWindow.tsx';
import { forgetRevealed } from '../src/features/measure/lift/scan.ts';
import type { MeasurementView } from '../src/features/measure/types.ts';

/* MapLibre stand-in (jsdom has no WebGL), as in measure.test.tsx: records the map and lets a test emit its events. */
const fake = vi.hoisted(() => {
  type Handler = (payload?: unknown) => void;
  class FakeMap {
    static instances: FakeMap[] = [];
    private listeners: { type: string; fn: Handler }[] = [];
    constructor(readonly options: Record<string, unknown>) {
      FakeMap.instances.push(this);
    }
    // A degree is 5,000,000 pixels: the 12 m house is about 640 pixels across.
    project = ([lng, lat]: [number, number]) => ({ x: (lng + 96.8) * 5e6 + 400, y: (32.8 - lat) * 5e6 + 300 });
    fitBounds = vi.fn();
    isStyleLoaded = () => true;
    resize = vi.fn();
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
  return { FakeMap };
});
vi.mock('maplibre-gl', () => ({ Map: fake.FakeMap }));

const LNG = -96.8;
const LAT = 32.8;
const M_PER_DEG = 111320;
/** A 12 x 10 m house: a hip roof, four eave runs and four outside corners. */
function rectM(w: number, h: number): Ring {
  const dx = w / (M_PER_DEG * Math.cos((LAT * Math.PI) / 180)) / 2;
  const dy = h / M_PER_DEG / 2;
  return [
    [LNG - dx, LAT - dy],
    [LNG + dx, LAT - dy],
    [LNG + dx, LAT + dy],
    [LNG - dx, LAT + dy],
  ];
}

let current: MeasurementView;
let adjustments: GutterAdjustments;
let role: string;
let patches: Record<string, unknown>[];
let reportEaveFt: number | null;

function measurement(ring: Ring): MeasurementView {
  const measured = measureRoof({ outline: [ring], pitchX12: 6, overhangFt: 1 });
  return {
    id: 'm1',
    propertyId: 'p1',
    jobId: null,
    kind: 'estimate',
    method: 'outline',
    drawMode: false,
    hasCustomer: true,
    roof: measured.roof,
    outline: [ring],
    structures: [],
    overhangFt: 1,
    center: [LNG, LAT],
    estimate: instantEstimate({ outline: [ring], pitchX12: 6, overhangFt: 1, valleyFt: 0 }),
    facets: measured.roof?.facets.length ?? null,
    providerRef: null,
    notes: null,
    createdAt: '2026-10-15T12:00:00.000Z',
    locked: false,
  };
}

/** What the API answers: the same pure rules, quotes only for those who see money. */
const serverView = (): GutterMeasurementView =>
  gutterView('m1', current.roof, eaveHeight({ floors: 1 }), adjustments, role === 'rep' ? null : undefined, { reportEaveFt });

const serverViewWith = (extra: Partial<GutterAdjustments>): GutterMeasurementView =>
  gutterView('m1', current.roof, eaveHeight({ floors: 1 }), { ...adjustments, ...extra }, undefined, { reportEaveFt });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderWindow() {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createMemoryRouter([{ path: 'estimator/measure/:measurementId/gutters', element: <GuttersWindow /> }], {
    initialEntries: ['/estimator/measure/m1/gutters'],
  });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
}

const lastMap = () => fake.FakeMap.instances[fake.FakeMap.instances.length - 1]!;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const card = () => screen.getByRole('region', { name: copy.cardLabel });
const stat = (name: string) => card().querySelector(`[data-stat="${name}"]`)?.textContent ?? '';

/** Opens the gutters, starts the map and plays the (instant) scan. */
async function open() {
  renderWindow();
  await waitFor(() => expect(fake.FakeMap.instances.length).toBeGreaterThan(0));
  lastMap().emit('load');
  fireEvent.click(await screen.findByRole('button', { name: copy.scanButton }));
  await screen.findByRole('button', { name: copy.adjust });
}

beforeEach(() => {
  forgetRevealed();
  fake.FakeMap.instances.length = 0;
  current = measurement(rectM(12, 10));
  adjustments = { ...EMPTY_GUTTER_ADJUSTMENTS };
  role = 'owner';
  patches = [];
  reportEaveFt = null;
  vi.stubEnv('VITE_MAPTILER_KEY', '');
  vi.stubEnv('VITE_MAP_TILES', '');
  vi.stubEnv('VITE_MEASURE_SCAN_MS', '0');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (key === 'GET /api/auth/me')
        return json({ user: { id: 'u1', email: 'a@b.c', name: 'A', emailVerified: true }, company: { id: 'c1', name: 'C', slug: 'c', status: 'active' }, role, companies: [] });
      if (key === 'GET /api/measurements/m1') return json(current);
      if (key === 'GET /api/measurements/m1/gutters') return json(serverView());
      if (key === 'PATCH /api/measurements/m1/gutters') {
        patches.push(body);
        // The server stamps who changed it
        adjustments = { ...adjustments, ...(body as Partial<GutterAdjustments>), adjustedBy: { name: 'Dana Cole', at: '2026-10-16T15:00:00.000Z' } };
        return json(serverView());
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

describe('Measure gutters', () => {
  it('waits for Measure gutters, then draws the runs, downspouts and rakes and shows the numbers and quotes', async () => {
    await open();
    const v = serverView();
    expect(v.runs).toHaveLength(4);
    expect(stat('gutter-ft')).toBe(Math.round(v.totals.gutterFt).toLocaleString('en-US'));
    expect(stat('downspouts')).toBe(copy.downspoutsValue(v.totals.downspouts, v.totals.downspoutFt));
    expect(stat('corners')).toBe(copy.cornersValue(0, 4));
    expect(stat('size')).toBe(copy.sizeValue('5in', '2x3'));
    expect(stat('eave')).toBe(copy.heightValue(10, 1));
    expect(card().querySelector('[data-size-reason]')?.textContent).toContain(v.size.reason);
    expect(document.querySelectorAll('[data-run-label]')).toHaveLength(4);
    expect(document.querySelectorAll('[data-downspout]')).toHaveLength(v.totals.downspouts);
    // A hip roof has no rakes; every label is a pressed (included) button named for its side
    expect(document.querySelectorAll('[data-rake]')).toHaveLength(0);
    const label = screen.getByRole('button', { name: copy.runButton(copy.side[v.runs[0]!.side], v.runs[0]!.lengthFt, false) });
    expect(label.getAttribute('aria-pressed')).toBe('true');
    // Good, Better and Best
    const panel = screen.getByRole('complementary', { name: liftProposal.label });
    expect(within(panel).getAllByRole('radio')).toHaveLength(3);
    // The switch shows Gutters as the page
    expect(screen.getByRole('link', { name: copy.switchGutters }).getAttribute('aria-current')).toBe('page');
  });

  it('a gable draws its rakes greyed and no gutter on them', async () => {
    current = measurement(rectM(20, 10));
    await open();
    expect(document.querySelectorAll('[data-rake]').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('[data-run-label]')).toHaveLength(2);
  });

  it('tapping a run leaves it out at once and saves once, 500 ms after the last change', async () => {
    await open();
    const before = serverView();
    const run = before.runs[0]!;
    const name = copy.runButton(copy.side[run.side], run.lengthFt, false);
    fireEvent.click(screen.getByRole('button', { name }));
    const out = screen.getByRole('button', { name: copy.runButton(copy.side[run.side], run.lengthFt, true) });
    expect(out.getAttribute('aria-pressed')).toBe('false');
    expect(stat('gutter-ft')).toBe(Math.round(before.totals.gutterFt - run.lengthFt).toLocaleString('en-US'));
    expect(stat('corners')).toBe(copy.cornersValue(0, 2));
    expect(patches).toHaveLength(0);
    // A second tap puts it back before the save: one PATCH with the final state
    fireEvent.click(out);
    fireEvent.click(screen.getByRole('button', { name }));
    await wait(650);
    expect(patches).toEqual([{ excludedRunIds: [run.id], downspouts: {}, size: null, addedRuns: [], totalFt: null }]);
  });

  it('Adjust: more downspouts on a run and a size chosen by hand update the numbers and save', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: copy.adjust }));
    const v = serverView();
    const runName = copy.runName(1, copy.side[v.runs[0]!.side], false);
    fireEvent.click(screen.getByRole('button', { name: copy.more(runName) }));
    fireEvent.click(screen.getByRole('button', { name: copy.size6 }));
    expect(screen.getByRole('button', { name: copy.size6 }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: copy.done }));
    expect(stat('downspouts')).toBe(copy.downspoutsValue(v.totals.downspouts + 1, v.totals.downspoutFt + 10));
    expect(stat('size')).toBe(copy.sizeValue('6in', '3x4'));
    await wait(650);
    expect(patches).toEqual([{ excludedRunIds: [], downspouts: { [v.runs[0]!.id]: 2 }, size: '6in', addedRuns: [], totalFt: null }]);
    // Saved: the card names who changed it
    await waitFor(() => expect(card().querySelector('[data-adjusted-by]')?.textContent).toBe(copy.adjustedBy('Dana Cole', '2026-10-16T15:00:00.000Z')));
  });

  it('an estimate is a draft: no Recommended or Built by Estimator marks, and a note to check it', async () => {
    await open();
    const panel = screen.getByRole('complementary', { name: liftProposal.label });
    expect(within(panel).queryByText(liftProposal.builtBy)).toBeNull();
    expect(within(panel).queryByText(liftProposal.recommended)).toBeNull();
    expect(panel.querySelector('[data-quote-draft]')?.textContent).toBe(copy.quoteDraft);
    expect(card().querySelector('[data-kind="estimate"]')?.textContent).toBe(copy.confidenceTag.estimate);
    expect(card().querySelector('[data-draft]')?.textContent).toBe(copy.draftNote);
    // The send button stays off
    expect(screen.getByRole('button', { name: copy.send })).toHaveProperty('disabled', true);
  });

  it('Adjust: a run added by hand joins the total, saves, and the quote is vouched for again', async () => {
    await open();
    const before = serverView();
    fireEvent.click(screen.getByRole('button', { name: copy.adjust }));
    const form = document.querySelector('[data-add-run]') as HTMLElement;
    fireEvent.change(within(form).getByLabelText(copy.addLabel), { target: { value: 'Upper floor, back' } });
    fireEvent.change(within(form).getByLabelText(copy.addLength), { target: { value: '40' } });
    fireEvent.click(within(form).getByRole('button', { name: copy.addRun }));
    expect(document.querySelector('[data-added-row="A1"]')?.textContent).toContain('Upper floor, back');
    fireEvent.click(screen.getByRole('button', { name: copy.done }));
    expect(stat('gutter-ft')).toBe(Math.round(before.totals.gutterFt + 40).toLocaleString('en-US'));
    expect(card().querySelector('[data-kind="adjusted"]')?.textContent).toBe(copy.confidenceTag.adjusted);
    const panel = screen.getByRole('complementary', { name: liftProposal.label });
    expect(within(panel).getByText(liftProposal.builtBy)).toBeTruthy();
    expect(within(panel).getByText(liftProposal.recommended)).toBeTruthy();
    await wait(650);
    expect(patches).toEqual([{ excludedRunIds: [], downspouts: {}, size: null, addedRuns: [{ id: 'A1', label: 'Upper floor, back', lengthFt: 40 }], totalFt: null }]);
  });

  it('Adjust: refuses a length out of range, and removes an added run', async () => {
    adjustments = { ...EMPTY_GUTTER_ADJUSTMENTS, addedRuns: [{ id: 'A1', label: 'Porch', lengthFt: 20 }] };
    await open();
    fireEvent.click(screen.getByRole('button', { name: copy.adjust }));
    const form = document.querySelector('[data-add-run]') as HTMLElement;
    fireEvent.change(within(form).getByLabelText(copy.addLength), { target: { value: '900' } });
    fireEvent.click(within(form).getByRole('button', { name: copy.addRun }));
    expect(within(form).getByText(copy.addLengthError)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy.removeAdded('Porch') }));
    expect(document.querySelector('[data-added-row]')).toBeNull();
    await wait(650);
    expect(patches).toEqual([{ excludedRunIds: [], downspouts: {}, size: null, addedRuns: [], totalFt: null }]);
  });

  it('Adjust: a total typed in replaces the measured length and prices', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: copy.adjust }));
    const form = document.querySelector('[data-total-form]') as HTMLElement;
    fireEvent.change(within(form).getByLabelText(copy.totalLabel), { target: { value: '300' } });
    fireEvent.click(within(form).getByRole('button', { name: copy.totalSet }));
    fireEvent.click(screen.getByRole('button', { name: copy.done }));
    expect(stat('gutter-ft')).toBe('300');
    expect(card().querySelector('[data-length-source="override"]')).not.toBeNull();
    expect(screen.getByText(copy.quoteLine(300, serverViewWith({ totalFt: 300 }).totals.downspouts))).toBeTruthy();
    await wait(650);
    expect(patches).toEqual([{ excludedRunIds: [], downspouts: {}, size: null, addedRuns: [], totalFt: 300 }]);
  });

  it("an exact report's eave length is the total, vouched for", async () => {
    reportEaveFt = 212;
    await open();
    expect(stat('gutter-ft')).toBe('212');
    expect(card().querySelector('[data-length-source="eagleview"]')?.textContent).toBe(copy.lengthFrom.eagleview(serverView().totals.measuredFt));
    expect(card().querySelector('[data-review="gutters-check"]')).toBeNull();
    const panel = screen.getByRole('complementary', { name: liftProposal.label });
    expect(within(panel).getByText(liftProposal.builtBy)).toBeTruthy();
  });

  it('flags gutter length that looks low for the house, and says how much of the outline the gutters cover', async () => {
    // Only one eave of the hip left: about a quarter of the perimeter
    const roof = current.roof!;
    const firstEave = roof.lines.find((l) => l.kind === 'eave')!;
    current = { ...current, roof: { ...roof, lines: roof.lines.filter((l) => l.kind !== 'eave' || l === firstEave) } };
    await open();
    const flag = card().querySelector('[data-review="gutters-check"]') as HTMLElement;
    expect(flag.textContent).toContain(copy.checkLow);
    const v = serverView();
    expect(card().querySelector('[data-coverage]')?.textContent).toBe(copy.coverage(v.check.perimeterFt, v.check.share));
    // Add runs opens Adjust at the runs the map missed
    fireEvent.click(within(flag).getByRole('button', { name: copy.checkAddRuns }));
    expect(document.querySelector('[data-added-runs]')).not.toBeNull();
  });

  it('a whole hip roof is not flagged', async () => {
    await open();
    expect(card().querySelector('[data-review="gutters-check"]')).toBeNull();
  });

  it('a rep sees the gutters without prices', async () => {
    role = 'rep';
    await open();
    expect(stat('gutter-ft')).not.toBe('');
    expect(screen.getByText(copy.noMoney)).toBeTruthy();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });
});
