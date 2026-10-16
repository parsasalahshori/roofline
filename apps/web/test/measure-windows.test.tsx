import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  priceWindows,
  windowCounts,
  WINDOWS_MISS_REASONS,
  WINDOWS_REVIEW_REASONS,
  windowSizeClass,
  type FacadePhoto,
  type MeasuredWindow,
  type WindowMeasurementView,
} from '@roofline/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { liftMeasure } from '../src/copy/liftMeasure.ts';
import { measureWindows as copy, windowPhotos as windowPhotosCopy } from '../src/copy/measureWindows.ts';
import { wholeDollars } from '../src/features/measure/lift/proposalLines.ts';
import { forgetRevealed } from '../src/features/measure/lift/scan.ts';
import {
  boxFromDrag,
  dragBox,
  focusLayout,
  MIN_BOX,
  moveCorner,
  panBy,
  photoLayout,
  rulerSizeLabel,
  shownWindows,
  tiersFromQuotes,
  WHOLE_PHOTO,
  zoomAt,
  zoomLayout,
  zoomTo,
  type Corners,
} from '../src/features/measure/windows/model.ts';
import { sizeShownAt, windowShownAt } from '../src/features/measure/windows/PhotoStage.tsx';
import { WindowsWindow } from '../src/features/measure/windows/WindowsWindow.tsx';

const CORNERS: Corners = [
  [0.2, 0.7],
  [0.8, 0.7],
  [0.8, 0.4],
  [0.2, 0.4],
];

function photo(over: Partial<FacadePhoto> = {}): FacadePhoto {
  return {
    id: 'ph1',
    heading: 180,
    fov: 80,
    widthPx: 640,
    heightPx: 640,
    capturedOn: '2025-06',
    distanceM: 24,
    wallOverlay: { corners: CORNERS, fit: 'good', fitScore: 0.8, headingCorrectionDeg: 1, wallHeightFromPhotoFt: 9 },
    ...over,
  };
}

function win(id: string, x: number, w = 30, h = 50, over: Partial<MeasuredWindow> = {}): MeasuredWindow {
  return { id, photoId: 'ph1', source: 'detector', box: { x, y: 0.45, w: 0.05, h: 0.08 }, widthIn: w, heightIn: h, sizeClass: windowSizeClass(w, h), floor: 1, confidence: 0.9, ...over };
}

function view(over: Partial<WindowMeasurementView> = {}): WindowMeasurementView {
  return {
    id: 'w1',
    propertyId: 'p1',
    address: '214 Brookside Dr, Springdale, AR',
    center: [-94.1, 36.2],
    createdAt: '2026-10-15T12:00:00.000Z',
    photos: [photo()],
    windows: [],
    estimated: { covers: 'all-sides', bySizeClass: { small: 3, standard: 9, large: 2, picture: 1 }, basis: 'One window per 92 sq ft of wall' },
    stories: 1,
    walls: { perimeterFt: 196, wallHeightFt: 9.2, wallAreaSqFt: 1803, frontWallFt: 58 },
    detector: null,
    missing: null,
    needsReview: { reasons: ['estimated-from-size'] },
    adjustments: { excludedWindowIds: [], manualCounts: {}, marked: [] },
    tookMs: 3900,
    // Most tests here drive the Street View tools; the server's default is off (see 'Street View tools off').
    photoTools: true,
    ...over,
  };
}

type Call = { key: string; body: unknown };
let calls: Call[];
let current: WindowMeasurementView;
const sent = (key: string) => calls.filter((c) => c.key === key).map((c) => c.body as Record<string, unknown>);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the server does with a PATCH, for what these tests look at: keeps the body, sizes each marked box (fake sizes). */
function serverPatch(before: WindowMeasurementView, body: Record<string, unknown>): WindowMeasurementView {
  const adjustments = { ...before.adjustments, ...body } as WindowMeasurementView['adjustments'];
  let windows = before.windows;
  let estimated = before.estimated;
  if (Array.isArray(body.marked)) {
    const marks = body.marked as NonNullable<WindowMeasurementView['adjustments']['marked']>;
    windows = [
      ...before.windows.filter((w) => w.source !== 'marked'),
      ...marks.map((m): MeasuredWindow => {
        const w = Math.round(m.box.w * 256);
        const h = Math.round(m.box.h * 375);
        return { id: m.id, photoId: m.photoId, source: 'marked', box: m.box, widthIn: w, heightIn: h, sizeClass: windowSizeClass(w, h), floor: 1, confidence: 1 };
      }),
    ];
    if (marks.length > 0 && estimated !== null) estimated = { ...estimated, covers: 'sides-and-back' };
  }
  let ruler = before.ruler ?? null;
  if ('ruler' in body) {
    const r = body.ruler as NonNullable<WindowMeasurementView['adjustments']['ruler']> | null;
    // The fake server: every ruler says things were coming out 30% small
    ruler = r === null ? null : { photoId: r.photoId, kind: r.kind, widthIn: r.widthIn, heightIn: r.heightIn, measuredWidthIn: Math.round(r.widthIn / 1.3), measuredHeightIn: Math.round(r.heightIn / 1.3), scale: 1.3, rangeM: { before: 16, after: 20.8 }, agreement: 'good' };
    if (r === null) delete adjustments.ruler;
  }
  if (ruler !== null) {
    windows = windows.map((w) =>
      w.source === 'marked' && w.photoId === ruler.photoId ? { ...w, beforeRuler: { widthIn: w.widthIn, heightIn: w.heightIn }, widthIn: Math.round(w.widthIn * 1.3), heightIn: Math.round(w.heightIn * 1.3) } : w,
    );
  }
  return { ...before, adjustments, windows, estimated, ruler };
}

function render_(path: string) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createMemoryRouter(
    [
      { path: 'estimator/windows', element: <WindowsWindow /> },
      { path: 'estimator/windows/:windowMeasurementId', element: <WindowsWindow /> },
    ],
    { initialEntries: [path] },
  );
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return router;
}

/** Opens a measurement and plays its scan to the end (the scan takes 0 ms here unless a test says otherwise). */
async function open(over: Partial<WindowMeasurementView> = {}) {
  current = view(over);
  const router = render_('/estimator/windows/w1');
  fireEvent.click(await screen.findByRole('button', { name: copy.scanButton }));
  await screen.findByRole('heading', { name: copy.measuredBy });
  return router;
}

const card = () => screen.getByRole('region', { name: copy.statsLabel });
const adjust = () => fireEvent.click(within(card()).getByRole('button', { name: new RegExp(copy.adjust) }));
const frame = () => screen.getByRole('group', { name: copy.photoLabel });
function stubRect(el: HTMLElement, w = 640, h = 640) {
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON: () => ({}) });
}

beforeEach(() => {
  forgetRevealed();
  calls = [];
  vi.stubEnv('VITE_MEASURE_SCAN_MS', '0');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ key, body });
      if (key === 'GET /api/auth/me') return json({ user: { id: 'u1', email: 'a@b.c', name: 'A', emailVerified: true }, company: { id: 'c1', name: 'C', slug: 'c', status: 'active' }, role: 'owner', companies: [] });
      if (key === 'GET /api/window-measurements/w1') return json(current);
      if (key === 'GET /api/window-measurements/w1/preview') return json({ quotes: priceWindows(windowCounts(current)) });
      if (key === 'PATCH /api/window-measurements/w1') {
        current = serverPatch(current, body as Record<string, unknown>);
        return json(current);
      }
      if (key === 'POST /api/window-measurements') {
        current = view();
        return json(current, 201);
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

describe('Measure windows: pure pieces', () => {
  it('a drag makes a box either way round, and a click is not a window', () => {
    expect(boxFromDrag([0.5, 0.6], [0.2, 0.3])).toEqual({ x: 0.2, y: 0.3, w: 0.3, h: 0.3 });
    expect(boxFromDrag([0.5, 0.5], [0.502, 0.6])).toBeNull();
    expect(boxFromDrag([-0.2, 0.9], [0.1, 1.4])).toEqual({ x: 0, y: 0.9, w: 0.1, h: 0.1 });
  });

  it('resizing never crosses the box over itself, and moving keeps it on the photo', () => {
    const b = { x: 0.2, y: 0.2, w: 0.1, h: 0.1 };
    expect(dragBox(b, 'e', 0.05, 0)).toEqual({ x: 0.2, y: 0.2, w: 0.15, h: 0.1 });
    expect(dragBox(b, 'w', 0.5, 0).w).toBe(MIN_BOX);
    expect(dragBox(b, 'nw', -0.05, -0.05)).toEqual({ x: 0.15, y: 0.15, w: 0.15, h: 0.15 });
    expect(dragBox(b, 'move', 2, 2)).toEqual({ x: 0.9, y: 0.9, w: 0.1, h: 0.1 });
    expect(moveCorner(CORNERS, 2, 1.3, 0.35)[2]).toEqual([1, 0.35]);
  });

  it('frames the photo: cover keeps the wall in the middle, focus closes in on it, both fill the area', () => {
    const cover = photoLayout(800, 400, 1, 'cover', 0.55);
    expect(cover).toEqual({ left: 0, top: -240, width: 800, height: 800 });
    const contain = photoLayout(800, 400, 1, 'contain');
    expect(contain).toEqual({ left: 200, top: 0, width: 400, height: 400 });
    const focus = focusLayout(800, 400, 1, { x: 0.2, y: 0.4, w: 0.6, h: 0.3 });
    expect(focus.width).toBeGreaterThan(800);
    expect(focus.left).toBeLessThanOrEqual(0);
    expect(focus.left + focus.width).toBeGreaterThanOrEqual(800);
    // The wall's middle sits in the middle of the area
    expect(focus.top + 0.55 * focus.height).toBeCloseTo(200, -1);
  });

  it('reads the company prices back from the quotes, and the defaults for sizes not quoted', () => {
    const quotes = priceWindows({ small: { measured: 0, estimated: 0 }, standard: { measured: 2, estimated: 0 }, large: { measured: 0, estimated: 0 }, picture: { measured: 0, estimated: 0 } }, [
      { tier: 'good', name: 'G', description: 'g', priceCents: { small: 1, standard: 777, large: 3, picture: 4 }, enabled: true },
    ]);
    const tiers = tiersFromQuotes(quotes);
    expect(tiers).toHaveLength(1);
    expect(tiers[0]!.priceCents.standard).toBe(777);
    expect(tiers[0]!.priceCents.small).toBe(45_000);
  });

  it('shows a new mark at once (unsized) and drops a removed one', () => {
    const v = view({ windows: [win('d1', 0.1), win('m1', 0.3, 30, 50, { source: 'marked' })] });
    const shown = shownWindows(v, [{ id: 'm2', photoId: 'ph1', box: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 } }]);
    expect(shown.map((w) => [w.id, w.source, w.sized === null])).toEqual([
      ['d1', 'detector', false],
      ['m2', 'marked', true],
    ]);
  });

  it('the scan shows the windows one by one while it traces and their sizes while it reads', () => {
    expect([0, 1, 2].map((i) => windowShownAt(i, 3))).toEqual([expect.closeTo(0.3417, 3), expect.closeTo(0.4250, 3), expect.closeTo(0.5083, 3)]);
    expect(sizeShownAt(0, 3)).toBe(0.55);
    expect(sizeShownAt(2, 3)).toBeLessThan(0.8);
  });
});

describe('Measure windows: the scan', () => {
  it('waits for Measure windows, then finds the house, traces the walls, shows the windows one by one and ends done', async () => {
    vi.stubEnv('VITE_MEASURE_SCAN_MS', '1500');
    current = view({ windows: [win('d1', 0.25), win('d2', 0.45), win('d3', 0.65)], detector: 'claude', needsReview: null });
    render_('/estimator/windows/w1');
    const start = await screen.findByRole('button', { name: copy.scanButton });
    expect(screen.getByText(copy.scanIntroName)).toBeTruthy();
    expect(document.querySelectorAll('[data-window]')).toHaveLength(0);
    fireEvent.click(start);
    await screen.findByText(copy.stage.finding);
    expect(document.querySelector('[data-scan-overlay]')).not.toBeNull();
    // While it traces, the walls are counted and the windows come in one at a time
    await screen.findByText(copy.stage.tracing(196));
    const seen = new Set<number>();
    await waitFor(
      () => {
        seen.add(document.querySelectorAll('[data-window]').length);
        expect(screen.queryByRole('heading', { name: copy.measuredBy })).not.toBeNull();
      },
      { timeout: 4000, interval: 40 },
    );
    expect([...seen].some((n) => n > 0 && n < 3)).toBe(true);
    expect(document.querySelectorAll('[data-window]')).toHaveLength(3);
    expect(document.querySelector('[data-windows-card]')?.getAttribute('data-phase')).toBe('done');
    expect(document.querySelector('[data-scan-overlay]')).toBeNull();
    expect(screen.getByText(liftMeasure.measuredIn(3.9))).toBeTruthy();
    // The quote opens beside the photo once measured
    expect(screen.getByRole('radiogroup')).toBeTruthy();
  });

  it('plays straight away when opened by a Measure press (autoScan), and the address in the URL is measured once', async () => {
    const router = render_('/estimator/windows?measure=214%20Brookside%20Dr');
    await waitFor(() => expect(router.state.location.pathname).toBe('/estimator/windows/w1'));
    expect(sent('POST /api/window-measurements')).toEqual([{ address: '214 Brookside Dr' }]);
    await screen.findByRole('heading', { name: copy.measuredBy });
    expect(screen.queryByRole('button', { name: copy.scanButton })).toBeNull();
  });

  it('the roof screen’s Windows switch measures the same property', async () => {
    const router = render_('/estimator/windows?property=p1');
    await waitFor(() => expect(router.state.location.pathname).toBe('/estimator/windows/w1'));
    expect(sent('POST /api/window-measurements')).toEqual([{ propertyId: 'p1' }]);
  });

  it('the Roof | Windows switch carries the address to the roof screen', async () => {
    await open();
    const nav = screen.getByRole('navigation', { name: copy.switchLabel });
    expect(within(nav).getByRole('link', { name: copy.switchRoof }).getAttribute('href')).toBe(`/estimator?measure=${encodeURIComponent('214 Brookside Dr, Springdale, AR')}`);
    expect(within(nav).getByRole('link', { name: copy.switchWindows }).getAttribute('aria-current')).toBe('page');
  });
});

describe('Measure windows: the card', () => {
  it('leads with About N windows estimated from the walls, the walls basis and the size table', async () => {
    await open();
    const c = card();
    expect(within(c).getByText(copy.fromWalls)).toBeTruthy();
    expect(within(c).getByText(copy.about)).toBeTruthy();
    expect(c.querySelector('[data-stat="windows"]')?.textContent).toBe('15');
    // Each fact once (it used to repeat itself: the walls, then the server's own sentence about the same walls).
    const basis = c.querySelector('[data-fact="basis"] dd')!.textContent!;
    expect(basis).toBe('196 ft of wall, 1 floor (from the height map), eaves 9 ft up. About 15 windows');
    expect(basis.match(/196 ft/g)).toHaveLength(1);
    expect(c.querySelector('[data-fact="floors"] dd')?.textContent).toBe('1 floor (from the height map)');
    expect(within(c).getByRole('columnheader', { name: copy.estimatedAll })).toBeTruthy();
    const row = (cls: string) => c.querySelector(`[data-size-class="${cls}"]`)!;
    expect([...row('standard').querySelectorAll('td')].map((td) => td.textContent)).toEqual(['0', '9', '9']);
    expect([...row('picture').querySelectorAll('td')].map((td) => td.textContent)).toEqual(['0', '1', '1']);
    expect(row('standard').querySelector('[data-col="estimated"]')?.hasAttribute('data-estimated')).toBe(true);
    expect(within(c).getByText(copy.reviewReason['estimated-from-size'])).toBeTruthy();
    expect(within(c).getByText('Jun 2025')).toBeTruthy();
    expect(within(c).getByText(copy.foundBy.none)).toBeTruthy();
  });

  it('front windows measured: the estimate covers the sides and back, and the totals add up', async () => {
    await open({
      windows: [win('m1', 0.3, 36, 60, { source: 'marked' }), win('d1', 0.5, 20, 30)],
      adjustments: { excludedWindowIds: [], manualCounts: {}, marked: [{ id: 'm1', photoId: 'ph1', box: win('m1', 0.3).box }] },
      estimated: { covers: 'sides-and-back', bySizeClass: { small: 1, standard: 6, large: 0, picture: 0 }, basis: 'Sides and back' },
      needsReview: { reasons: ['front-only'] },
    });
    const c = card();
    expect(c.querySelector('[data-stat="windows"]')?.textContent).toBe('9');
    expect(within(c).getByText(copy.measuredAndEstimated(2, 7))).toBeTruthy();
    expect(within(c).getByRole('columnheader', { name: copy.estimatedSidesBack })).toBeTruthy();
    expect([...c.querySelector('[data-size-class="standard"]')!.querySelectorAll('td')].map((td) => td.textContent)).toEqual(['1', '6', '7']);
    expect(within(c).getByText(copy.foundBy.marked)).toBeTruthy();
    // The detector's window carries the auto-found chip; the marked one does not
    expect(document.querySelector('[data-window="d1"]')?.textContent).toContain(copy.autoFound);
    expect(document.querySelector('[data-window="m1"]')?.textContent).not.toContain(copy.autoFound);
    expect(screen.getByRole('button', { name: copy.windowLabel(1, copy.size(36, 60), true) })).toBeTruthy();
  });

  it.each(WINDOWS_MISS_REASONS)('says why no window was seen (%s) and still shows the estimate', async (reason) => {
    await open({ missing: { reason }, photos: reason === 'no-street-view' || reason === 'house-blurred' ? [] : [photo()] });
    expect(document.querySelector(`[data-missing="${reason}"]`)?.textContent).toBe(copy.missing[reason]);
    expect(card().querySelector('[data-stat="windows"]')?.textContent).toBe('15');
  });

  it('no estimate and nothing seen: says to type the counts in', async () => {
    await open({ missing: { reason: 'no-footprint' }, estimated: null, walls: null });
    expect(screen.getByText(copy.noEstimate)).toBeTruthy();
  });

  it.each(WINDOWS_REVIEW_REASONS.filter((r) => r !== 'stand-in-detector'))('lists the review reason %s', async (reason) => {
    await open({ needsReview: { reasons: [reason] } });
    expect(within(card()).getByText(copy.reviewReason[reason])).toBeTruthy();
  });

  it('the demo detector cannot be missed: an alert over the photo', async () => {
    await open({ detector: 'stand-in', windows: [win('s1', 0.3)], needsReview: { reasons: ['stand-in-detector'] } });
    const alert = screen.getAllByRole('alert').find((a) => a.hasAttribute('data-stand-in'));
    expect(alert?.textContent).toBe('Demo detector: these windows are made up. Add a detector key for real windows.');
    expect(within(card()).getByText(copy.foundBy.standIn)).toBeTruthy();
  });

  it('no stand-in banner for the default (no detector)', async () => {
    await open();
    expect(document.querySelector('[data-stand-in]')).toBeNull();
  });
});

describe('Measure windows: Street View tools off (the default)', () => {
  // As the server answers with WINDOWS_STREET_VIEW_TOOLS off: no wall drawn on the photo, photoTools false.
  const off = (over: Partial<WindowMeasurementView> = {}) => open({ photoTools: false, photos: [photo({ wallOverlay: undefined })], ...over });

  it('keeps the photo as an "is this the right house?" picture with its date; no wall, no marking, no ruler', async () => {
    await off();
    expect(screen.getByText(copy.rightHouse('Jun 2025'))).toBeTruthy();
    expect(screen.queryByRole('img', { name: copy.wallOutlineLabel })).toBeNull();
    expect(document.querySelector('[data-fit="good"], [data-fit="off"], [data-fit="unknown"]')).toBeNull();
    // The review note points at on-site photos, not at marking the street photo.
    expect(within(card()).getByText(copy.estimatedFromSizeNoTools)).toBeTruthy();
    expect(within(card()).queryByText(copy.foundBy.none)).toBeNull();
    adjust();
    expect(document.querySelector('[data-wall-corner]')).toBeNull();
    expect(screen.queryByRole('heading', { name: copy.wallTitle })).toBeNull();
    expect(screen.queryByRole('heading', { name: copy.markTitle })).toBeNull();
    expect(screen.queryByRole('button', { name: copy.markStart })).toBeNull();
    expect(document.querySelector('[data-ruler-panel]')).toBeNull();
    // On-site photos stay.
    expect(screen.getAllByRole('button', { name: windowPhotosCopy.add }).length).toBeGreaterThan(0);
  });

  it('even a stale wall on the photo and a "walls" review are not shown', async () => {
    await open({ photoTools: false, needsReview: { reasons: ['estimated-from-size'] } });
    expect(screen.queryByRole('img', { name: copy.wallOutlineLabel })).toBeNull();
    expect(document.querySelector('[data-fit="good"], [data-fit="off"], [data-fit="unknown"]')).toBeNull();
  });
});

describe('Measure windows: floors and ranges', () => {
  it('shows an unsure count as a range, most likely in between, and says where the floors came from', async () => {
    await open({
      stories: 2,
      walls: { perimeterFt: 220, wallHeightFt: 19.4, wallAreaSqFt: 4268, frontWallFt: 58, windowWallSqFt: 3240, lowWingFt: 40, floorsFrom: 'height-map', outlineFrom: 'footprint' },
      estimated: { covers: 'all-sides', bySizeClass: { small: 5, standard: 17, large: 3, picture: 1 }, range: { low: 26, high: 29 }, basis: 'x' },
    });
    const c = card();
    expect(c.querySelector('[data-stat="windows"]')?.textContent).toBe(copy.range(26, 29));
    expect(within(c).getByText(copy.mostLikely(26))).toBeTruthy();
    expect(c.querySelector('[data-fact="floors"] dd')?.textContent).toBe('2 floors (from the height map)');
    const basis = c.querySelector('[data-fact="basis"] dd')!.textContent!;
    expect(basis).toBe(
      '220 ft of wall, 2 floors (from the height map), eaves 19 ft up. 40 ft of a low one-storey wing (likely a garage or porch) left out. About 26 to 29 windows, most likely 26',
    );
  });

  it('no height data: "1 floor (assumed)", and no eave height', async () => {
    await open({ stories: null, walls: { perimeterFt: 196, wallHeightFt: 9, wallAreaSqFt: 1764, frontWallFt: 58, floorsFrom: 'assumed' } });
    expect(card().querySelector('[data-fact="floors"] dd')?.textContent).toBe('1 floor (assumed: no height data)');
    expect(card().querySelector('[data-fact="basis"] dd')?.textContent).toBe('196 ft of wall, 1 floor (assumed: no height data). About 15 windows');
  });

  it('a storey and a half reads 1.5 floors', async () => {
    await open({ stories: 1.5 });
    expect(card().querySelector('[data-fact="floors"] dd')?.textContent).toBe('1.5 floors (from the height map)');
  });

  it('an outline from Google’s roof says so', async () => {
    await open({ walls: { perimeterFt: 196, wallHeightFt: 9.2, wallAreaSqFt: 1803, frontWallFt: 58, outlineFrom: 'google-roof', floorsFrom: 'height-map' } });
    expect(card().querySelector('[data-fact="basis"] dd')?.textContent).toContain('Outline from Google’s roof');
  });
});

describe('Measure windows: the front wall on the photo', () => {
  it('draws the wall from its corners: ground line, eave line and sides', async () => {
    await open();
    const svg = screen.getByRole('img', { name: copy.wallOutlineLabel });
    const edges = [...svg.querySelectorAll('line')].map((l) => [l.dataset.edge, l.getAttribute('x1'), l.getAttribute('y1'), l.getAttribute('x2'), l.getAttribute('y2')]);
    expect(edges).toEqual([
      ['ground', '20', '70', '80', '70'],
      ['side', '80', '70', '80', '40'],
      ['eave', '80', '40', '20', '40'],
      ['side', '20', '40', '20', '70'],
    ]);
  });

  it.each([
    ['good', copy.wallFit.good],
    ['off', copy.wallFit.off],
    ['unknown', copy.wallFit.unknown],
  ] as const)('the fit chip for %s', async (fit, text) => {
    await open({ photos: [photo({ wallOverlay: { corners: CORNERS, fit, fitScore: null, headingCorrectionDeg: 0, wallHeightFromPhotoFt: fit === 'unknown' ? null : 9 } })] });
    const chip = document.querySelector(`[data-fit="${fit}"]`)!;
    expect(chip.textContent).toContain(text);
    if (fit === 'unknown') expect(chip.textContent).not.toContain('from photo');
    else expect(chip.textContent).toContain(copy.wallHeights(9.2, 9));
  });

  it('a corner dragged in Adjust PATCHes wallCorners once, 500 ms after the drag ends', async () => {
    await open();
    adjust();
    const corner = document.querySelector('[data-wall-corner="tr"]') as HTMLElement;
    expect(corner.getAttribute('aria-label')).toBe(copy.wallCornerLabel(copy.wallCorner.tr));
    stubRect(frame());
    fireEvent.pointerDown(corner, { clientX: 512, clientY: 256, pointerId: 1 });
    fireEvent.pointerMove(frame(), { clientX: 540, clientY: 240, pointerId: 1 });
    fireEvent.pointerMove(frame(), { clientX: 560, clientY: 230, pointerId: 1 });
    fireEvent.pointerUp(frame(), { clientX: 560, clientY: 230, pointerId: 1 });
    await wait(200);
    expect(sent('PATCH /api/window-measurements/w1')).toHaveLength(0);
    await waitFor(() => expect(sent('PATCH /api/window-measurements/w1')).toHaveLength(1));
    expect(sent('PATCH /api/window-measurements/w1')[0]).toEqual({
      wallCorners: { photoId: 'ph1', corners: [CORNERS[0], CORNERS[1], [0.875, 0.3594], CORNERS[3]] },
    });
    await wait(600);
    expect(sent('PATCH /api/window-measurements/w1')).toHaveLength(1);
  });

  it('a corner moves with the arrow keys too', async () => {
    await open();
    adjust();
    fireEvent.keyDown(document.querySelector('[data-wall-corner="bl"]')!, { key: 'ArrowLeft' });
    await waitFor(() => expect(sent('PATCH /api/window-measurements/w1')).toHaveLength(1));
    expect((sent('PATCH /api/window-measurements/w1')[0]!.wallCorners as { corners: Corners }).corners[0]).toEqual([0.195, 0.7]);
  });
});

describe('Measure windows: Adjust', () => {
  it('a window clicked on the photo is left out, then back in: one PATCH, and the numbers follow at once', async () => {
    await open({ windows: [win('d1', 0.3, 36, 60)], needsReview: null });
    const box = screen.getByRole('button', { name: copy.windowLabel(1, copy.size(36, 60), true) });
    fireEvent.click(box);
    expect(card().querySelector('[data-stat="windows"]')?.textContent).toBe('15');
    expect(screen.getByRole('button', { name: copy.windowLabel(1, copy.size(36, 60), false) })).toBeTruthy();
    await wait(200);
    expect(sent('PATCH /api/window-measurements/w1')).toHaveLength(0);
    await waitFor(() => expect(sent('PATCH /api/window-measurements/w1')).toEqual([{ excludedWindowIds: ['d1'] }]));
  });

  it('the steppers change the estimated counts: several presses, one PATCH', async () => {
    await open();
    adjust();
    const up = screen.getByRole('button', { name: copy.stepUp(copy.sizeClass.standard) });
    fireEvent.click(up);
    fireEvent.click(up);
    fireEvent.click(screen.getByRole('button', { name: copy.stepDown(copy.sizeClass.small) }));
    expect(screen.getByLabelText(copy.stepValue(copy.sizeClass.standard)).textContent).toBe('11');
    await wait(200);
    expect(sent('PATCH /api/window-measurements/w1')).toHaveLength(0);
    await waitFor(() => expect(sent('PATCH /api/window-measurements/w1')).toHaveLength(1));
    expect(sent('PATCH /api/window-measurements/w1')[0]).toEqual({ manualCounts: { standard: 11, small: 2 } });
    fireEvent.click(screen.getByRole('button', { name: copy.resetCounts }));
    await waitFor(() => expect(sent('PATCH /api/window-measurements/w1')).toHaveLength(2));
    expect(sent('PATCH /api/window-measurements/w1')[1]).toEqual({ manualCounts: {} });
  });

  it('marking: a drag on the photo draws a window, the server sizes it, and the estimate turns to sides and back', async () => {
    await open();
    adjust();
    fireEvent.click(screen.getByRole('button', { name: copy.markStart }));
    stubRect(frame());
    fireEvent.pointerDown(frame(), { clientX: 128, clientY: 256, pointerId: 1 });
    fireEvent.pointerMove(frame(), { clientX: 160, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(frame(), { clientX: 192, clientY: 320, pointerId: 1 });
    fireEvent.pointerUp(frame(), { clientX: 192, clientY: 320, pointerId: 1 });
    // Shown at once, unsized
    expect(document.querySelectorAll('[data-window]')).toHaveLength(1);
    expect(document.querySelector('[data-window]')?.textContent).toContain(copy.sizing);
    await waitFor(() => expect(sent('PATCH /api/window-measurements/w1')).toHaveLength(1));
    const marked = sent('PATCH /api/window-measurements/w1')[0]!.marked as { id: string; photoId: string; box: unknown }[];
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ photoId: 'ph1', box: { x: 0.2, y: 0.4, w: 0.1, h: 0.1 } });
    // The size comes back from the server
    await waitFor(() => expect(document.querySelector('[data-window]')?.textContent).toContain(copy.size(26, 38)));
    fireEvent.click(within(card()).getByRole('button', { name: copy.done }));
    expect(within(card()).getByRole('columnheader', { name: copy.estimatedSidesBack })).toBeTruthy();
  });

  it('marking: Delete removes the selected window, and Undo brings it back', async () => {
    const box = { x: 0.3, y: 0.45, w: 0.05, h: 0.08 };
    await open({ windows: [win('m1', 0.3, 36, 60, { source: 'marked' })], adjustments: { excludedWindowIds: [], manualCounts: {}, marked: [{ id: 'm1', photoId: 'ph1', box }] } });
    adjust();
    fireEvent.click(screen.getByRole('button', { name: copy.markStart }));
    const marked = screen.getByRole('button', { name: copy.markedLabel(1, copy.size(36, 60)) });
    fireEvent.click(marked);
    expect(marked.getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(marked, { key: 'Delete' });
    expect(document.querySelectorAll('[data-window]')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: copy.undo }));
    expect(document.querySelectorAll('[data-window]')).toHaveLength(1);
    // Two changes inside the pause: one PATCH, with the window back
    await waitFor(() => expect(sent('PATCH /api/window-measurements/w1')).toHaveLength(1));
    expect(sent('PATCH /api/window-measurements/w1')[0]).toEqual({ marked: [{ id: 'm1', photoId: 'ph1', box }] });
  });

  it('marking: a selected window resizes from a handle and moves with the arrow keys', async () => {
    const box = { x: 0.3, y: 0.45, w: 0.05, h: 0.08 };
    await open({ windows: [win('m1', 0.3, 36, 60, { source: 'marked' })], adjustments: { excludedWindowIds: [], manualCounts: {}, marked: [{ id: 'm1', photoId: 'ph1', box }] } });
    adjust();
    fireEvent.click(screen.getByRole('button', { name: copy.markStart }));
    const marked = screen.getByRole('button', { name: copy.markedLabel(1, copy.size(36, 60)) });
    fireEvent.click(marked);
    stubRect(frame(), 1000, 1000);
    const handle = document.querySelector('[data-window="m1"] [data-handle="se"]') as HTMLElement;
    fireEvent.pointerDown(handle, { clientX: 350, clientY: 530, pointerId: 2 });
    fireEvent.pointerMove(frame(), { clientX: 370, clientY: 560, pointerId: 2 });
    fireEvent.pointerUp(frame(), { clientX: 370, clientY: 560, pointerId: 2 });
    fireEvent.keyDown(marked, { key: 'ArrowRight' });
    await waitFor(() => expect(sent('PATCH /api/window-measurements/w1')).toHaveLength(1));
    expect((sent('PATCH /api/window-measurements/w1')[0]!.marked as { box: unknown }[])[0]!.box).toEqual({ x: 0.305, y: 0.45, w: 0.07, h: 0.11 });
  });
});

describe('Measure windows: Adjust shows the whole photo, with zoom and pan', () => {
  /** The photo area measures 800 x 400 px (jsdom has no layout): the photo, 1:1, contains at 400 x 400. */
  function withArea() {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get(this: HTMLElement) { return this.dataset.fit !== undefined ? 800 : 0; } });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get(this: HTMLElement) { return this.dataset.fit !== undefined ? 400 : 0; } });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private cb: () => void) {}
        observe() {
          this.cb();
        }
        disconnect() {}
      },
    );
    // The originals live on Element.prototype: taking these away restores them
    return () => {
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
      delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    };
  }
  const area = () => frame().parentElement as HTMLElement;
  const box = () => ({ left: parseFloat(frame().style.left), top: parseFloat(frame().style.top), width: parseFloat(frame().style.width) });

  it('pure: zoom 1 is the whole photo; zoom keeps the point under the pointer; pan stops at the edges; zoom to a box frames it', () => {
    expect(zoomLayout(800, 400, 1, WHOLE_PHOTO)).toEqual({ left: 200, top: 0, width: 400, height: 400 });
    const z = zoomAt(800, 400, 1, WHOLE_PHOTO, 3, 300, 100);
    const l = zoomLayout(800, 400, 1, z);
    expect(l.width).toBe(1200);
    // The photo point that was under (300, 100) is still there: (300-200)/400 = 0.25 across, 0.25 down
    expect(l.left + 0.25 * l.width).toBeCloseTo(300, 0);
    expect(l.top + 0.25 * l.height).toBeCloseTo(100, 0);
    const far = panBy(800, 400, 1, z, 5000, 5000);
    expect(zoomLayout(800, 400, 1, far)).toMatchObject({ left: 0, top: 0 });
    expect(zoomAt(800, 400, 1, WHOLE_PHOTO, 0.2, 400, 200)).toEqual(WHOLE_PHOTO);
    const wall = zoomTo(800, 400, 1, { x: 0.2, y: 0.4, w: 0.3, h: 0.2 });
    expect(wall.z).toBeGreaterThan(1.5);
    const wl = zoomLayout(800, 400, 1, wall);
    expect(wl.left + 0.2 * wl.width).toBeGreaterThanOrEqual(0);
    expect(wl.left + 0.5 * wl.width).toBeLessThanOrEqual(800);
  });

  it('Adjust opens on the whole photo (not cropped to the wall); +, wheel, pinch, zoom to the wall and Whole photo', async () => {
    const restore = withArea();
    try {
      // A window outside the drawn wall: Adjust must still show it
      await open({ windows: [win('d1', 0.85, 36, 60)] });
      expect(area().dataset.fit).toBe('cover');
      adjust();
      expect(area().dataset.fit).toBe('zoom');
      expect(box()).toEqual({ left: 200, top: 0, width: 400 });
      const bar = screen.getByRole('toolbar', { name: copy.zoomLabel });
      expect(within(bar).getByRole('button', { name: copy.zoomOut }).hasAttribute('disabled')).toBe(true);
      fireEvent.click(within(bar).getByRole('button', { name: copy.zoomIn }));
      expect(box().width).toBe(600);
      expect(area().dataset.zoom).toBe('1.5');
      fireEvent.click(within(bar).getByRole('button', { name: copy.zoomWhole }));
      expect(box()).toEqual({ left: 200, top: 0, width: 400 });
      // The wheel zooms round the pointer, and the page does not scroll
      const wheel = new WheelEvent('wheel', { deltaY: -100, clientX: 400, clientY: 200, bubbles: true, cancelable: true });
      act(() => {
        area().dispatchEvent(wheel);
      });
      expect(wheel.defaultPrevented).toBe(true);
      expect(box().width).toBe(600);
      // Not marking: a drag pans the zoomed photo
      stubRect(frame());
      // (600 px wide in an 800 px area it stays centred across; 600 px tall in 400 it moves up and down)
      const before = box();
      fireEvent.pointerDown(frame(), { clientX: 300, clientY: 200, pointerId: 1, button: 0 });
      fireEvent.pointerMove(frame(), { clientX: 360, clientY: 260, pointerId: 1 });
      fireEvent.pointerUp(frame(), { clientX: 360, clientY: 260, pointerId: 1 });
      expect(box()).toEqual({ ...before, top: before.top + 60 });
      // Two fingers: a pinch zooms
      fireEvent.click(within(bar).getByRole('button', { name: copy.zoomWhole }));
      fireEvent.pointerDown(frame(), { clientX: 350, clientY: 200, pointerId: 11, pointerType: 'touch' });
      fireEvent.pointerDown(frame(), { clientX: 450, clientY: 200, pointerId: 12, pointerType: 'touch' });
      fireEvent.pointerMove(frame(), { clientX: 300, clientY: 200, pointerId: 11, pointerType: 'touch' });
      fireEvent.pointerMove(frame(), { clientX: 500, clientY: 200, pointerId: 12, pointerType: 'touch' });
      fireEvent.pointerUp(frame(), { pointerId: 11, pointerType: 'touch' });
      fireEvent.pointerUp(frame(), { pointerId: 12, pointerType: 'touch' });
      expect(box().width).toBe(800);
      expect(sent('PATCH /api/window-measurements/w1')).toHaveLength(0);
      fireEvent.click(within(bar).getByRole('button', { name: copy.zoomWall }));
      expect(box().width).toBeGreaterThan(400);
      // Done, then Adjust again: the whole photo again
      fireEvent.click(within(card()).getByRole('button', { name: copy.done }));
      adjust();
      expect(box()).toEqual({ left: 200, top: 0, width: 400 });
    } finally {
      restore();
    }
  });

  it('marking while zoomed: the box is where the drag was on the photo, and two fingers do not draw', async () => {
    const restore = withArea();
    try {
      await open();
      adjust();
      fireEvent.click(within(screen.getByRole('toolbar', { name: copy.zoomLabel })).getByRole('button', { name: copy.zoomIn }));
      fireEvent.click(within(screen.getByRole('toolbar', { name: copy.zoomLabel })).getByRole('button', { name: copy.zoomIn }));
      fireEvent.click(screen.getByRole('button', { name: copy.markStart }));
      // Zoomed: the frame is 900 px wide, its left edge off the area to the left
      frame().getBoundingClientRect = () => ({ left: -50, top: -250, right: 850, bottom: 650, width: 900, height: 900, x: -50, y: -250, toJSON: () => ({}) });
      fireEvent.pointerDown(frame(), { clientX: 130, clientY: 110, pointerId: 1, button: 0 });
      fireEvent.pointerMove(frame(), { clientX: 220, clientY: 200, pointerId: 1 });
      fireEvent.pointerUp(frame(), { clientX: 220, clientY: 200, pointerId: 1 });
      await waitFor(() => expect(sent('PATCH /api/window-measurements/w1')).toHaveLength(1));
      expect(sent('PATCH /api/window-measurements/w1')[0]!.marked).toEqual([{ id: expect.any(String), photoId: 'ph1', box: { x: 0.2, y: 0.4, w: 0.1, h: 0.1 } }]);
      // Two fingers while marking pinch, they never draw a window
      fireEvent.pointerDown(frame(), { clientX: 300, clientY: 200, pointerId: 21, pointerType: 'touch' });
      fireEvent.pointerDown(frame(), { clientX: 400, clientY: 200, pointerId: 22, pointerType: 'touch' });
      fireEvent.pointerMove(frame(), { clientX: 250, clientY: 200, pointerId: 21, pointerType: 'touch' });
      fireEvent.pointerUp(frame(), { pointerId: 21, pointerType: 'touch' });
      fireEvent.pointerUp(frame(), { pointerId: 22, pointerType: 'touch' });
      expect(document.querySelectorAll('[data-window]')).toHaveLength(1);
      // The corners still drag while zoomed
      const corner = document.querySelector('[data-wall-corner="tr"]') as HTMLElement;
      fireEvent.pointerDown(corner, { clientX: 0, clientY: 0, pointerId: 3 });
      fireEvent.pointerMove(frame(), { clientX: 625, clientY: 110, pointerId: 3 });
      fireEvent.pointerUp(frame(), { clientX: 625, clientY: 110, pointerId: 3 });
      await waitFor(() => expect(sent('PATCH /api/window-measurements/w1')).toHaveLength(2));
      expect((sent('PATCH /api/window-measurements/w1')[1]!.wallCorners as { corners: Corners }).corners[2]).toEqual([0.75, 0.4]);
    } finally {
      restore();
    }
  });

  it('the photo takes touches while Adjust is open (no page pan or zoom under a pinch or a drag)', () => {
    const css = readFileSync([resolve(process.cwd(), 'src/features/measure/windows/WindowsWindow.module.css'), resolve(process.cwd(), 'apps/web/src/features/measure/windows/WindowsWindow.module.css')].find((p) => existsSync(p))!, 'utf8');
    expect(css).toMatch(/\.photoFrame\[data-adjusting="true"\] \{[^}]*touch-action: none;/);
    expect(css).toMatch(/\.photoFrame\[data-dragging\] \{[^}]*touch-action: none;/);
  });
});

describe('Measure windows: a door as a ruler', () => {
  const panel = () => document.querySelector('[data-ruler-panel]') as HTMLElement;

  it('garage door first (16 × 7 ft); the reliability note says why; Mark the door, drag, and every window is re-sized', async () => {
    const box = { x: 0.3, y: 0.45, w: 0.05, h: 0.08 };
    await open({ windows: [win('m1', 0.3, 28, 46, { source: 'marked' })], adjustments: { excludedWindowIds: [], manualCounts: {}, marked: [{ id: 'm1', photoId: 'ph1', box }] } });
    adjust();
    expect(within(panel()).getByText(copy.rulerHint)).toBeTruthy();
    expect(copy.rulerHint).toMatch(/garage door[^.]*flush/i);
    expect(copy.rulerHint).toMatch(/front door[^.]*set back/i);
    const kind = within(panel()).getByLabelText(copy.rulerKindLabel) as HTMLSelectElement;
    expect(kind.value).toBe('garage-door');
    const size = within(panel()).getByLabelText(copy.rulerSizeLabel) as HTMLSelectElement;
    expect([...size.options].map((o) => o.textContent)).toEqual(['16 × 7 ft', '9 × 7 ft', '18 × 7 ft', '16 × 8 ft']);
    fireEvent.change(kind, { target: { value: 'front-door' } });
    expect([...(within(panel()).getByLabelText(copy.rulerSizeLabel) as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['36 × 80 in', '32 × 80 in', '72 × 80 in']);
    fireEvent.click(within(panel()).getByRole('button', { name: copy.rulerMark }));
    expect(frame().dataset.rulerMarking).toBe('true');
    stubRect(frame());
    fireEvent.pointerDown(frame(), { clientX: 320, clientY: 320, pointerId: 1, button: 0 });
    fireEvent.pointerMove(frame(), { clientX: 352, clientY: 384, pointerId: 1 });
    fireEvent.pointerUp(frame(), { clientX: 352, clientY: 384, pointerId: 1 });
    // The ruler is drawn at once, not as a window
    expect(document.querySelector('[data-ruler="front-door"]')?.getAttribute('aria-label')).toBe(copy.rulerBoxLabel('Front door', '36 × 80 in'));
    expect(document.querySelectorAll('[data-window]')).toHaveLength(1);
    await waitFor(() => expect(sent('PATCH /api/window-measurements/w1')).toHaveLength(1));
    expect(sent('PATCH /api/window-measurements/w1')[0]).toEqual({ ruler: { photoId: 'ph1', box: { x: 0.5, y: 0.5, w: 0.05, h: 0.1 }, kind: 'front-door', widthIn: 36, heightIn: 80 } });
    // The server's answer: the windows re-sized, what was used, and how
    await waitFor(() => expect(document.querySelector('[data-ruler-chip]')?.textContent).toBe(copy.rulerUsed('Front door', '36 × 80 in')));
    expect(copy.rulerUsed('Front door', '36 × 80 in')).toBe('Sized using the front door as a ruler (36 × 80 in)');
    expect(within(panel()).getByText(copy.rulerAssumption(16, 20.8))).toBeTruthy();
    expect(within(panel()).getByText(copy.rulerFrontDoorNote)).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: `${copy.includeWindow(1)} · ${copy.size(36, 60)} · ${copy.wasSize(28, 46)}` })).toBeTruthy();
    expect(document.querySelector('[data-window="m1"]')?.textContent).toContain(copy.size(36, 60));
  });

  it('a custom size, a size change after marking, and taking the ruler away', async () => {
    await open({ adjustments: { excludedWindowIds: [], manualCounts: {}, marked: [], ruler: { photoId: 'ph1', box: { x: 0.2, y: 0.5, w: 0.3, h: 0.1 }, kind: 'garage-door', widthIn: 192, heightIn: 84 } } });
    adjust();
    expect(within(panel()).getByRole('button', { name: copy.rulerMarkAgain })).toBeTruthy();
    fireEvent.change(within(panel()).getByLabelText(copy.rulerSizeLabel), { target: { value: '3' } });
    await waitFor(() => expect(sent('PATCH /api/window-measurements/w1')).toHaveLength(1));
    expect(sent('PATCH /api/window-measurements/w1')[0]).toMatchObject({ ruler: { kind: 'garage-door', widthIn: 192, heightIn: 96 } });
    fireEvent.change(within(panel()).getByLabelText(copy.rulerKindLabel), { target: { value: 'custom' } });
    await waitFor(() => expect(sent('PATCH /api/window-measurements/w1')).toHaveLength(2));
    expect(sent('PATCH /api/window-measurements/w1')[1]).toMatchObject({ ruler: { kind: 'custom', widthIn: 36, heightIn: 80 } });
    const width = within(panel()).getByLabelText(copy.rulerCustomWidth);
    fireEvent.change(width, { target: { value: '400' } });
    expect(within(panel()).getByRole('button', { name: copy.rulerMarkAgain }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(width, { target: { value: '42' } });
    fireEvent.blur(width);
    await waitFor(() => expect(sent('PATCH /api/window-measurements/w1')).toHaveLength(3));
    expect(sent('PATCH /api/window-measurements/w1')[2]).toMatchObject({ ruler: { kind: 'custom', widthIn: 42, heightIn: 80 } });
    fireEvent.click(within(panel()).getByRole('button', { name: copy.rulerRemove }));
    expect(document.querySelector('[data-ruler="custom"]')).toBeNull();
    await waitFor(() => expect(sent('PATCH /api/window-measurements/w1')).toHaveLength(4));
    expect(sent('PATCH /api/window-measurements/w1')[3]).toEqual({ ruler: null });
    expect(rulerSizeLabel(192, 84, 'garage-door')).toBe('16 × 7 ft');
  });

  it("the walls can't be confirmed: says so, and the review note points at the corners and the ruler", async () => {
    await open({ photos: [photo({ wallOverlay: { corners: CORNERS, fit: 'unknown', fitScore: 0.43, headingCorrectionDeg: 0, wallHeightFromPhotoFt: null } })], needsReview: { reasons: ['walls-unconfirmed'] } });
    expect(document.querySelector('[data-fit="unknown"]')?.textContent).toContain("Can\u2019t confirm the walls in this photo");
    expect(document.querySelector('[data-reason="walls-unconfirmed"]')?.textContent).toMatch(/ruler/);
  });
});

describe('Measure windows: the quote', () => {
  it('Good, Better and Best match priceWindows, Better picked, and follow a change at once', async () => {
    await open();
    const panel = screen.getByRole('complementary', { name: 'Proposal' });
    const expected = priceWindows(windowCounts(current));
    await waitFor(() => expect(within(panel).getAllByRole('radio')).toHaveLength(3));
    for (const q of expected) expect(within(panel).getByText(q.name)).toBeTruthy();
    const better = expected.find((q) => q.tier === 'better')!;
    expect(within(panel).getByRole('radio', { checked: true }).textContent).toContain(wholeDollars(better.totalCents));
    expect(within(panel).getByText(copy.quoteLine(15, 0))).toBeTruthy();
    expect(within(panel).getByText(copy.quoteLineName(copy.sizeClass.standard))).toBeTruthy();
    // Send is off until window proposals exist
    const send = within(panel).getByRole('button', { name: copy.send });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    expect(within(panel).getByText(copy.sendNext)).toBeTruthy();
    // One more standard window: Better goes up by its price straight away
    adjust();
    fireEvent.click(screen.getByRole('button', { name: copy.stepUp(copy.sizeClass.standard) }));
    expect(within(panel).getByRole('radio', { checked: true }).textContent).toContain(wholeDollars(better.totalCents + 80_000));
    await act(() => wait(600));
  });
});

describe('Measure windows: reduced motion and touch', () => {
  // Run from the repo or from apps/web
  const source = (path: string) => readFileSync([resolve(process.cwd(), path), resolve(process.cwd(), 'apps/web', path)].find((p) => existsSync(p))!, 'utf8');
  const css = source('src/features/measure/windows/WindowsWindow.module.css');
  const scanCss = source('src/features/measure/lift/ScanOverlay.module.css');

  it('turns the wall and window animations off, and the sweep stands still', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.wallEdge,\s*\.box\[data-fresh="true"\] \{\s*animation: none;/);
    expect(scanCss).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.sweep \{\s*top: 30%;\s*animation: none;/);
  });

  it('drags on the photo never pan the page: no touch scrolling while marking, or on the corners and handles', () => {
    expect(css).toMatch(/\.photoFrame\[data-marking="true"\] \{[^}]*touch-action: none;/);
    expect(css).toMatch(/\.corner \{[^}]*touch-action: none;/);
    expect(css).toMatch(/\.handle \{[^}]*touch-action: none;/);
  });
});
