import {
  focalPxFrom35mm,
  priceWindows,
  sizeFromKnownSide,
  sizeFromReference,
  windowCounts,
  windowSizeClass,
  type PhotoWindow,
  type PhotoWindowInput,
  type Quad,
  type WindowMeasurementView,
  type WindowPhotoUpload,
} from '@roofline/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { measureWindows, windowPhotos as copy } from '../src/copy/measureWindows.ts';
import { forgetRevealed } from '../src/features/measure/lift/scan.ts';
import { PhotoMeasure } from '../src/features/measure/windows/PhotoMeasure.tsx';
import { livePhotoWindows, seedPaperQuad, seedWindowQuad, sizePhotoWindow } from '../src/features/measure/windows/photoModel.ts';
import { WindowsWindow } from '../src/features/measure/windows/WindowsWindow.tsx';

/** A generated photo: 1200 x 1600, a window seen at an angle and a sheet of letter paper on its glass. */
const UPLOAD: WindowPhotoUpload = { id: 'up1', widthPx: 1200, heightPx: 1600, focal35mm: 26, takenAt: null };
const WIN: Quad = [
  [300, 380],
  [930, 430],
  [910, 1250],
  [320, 1300],
];
const PAPER: Quad = [
  [540, 700],
  [700, 712],
  [697, 925],
  [540, 935],
];
const round1 = (v: number) => Math.round(v * 10) / 10;
const sizeText = (s: { widthIn: number; heightIn: number }) => copy.size(round1(s.widthIn), round1(s.heightIn));

function stubRect(el: Element, w = 1200, h = 1600) {
  (el as HTMLElement).getBoundingClientRect = () => ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON: () => ({}) });
}
const photoFrame = () => screen.getByRole('group', { name: copy.photoLabel });
const handle = (which: 'window' | 'paper', i: number) => document.querySelector(`[data-which="${which}"][data-corner="${i}"]`) as HTMLElement;
/** Drags a corner to a spot (photo pixels; the frame is stubbed at 1 px per photo pixel). */
function dragTo(which: 'window' | 'paper', i: number, [x, y]: [number, number]) {
  const [sx, sy] = [handle(which, i).style.left, handle(which, i).style.top].map((v) => Number.parseFloat(v));
  fireEvent.pointerDown(handle(which, i), { clientX: (sx! / 100) * 1200, clientY: (sy! / 100) * 1600, pointerId: 1 });
  fireEvent.pointerMove(photoFrame(), { clientX: (x + (sx! / 100) * 1200) / 2, clientY: (y + (sy! / 100) * 1600) / 2, pointerId: 1 });
  fireEvent.pointerMove(photoFrame(), { clientX: x, clientY: y, pointerId: 1 });
  fireEvent.pointerUp(photoFrame(), { clientX: x, clientY: y, pointerId: 1 });
}
const liveSize = () => document.querySelector('[data-live-size]')?.textContent ?? '';

describe('Measure a window on its photo (PhotoMeasure)', () => {
  /** The measure view on the paper method (the measuring sheet is the default now; it has its own tests). */
  function renderMeasure(initial: PhotoWindowInput | null = null, saved: PhotoWindow | null = null) {
    const onSave = vi.fn();
    render(<PhotoMeasure upload={UPLOAD} src="/x.jpg" initial={initial} saved={saved} onSave={onSave} onCancel={vi.fn()} />);
    if (initial === null) fireEvent.click(screen.getByRole('tab', { name: new RegExp(copy.methodReference) }));
    stubRect(photoFrame());
    return onSave;
  }
  afterEach(cleanup);

  it('starts with the window inset 15% and a small sheet of paper in the middle (Paper on the glass)', () => {
    renderMeasure();
    expect(screen.getByRole('tab', { selected: true }).textContent).toContain(copy.methodReference);
    expect(seedWindowQuad(1200, 1600)).toEqual([
      [180, 240],
      [1020, 240],
      [1020, 1360],
      [180, 1360],
    ]);
    expect(handle('window', 0).style.left).toBe('15%');
    const paper = seedPaperQuad(1200, 1600);
    expect(paper[0][0]).toBeGreaterThan(450);
    expect(paper[2][0]).toBeLessThan(750);
    expect(handle('paper', 2)).not.toBeNull();
    expect(handle('window', 0).getAttribute('aria-label')).toBe(copy.windowCornerLabel(copy.windowCorner[0]));
  });

  it('dragging the corners onto the paper and the window shows the size live, as the shared math works it out', () => {
    renderMeasure();
    for (let i = 0; i < 4; i++) dragTo('paper', i, PAPER[i]!);
    for (let i = 0; i < 3; i++) dragTo('window', i, WIN[i]!);
    // Part way: no size yet (a corner still where it started is a guess, not the window)
    const partial = sizeFromReference([WIN[0], WIN[1], WIN[2], seedWindowQuad(1200, 1600)[3]], PAPER, 8.5, 11)!;
    expect(liveSize()).not.toContain(sizeText(partial));
    expect(liveSize()).toContain(copy.cornersFirst(7, 8));
    expect((screen.getByRole('button', { name: copy.save }) as HTMLButtonElement).disabled).toBe(true);
    dragTo('window', 3, WIN[3]);
    const expected = sizeFromReference(WIN, PAPER, 8.5, 11)!;
    expect(liveSize()).toContain(sizeText(expected));
    expect(liveSize()).toContain(copy.live);
    // About a 33 x 43 inch window in this photo
    expect(expected.widthIn).toBeGreaterThan(30);
    expect(expected.heightIn).toBeGreaterThan(40);
  });

  it('a corner moves with the arrow keys (Shift for bigger steps)', () => {
    renderMeasure();
    fireEvent.keyDown(handle('window', 0), { key: 'ArrowRight' });
    fireEvent.keyDown(handle('window', 0), { key: 'ArrowDown', shiftKey: true });
    // 1600 / 400 = 4 px a step, 16 with Shift
    expect(handle('window', 0).style.left).toBe(`${(184 / 1200) * 100}%`);
    expect(handle('window', 0).style.top).toBe(`${(256 / 1600) * 100}%`);
  });

  it('A4 or legal paper changes the size', () => {
    renderMeasure();
    for (let i = 0; i < 4; i++) dragTo('paper', i, PAPER[i]!);
    for (let i = 0; i < 4; i++) dragTo('window', i, WIN[i]!);
    fireEvent.change(screen.getByLabelText(copy.paperSize), { target: { value: 'legal' } });
    expect(liveSize()).toContain(sizeText(sizeFromReference(WIN, PAPER, 8.5, 14)!));
  });

  it('I measured one side: hides the paper, and sizes from the window’s corners and the typed side', () => {
    renderMeasure();
    for (let i = 0; i < 4; i++) dragTo('window', i, WIN[i]!);
    fireEvent.click(screen.getByRole('tab', { name: copy.methodKnownSide }));
    expect(handle('paper', 0)).toBeNull();
    expect(liveSize()).toContain(copy.typeSide);
    fireEvent.change(screen.getByLabelText(copy.inches), { target: { value: '36' } });
    const focal = focalPxFrom35mm(26, 1200, 1600);
    expect(liveSize()).toContain(sizeText(sizeFromKnownSide(WIN, 1200, 1600, 'width', 36, focal)!));
    fireEvent.change(screen.getByLabelText(copy.side), { target: { value: 'height' } });
    expect(liveSize()).toContain(sizeText(sizeFromKnownSide(WIN, 1200, 1600, 'height', 36, focal)!));
  });

  it('Save hands back the window with its label, corners and scale', () => {
    const onSave = renderMeasure();
    for (let i = 0; i < 4; i++) dragTo('paper', i, PAPER[i]!);
    for (let i = 0; i < 4; i++) dragTo('window', i, WIN[i]!);
    fireEvent.change(screen.getByLabelText(copy.label), { target: { value: 'Kitchen' } });
    fireEvent.click(screen.getByRole('button', { name: copy.save }));
    expect(onSave).toHaveBeenCalledWith({
      id: expect.stringMatching(/^photo-/),
      uploadId: 'up1',
      label: 'Kitchen',
      corners: WIN,
      scale: { kind: 'reference', reference: 'letter', corners: PAPER },
    });
  });

  it('the server’s size wins while the corners are the ones it sized', () => {
    const input: PhotoWindowInput = { id: 'pw1', uploadId: 'up1', corners: WIN, scale: { kind: 'reference', reference: 'letter', corners: PAPER } };
    renderMeasure(input, { ...input, widthIn: 33, heightIn: 44, sizeClass: 'large', quality: 'check' });
    expect(liveSize()).toContain(copy.size(33, 44));
    expect(liveSize()).toContain(copy.fromServer);
    expect(screen.getByText(copy.check)).toBeTruthy();
    fireEvent.keyDown(handle('window', 0), { key: 'ArrowLeft' });
    expect(liveSize()).toContain(copy.live);
  });

  it('livePhotoWindows: the server’s sizes for unchanged windows, the browser’s for changed ones', () => {
    const input: PhotoWindowInput = { id: 'pw1', uploadId: 'up1', corners: WIN, scale: { kind: 'reference', reference: 'letter', corners: PAPER } };
    const server: PhotoWindow = { ...input, widthIn: 33, heightIn: 44, sizeClass: 'large', quality: 'good' };
    expect(livePhotoWindows([input], [server], [UPLOAD])[0]).toMatchObject({ widthIn: 33, fromServer: true });
    const moved = { ...input, corners: [[310, 380], WIN[1], WIN[2], WIN[3]] as Quad };
    const local = livePhotoWindows([moved], [server], [UPLOAD])[0]!;
    expect(local.fromServer).toBe(false);
    expect(local.widthIn).toBe(sizePhotoWindow(moved, UPLOAD)!.widthIn);
    expect(livePhotoWindows([input], [], [])).toEqual([]);
  });
});

/* The windows screen with the flow, against a mocked server. */

type Reply = { status: number; body: unknown };
let xhrReplies: Reply[];
let xhrSent: { url: string; field: string | null }[];
class FakeXHR {
  status = 0;
  responseText = '';
  withCredentials = false;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private url = '';
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  send(form: FormData) {
    xhrSent.push({ url: this.url, field: form.get('photo') instanceof File ? 'photo' : null });
    const reply = xhrReplies.shift() ?? { status: 201, body: UPLOAD };
    setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
      setTimeout(() => {
        this.status = reply.status;
        this.responseText = JSON.stringify(reply.body);
        this.onload?.();
      }, 20);
    }, 10);
  }
}

let calls: { key: string; body: unknown }[];
let current: WindowMeasurementView;
const sent = (key: string) => calls.filter((c) => c.key === key).map((c) => c.body as Record<string, unknown>);
const PATCH = 'PATCH /api/window-measurements/w1';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function view(over: Partial<WindowMeasurementView> = {}): WindowMeasurementView {
  return {
    id: 'w1',
    propertyId: 'p1',
    address: '214 Brookside Dr',
    center: [-94.1, 36.2],
    createdAt: '2026-10-15T12:00:00.000Z',
    photos: [],
    windows: [],
    estimated: { covers: 'all-sides', bySizeClass: { small: 3, standard: 9, large: 2, picture: 1 }, basis: 'b' },
    stories: 1,
    walls: { perimeterFt: 196, wallHeightFt: 9.2, wallAreaSqFt: 1803, frontWallFt: 58 },
    detector: null,
    missing: null,
    needsReview: null,
    adjustments: { excludedWindowIds: [], manualCounts: {} },
    tookMs: 0,
    ...over,
  };
}

/** The server sizes photographed windows with the shared math (as the API does). */
function serverPatch(before: WindowMeasurementView, body: Record<string, unknown>): WindowMeasurementView {
  const adjustments = { ...before.adjustments, ...body } as WindowMeasurementView['adjustments'];
  const photoWindows = (adjustments.photoWindows ?? []).map((w): PhotoWindow => {
    const s = sizePhotoWindow(w, UPLOAD)!;
    return { ...w, ...s, sizeClass: windowSizeClass(s.widthIn, s.heightIn), quality: 'good' };
  });
  return { ...before, adjustments, photoWindows, uploads: before.uploads ?? [UPLOAD] };
}

const SAVED_INPUT: PhotoWindowInput = { id: 'pw1', uploadId: 'up1', label: 'Kitchen', corners: WIN, scale: { kind: 'reference', reference: 'letter', corners: PAPER } };
const savedView = () => serverPatch(view({ uploads: [UPLOAD] }), { photoWindows: [SAVED_INPUT] });

async function open(v: WindowMeasurementView = view()) {
  current = v;
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createMemoryRouter([{ path: 'estimator/windows/:windowMeasurementId', element: <WindowsWindow /> }], { initialEntries: ['/estimator/windows/w1'] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  fireEvent.click(await screen.findByRole('button', { name: measureWindows.scanButton }));
  await screen.findByRole('heading', { name: measureWindows.measuredBy });
}
const card = () => screen.getByRole('region', { name: measureWindows.statsLabel });
const stat = () => card().querySelector('[data-stat="windows"]')?.textContent;

beforeEach(() => {
  forgetRevealed();
  calls = [];
  xhrReplies = [];
  xhrSent = [];
  vi.stubEnv('VITE_MEASURE_SCAN_MS', '0');
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ key, body });
      if (key === 'GET /api/window-measurements/w1') return json(current);
      if (key === 'GET /api/window-measurements/w1/preview') return json({ quotes: priceWindows(windowCounts(current)) });
      if (key === PATCH) {
        current = serverPatch(current, body as Record<string, unknown>);
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

describe('Photograph windows on site', () => {
  it('take a photo, upload it with progress, size the window on it, save: one PATCH after 500 ms, listed in the card', async () => {
    await open();
    fireEvent.click(within(card()).getByRole('button', { name: copy.add }));
    const dialog = screen.getByRole('dialog', { name: copy.title });
    expect(within(dialog).getByText(copy.guidance)).toBeTruthy();
    const camera = within(dialog).getByLabelText(copy.takeLabel) as HTMLInputElement;
    expect(camera.getAttribute('capture')).toBe('environment');
    expect(camera.accept).toBe('image/*');
    expect(camera.multiple).toBe(true);
    fireEvent.change(camera, { target: { files: [new File(['x'], 'kitchen.jpg', { type: 'image/jpeg' })] } });
    expect(await within(dialog).findByRole('progressbar', { name: copy.uploading('kitchen.jpg') })).toBeTruthy();
    fireEvent.click(await within(dialog).findByRole('button', { name: copy.measure }));
    expect(xhrSent).toEqual([{ url: '/api/window-measurements/w1/uploads', field: 'photo' }]);

    fireEvent.click(screen.getByRole('tab', { name: new RegExp(copy.methodReference) }));
    stubRect(photoFrame());
    for (let i = 0; i < 4; i++) dragTo('paper', i, PAPER[i]!);
    for (let i = 0; i < 4; i++) dragTo('window', i, WIN[i]!);
    expect(liveSize()).toContain(sizeText(sizeFromReference(WIN, PAPER, 8.5, 11)!));
    fireEvent.change(screen.getByLabelText(copy.label), { target: { value: 'Kitchen' } });
    fireEvent.click(screen.getByRole('button', { name: copy.save }));
    // Back on the photos, ready for the next one
    expect(within(dialog).getByText(copy.measured)).toBeTruthy();
    await wait(200);
    expect(sent(PATCH)).toHaveLength(0);
    await waitFor(() => expect(sent(PATCH)).toHaveLength(1));
    expect(sent(PATCH)[0]).toEqual({ photoWindows: [{ id: expect.stringMatching(/^photo-/), uploadId: 'up1', label: 'Kitchen', corners: WIN, scale: { kind: 'reference', reference: 'letter', corners: PAPER } }] });
    fireEvent.click(within(dialog).getByRole('button', { name: copy.close }));
    expect(screen.queryByRole('dialog')).toBeNull();
    const row = card().querySelector('[data-photo-window]')!;
    expect(row.textContent).toContain('Kitchen');
    expect(row.textContent).toContain(copy.chip);
    const s = sizePhotoWindow({ corners: WIN, scale: { kind: 'reference', reference: 'letter', corners: PAPER } }, UPLOAD)!;
    expect(row.textContent).toContain(measureWindows.size(s.widthIn, s.heightIn));
    // Measured now: 1 photographed + 15 estimated
    expect(stat()).toBe('16');
  });

  it('a photo the server refuses says why, and can be tried again', async () => {
    xhrReplies = [{ status: 422, body: { error: 'The photo could not be read.' } }];
    await open();
    fireEvent.click(within(card()).getByRole('button', { name: copy.add }));
    fireEvent.change(screen.getByLabelText(copy.libraryLabel), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    expect(await screen.findByText('The photo could not be read.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy.retry }));
    expect(await screen.findByRole('button', { name: copy.measure })).toBeTruthy();
    expect(xhrSent).toHaveLength(2);
  });

  it('a photo over 12 MB or of the wrong type is refused before it is sent', async () => {
    await open();
    fireEvent.click(within(card()).getByRole('button', { name: copy.add }));
    const big = new File(['x'], 'big.jpg', { type: 'image/jpeg' });
    Object.defineProperty(big, 'size', { value: 13 * 1024 * 1024 });
    fireEvent.change(screen.getByLabelText(copy.takeLabel), { target: { files: [big, new File(['x'], 'notes.pdf', { type: 'application/pdf' })] } });
    await screen.findByText(copy.tooBig);
    expect(screen.getByText(copy.wrongType)).toBeTruthy();
    expect(xhrSent).toHaveLength(0);
  });

  it('a HEIC this browser cannot open: says what to change on the phone, no broken thumbnail, no useless retry', async () => {
    await open();
    fireEvent.click(within(card()).getByRole('button', { name: copy.add }));
    const heic = new File([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0])], 'IMG_0001.HEIC', { type: 'image/heic' });
    fireEvent.change(screen.getByLabelText(copy.takeLabel), { target: { files: [heic] } });
    const alert = await screen.findByText(copy.heicUnsupported);
    const row = alert.closest('[data-upload]') as HTMLElement;
    expect(row.querySelector('img')).toBeNull();
    expect(within(row).queryByRole('button', { name: copy.retry })).toBeNull();
    expect(within(row).getByRole('button', { name: copy.remove })).toBeTruthy();
    expect(xhrSent).toHaveLength(0);
  });

  it('"I photographed every window" zeroes the estimate and says the count is from photos', async () => {
    await open(savedView());
    expect(stat()).toBe('16');
    fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(copy.coverAll) }));
    expect(stat()).toBe('1');
    expect(within(card()).getByText(copy.fromPhotos)).toBeTruthy();
    const estimated = [...card().querySelectorAll('td[data-col="estimated"]')].map((td) => td.textContent);
    expect(estimated).toEqual(['0', '0', '0', '0']);
    await waitFor(() => expect(sent(PATCH)).toEqual([{ photosCoverAllWindows: true }]));
  });

  it('a photographed window can be left out of the quote, and deleted', async () => {
    await open(savedView());
    const row = card().querySelector('[data-photo-window="pw1"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('checkbox', { name: copy.inQuote }));
    expect(stat()).toBe('15');
    expect(row.textContent).toContain(measureWindows.leftOut);
    await waitFor(() => expect(sent(PATCH)).toEqual([{ excludedWindowIds: ['pw1'] }]));
    fireEvent.click(within(row).getByRole('button', { name: copy.deleteRow('Kitchen') }));
    expect(card().querySelector('[data-photo-window]')).toBeNull();
    await waitFor(() => expect(sent(PATCH)).toHaveLength(2));
    expect(sent(PATCH)[1]).toEqual({ photoWindows: [], excludedWindowIds: [] });
  });

  it('tapping a photographed window reopens it to edit, with the server’s size', async () => {
    await open(savedView());
    const s = savedView().photoWindows![0]!;
    fireEvent.click(within(card()).getByRole('button', { name: copy.rowLabel('Kitchen', measureWindows.size(s.widthIn, s.heightIn)) }));
    expect(screen.getByRole('dialog', { name: copy.measureTitle })).toBeTruthy();
    expect(liveSize()).toContain(copy.fromServer);
    expect((screen.getByLabelText(copy.label) as HTMLInputElement).value).toBe('Kitchen');
    fireEvent.click(screen.getByRole('button', { name: copy.delete }));
    await waitFor(() => expect(sent(PATCH)).toEqual([{ photoWindows: [] }]));
  });

  it('Adjust offers the photos too', async () => {
    await open();
    fireEvent.click(within(card()).getByRole('button', { name: new RegExp(measureWindows.adjust) }));
    const inAdjust = within(card()).getAllByRole('button', { name: copy.add });
    expect(inAdjust).toHaveLength(2);
    fireEvent.click(inAdjust[0]!);
    expect(screen.getByRole('dialog', { name: copy.title })).toBeTruthy();
  });
});

describe('Photograph windows: touch and motion', () => {
  it('the photo and its corners never pan the page; the corners have 44 px hit areas', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const file = ['src/features/measure/windows/PhotoMeasure.module.css', 'apps/web/src/features/measure/windows/PhotoMeasure.module.css'].map((p) => resolve(process.cwd(), p)).find((p) => existsSync(p))!;
    const css = readFileSync(file, 'utf8');
    expect(css).toMatch(/\.frame \{[^}]*touch-action: none;/);
    expect(css).toMatch(/\.handle \{[^}]*width: 44px;[^}]*height: 44px;[^}]*touch-action: none;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
