import {
  priceWindows,
  sizeFromArPoints,
  windowCounts,
  windowSizeClass,
  type ArPoint,
  type PhotoWindow,
  type PhotoWindowInput,
  type WindowMeasurementView,
  type WindowPhotoUpload,
} from '@roofline/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { measureWindows, windowPhotos as copy } from '../src/copy/measureWindows.ts';
import { forgetRevealed } from '../src/features/measure/lift/scan.ts';
import { ArMeasure, type ArResult } from '../src/features/measure/windows/ar/ArMeasure.tsx';
import { insetCorners, projectToImage } from '../src/features/measure/windows/ar/arMath.ts';
import { forgetArSupport } from '../src/features/measure/windows/ar/arSupport.ts';
import { OPTIONAL_FEATURES } from '../src/features/measure/windows/ar/arSession.ts';
import { PhotoMeasure } from '../src/features/measure/windows/PhotoMeasure.tsx';
import { sizePhotoWindow } from '../src/features/measure/windows/photoModel.ts';
import { WindowsWindow } from '../src/features/measure/windows/WindowsWindow.tsx';

/*
 * AR window measuring (Android WebXR) against a FAKE navigator.xr: a session whose frames the test steps by hand, with
 * hit-test results where the test aims, select events for taps, and tracking that can be lost.
 */

const IN = 0.0254;
/** A 36 x 60 in frame 2 m in front of the camera, centred 1.2 m up (TL, TR, BR, BL), metres. */
const FRAME: ArPoint[] = [
  [-18 * IN, 30 * IN, -2],
  [18 * IN, 30 * IN, -2],
  [18 * IN, -30 * IN, -2],
  [-18 * IN, -30 * IN, -2],
];

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** A GL perspective matrix (column-major): 60 degree vertical field of view, 4:3. */
function perspective(fovyDeg = 60, aspect = 4 / 3, near = 0.1, far = 100): number[] {
  const f = 1 / Math.tan((fovyDeg * Math.PI) / 360);
  const nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}
const PROJECTION = perspective();
const translation = ([x, y, z]: ArPoint) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const transform = (p: ArPoint) => ({ position: { x: p[0], y: p[1], z: p[2] }, matrix: translation(p), inverse: { matrix: IDENTITY } });

type FrameState = { tracked: boolean; hit: ArPoint | null };

class FakeSession {
  enabledFeatures: string[];
  ended = false;
  private callbacks = new Map<number, (t: number, frame: unknown) => void>();
  private next = 1;
  private listeners: Record<string, (() => void)[]> = { select: [], end: [] };
  anchorsMade = 0;
  constructor(features: string[]) {
    this.enabledFeatures = features;
  }
  requestReferenceSpace = vi.fn(async (type: string) => ({ type }));
  requestHitTestSource = vi.fn(async () => ({ cancel: vi.fn() }));
  requestAnimationFrame(cb: (t: number, frame: unknown) => void) {
    const id = this.next++;
    this.callbacks.set(id, cb);
    return id;
  }
  cancelAnimationFrame(id: number) {
    this.callbacks.delete(id);
  }
  updateRenderState = vi.fn();
  addEventListener(type: string, cb: () => void) {
    this.listeners[type]!.push(cb);
  }
  removeEventListener() {}
  end = vi.fn(async () => {
    if (this.ended) return;
    this.ended = true;
    this.callbacks.clear();
    this.listeners.end!.forEach((cb) => cb());
  });
  pending() {
    return this.callbacks.size;
  }
  /** Runs one XR frame with the camera at the origin looking down -z. */
  tick(state: FrameState) {
    const cbs = [...this.callbacks.values()];
    this.callbacks.clear();
    const view = { projectionMatrix: PROJECTION, transform: transform([0, 0, 0]), camera: this.enabledFeatures.includes('camera-access') ? { width: 640, height: 480 } : null };
    const frame = {
      session: this,
      getViewerPose: () => (state.tracked ? { transform: transform([0, 0, 0]), views: [view] } : null),
      getHitTestResults: () =>
        state.tracked && state.hit !== null
          ? [
              {
                getPose: () => ({ transform: transform(state.hit!) }),
                createAnchor: async () => {
                  this.anchorsMade += 1;
                  return { anchorSpace: { at: state.hit }, delete: vi.fn() };
                },
              },
            ]
          : [],
      getPose: (space: { at: ArPoint }) => ({ transform: transform(space.at) }),
      trackedAnchors: { has: () => true },
    };
    for (const cb of cbs) cb(0, frame);
  }
  select() {
    this.listeners.select!.forEach((cb) => cb());
  }
}

let session: FakeSession;
let requestSession: ReturnType<typeof vi.fn>;
function fakeXr(supported: boolean, features = ['hit-test', 'dom-overlay', 'anchors']) {
  session = new FakeSession(features);
  requestSession = vi.fn(async () => session);
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator) as Navigator, { xr: { isSessionSupported: vi.fn(async () => supported), requestSession } }));
}

const step = (state: FrameState) => act(() => session.tick(state));
const tap = (state: FrameState) =>
  act(() => {
    session.tick(state);
    session.select();
    session.tick(state);
  });
const overlay = () => screen.getByRole('dialog', { name: copy.arOverlay });
const message = () => overlay().querySelector('[data-ar-message]')!.textContent;

async function startAr() {
  fireEvent.click(await screen.findByRole('button', { name: copy.arStart }));
  await waitFor(() => expect(session.pending()).toBeGreaterThan(0));
}

const UPLOAD: WindowPhotoUpload = { id: 'up1', widthPx: 1200, heightPx: 1600, focal35mm: 26, takenAt: null };

beforeEach(() => {
  forgetArSupport();
  // jsdom has no WebGL: the session runs without drawing (the overlay is what is tested)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('AR method tab', () => {
  const renderMeasure = () => render(<PhotoMeasure upload={UPLOAD} src="/x.jpg" initial={null} saved={null} onSave={vi.fn()} onCancel={vi.fn()} uploadPhoto={vi.fn()} />);

  it('shows "AR (Android)" first where immersive-ar is supported', async () => {
    fakeXr(true);
    renderMeasure();
    await waitFor(() => expect(screen.getAllByRole('tab')[0]!.textContent).toBe(copy.methodAr));
    expect(screen.getAllByRole('tab')).toHaveLength(4);
  });

  it('is hidden where it is not supported, and where there is no WebXR at all (iPhone Safari)', async () => {
    fakeXr(false);
    renderMeasure();
    await act(async () => undefined);
    expect(screen.queryByRole('tab', { name: copy.methodAr })).toBeNull();
    cleanup();
    forgetArSupport();
    vi.stubGlobal('navigator', Object.create(navigator) as Navigator);
    renderMeasure();
    await act(async () => undefined);
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.queryByRole('tab', { name: copy.methodAr })).toBeNull();
  });
});

describe('measuring in AR (fake WebXR session)', () => {
  async function openArTab() {
    const onSave = vi.fn();
    render(<PhotoMeasure upload={UPLOAD} src="/x.jpg" initial={null} saved={null} onSave={onSave} onCancel={vi.fn()} uploadPhoto={vi.fn()} />);
    fireEvent.click(await screen.findByRole('tab', { name: copy.methodAr }));
    return onSave;
  }

  it('asks for hit-test (required) and the optional features, with the overlay as the dom-overlay root; guidance first', async () => {
    fakeXr(true);
    await openArTab();
    // The AR screen is loaded only now (lazily)
    for (const g of copy.arGuidance) expect(await screen.findByText(g)).toBeTruthy();
    await startAr();
    expect(requestSession).toHaveBeenCalledTimes(1);
    const [mode, init] = requestSession.mock.calls[0]!;
    expect(mode).toBe('immersive-ar');
    expect(init.requiredFeatures).toEqual(['hit-test']);
    expect(init.optionalFeatures).toEqual(['dom-overlay', 'anchors', 'camera-access', 'depth-sensing']);
    expect(OPTIONAL_FEATURES).toEqual(init.optionalFeatures);
    expect(init.domOverlay.root).toBe(document.querySelector('[data-ar-overlay]'));
    expect(session.requestHitTestSource).toHaveBeenCalledWith({ space: { type: 'viewer' } });
    expect(overlay().getAttribute('aria-modal')).toBe('true');
  });

  it('searching, then the reticle on the frame; 4 taps give live sides and the size; undo takes the last one back', async () => {
    fakeXr(true);
    await openArTab();
    await startAr();
    await step({ tracked: true, hit: null });
    expect(message()).toBe(copy.arSearching);
    expect(screen.getByRole('button', { name: copy.arPlace }).hasAttribute('disabled')).toBe(true);
    await step({ tracked: true, hit: FRAME[0]! });
    expect(message()).toBe(copy.arAimAt('top left'));
    expect(overlay().querySelector('[data-aim]')!.getAttribute('data-aim')).toBe('on');
    await tap({ tracked: true, hit: FRAME[0]! });
    expect(overlay().getAttribute('data-ar-points') ?? overlay().querySelector('[data-ar-points]')!.getAttribute('data-ar-points')).toBe('1');
    // The open side follows the reticle
    await step({ tracked: true, hit: FRAME[1]! });
    expect(overlay().textContent).toContain(copy.arEdge('Top', '36'));
    await tap({ tracked: true, hit: FRAME[1]! });
    // The Place button works as well as a screen tap
    await step({ tracked: true, hit: FRAME[2]! });
    fireEvent.click(screen.getByRole('button', { name: copy.arPlace }));
    await step({ tracked: true, hit: FRAME[3]! });
    await tap({ tracked: true, hit: FRAME[3]! });
    expect(message()).toBe(copy.arAllPlaced);
    const edges = [...overlay().querySelectorAll('[data-ar-edges] li')].map((li) => li.textContent);
    expect(edges).toEqual([copy.arEdge('Top', '36'), copy.arEdge('Right', '60'), copy.arEdge('Bottom', '36'), copy.arEdge('Left', '60')]);
    expect(overlay().querySelector('[data-ar-size]')!.textContent).toContain(copy.sizeExact('36', '60'));
    expect(session.anchorsMade).toBe(4);
    // A fifth tap does nothing
    await tap({ tracked: true, hit: [0, 0, -2] });
    expect(overlay().querySelector('[data-ar-points]')!.getAttribute('data-ar-points')).toBe('4');
    fireEvent.click(screen.getByRole('button', { name: copy.arUndo }));
    await step({ tracked: true, hit: FRAME[3]! });
    expect(overlay().querySelector('[data-ar-points]')!.getAttribute('data-ar-points')).toBe('3');
    expect(message()).toBe(copy.arAimAt('bottom left'));
    fireEvent.click(screen.getByRole('button', { name: copy.arRestart }));
    await step({ tracked: true, hit: FRAME[0]! });
    expect(overlay().querySelector('[data-ar-points]')!.getAttribute('data-ar-points')).toBe('0');
  });

  it('tracking lost: "Move slowly to find the wall again", counted each time it is lost', async () => {
    fakeXr(true);
    await openArTab();
    await startAr();
    // Not lost before AR ever found the wall: just searching
    await step({ tracked: false, hit: null });
    expect(message()).toBe(copy.arSearching);
    await step({ tracked: true, hit: FRAME[0]! });
    await tap({ tracked: true, hit: FRAME[0]! });
    await step({ tracked: false, hit: null });
    expect(message()).toBe(copy.arLost);
    expect(screen.getByRole('alert').textContent).toBe(copy.arLost);
    await step({ tracked: false, hit: null });
    expect(overlay().textContent).toContain(copy.arLostTimes(1));
    await step({ tracked: true, hit: FRAME[1]! });
    expect(message()).toBe(copy.arAimAt('top right'));
    await step({ tracked: false, hit: null });
    await step({ tracked: true, hit: FRAME[1]! });
    expect(overlay().textContent).toContain(copy.arLostTimes(2));
  });

  it('no camera access: finish ends the session and keeps the photo already taken, corners inset 15%', async () => {
    fakeXr(true);
    const onSave = await openArTab();
    await startAr();
    for (const p of FRAME) await tap({ tracked: true, hit: p });
    await step({ tracked: false, hit: null });
    await step({ tracked: true, hit: FRAME[0]! });
    fireEvent.click(screen.getByRole('button', { name: copy.arFinish }));
    await step({ tracked: true, hit: FRAME[0]! });
    await waitFor(() => expect(session.end).toHaveBeenCalled());
    expect(await screen.findByText(copy.arMeasuredWith)).toBeTruthy();
    expect(screen.getByText(copy.arCornersApprox)).toBeTruthy();
    expect(document.querySelector('[data-live-size]')!.textContent).toContain(copy.sizeExact('36', '60'));
    fireEvent.click(screen.getByRole('button', { name: copy.save }));
    const saved = onSave.mock.calls[0]![0] as PhotoWindowInput;
    expect(saved.uploadId).toBe('up1');
    expect(saved.corners).toEqual(insetCorners(1200, 1600));
    expect(saved.scale).toMatchObject({ kind: 'ar', trackingLostCount: 1 });
    if (saved.scale.kind !== 'ar') throw new Error('not ar');
    saved.scale.pointsM.forEach((p, i) => p.forEach((v, k) => expect(v).toBeCloseTo(FRAME[i]![k]!, 9)));
  });

  it('with camera access: one picture is kept and uploaded, the corners projected into it with the view and projection matrices', async () => {
    fakeXr(true, ['hit-test', 'dom-overlay', 'anchors', 'camera-access']);
    const picture = new Blob(['jpeg'], { type: 'image/jpeg' });
    const captureCamera = vi.fn(async () => ({ blob: picture, widthPx: 640, heightPx: 480 }));
    const arUpload: WindowPhotoUpload = { id: 'ar1', widthPx: 640, heightPx: 480, focal35mm: null, takenAt: null };
    const uploadPhoto = vi.fn<(file: File) => Promise<WindowPhotoUpload>>(async () => arUpload);
    const onResult = vi.fn();
    render(<ArMeasure photo={UPLOAD} uploadPhoto={uploadPhoto} onResult={onResult} session={{ captureCamera }} />);
    await startAr();
    for (const p of FRAME) await tap({ tracked: true, hit: p });
    fireEvent.click(screen.getByRole('button', { name: copy.arFinish }));
    await step({ tracked: true, hit: FRAME[0]! });
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(captureCamera).toHaveBeenCalledTimes(1);
    const file = uploadPhoto.mock.calls[0]![0];
    expect(file.type).toBe('image/jpeg');
    const r = onResult.mock.calls[0]![0] as ArResult;
    expect(r.upload).toBe(arUpload);
    expect(r.projected).toBe(true);
    expect(r.corners).toEqual(projectToImage(FRAME, IDENTITY, PROJECTION, 640, 480));
    // The frame is centred, so its corners are symmetric about the picture's middle; TL is up and left
    expect(r.corners[0][0]).toBeLessThan(320);
    expect(r.corners[0][1]).toBeLessThan(240);
    expect(r.corners[0][0] + r.corners[1][0]).toBeCloseTo(640, 0);
    expect(session.end).toHaveBeenCalled();
  });

  it('a session the phone refuses says so and offers Start AR again', async () => {
    fakeXr(true);
    requestSession.mockRejectedValue(new Error('NotSupportedError'));
    await openArTab();
    fireEvent.click(screen.getByRole('button', { name: copy.arStart }));
    expect(await screen.findByText(copy.arFailed)).toBeTruthy();
    expect(screen.getByRole('button', { name: copy.arStart })).toBeTruthy();
  });
});

/* The whole windows screen, against a mocked server (as measure-windows-photos.test.tsx). */

let xhrSent: string[];
let nextUpload: WindowPhotoUpload[];
class FakeXHR {
  status = 0;
  responseText = '';
  withCredentials = false;
  upload = { onprogress: null as ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private url = '';
  open(_m: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  send() {
    xhrSent.push(this.url);
    const body = nextUpload.shift() ?? UPLOAD;
    setTimeout(() => {
      this.status = 201;
      this.responseText = JSON.stringify(body);
      this.onload?.();
    }, 10);
  }
}

let calls: { key: string; body: unknown }[];
let current: WindowMeasurementView;
const PATCH = 'PATCH /api/window-measurements/w1';
const sent = (key: string) => calls.filter((c) => c.key === key).map((c) => c.body as Record<string, unknown>);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function view(): WindowMeasurementView {
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
  };
}

function serverPatch(before: WindowMeasurementView, body: Record<string, unknown>, uploads: WindowPhotoUpload[]): WindowMeasurementView {
  const adjustments = { ...before.adjustments, ...body } as WindowMeasurementView['adjustments'];
  const photoWindows = (adjustments.photoWindows ?? []).map((w): PhotoWindow => {
    const s = sizePhotoWindow(w, uploads.find((u) => u.id === w.uploadId)!)!;
    const ar = w.scale.kind === 'ar' ? sizeFromArPoints(w.scale.pointsM)! : null;
    return { ...w, ...s, sizeClass: windowSizeClass(s.widthIn, s.heightIn), quality: ar?.quality ?? 'good', uncertaintyIn: ar?.uncertaintyIn ?? null };
  });
  return { ...before, adjustments, photoWindows, uploads };
}

async function openWindows(uploads: WindowPhotoUpload[]) {
  current = view();
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
        current = serverPatch(current, body as Record<string, unknown>, uploads);
        return json(current);
      }
      return json({ error: `Unexpected ${key}` }, 500);
    }),
  );
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createMemoryRouter([{ path: 'estimator/windows/:windowMeasurementId', element: <WindowsWindow /> }], { initialEntries: ['/estimator/windows/w1'] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  fireEvent.click(await screen.findByRole('button', { name: measureWindows.scanButton }));
  await waitFor(() => expect(screen.getByRole('region', { name: measureWindows.statsLabel }).dataset.phase).toBe('done'));
  fireEvent.click(screen.getByRole('button', { name: copy.add }));
  return screen.getByRole('dialog', { name: copy.title });
}

describe('AR on the windows screen', () => {
  beforeEach(() => {
    forgetRevealed();
    calls = [];
    xhrSent = [];
    nextUpload = [];
  });

  it('iPhone (no WebXR): the photos how-to says AR needs Android Chrome; no AR button', async () => {
    vi.stubGlobal('navigator', Object.create(navigator) as Navigator);
    const dialog = await openWindows([UPLOAD]);
    expect(await within(dialog).findByText(copy.arOnlyAndroid)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: copy.arStartFromCapture })).toBeNull();
  });

  it('Android: photo, AR tab, 4 taps, finish: one PATCH 500 ms later with kind "ar", sized in the card', async () => {
    fakeXr(true);
    const dialog = await openWindows([UPLOAD]);
    expect(within(dialog).queryByText(copy.arOnlyAndroid)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(copy.takeLabel), { target: { files: [new File(['x'], 'den.jpg', { type: 'image/jpeg' })] } });
    fireEvent.click(await within(dialog).findByRole('button', { name: copy.measure }));
    fireEvent.click(await screen.findByRole('tab', { name: copy.methodAr }));
    await startAr();
    for (const p of FRAME) await tap({ tracked: true, hit: p });
    fireEvent.click(screen.getByRole('button', { name: copy.arFinish }));
    await step({ tracked: true, hit: FRAME[0]! });
    await screen.findByText(copy.arMeasuredWith);
    fireEvent.change(screen.getByLabelText(copy.label), { target: { value: 'Den' } });
    fireEvent.click(screen.getByRole('button', { name: copy.save }));
    await wait(200);
    expect(sent(PATCH)).toHaveLength(0);
    await waitFor(() => expect(sent(PATCH)).toHaveLength(1));
    await wait(700);
    expect(sent(PATCH)).toHaveLength(1);
    const body = sent(PATCH)[0]! as { photoWindows: PhotoWindowInput[] };
    expect(body.photoWindows).toHaveLength(1);
    expect(body.photoWindows[0]).toMatchObject({ uploadId: 'up1', label: 'Den', corners: insetCorners(1200, 1600), scale: { kind: 'ar', trackingLostCount: 0 } });
    // One upload: the photo (no camera access, so no AR picture)
    expect(xhrSent).toEqual(['/api/window-measurements/w1/uploads']);
    fireEvent.click(within(dialog).getByRole('button', { name: copy.close }));
    const row = document.querySelector('[data-photo-window]')!;
    expect(row.textContent).toContain('Den');
    expect(row.textContent).toContain('36 by 60 inches');
  });

  it('Android, straight to AR from the photos screen: no camera access, so it asks for one normal photo, then saves', async () => {
    fakeXr(true);
    const shot: WindowPhotoUpload = { id: 'up2', widthPx: 900, heightPx: 1200, focal35mm: null, takenAt: null };
    nextUpload = [shot];
    const dialog = await openWindows([shot]);
    fireEvent.click(await within(dialog).findByRole('button', { name: copy.arStartFromCapture }));
    await startAr();
    for (const p of FRAME) await tap({ tracked: true, hit: p });
    fireEvent.click(screen.getByRole('button', { name: copy.arFinish }));
    await step({ tracked: true, hit: FRAME[0]! });
    expect(await screen.findByText(copy.arNeedPhoto)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(copy.arTakePhotoLabel), { target: { files: [new File(['x'], 'den.jpg', { type: 'image/jpeg' })] } });
    expect(await screen.findByText(copy.arMeasuredWith)).toBeTruthy();
    const measure = document.querySelector('[data-photo-measure]') as HTMLElement;
    expect(within(measure).getByRole('tab', { selected: true }).textContent).toBe(copy.methodAr);
    fireEvent.click(screen.getByRole('button', { name: copy.save }));
    await waitFor(() => expect(sent(PATCH)).toHaveLength(1));
    expect(sent(PATCH)[0]).toMatchObject({ photoWindows: [{ uploadId: 'up2', corners: insetCorners(900, 1200), scale: { kind: 'ar' } }] });
    expect(xhrSent).toEqual(['/api/window-measurements/w1/uploads']);
  });
});

describe('AR math on the web side', () => {
  it('projects a centred point to the middle of the picture; a point behind the camera cannot be drawn', () => {
    expect(projectToImage([[0, 0, -2]], IDENTITY, PROJECTION, 640, 480)).toEqual([[320, 240]]);
    expect(projectToImage([[0, 0, 2]], IDENTITY, PROJECTION, 640, 480)).toBeNull();
    // Off the side of the picture: kept on it
    expect(projectToImage([[50, 0, -2]], IDENTITY, PROJECTION, 640, 480)).toEqual([[640, 240]]);
  });

  it('the web preview sizes an AR window the way the server does (0.01 in)', () => {
    const s = sizePhotoWindow({ corners: insetCorners(1200, 1600), scale: { kind: 'ar', pointsM: FRAME as [ArPoint, ArPoint, ArPoint, ArPoint], trackingLostCount: 0 } }, UPLOAD)!;
    expect(s).toEqual({ widthIn: 36, heightIn: 60 });
  });
});
