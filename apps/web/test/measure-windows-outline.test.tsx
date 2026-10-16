import type { CalibrationSheet, Quad, SheetDetection, SheetPaper, SnappedQuad, WindowPhotoCv, WindowPhotoMeasurement, WindowPhotoUpload } from '@roofline/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { windowPhotos as copy } from '../src/copy/measureWindows.ts';
import { PhotoEngineProvider, type PhotoEngineSeam } from '../src/features/measure/windows/photoEngine.tsx';
import { PhotoMeasure } from '../src/features/measure/windows/PhotoMeasure.tsx';
import { needsOutlinePick, readPrintScale, writePrintScale } from '../src/features/measure/windows/photoModel.ts';
import { SheetHowTo } from '../src/features/measure/windows/PhotoWindows.tsx';
import { SheetPrint } from '../src/features/measure/windows/SheetPrint.tsx';

/* The outline picker, proposed corners, two sheets and the print check, against a fake engine. */

const UPLOAD: WindowPhotoUpload = { id: 'up1', widthPx: 1200, heightPx: 1600, focal35mm: 26, takenAt: null };
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
  outline: [
    [700, 1100],
    [880, 1105],
    [878, 1340],
    [700, 1345],
  ],
};
const box = (x0: number, y0: number, x1: number, y1: number): Quad => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
// Nested outlines, outside in: the trim, the inside of the frame, the glass
const TRIM = box(280, 360, 960, 1300);
const FRAME = box(300, 380, 940, 1280);
const GLASS = box(330, 410, 910, 1250);
const SIGMA: [number, number, number, number] = [0.4, 0.5, 0.45, 0.6];
const CLOSE: SnappedQuad = {
  quad: TRIM,
  sideConfidence: [0.9, 0.3, 0.9, 0.9],
  moved: true,
  cornerSigmaPx: SIGMA,
  rivals: [0, 1, 0, 0],
  candidates: [
    { quad: TRIM, layer: 'outer-trim', score: 0.82 },
    { quad: FRAME, layer: 'frame-inner', score: 0.8 },
    { quad: GLASS, layer: 'glass', score: 0.5 },
  ],
};
/** Inches from a quad's pixels (1 in = 20 px here), so each outline has its own size. */
const sizeOf = (q: Quad): WindowPhotoMeasurement => ({
  widthIn: (q[1][0] - q[0][0]) / 20,
  heightIn: (q[3][1] - q[0][1]) / 20,
  uncertaintyIn: { width: 0.05, height: 0.05 },
  distanceIn: 78,
  viewAngleDeg: 12,
  warnings: [],
});

let cv: WindowPhotoCv & { [K in 'detectSheet' | 'snapQuad' | 'measure' | 'calibrationSheet']: ReturnType<typeof vi.fn> } & { proposeQuad?: ReturnType<typeof vi.fn> };
let seam: PhotoEngineSeam;

function makeEngine(over: { snap?: SnappedQuad; detection?: SheetDetection; propose?: SnappedQuad | null; twoSheetPrint?: boolean } = {}) {
  const sheet = (paper: SheetPaper, which?: 'A' | 'B'): CalibrationSheet => ({ paper, svg: `<svg data-fake-sheet="${paper}-${which ?? 'A'}"></svg>`, widthIn: 8.5, heightIn: 11 });
  cv = {
    calibrationSheet: vi.fn(over.twoSheetPrint ? (paper: SheetPaper, which?: 'A' | 'B') => sheet(paper, which) : (paper: SheetPaper) => sheet(paper)),
    detectSheet: vi.fn(async () => over.detection ?? DETECTION),
    snapQuad: vi.fn(async () => over.snap ?? CLOSE),
    measure: vi.fn((input: { windowQuad: Quad }) => sizeOf(input.windowQuad)),
    combine: vi.fn(() => null),
    ...(over.propose !== undefined && { proposeQuad: vi.fn(async () => over.propose) }),
  } as unknown as typeof cv;
  seam = { load: async () => cv, readPixels: async () => ({ img: { width: 1200, height: 1600, data: new Uint8ClampedArray(4) }, scale: 1 }) };
}
const withEngine = (ui: ReactNode) => <PhotoEngineProvider engine={seam}>{ui}</PhotoEngineProvider>;
type MeasureInput = Parameters<WindowPhotoCv['measure']>[0];
const lastMeasure = () => cv.measure.mock.calls.at(-1)![0] as MeasureInput;
/** The last time this outline was measured. */
const measureOf = (q: Quad) => [...cv.measure.mock.calls].reverse().map((c) => c[0] as MeasureInput).find((m) => JSON.stringify(m.windowQuad) === JSON.stringify(q))!;
const liveSize = () => document.querySelector('[data-live-size]')!.textContent;
const windowPolygon = () => document.querySelector('svg polygon:not([data-candidate]):not([data-sheet-outline])')!;
const pointsOf = (q: Quad) => q.map(([x, y]) => `${x},${y}`).join(' ');

function renderMeasure() {
  const onSave = vi.fn();
  render(withEngine(<PhotoMeasure upload={UPLOAD} src="/x.jpg" initial={null} saved={null} onSave={onSave} onCancel={vi.fn()} />));
  const frame = screen.getByRole('group', { name: copy.photoLabel });
  (frame as HTMLElement).getBoundingClientRect = () => ({ left: 0, top: 0, right: 1200, bottom: 1600, width: 1200, height: 1600, x: 0, y: 0, toJSON: () => ({}) });
  return onSave;
}
const settled = () => waitFor(() => expect(document.querySelector('[data-snap="snapped"]')).not.toBeNull());
const handle = (i: number) => document.querySelector(`[data-which="window"][data-corner="${i}"]`) as HTMLElement;
/** The person drops the four corners roughly on the frame (the snap runs once all four are placed). */
async function place() {
  await screen.findByText(copy.sheetFound);
  const frame = screen.getByRole('group', { name: copy.photoLabel });
  for (const [i, [x, y]] of FRAME.entries()) {
    const [sx, sy] = [handle(i).style.left, handle(i).style.top].map((v) => Number.parseFloat(v));
    fireEvent.pointerDown(handle(i), { clientX: (sx! / 100) * 1200, clientY: (sy! / 100) * 1600, pointerId: 1 });
    fireEvent.pointerMove(frame, { clientX: x + 5, clientY: y + 5, pointerId: 1 });
    fireEvent.pointerUp(frame, { clientX: x + 5, clientY: y + 5, pointerId: 1 });
  }
}
async function renderPlaced() {
  const onSave = renderMeasure();
  await place();
  return onSave;
}

beforeEach(() => {
  makeEngine();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('Which outline are you measuring?', () => {
  it('asks when the top outlines score close, picks the one matching the target, and sizes each', async () => {
    await renderPlaced();
    const pickBox = await screen.findByRole('group', { name: copy.pickTitle });
    // Inside of the frame is measured, so B (frame-inner) is picked even though the engine ranked the trim first
    const options = within(pickBox).getAllByRole('radio');
    expect(options).toHaveLength(3);
    expect((options[1] as HTMLInputElement).checked).toBe(true);
    expect(options[0]!.getAttribute('aria-label')).toBe(copy.pickOption('A', copy.sizeExact('34', '47'), copy.layers['outer-trim']));
    expect(options[1]!.getAttribute('aria-label')).toBe(copy.pickOption('B', copy.sizeExact('32', '45'), copy.layers['frame-inner']));
    expect(options[2]!.getAttribute('aria-label')).toBe(copy.pickOption('C', copy.sizeExact('29', '42'), copy.layers.glass));
    expect(within(pickBox).getAllByRole('img').map((i) => i.getAttribute('aria-label'))).toEqual(['A', 'B', 'C'].map((l) => copy.pickCorner(l)));
    expect(windowPolygon().getAttribute('points')).toBe(pointsOf(FRAME));
    // The other two are drawn dashed, lettered on the photo
    expect([...document.querySelectorAll('polygon[data-candidate]')].map((p) => p.getAttribute('data-candidate'))).toEqual(['0', '2']);
    expect(document.querySelectorAll('[data-candidate-tag]')).toHaveLength(3);
    expect(document.querySelector('[data-live-size]')!.textContent).toContain(copy.sizeExact('32', '45'));
  });

  it('tapping an outline picks it; the target no longer moves a pick the person made', async () => {
    await renderPlaced();
    const pickBox = await screen.findByRole('group', { name: copy.pickTitle });
    fireEvent.click(within(pickBox).getAllByRole('radio')[2]!);
    expect(liveSize()).toContain(copy.sizeExact('29', '42'));
    expect(windowPolygon().getAttribute('points')).toBe(pointsOf(GLASS));
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(copy.targets.trim.label) }));
    expect(windowPolygon().getAttribute('points')).toBe(pointsOf(GLASS));
    expect(measureOf(GLASS).planeOffsetIn).toBe(1.5);
  });

  it('the screen’s own pick follows "What are you measuring?"', async () => {
    await renderPlaced();
    await screen.findByRole('group', { name: copy.pickTitle });
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(copy.targets.trim.label) }));
    expect(windowPolygon().getAttribute('points')).toBe(pointsOf(TRIM));
    expect(liveSize()).toContain(copy.sizeExact('34', '47'));
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(copy.targets.glass.label) }));
    expect(windowPolygon().getAttribute('points')).toBe(pointsOf(GLASS));
  });

  it('per-side "check this edge" and the corner noise belong to the engine’s chosen outline only', async () => {
    await renderPlaced();
    const pickBox = await screen.findByRole('group', { name: copy.pickTitle });
    // B is shown: no per-side data for it, corners treated as placed by hand
    expect(document.querySelector('[data-edge-flag]')).toBeNull();
    expect(measureOf(FRAME).cornerSigmaPx).toBeUndefined();
    expect(measureOf(GLASS).cornerSigmaPx).toBeUndefined();
    expect(measureOf(TRIM).cornerSigmaPx).toEqual(SIGMA);
    fireEvent.click(within(pickBox).getAllByRole('radio')[0]!);
    expect(document.querySelector('[data-edge-flag="1"]')!.textContent).toBe(copy.checkEdge);
  });

  it('no question when no side has rivals and one outline clearly wins; cornerSigmaPx goes to measure', async () => {
    makeEngine({ snap: { ...CLOSE, quad: FRAME, rivals: [0, 0, 0, 0], candidates: [{ quad: FRAME, layer: 'frame-inner', score: 0.9 }, { quad: GLASS, layer: 'glass', score: 0.4 }] } });
    await renderPlaced();
    await settled();
    expect(screen.queryByRole('group', { name: copy.pickTitle })).toBeNull();
    expect(lastMeasure().windowQuad).toEqual(FRAME);
    expect(lastMeasure().cornerSigmaPx).toEqual(SIGMA);
    expect(cv.snapQuad.mock.calls[0]![2]).toEqual({ target: 'inside-frame', sheet: expect.objectContaining({ imagePoints: DETECTION.imagePoints }) });
  });

  it('the rule: rivals, or the top two within 15%', () => {
    const c = (a: number, b: number) => [
      { quad: FRAME, layer: 'frame-inner' as const, score: a },
      { quad: GLASS, layer: 'glass' as const, score: b },
    ];
    expect(needsOutlinePick({ candidates: c(0.9, 0.5) })).toBe(false);
    expect(needsOutlinePick({ candidates: c(0.9, 0.8) })).toBe(true);
    expect(needsOutlinePick({ candidates: c(0.9, 0.5), rivals: [0, 0, 2, 0] })).toBe(true);
    expect(needsOutlinePick({ candidates: c(0.9, 0.5).slice(0, 1), rivals: [1, 1, 1, 1] })).toBe(false);
  });
});

describe('Corners proposed around the sheet', () => {
  it('seeds the corners with proposeQuad (target included) instead of the inset, and does not snap first', async () => {
    makeEngine({ propose: { quad: FRAME, sideConfidence: [0.9, 0.9, 0.9, 0.9], moved: true, rivals: [0, 0, 0, 0], candidates: [{ quad: FRAME, layer: 'frame-inner', score: 0.9 }] } });
    renderMeasure();
    await settled();
    expect(cv.proposeQuad).toHaveBeenCalledTimes(1);
    expect(cv.proposeQuad!.mock.calls[0]![1]).toMatchObject({ imagePoints: DETECTION.imagePoints });
    expect(cv.proposeQuad!.mock.calls[0]![2]).toBe('inside-frame');
    expect(cv.snapQuad).not.toHaveBeenCalled();
    expect(windowPolygon().getAttribute('points')).toBe(pointsOf(FRAME));
    // The hint says the window was found; the corners count as placed, so the size and Save are there
    expect(screen.getByText(copy.sheetHintProposed)).toBeTruthy();
    expect(document.querySelector('[data-snap]')!.textContent).toBe(copy.snapped);
    expect((screen.getByRole('button', { name: copy.save }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('nothing proposed: the corners wait for the person, then snap', async () => {
    makeEngine({ propose: null });
    renderMeasure();
    await waitFor(() => expect(cv.proposeQuad).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(cv.snapQuad).not.toHaveBeenCalled();
    // The hint does not claim the corners were found
    expect(screen.getByText(copy.sheetHintPlace)).toBeTruthy();
    expect(screen.queryByText(copy.sheetHintProposed)).toBeNull();
    expect(document.querySelector('[data-snap]')!.textContent).toBe(copy.placeCorners(0));
    await place();
    await waitFor(() => expect(cv.snapQuad).toHaveBeenCalledTimes(1));
  });
});

describe('Two sheets on a big window', () => {
  it('says two sheets were found, sizes from both, and saves which sheet each point is on', async () => {
    const two: SheetDetection = {
      ...DETECTION,
      imagePoints: [...DETECTION.imagePoints, [300, 400], [380, 402], [379, 510], [301, 512]],
      sheetPointsIn: [...DETECTION.sheetPointsIn, ...DETECTION.sheetPointsIn],
      sheets: 2,
      sheetIndex: [0, 0, 0, 0, 1, 1, 1, 1],
    };
    makeEngine({ detection: two, snap: { ...CLOSE, quad: FRAME, rivals: [0, 0, 0, 0], candidates: [] } });
    const onSave = await renderPlaced();
    await settled();
    expect(document.querySelector('[data-two-sheets]')!.textContent).toBe(copy.twoSheets);
    expect(document.querySelector('[data-size-two-sheets]')!.textContent).toBe(copy.twoSheetsSize);
    expect(lastMeasure().sheet).toMatchObject({ sheetIndex: two.sheetIndex });
    fireEvent.click(screen.getByRole('button', { name: copy.save }));
    expect(onSave.mock.calls[0]![0].scale).toMatchObject({ kind: 'sheet', sheetIndex: two.sheetIndex, imagePoints: two.imagePoints });
  });

  it('the how-to and the print view say to tape a second sheet on wide windows', async () => {
    render(withEngine(<SheetHowTo onPrint={vi.fn()} />));
    expect(screen.getByText(copy.bigWindow)).toBeTruthy();
    cleanup();
    render(withEngine(<SheetPrint onClose={vi.fn()} />));
    expect(await screen.findByText(copy.bigWindow)).toBeTruthy();
  });

  it('offers Sheet A and Sheet B when the engine prints two different sheets (and not otherwise)', async () => {
    render(withEngine(<SheetPrint onClose={vi.fn()} />));
    await screen.findByRole('img', { name: copy.printPreview });
    expect(screen.queryByRole('radiogroup', { name: copy.sheetPick })).toBeNull();
    cleanup();
    makeEngine({ twoSheetPrint: true });
    render(withEngine(<SheetPrint onClose={vi.fn()} />));
    const group = await screen.findByRole('radiogroup', { name: copy.sheetPick });
    expect(document.querySelector('[data-fake-sheet="letter-A"]')).not.toBeNull();
    fireEvent.click(within(group).getByRole('radio', { name: copy.sheetLetters[1] }));
    expect(cv.calibrationSheet).toHaveBeenLastCalledWith('letter', 'B');
    expect(document.querySelector('[data-print-sheet] [data-fake-sheet="letter-B"]')).not.toBeNull();
  });
});

describe('Print check', () => {
  it('the ruler as measured gives the print scale (100% by default), kept for this paper', async () => {
    render(withEngine(<SheetPrint onClose={vi.fn()} />));
    await screen.findByRole('img', { name: copy.printPreview });
    const field = screen.getByLabelText(copy.printCheckField('in')) as HTMLInputElement;
    expect(field.value).toBe('6');
    expect(screen.getByText(copy.printCheckScale('100.0'))).toBeTruthy();
    fireEvent.change(field, { target: { value: '5.94' } });
    expect(screen.getByText(copy.printCheckScale('99.0'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy.printCheckSave }));
    expect(screen.getByText(copy.printCheckSaved('99.0'))).toBeTruthy();
    expect(readPrintScale('letter')).toBeCloseTo(0.99, 6);
    expect(readPrintScale('a4')).toBe(1);
    // More than 10% off is a misprint
    fireEvent.change(field, { target: { value: '5' } });
    expect(screen.getByText(copy.printCheckOff)).toBeTruthy();
    expect((screen.getByRole('button', { name: copy.printCheckSave }) as HTMLButtonElement).disabled).toBe(true);
    // A4's ruler is in centimetres
    fireEvent.change(screen.getByLabelText(copy.printPaper), { target: { value: 'a4' } });
    expect((screen.getByLabelText(copy.printCheckField('cm')) as HTMLInputElement).value).toBe('15');
  });

  it('a checked print scale goes to measure() and is saved with the window', async () => {
    writePrintScale('letter', 0.99);
    makeEngine({ snap: { ...CLOSE, quad: FRAME, rivals: [0, 0, 0, 0], candidates: [] } });
    const onSave = await renderPlaced();
    await settled();
    expect(lastMeasure().printScale).toBe(0.99);
    expect(document.querySelector('[data-size-print-scale]')!.textContent).toBe(copy.printCheckApplied('99.0'));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: copy.save }));
    expect(onSave.mock.calls[0]![0].scale.printScale).toBe(0.99);
  });

  it('an unchecked print (100%) sends no printScale', async () => {
    makeEngine({ snap: { ...CLOSE, quad: FRAME, rivals: [0, 0, 0, 0], candidates: [] } });
    const onSave = await renderPlaced();
    await settled();
    expect(lastMeasure().printScale).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: copy.save }));
    expect(onSave.mock.calls[0]![0].scale).not.toHaveProperty('printScale');
  });
});
