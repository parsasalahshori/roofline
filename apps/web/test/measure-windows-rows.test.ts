import { windowSizeClass, type PhotoWindow, type PhotoWindowInput, type WindowCounts } from '@roofline/shared';
import { describe, expect, it } from 'vitest';
import { layoutWindows } from '../src/features/measure/windows/ElevationDrawing.tsx';
import type { ShownWindow } from '../src/features/measure/windows/model.ts';
import {
  buildRows,
  drawnWindows,
  firstToMeasureAgain,
  gradeCounts,
  groupMeasure,
  methodOf,
  toEighth,
  toSixteenthUp,
  TYPICAL_SIZE,
  type RowSources,
} from '../src/features/measure/windows/rows.ts';

const LIDAR = { kind: 'ar', device: 'arkit-lidar', pointsM: [], cornerSpreadM: [0, 0, 0, 0], trackingLostCount: 0 } as unknown as PhotoWindowInput['scale'];
const SHEET = { kind: 'sheet', paper: 'letter', imagePoints: [], sheetPointsIn: [], planeOffsetIn: 1 } as unknown as PhotoWindowInput['scale'];
const PAPER = { kind: 'reference', reference: 'letter', corners: [] } as unknown as PhotoWindowInput['scale'];

const input = (id: string, label: string, scale: PhotoWindowInput['scale'], windowKey?: string): PhotoWindowInput => ({ id, uploadId: `up-${id}`, label, scale, ...(windowKey !== undefined && { windowKey }) });
const sized = (i: PhotoWindowInput, widthIn: number, heightIn: number, over: Partial<PhotoWindow> = {}): PhotoWindow => ({
  ...i,
  widthIn,
  heightIn,
  sizeClass: windowSizeClass(widthIn, heightIn),
  quality: 'good',
  uncertaintyIn: { width: 0.1, height: 0.1 },
  ...over,
});
const counts = (estimated: Partial<Record<'small' | 'standard' | 'large' | 'picture', number>> = {}, measured = 0): WindowCounts => ({
  small: { measured: 0, estimated: estimated.small ?? 0 },
  standard: { measured, estimated: estimated.standard ?? 0 },
  large: { measured: 0, estimated: estimated.large ?? 0 },
  picture: { measured: 0, estimated: estimated.picture ?? 0 },
});
const base = (over: Partial<RowSources> = {}): RowSources => ({
  inputs: [],
  live: [],
  street: [],
  counts: counts(),
  excluded: new Set(),
  untitled: (n) => `Window ${n}`,
  streetName: (floor) => `Front ${floor}`,
  combine: null,
  ...over,
});

describe('how a window was measured', () => {
  it('names the method and the grade each way of measuring gives', () => {
    expect(methodOf(LIDAR)).toEqual({ method: 'lidar', grade: 'order' });
    expect(methodOf({ ...(LIDAR as object), device: 'webxr' } as PhotoWindowInput['scale'])).toEqual({ method: 'ar', grade: 'order' });
    expect(methodOf(SHEET)).toEqual({ method: 'sheet', grade: 'order' });
    expect(methodOf(PAPER)).toEqual({ method: 'paper', grade: 'quote' });
    expect(methodOf({ kind: 'known-side', side: 'width', inches: 36 })).toEqual({ method: 'hand', grade: 'quote' });
    expect(methodOf({ kind: 'roomplan', widthM: 1, heightM: 1 } as PhotoWindowInput['scale'])).toEqual({ method: 'room', grade: 'quote' });
  });

  it('shows a size to the eighth, and a tolerance rounded up so it never reads as zero', () => {
    expect(toEighth(71.3)).toBe(71.25);
    expect(toEighth(59.7)).toBe(59.75);
    expect(toSixteenthUp(0.02)).toBe(1 / 16);
    expect(toSixteenthUp(0.05)).toBe(1 / 16);
    expect(toSixteenthUp(0.72)).toBe(12 / 16);
  });
});

describe('one window from its photos', () => {
  const a = input('a1', 'Living', LIDAR, 'w1');
  const b = input('a2', 'Living', LIDAR, 'w1');

  it('a single photo is its own size, with the error it states', () => {
    expect(groupMeasure([sized(a, 35.9, 59.7)], null)).toEqual({ widthIn: 35.9, heightIn: 59.7, pm: 0.1, spreadIn: null });
  });

  it('a photo that states no error (paper, a side by hand) has none to show', () => {
    expect(groupMeasure([sized(input('p', 'P', PAPER), 30, 40, { uncertaintyIn: null })], null)?.pm).toBeNull();
  });

  it('several photos are their median and how far they differ, or the engine\'s own combination', () => {
    const photos = [sized(a, 71.25, 59.38), sized(b, 71.63, 59.75), sized(input('a3', 'Living', LIDAR, 'w1'), 71.38, 59.5)];
    expect(groupMeasure(photos, null)).toMatchObject({ widthIn: 71.38, heightIn: 59.5, spreadIn: expect.closeTo(0.38, 5) });
    const combine = () => ({ widthIn: 71.4, heightIn: 59.6, spreadIn: { width: 0.2, height: 0.1 } });
    expect(groupMeasure(photos, combine)).toMatchObject({ widthIn: 71.4, heightIn: 59.6, spreadIn: 0.2 });
  });
});

describe('the rows the table lists', () => {
  it('numbers the photographed windows, then the street ones, then the estimates, a run to a row', () => {
    const kitchen = input('k', 'Kitchen', SHEET);
    const living = input('l', 'Living, front', LIDAR);
    const street: ShownWindow = { id: 's1', photoId: 'ph', box: { x: 0, y: 0, w: 0.1, h: 0.1 }, source: 'marked', sized: { id: 's1', photoId: 'ph', box: { x: 0, y: 0, w: 0.1, h: 0.1 }, widthIn: 30, heightIn: 50, sizeClass: 'standard', floor: 2, confidence: 1 } };
    const rows = buildRows(
      base({
        inputs: [kitchen, living],
        live: [sized(kitchen, 35.62, 47.88), sized(living, 71.25, 59.38)],
        street: [street],
        counts: counts({ standard: 3, picture: 1 }),
      }),
    );
    expect(rows.map((r) => [r.tag, r.kind, r.name, r.count])).toEqual([
      ['W1', 'photo', 'Kitchen', 1],
      ['W2', 'photo', 'Living, front', 1],
      ['W3', 'street', 'Front 2', 1],
      ['W4–6', 'estimate', '', 3],
      ['W7', 'estimate', '', 1],
    ]);
    expect(rows[3]).toMatchObject({ sizeClass: 'standard', size: null, method: 'walls', status: 'estimate' });
    expect(rows[2]).toMatchObject({ method: 'street', grade: 'estimate', size: { widthIn: 30, heightIn: 50, pm: null } });
  });

  it('an order-grade window within tolerance is ready; one out of tolerance or unclear is to be measured again, and says why', () => {
    const fine = input('f', 'Kitchen', SHEET);
    const doubt = input('d', 'Living', LIDAR);
    const blurry = input('b', 'Bath', LIDAR);
    const rows = buildRows(
      base({
        inputs: [fine, doubt, blurry],
        live: [sized(fine, 35, 47, { uncertaintyIn: { width: 0.1, height: 0.1 } }), sized(doubt, 71, 59, { uncertaintyIn: { width: 0.72, height: 0.6 } }), sized(blurry, 23, 35, { quality: 'check' })],
      }),
    );
    expect(rows.map((r) => r.status)).toEqual(['ready', 'remeasure', 'remeasure']);
    expect(rows[1]!.reasons).toEqual([{ kind: 'doubt', inches: 0.72 }]);
    expect(rows[2]!.reasons).toEqual([{ kind: 'unclear' }]);
    expect(firstToMeasureAgain(rows)).toBe(rows[1]!.key);
  });

  it('paper and hand measures are quote-grade whatever their error; a window left out says so', () => {
    const paper = input('p', 'Den', PAPER);
    const out = input('o', 'Hall', SHEET);
    const rows = buildRows(base({ inputs: [paper, out], live: [sized(paper, 30, 40), sized(out, 30, 40)], excluded: new Set(['o']) }));
    expect(rows.map((r) => [r.grade, r.status, r.excluded])).toEqual([
      ['quote', 'quote', false],
      ['order', 'out', true],
    ]);
  });

  it('photos of one window are one row; their spread is a reason to look when it passes the tolerance', () => {
    const a = input('a1', 'Living', LIDAR, 'w1');
    const b = input('a2', 'Living', LIDAR, 'w1');
    const rows = buildRows(base({ inputs: [a, b], live: [sized(a, 71, 59), sized(b, 72, 60)] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ photos: 2, ids: ['a1', 'a2'], status: 'remeasure' });
    expect(rows[0]!.reasons).toEqual([{ kind: 'spread', inches: 1 }]);
  });

  it('a window not sized yet has no row (the quote does not count it either)', () => {
    expect(buildRows(base({ inputs: [input('n', 'New', SHEET)], live: [] }))).toEqual([]);
  });
});

describe('the three grades', () => {
  it('counts windows by grade: a window to measure again is not order-grade yet, and one left out is not counted', () => {
    const a = input('a', 'A', SHEET);
    const b = input('b', 'B', LIDAR);
    const c = input('c', 'C', PAPER);
    const d = input('d', 'D', SHEET);
    const rows = buildRows(
      base({
        inputs: [a, b, c, d],
        live: [sized(a, 30, 40), sized(b, 30, 40, { uncertaintyIn: { width: 1, height: 1 } }), sized(c, 30, 40), sized(d, 30, 40)],
        counts: counts({ standard: 3 }),
        excluded: new Set(['d']),
      }),
    );
    expect(gradeCounts(rows)).toEqual({ estimate: 3, quote: 2, order: 1 });
  });
});

describe('the windows as the drawing has them', () => {
  it('draws every window a row stands for, an estimate dashed at its class\'s usual size, numbered on from the row', () => {
    const rows = buildRows(base({ counts: counts({ small: 1, standard: 2 }) }));
    const drawn = drawnWindows(rows);
    expect(drawn.map((w) => [w.tag, w.estimated, w.widthIn, w.heightIn])).toEqual([
      ['W1', true, TYPICAL_SIZE.small.widthIn, TYPICAL_SIZE.small.heightIn],
      ['W2', true, TYPICAL_SIZE.standard.widthIn, TYPICAL_SIZE.standard.heightIn],
      ['W3', true, TYPICAL_SIZE.standard.widthIn, TYPICAL_SIZE.standard.heightIn],
    ]);
    expect(new Set(drawn.slice(1).map((w) => w.rowKey))).toEqual(new Set(['estimate:standard']));
  });

  it('each typical size is in its own class (the estimate counts windows of 36 x 60)', () => {
    for (const [cls, size] of Object.entries(TYPICAL_SIZE)) expect(windowSizeClass(size.widthIn, size.heightIn)).toBe(cls);
    expect(TYPICAL_SIZE.standard).toEqual({ widthIn: 36, heightIn: 60 });
  });
});

describe('laying the windows out along the wall', () => {
  const wall = { x: 100, ground: 300, width: 400, height: 100, floors: 1 };
  const win = (tag: string, widthIn: number, heightIn = 40) => ({ rowKey: `r:${tag}`, tag, widthIn, heightIn, status: 'ready' as const, estimated: false });

  it('keeps each window to scale and inside the wall, in order, with even gaps', () => {
    const { boxes, hidden } = layoutWindows({ windows: [win('W1', 36), win('W2', 36), win('W3', 36)], wall, pxPerIn: 2 });
    expect(hidden).toBe(0);
    expect(boxes.map((b) => b.w)).toEqual([72, 72, 72]);
    expect(boxes.map((b) => b.h)).toEqual([80, 80, 80]);
    const gaps = boxes.slice(1).map((b, i) => b.x - (boxes[i]!.x + boxes[i]!.w));
    expect(gaps[0]).toBeCloseTo(gaps[1]!, 5);
    expect(boxes[0]!.x).toBeGreaterThan(wall.x);
    expect(boxes[2]!.x + boxes[2]!.w).toBeLessThan(wall.x + wall.width);
  });

  it('takes the next floor for what does not fit on this one, and counts what fits nowhere', () => {
    const three = [win('W1', 60), win('W2', 60), win('W3', 60)];
    const two = layoutWindows({ windows: three, wall: { ...wall, height: 200, floors: 2 }, pxPerIn: 2 });
    expect(two.hidden).toBe(0);
    expect(new Set(two.boxes.map((b) => Math.round(b.y))).size).toBe(2);
    const one = layoutWindows({ windows: three, wall, pxPerIn: 2 });
    expect(one.boxes).toHaveLength(2);
    expect(one.hidden).toBe(1);
  });
});
