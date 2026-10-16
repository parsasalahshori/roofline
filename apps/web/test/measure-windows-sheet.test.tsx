import {
  priceWindows,
  SHEET_FOCAL_UNKNOWN_SIGMA,
  windowCounts,
  windowSizeClass,
  type PhotoWindow,
  type PhotoWindowInput,
  type Quad,
  type SheetDetection,
  type SnappedQuad,
  type WindowMeasurementView,
  type WindowPhotoCv,
  type WindowPhotoMeasurement,
  type WindowPhotoScale,
  type WindowPhotoUpload,
} from '@roofline/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { measureWindows, windowPhotos as copy } from '../src/copy/measureWindows.ts';
import { forgetRevealed } from '../src/features/measure/lift/scan.ts';
import { PhotoEngineProvider, type PhotoEngineSeam } from '../src/features/measure/windows/photoEngine.tsx';
import { PhotoMeasure } from '../src/features/measure/windows/PhotoMeasure.tsx';
import { inchesFraction, livePhotoWindows, plusMinusFraction, seedWindowQuad } from '../src/features/measure/windows/photoModel.ts';
import { PhotoWindowsList } from '../src/features/measure/windows/PhotoWindows.tsx';
import { SheetPrint } from '../src/features/measure/windows/SheetPrint.tsx';
import { WindowsWindow } from '../src/features/measure/windows/WindowsWindow.tsx';

/* A fake measuring engine: the screen is built against the WindowPhotoCv interface only. */

const UPLOAD: WindowPhotoUpload = { id: 'up1', widthPx: 1200, heightPx: 1600, focal35mm: 26, takenAt: null };
const SHEET_OUTLINE: Quad = [
  [700, 1100],
  [880, 1105],
  [878, 1340],
  [700, 1345],
];
const DETECTION: SheetDetection = {
  paper: 'letter',
  imagePoints: [
    [710, 1110],
    [870, 1112],
    [868, 1330],
    [712, 1333],
  ],
  sheetPointsIn: [
    [0.5, 0.5],
    [8, 0.5],
    [8, 10.5],
    [0.5, 10.5],
  ],
  rmsErrorPx: 0.4,
  outline: SHEET_OUTLINE,
};
const SNAPPED: Quad = [
  [300, 380],
  [930, 430],
  [910, 1250],
  [320, 1300],
];
const MEASURED: WindowPhotoMeasurement = { widthIn: 35.87, heightIn: 59.74, uncertaintyIn: { width: 0.05, height: 0.06 }, distanceIn: 78, viewAngleDeg: 12, warnings: [] };

type Fake = { [K in keyof WindowPhotoCv]: ReturnType<typeof vi.fn> & WindowPhotoCv[K] };
let cv: Fake;
let seam: PhotoEngineSeam;
let measureResult: WindowPhotoMeasurement | null;

function makeEngine(over: Partial<{ detection: SheetDetection | null; snap: SnappedQuad }> = {}) {
  measureResult = MEASURED;
  cv = {
    calibrationSheet: vi.fn((paper: 'letter' | 'a4') => ({
      paper,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" data-fake-sheet="${paper}" viewBox="0 0 8.5 11"><rect width="8.5" height="11" fill="#fff"/></svg>`,
      widthIn: paper === 'a4' ? 8.27 : 8.5,
      heightIn: paper === 'a4' ? 11.69 : 11,
    })),
    detectSheet: vi.fn(async () => ('detection' in over ? over.detection! : DETECTION)),
    snapQuad: vi.fn(async () => over.snap ?? { quad: SNAPPED, sideConfidence: [0.95, 0.3, 0.9, 0.92], moved: true }),
    measure: vi.fn(() => measureResult),
    combine: vi.fn((ms: WindowPhotoMeasurement[]) => {
      const mid = (vs: number[]) => [...vs].sort((a, b) => a - b)[Math.floor(vs.length / 2)]!;
      const w = ms.map((m) => m.widthIn);
      const h = ms.map((m) => m.heightIn);
      return { widthIn: mid(w), heightIn: mid(h), spreadIn: { width: Math.max(...w) - Math.min(...w), height: Math.max(...h) - Math.min(...h) } };
    }),
  } as unknown as Fake;
  seam = {
    load: vi.fn(async () => cv as unknown as WindowPhotoCv),
    readPixels: vi.fn(async () => ({ img: { width: 1200, height: 1600, data: new Uint8ClampedArray(4) }, scale: 1 })),
  };
}

const withEngine = (ui: ReactNode) => <PhotoEngineProvider engine={seam}>{ui}</PhotoEngineProvider>;

function stubRect(el: Element, w = 1200, h = 1600) {
  (el as HTMLElement).getBoundingClientRect = () => ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON: () => ({}) });
}
const photoFrame = () => screen.getByRole('group', { name: copy.photoLabel });
const handle = (i: number) => document.querySelector(`[data-which="window"][data-corner="${i}"]`) as HTMLElement;
/** Drags a window corner to a spot and lets go (photo pixels; the frame is stubbed at 1 px per photo pixel). */
function dragTo(i: number, [x, y]: [number, number]) {
  const [sx, sy] = [handle(i).style.left, handle(i).style.top].map((v) => Number.parseFloat(v));
  fireEvent.pointerDown(handle(i), { clientX: (sx! / 100) * 1200, clientY: (sy! / 100) * 1600, pointerId: 1 });
  fireEvent.pointerMove(photoFrame(), { clientX: x, clientY: y, pointerId: 1 });
  fireEvent.pointerUp(photoFrame(), { clientX: x, clientY: y, pointerId: 1 });
}
const cornerAt = (i: number) => [Number.parseFloat(handle(i).style.left), Number.parseFloat(handle(i).style.top)];
const pctOf = ([x, y]: [number, number]) => [(x / 1200) * 100, (y / 1600) * 100];
const liveSize = () => document.querySelector('[data-live-size]')?.textContent ?? '';
const lastMeasureInput = () => cv.measure.mock.calls.at(-1)![0] as Parameters<WindowPhotoCv['measure']>[0];

function renderMeasure(props: Partial<Parameters<typeof PhotoMeasure>[0]> = {}) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  render(withEngine(<PhotoMeasure upload={UPLOAD} src="/x.jpg" initial={null} saved={null} onSave={onSave} onCancel={onCancel} {...props} />));
  stubRect(photoFrame());
  return { onSave, onCancel };
}
/** The sheet found and the first snap applied. */
/** Roughly on the frame: where a person drops the corners (a few pixels off). */
const ROUGH = SNAPPED.map(([x, y]) => [x + 6, y + 6]) as Quad;
/** The sheet found, the four corners dropped roughly on the frame, and the snap applied. */
async function ready() {
  await screen.findByText(copy.sheetFound);
  for (let i = 0; i < 4; i++) dragTo(i, ROUGH[i]!);
  await waitFor(() => expect(document.querySelector('[data-snap="snapped"]')).not.toBeNull());
}

beforeEach(() => {
  forgetRevealed();
  makeEngine();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Inches to 1/8 and the ±', () => {
  it('formats sizes to the nearest 1/8 in, reduced', () => {
    expect(inchesFraction(35.87)).toBe('35 7/8');
    expect(inchesFraction(59.74)).toBe('59 3/4');
    expect(inchesFraction(36)).toBe('36');
    expect(inchesFraction(35.95)).toBe('36');
    expect(inchesFraction(24.5)).toBe('24 1/2');
    expect(inchesFraction(10.26)).toBe('10 1/4');
    expect(inchesFraction(0.375)).toBe('3/8');
  });
  it('rounds the ± up to the next 1/16 in, never less than 1/16', () => {
    expect(plusMinusFraction(0)).toBe('1/16');
    expect(plusMinusFraction(0.05)).toBe('1/16');
    expect(plusMinusFraction(0.0625)).toBe('1/16');
    expect(plusMinusFraction(0.07)).toBe('1/8');
    expect(plusMinusFraction(0.3)).toBe('5/16');
    expect(plusMinusFraction(1.2)).toBe('1 1/4');
  });
});

describe('Print the measuring sheet', () => {
  it('shows the engine’s sheet for letter or A4, prints it at its real size on a margin-less page, and downloads it', async () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:sheet');
    render(withEngine(<SheetPrint onClose={vi.fn()} />));
    const preview = await screen.findByRole('img', { name: copy.printPreview });
    expect(preview.querySelector('[data-fake-sheet="letter"]')).not.toBeNull();
    expect(screen.getByText(copy.printRulerCheck)).toBeTruthy();
    expect(screen.getByText(copy.printIntro)).toBeTruthy();
    // The print-only page: the sheet at 8.5 x 11 in, on letter paper with no margins
    const page = document.querySelector('[data-print-sheet="letter"]') as HTMLElement;
    expect(page.parentElement).toBe(document.body);
    expect((page.lastElementChild as HTMLElement).style.width).toBe('8.5in');
    expect((page.lastElementChild as HTMLElement).style.height).toBe('11in');
    expect(page.querySelector('style')!.textContent).toContain('size: letter portrait; margin: 0');
    fireEvent.click(screen.getByRole('button', { name: copy.print }));
    expect(print).toHaveBeenCalledTimes(1);
    const download = screen.getByRole('link', { name: copy.download });
    expect(download.getAttribute('href')).toBe('blob:sheet');
    expect(download.getAttribute('download')).toBe(copy.downloadName('letter'));
    fireEvent.change(screen.getByLabelText(copy.printPaper), { target: { value: 'a4' } });
    expect(cv.calibrationSheet).toHaveBeenLastCalledWith('a4');
    const a4 = document.querySelector('[data-print-sheet="a4"]') as HTMLElement;
    expect((a4.lastElementChild as HTMLElement).style.width).toBe('8.27in');
    expect(a4.querySelector('style')!.textContent).toContain('size: A4 portrait');
    expect(download.getAttribute('download')).toBe(copy.downloadName('a4'));
  });

  it('says so when the engine is not available on this device', async () => {
    seam = { ...seam, load: async () => null };
    render(withEngine(<SheetPrint onClose={vi.fn()} />));
    expect(await screen.findByText(copy.engineUnavailable)).toBeTruthy();
    expect(document.querySelector('[data-print-sheet]')).toBeNull();
  });

  it('the print stylesheet prints only the sheet', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const file = ['src/features/measure/windows/SheetPrint.module.css', 'apps/web/src/features/measure/windows/SheetPrint.module.css'].map((p) => resolve(process.cwd(), p)).find((p) => existsSync(p))!;
    const css = readFileSync(file, 'utf8');
    expect(css).toMatch(/@media print \{[\s\S]*body > \*:not\(\[data-print-sheet\]\)[\s\S]*display: none !important/);
    expect(css).toMatch(/\.printPage \{\s*display: none;/);
  });
});

describe('Measuring sheet: finding it in the photo', () => {
  it('is the recommended method for a new window, finds the sheet and draws its outline, with distance and angle', async () => {
    renderMeasure();
    expect(screen.getByRole('tab', { selected: true }).textContent).toContain(copy.methodSheet);
    expect(screen.getByRole('tab', { selected: true }).textContent).toContain(copy.recommended);
    await ready();
    expect(cv.detectSheet).toHaveBeenCalledTimes(1);
    const outline = document.querySelector('[data-sheet-outline]')!;
    expect(outline.getAttribute('points')).toBe(SHEET_OUTLINE.map(([x, y]) => `${x},${y}`).join(' '));
    // 78 in = 6.5 ft
    expect(screen.getByText(copy.quality(6.5, 12))).toBeTruthy();
    expect(copy.quality(6.5, 12)).toBe('6.5 ft away, 12° off straight-on');
  });

  it('maps the sheet back to the photo’s own pixels when the engine read it smaller', async () => {
    seam.readPixels = vi.fn(async () => ({ img: { width: 600, height: 800, data: new Uint8ClampedArray(4) }, scale: 0.5 }));
    cv.detectSheet.mockResolvedValue({ ...DETECTION, imagePoints: DETECTION.imagePoints.map(([x, y]) => [x / 2, y / 2]), outline: SHEET_OUTLINE.map(([x, y]) => [x / 2, y / 2]) as Quad });
    renderMeasure();
    await ready();
    expect(lastMeasureInput().sheet.imagePoints).toEqual(DETECTION.imagePoints);
    // The rough corners go to the engine at its size
    expect(cv.snapQuad.mock.calls[0]![1]).toEqual(ROUGH.map(([x, y]) => [x / 2, y / 2]));
  });

  it('not found: explains why and how to fix it, offers to take the photo again, and cannot be saved', async () => {
    makeEngine({ detection: null });
    const { onCancel } = renderMeasure();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(copy.sheetMissing);
    for (const fix of copy.sheetFixes) expect(within(alert).getByText(fix)).toBeTruthy();
    expect(document.querySelector('[data-sheet-outline]')).toBeNull();
    expect((screen.getByRole('button', { name: copy.save }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(alert).getByRole('button', { name: copy.retakePhoto }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('shows the engine’s warnings and asks for a re-take', async () => {
    measureResult = { ...MEASURED, warnings: ['Step back: the photo is too close', 'Use the 1x lens'] };
    renderMeasure();
    await ready();
    const list = document.querySelector('[data-warnings]')!;
    expect(list.textContent).toContain('Step back: the photo is too close');
    expect(list.textContent).toContain('Use the 1x lens');
    expect(screen.getByText(copy.retake)).toBeTruthy();
  });
});

describe('Measuring sheet: corners snapped onto the frame', () => {
  it('waits until all four corners are on the frame, then fits them, draws the fitted edges and flags the unsure one', async () => {
    renderMeasure();
    await screen.findByText(copy.sheetFound);
    // No engine proposal: the corners start inset and nothing is snapped from there
    expect(cornerAt(0)).toEqual(pctOf(seedWindowQuad(1200, 1600)[0]));
    for (let i = 0; i < 3; i++) dragTo(i, ROUGH[i]!);
    await act(async () => {});
    expect(cv.snapQuad).not.toHaveBeenCalled();
    expect(document.querySelector('[data-snap]')!.textContent).toBe(copy.placeCorners(3));
    dragTo(3, ROUGH[3]);
    await waitFor(() => expect(document.querySelector('[data-snap="snapped"]')).not.toBeNull());
    expect(cv.snapQuad).toHaveBeenCalledTimes(1);
    expect(cv.snapQuad.mock.calls[0]![1]).toEqual(ROUGH);
    for (let i = 0; i < 4; i++) expect(cornerAt(i)).toEqual(pctOf(SNAPPED[i]!));
    expect(document.querySelectorAll('line[data-edge]')).toHaveLength(4);
    expect(document.querySelector('line[data-edge="1"]')!.getAttribute('data-low')).toBe('true');
    expect(document.querySelector('line[data-edge="0"]')!.getAttribute('data-low')).toBeNull();
    // Side 1 is the right edge
    const flag = document.querySelector('[data-edge-flag]')!;
    expect(flag.getAttribute('data-edge-flag')).toBe('1');
    expect(flag.textContent).toBe(copy.checkEdge);
    expect(screen.getByText(copy.checkEdges('right'))).toBeTruthy();
  });

  it('snaps again when a corner is let go, and not with "Don\'t snap"', async () => {
    renderMeasure();
    await ready();
    const moved: Quad = [[320, 395], SNAPPED[1], SNAPPED[2], SNAPPED[3]];
    cv.snapQuad.mockResolvedValueOnce({ quad: [[302, 381], SNAPPED[1], SNAPPED[2], SNAPPED[3]], sideConfidence: [0.9, 0.9, 0.9, 0.9], moved: true });
    dragTo(0, [320, 395]);
    expect(cv.snapQuad).toHaveBeenCalledTimes(2);
    expect(cv.snapQuad.mock.calls[1]![1]).toEqual(moved);
    await waitFor(() => expect(cornerAt(0)).toEqual(pctOf([302, 381])));
    // Every side sure now: nothing to check
    expect(document.querySelector('[data-edge-flag]')).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: copy.noSnap }));
    dragTo(0, [340, 410]);
    await act(async () => {});
    expect(cv.snapQuad).toHaveBeenCalledTimes(2);
    expect(cornerAt(0)).toEqual(pctOf([340, 410]));
  });

  it('shows no size and cannot be saved until all four corners are placed (the starting corners are a guess)', async () => {
    renderMeasure();
    await screen.findByText(copy.sheetFound);
    const save = () => screen.getByRole('button', { name: copy.save }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    expect(liveSize()).toContain(copy.cornersFirst(0, 4));
    expect(liveSize()).not.toContain(copy.sizeExact('35 7/8', '59 3/4'));
    expect(cv.measure).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i++) dragTo(i, ROUGH[i]!);
    await act(async () => {});
    expect(save().disabled).toBe(true);
    expect(liveSize()).toContain(copy.cornersFirst(3, 4));
    dragTo(3, ROUGH[3]);
    await waitFor(() => expect(document.querySelector('[data-snap="snapped"]')).not.toBeNull());
    expect(save().disabled).toBe(false);
    expect(liveSize()).toContain(copy.sizeExact('35 7/8', '59 3/4'));
  });

  it('a corner moved with the keys is not snapped (fine adjustment), and the size follows', async () => {
    renderMeasure();
    await ready();
    fireEvent.keyDown(handle(2), { key: 'ArrowRight' });
    expect(cv.snapQuad).toHaveBeenCalledTimes(1);
    expect(lastMeasureInput().windowQuad[2]).toEqual([914, 1250]);
  });
});

describe('Measuring sheet: what is measured, and the size', () => {
  it('"What are you measuring?" sets the frame’s offset from the glass, with an advanced override', async () => {
    const { onSave } = renderMeasure();
    await ready();
    expect(lastMeasureInput().planeOffsetIn).toBe(1);
    expect((screen.getByRole('radio', { name: new RegExp(copy.targets.frame.label) }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(copy.practice)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(copy.targets.trim.label) }));
    expect(lastMeasureInput().planeOffsetIn).toBe(1.5);
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(copy.targets.glass.label) }));
    expect(lastMeasureInput().planeOffsetIn).toBe(0);
    fireEvent.change(screen.getByLabelText(copy.offsetField), { target: { value: '0.75' } });
    expect(lastMeasureInput().planeOffsetIn).toBe(0.75);
    for (const t of ['frame', 'trim', 'glass'] as const) expect((screen.getByRole('radio', { name: new RegExp(copy.targets[t].label) }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: copy.save }));
    expect(onSave.mock.calls[0]![0].scale).toEqual({ kind: 'sheet', paper: 'letter', imagePoints: DETECTION.imagePoints, sheetPointsIn: DETECTION.sheetPointsIn, planeOffsetIn: 0.75 });
  });

  it('shows the size to 1/8 in with its ±; Save hands back the sheet scale and the engine’s numbers', async () => {
    const { onSave } = renderMeasure();
    await ready();
    expect(liveSize()).toContain(copy.sizeExact('35 7/8', '59 3/4'));
    expect(liveSize()).toContain(copy.plusMinus('1/16'));
    expect(screen.queryByText(copy.retake)).toBeNull();
    fireEvent.change(screen.getByLabelText(copy.label), { target: { value: 'Kitchen' } });
    fireEvent.click(screen.getByRole('button', { name: copy.save }));
    const [input, local] = onSave.mock.calls[0]!;
    expect(input).toEqual({ id: expect.stringMatching(/^photo-/), uploadId: 'up1', label: 'Kitchen', corners: SNAPPED, scale: { kind: 'sheet', paper: 'letter', imagePoints: DETECTION.imagePoints, sheetPointsIn: DETECTION.sheetPointsIn, planeOffsetIn: 1 } });
    expect(local).toMatchObject({ widthIn: 35.87, heightIn: 59.74, uncertaintyIn: MEASURED.uncertaintyIn, distanceIn: 78, viewAngleDeg: 12 });
  });

  it('a photo with no camera data (no focal length): says the size is less certain and asks the engine for the wider ±', async () => {
    renderMeasure({ upload: { ...UPLOAD, focal35mm: null } });
    await ready();
    expect(document.querySelector('[data-no-camera-data]')!.textContent).toBe(copy.noCameraData);
    expect(lastMeasureInput().focalSigmaFrac).toBe(SHEET_FOCAL_UNKNOWN_SIGMA);
    cleanup();
    renderMeasure();
    await ready();
    expect(document.querySelector('[data-no-camera-data]')).toBeNull();
    expect(lastMeasureInput().focalSigmaFrac).toBeUndefined();
  });

  it('asks for a re-take when the size could be off by more than 1/4 in', async () => {
    measureResult = { ...MEASURED, uncertaintyIn: { width: 0.3, height: 0.1 } };
    renderMeasure();
    await ready();
    const prompt = document.querySelector('[data-retake-prompt]')!;
    expect(prompt.textContent).toContain(copy.retake);
    expect(prompt.textContent).toContain(copy.retakeWhy('5/16'));
    expect(liveSize()).toContain(copy.plusMinus('5/16'));
  });

  it('combines this photo with the other photos of the same window', async () => {
    const other = (id: string, widthIn: number, heightIn: number): PhotoWindow => ({
      id,
      uploadId: 'up0',
      label: 'Kitchen',
      ...(id !== 'pw1' && { windowKey: 'pw1' }),
      corners: SNAPPED,
      scale: { kind: 'sheet', paper: 'letter', imagePoints: DETECTION.imagePoints, sheetPointsIn: DETECTION.sheetPointsIn, planeOffsetIn: 1 },
      widthIn,
      heightIn,
      sizeClass: 'large',
      uncertaintyIn: { width: 0.05, height: 0.05 },
      distanceIn: 80,
      viewAngleDeg: 8,
      quality: 'good',
    });
    const live = [other('pw1', 35.75, 59.8), other('pw2', 36, 59.7)];
    const { onSave } = renderMeasure({ live, groups: [{ key: 'pw1', name: 'Kitchen' }], defaultWindowKey: 'pw1' });
    await ready();
    expect((screen.getByLabelText(copy.whichWindow) as HTMLSelectElement).value).toBe('pw1');
    expect(cv.combine).toHaveBeenCalled();
    expect(cv.combine.mock.calls.at(-1)![0]).toHaveLength(3);
    const combined = document.querySelector('[data-combined]')!;
    expect(combined.textContent).toContain(copy.combinedLabel(3));
    // Median of 35.75, 35.87, 36 and of 59.8, 59.74, 59.7; spread 0.25 and 0.1
    expect(combined.textContent).toContain(copy.sizeExact('35 7/8', '59 3/4'));
    expect(combined.textContent).toContain(copy.spread('1/4'));
    fireEvent.click(screen.getByRole('button', { name: copy.save }));
    expect(onSave.mock.calls[0]![0].windowKey).toBe('pw1');
  });
});

describe('Several photos of one window, in the card', () => {
  const input = (id: string, uploadId: string): PhotoWindowInput => ({
    id,
    uploadId,
    label: 'Kitchen',
    ...(id !== 'pw1' && { windowKey: 'pw1' }),
    corners: SNAPPED,
    scale: { kind: 'sheet', paper: 'letter', imagePoints: DETECTION.imagePoints, sheetPointsIn: DETECTION.sheetPointsIn, planeOffsetIn: 1 },
  });
  const inputs = [input('pw1', 'up1'), input('pw2', 'up2'), input('pw3', 'up3')];
  const sizes = new Map([
    ['pw1', { key: '', widthIn: 35.75, heightIn: 59.8, uncertaintyIn: { width: 0.05, height: 0.05 }, distanceIn: 80, viewAngleDeg: 8 }],
    ['pw2', { key: '', widthIn: 35.87, heightIn: 59.74, uncertaintyIn: { width: 0.05, height: 0.05 }, distanceIn: 78, viewAngleDeg: 12 }],
    ['pw3', { key: '', widthIn: 36, heightIn: 59.7, uncertaintyIn: { width: 0.05, height: 0.05 }, distanceIn: 75, viewAngleDeg: 5 }],
  ]);

  it('one row with the combined size and the spread; one window in the counts; in or out together', async () => {
    const local = new Map([...sizes].map(([id, s]) => [id, { ...s, key: JSON.stringify([SNAPPED, inputs.find((w) => w.id === id)!.scale]) }]));
    const live = livePhotoWindows(inputs, [], [], local);
    expect(live).toHaveLength(3);
    const onToggle = vi.fn();
    const onDelete = vi.fn();
    render(
      withEngine(
        <PhotoWindowsList windows={live} inputs={inputs} excluded={new Set()} coverAll={false} srcFor={(id) => `/${id}.jpg`} onOpen={vi.fn()} onToggle={onToggle} onDelete={onDelete} onCoverAll={vi.fn()} />,
      ),
    );
    const rows = document.querySelectorAll('[data-photo-window]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute('data-photos')).toBe('3');
    await waitFor(() => expect(rows[0]!.textContent).toContain(copy.groupSpread(3, '1/4')));
    expect(rows[0]!.textContent).toContain(copy.sizeExact('35 7/8', '59 3/4'));
    expect(rows[0]!.textContent).toContain(copy.photosOfWindow(3));
    fireEvent.click(within(rows[0] as HTMLElement).getByRole('checkbox', { name: copy.inQuote }));
    expect(onToggle).toHaveBeenCalledWith(['pw1', 'pw2', 'pw3']);
    fireEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: copy.deleteRow('Kitchen') }));
    expect(onDelete).toHaveBeenCalledWith(['pw1', 'pw2', 'pw3']);
    // Counted once
    const counts = windowCounts({ windows: [], estimated: null, adjustments: { excludedWindowIds: [], manualCounts: {} }, photoWindows: live });
    expect(Object.values(counts).reduce((n, c) => n + c.measured, 0)).toBe(1);
    expect(counts[windowSizeClass(35.87, 59.74)].measured).toBe(1);
  });
});

describe('Windows from the homeowner\'s phone app, in the card', () => {
  const scale: WindowPhotoScale = { kind: 'ar', pointsM: [[0, 1.5, -2], [0.9, 1.5, -2], [0.9, 0.3, -2], [0, 0.3, -2]], trackingLostCount: 0, device: 'arkit-lidar' };
  const own = (id: string, extra: Partial<PhotoWindowInput>): PhotoWindowInput => ({ id, uploadId: 'up1', corners: SNAPPED, scale, source: 'homeowner-app', ...extra });

  it('are named by their room (with the homeowner\'s own words in brackets) and tagged; a rep\'s own window is not', () => {
    const inputs: PhotoWindowInput[] = [
      own('h1', { room: 'Kitchen', label: 'Over the sink' }),
      own('h2', { room: 'Bedroom' }),
      { id: 'r1', uploadId: 'up1', label: 'Front', corners: SNAPPED, scale },
      { id: 'r2', uploadId: 'up1', corners: SNAPPED, scale },
    ];
    render(withEngine(<PhotoWindowsList windows={[]} inputs={inputs} excluded={new Set()} coverAll={false} srcFor={(id) => `/${id}.jpg`} onOpen={vi.fn()} onToggle={vi.fn()} onDelete={vi.fn()} onCoverAll={vi.fn()} />));
    const row = (id: string) => document.querySelector(`[data-photo-window="${id}"]`)!;
    expect(row('h1').textContent).toContain(copy.roomAndLabel('Kitchen', 'Over the sink'));
    expect(row('h1').textContent).toContain(copy.chipHomeowner);
    expect(row('h2').textContent).toContain('Bedroom');
    expect(row('h2').textContent).toContain(copy.chipHomeowner);
    expect(row('r1').textContent).toContain('Front');
    expect(row('r1').textContent).toContain(copy.chip);
    expect(row('r1').textContent).not.toContain(copy.chipHomeowner);
    expect(row('r2').textContent).toContain(copy.untitled(4));
  });
});

/* The whole screen: the measuring sheet saved through the flow, against a mocked server. */

let calls: { key: string; body: unknown }[];
let current: WindowMeasurementView;
const PATCH = 'PATCH /api/window-measurements/w1';
const sent = () => calls.filter((c) => c.key === PATCH).map((c) => c.body as Record<string, unknown>);
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
    walls: null,
    detector: null,
    missing: null,
    needsReview: null,
    adjustments: { excludedWindowIds: [], manualCounts: {} },
    tookMs: 0,
    uploads: [UPLOAD],
  };
}

describe('Measuring sheet through the windows screen', () => {
  beforeEach(() => {
    calls = [];
    current = view();
    vi.stubEnv('VITE_MEASURE_SCAN_MS', '0');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const key = `${init?.method ?? 'GET'} ${String(input)}`;
        const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        calls.push({ key, body });
        if (key === 'GET /api/window-measurements/w1') return json(current);
        if (key === 'GET /api/window-measurements/w1/preview') return json({ quotes: priceWindows(windowCounts(current)) });
        if (key === PATCH) {
          // The server re-checks the sheet and its size wins
          const adjustments = { ...current.adjustments, ...(body as object) } as WindowMeasurementView['adjustments'];
          const photoWindows = (adjustments.photoWindows ?? []).map((w): PhotoWindow => ({ ...w, widthIn: 35.9, heightIn: 59.7, sizeClass: windowSizeClass(35.9, 59.7), uncertaintyIn: { width: 0.04, height: 0.05 }, distanceIn: 78, viewAngleDeg: 12, quality: 'good' }));
          current = { ...current, adjustments, photoWindows };
          return json(current);
        }
        return json({ error: `Unexpected ${key}` }, 500);
      }),
    );
  });

  it('measure a photo with the sheet, save: one PATCH after 500 ms with kind "sheet"; the card shows the size to 1/8 in', async () => {
    const queryClient = createQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false } });
    const router = createMemoryRouter([{ path: 'estimator/windows/:windowMeasurementId', element: <WindowsWindow /> }], { initialEntries: ['/estimator/windows/w1'] });
    render(
      withEngine(
        <Providers client={queryClient}>
          <RouterProvider router={router} />
        </Providers>,
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: measureWindows.scanButton }));
    await screen.findByRole('heading', { name: measureWindows.measuredBy });
    const card = () => screen.getByRole('region', { name: measureWindows.statsLabel });
    fireEvent.click(within(card()).getByRole('button', { name: copy.add }));
    const dialog = screen.getByRole('dialog', { name: copy.title });
    // The how-to and the way to print the sheet are on the photos screen
    for (const step of copy.howTo) expect(within(dialog).getByText(step)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: copy.printOpen }));
    expect(await within(dialog).findByRole('img', { name: copy.printPreview })).toBeTruthy();
    fireEvent.click(within(dialog).getAllByRole('button', { name: copy.back })[0]!);
    fireEvent.click(within(dialog).getByRole('button', { name: copy.measure }));
    stubRect(photoFrame());
    await ready();
    fireEvent.change(screen.getByLabelText(copy.label), { target: { value: 'Kitchen' } });
    fireEvent.click(screen.getByRole('button', { name: copy.save }));
    // "Add another photo of Kitchen" is offered for the next photo
    expect(within(dialog).getByRole('button', { name: copy.anotherPhoto('Kitchen') })).toBeTruthy();
    await wait(200);
    expect(sent()).toHaveLength(0);
    await waitFor(() => expect(sent()).toHaveLength(1));
    await wait(600);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toEqual({
      photoWindows: [{ id: expect.stringMatching(/^photo-/), uploadId: 'up1', label: 'Kitchen', corners: SNAPPED, scale: { kind: 'sheet', paper: 'letter', imagePoints: DETECTION.imagePoints, sheetPointsIn: DETECTION.sheetPointsIn, planeOffsetIn: 1 } }],
    });
    fireEvent.click(within(dialog).getByRole('button', { name: copy.close }));
    const row = card().querySelector('[data-photo-window]')!;
    // The server's size (35.9 x 59.7) wins: 35 7/8 x 59 3/4
    await waitFor(() => expect(row.textContent).toContain(copy.sizeExact('35 7/8', '59 3/4')));
    expect(row.textContent).toContain(copy.plusMinus('1/16'));
  });
});
