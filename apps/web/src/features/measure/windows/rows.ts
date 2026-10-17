import {
  photoWindowGroups,
  photoWindowKey,
  WINDOW_SIZE_CLASSES,
  type PhotoWindow,
  type PhotoWindowInput,
  type WindowCounts,
  type WindowPhotoMeasurement,
  type WindowPhotoScale,
  type WindowSizeClass,
} from '@roofline/shared';
import type { ShownWindow } from './model.ts';
import { asMeasurement, RETAKE_UNCERTAINTY_IN } from './photoModel.ts';

/** How a window was measured: its glyph and name in the table. */
export type RowMethod = 'lidar' | 'ar' | 'sheet' | 'paper' | 'hand' | 'room' | 'street' | 'walls';
/**
 * How far a measurement can be trusted. estimate: a count, or a size from the street photo (a quote only). quote: good
 * enough to quote, not to order from (a room scan, paper on the glass, one side by hand). order: LiDAR AR or the
 * measuring sheet, with a stated error: a factory can build from it.
 */
export type RowGrade = 'estimate' | 'quote' | 'order';
export type RowStatus = 'ready' | 'remeasure' | 'quote' | 'estimate' | 'out';
/** Why a window should be measured again (or looked at). `inches` is how far off the size could be, or how far the photos differ. */
export type RowReason = { kind: 'unclear' } | { kind: 'doubt'; inches: number } | { kind: 'spread'; inches: number };

export type WindowRow = {
  key: string;
  kind: 'photo' | 'street' | 'estimate';
  /** "W1", or "W5–7" for a run of estimated windows of one size. */
  tag: string;
  /** Number of the first window the row stands for (1-based), and how many windows it stands for (an estimate row has several). */
  first: number;
  count: number;
  /** What the person called it ("Living, front"); empty for an estimate row. */
  name: string;
  sizeClass: WindowSizeClass;
  /** Null for an estimate: nobody measured it, so no size is made up. */
  size: { widthIn: number; heightIn: number; pm: number | null } | null;
  method: RowMethod;
  grade: RowGrade;
  status: RowStatus;
  /** Left out of the quote (the row stays, and says so). */
  excluded: boolean;
  /** Photos behind the size (1 for a window measured once). */
  photos: number;
  reasons: RowReason[];
  /** What the row's controls act on: the photographed windows' ids (all of one window's photos), or the street window's. */
  ids: string[];
  /** The photographed window "Measure again" opens (one with a photo to open), or null. */
  open: PhotoWindowInput | null;
  /** A street-photo window's size before a door ruler corrected it, or null. */
  was: { widthIn: number; heightIn: number } | null;
};

/** The method, and the grade it gives, for a photographed window's scale. */
export function methodOf(scale: WindowPhotoScale): { method: RowMethod; grade: RowGrade } {
  switch (scale.kind) {
    case 'ar':
      return { method: scale.device === 'arkit-lidar' ? 'lidar' : 'ar', grade: 'order' };
    case 'sheet':
      return { method: 'sheet', grade: 'order' };
    case 'reference':
      return { method: 'paper', grade: 'quote' };
    case 'known-side':
      return { method: 'hand', grade: 'quote' };
    case 'roomplan':
      return { method: 'room', grade: 'quote' };
  }
}

/** A size as the table shows it: to the nearest eighth of an inch (a reading is never finer than that). */
export const toEighth = (inches: number) => Math.round(inches * 8) / 8;
/** An error as the table shows it: rounded up to the next sixteenth, never less than 1/16, so a tolerance never reads as zero. */
export const toSixteenthUp = (inches: number) => Math.max(1, Math.ceil(Math.abs(inches) * 16 - 1e-9)) / 16;

const GRADE_ORDER: RowGrade[] = ['estimate', 'quote', 'order'];
const lowest = (grades: RowGrade[]): RowGrade => grades.reduce((a, b) => (GRADE_ORDER.indexOf(b) < GRADE_ORDER.indexOf(a) ? b : a));

/** One photographed window's size from its photos, and how far they disagree. */
export type GroupMeasure = { widthIn: number; heightIn: number; pm: number | null; spreadIn: number | null };

const middle = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)]!;

/** The engine's way of combining several photos of one window (WindowPhotoCv.combine). */
export type Combine = (ms: WindowPhotoMeasurement[]) => { widthIn: number; heightIn: number; spreadIn: { width: number; height: number } } | null;

/**
 * One photographed window's size from its photos. Several photos are combined by `combine` when the engine is there
 * (the median size and how far the photos differ), else by their median; one photo is its own size. The error is the
 * largest any photo states, and absent when none does (paper, a side by hand, a room scan).
 */
export function groupMeasure(photos: readonly PhotoWindow[], combine: Combine | null): GroupMeasure | null {
  if (photos.length === 0) return null;
  const errors = photos.flatMap((p) => (p.uncertaintyIn ? [p.uncertaintyIn.width, p.uncertaintyIn.height] : []));
  const pm = errors.length === 0 ? null : Math.max(...errors);
  if (photos.length === 1) return { widthIn: photos[0]!.widthIn, heightIn: photos[0]!.heightIn, pm, spreadIn: null };
  const widths = photos.map((p) => p.widthIn);
  const heights = photos.map((p) => p.heightIn);
  const spreadOf = (vs: number[]) => Math.max(...vs) - Math.min(...vs);
  const combined = combine?.(photos.map(asMeasurement)) ?? null;
  if (combined === null) return { widthIn: middle(widths), heightIn: middle(heights), pm, spreadIn: Math.max(spreadOf(widths), spreadOf(heights)) };
  return { widthIn: combined.widthIn, heightIn: combined.heightIn, pm, spreadIn: Math.max(combined.spreadIn.width, combined.spreadIn.height) };
}

/** The windows photographed on site, grouped by window (several photos of one window are one), named as the person did. */
export function photoGroups(inputs: readonly PhotoWindowInput[], untitled: (n: number) => string): { key: string; name: string; members: PhotoWindowInput[] }[] {
  const out: { key: string; name: string; members: PhotoWindowInput[] }[] = [];
  for (const w of inputs) {
    const key = photoWindowKey(w);
    const found = out.find((g) => g.key === key);
    if (found) found.members.push(w);
    else out.push({ key, name: w.label ?? untitled(out.length + 1), members: [w] });
  }
  return out;
}

export type RowSources = {
  /** The photographed windows as the screen has them. */
  inputs: readonly PhotoWindowInput[];
  /** The photographed windows as sized now (one that cannot be sized yet is left out). */
  live: readonly PhotoWindow[];
  /** The windows seen on the street photo, as drawn. */
  street: readonly ShownWindow[];
  /** What the quote counts now (measured and estimated, by size). */
  counts: WindowCounts;
  /** Windows left out of the quote. */
  excluded: ReadonlySet<string>;
  untitled: (n: number) => string;
  streetName: (floor: number) => string;
  combine: Combine | null;
};

/**
 * The windows as the table lists them, numbered the way the drawing numbers them: those measured on site first, then
 * those marked on the street photo, then the windows that are only an estimate (one row for each size, standing for a run).
 */
export function buildRows(src: RowSources): WindowRow[] {
  const rows: WindowRow[] = [];
  let n = 0;
  const next = (count: number) => {
    const first = n + 1;
    n += count;
    return { first, tag: count === 1 ? `W${first}` : `W${first}–${first + count - 1}` };
  };

  for (const g of photoGroups(src.inputs, src.untitled)) {
    const sized = g.members.flatMap((m) => src.live.filter((w) => w.id === m.id));
    const measure = groupMeasure(sized, src.combine);
    // A window still being sized has no row yet: it has no size, and the quote does not count it either
    if (measure === null) continue;
    const methods = sized.map((p) => methodOf(p.scale));
    const grade = lowest(methods.map((m) => m.grade));
    const ids = g.members.map((m) => m.id);
    const excluded = ids.every((id) => src.excluded.has(id));
    const reasons: RowReason[] = [];
    // Photos taken to the order's standard are checked the way the order sheet checks them
    if (grade === 'order') {
      if (sized.some((p) => p.quality === 'check')) reasons.push({ kind: 'unclear' });
      if (measure.pm !== null && measure.pm > RETAKE_UNCERTAINTY_IN) reasons.push({ kind: 'doubt', inches: measure.pm });
    }
    if (measure.spreadIn !== null && measure.spreadIn > RETAKE_UNCERTAINTY_IN) reasons.push({ kind: 'spread', inches: measure.spreadIn });
    const needsAgain = reasons.length > 0;
    rows.push({
      key: `photo:${g.key}`,
      kind: 'photo',
      ...next(1),
      count: 1,
      name: g.name,
      // The quote's own class for it: the median of its photos, the way the counts group them
      sizeClass: photoWindowGroups(sized)[0]?.sizeClass ?? 'standard',
      size: { widthIn: measure.widthIn, heightIn: measure.heightIn, pm: measure.pm },
      method: methods[0]!.method,
      grade,
      status: excluded ? 'out' : grade === 'order' ? (needsAgain ? 'remeasure' : 'ready') : 'quote',
      excluded,
      photos: g.members.length,
      reasons,
      ids,
      open: g.members.find((m) => m.uploadId !== undefined) ?? null,
      was: null,
    });
  }

  for (const w of src.street) {
    if (w.sized === null) continue;
    const out = src.excluded.has(w.id);
    rows.push({
      key: `street:${w.id}`,
      kind: 'street',
      ...next(1),
      count: 1,
      name: src.streetName(w.sized.floor),
      sizeClass: w.sized.sizeClass,
      size: { widthIn: Math.round(w.sized.widthIn), heightIn: Math.round(w.sized.heightIn), pm: null },
      method: 'street',
      grade: 'estimate',
      status: out ? 'out' : 'estimate',
      excluded: out,
      photos: 1,
      reasons: [],
      ids: [w.id],
      open: null,
      was: w.sized.beforeRuler ?? null,
    });
  }

  for (const cls of WINDOW_SIZE_CLASSES) {
    const count = src.counts[cls].estimated;
    if (count <= 0) continue;
    rows.push({
      key: `estimate:${cls}`,
      kind: 'estimate',
      ...next(count),
      count,
      name: '',
      sizeClass: cls,
      size: null,
      method: 'walls',
      grade: 'estimate',
      status: 'estimate',
      excluded: false,
      photos: 0,
      reasons: [],
      ids: [],
      open: null,
      was: null,
    });
  }
  return rows;
}

/**
 * How many windows are at each grade, left-out ones not counted. A window whose readings are out of tolerance is not
 * order-grade yet: it counts as quote-grade until it is measured again.
 */
export function gradeCounts(rows: readonly WindowRow[]): Record<RowGrade, number> {
  const out: Record<RowGrade, number> = { estimate: 0, quote: 0, order: 0 };
  for (const r of rows) {
    if (r.excluded) continue;
    out[r.status === 'remeasure' ? 'quote' : r.grade] += r.count;
  }
  return out;
}

/** The row to open on: the first window that should be measured again, if there is one. */
export function firstToMeasureAgain(rows: readonly WindowRow[]): string | null {
  return rows.find((r) => r.status === 'remeasure')?.key ?? null;
}

/**
 * A typical window of each size class (united inches in the class), for drawing an estimated window: nobody measured
 * it, so it is drawn dashed and at the class's usual size. The estimate itself counts windows of 36 x 60.
 */
export const TYPICAL_SIZE: Readonly<Record<WindowSizeClass, { widthIn: number; heightIn: number }>> = {
  small: { widthIn: 24, heightIn: 36 },
  standard: { widthIn: 36, heightIn: 60 },
  large: { widthIn: 42, heightIn: 66 },
  picture: { widthIn: 72, heightIn: 60 },
};

/** A window as the elevation draws it: which table row it belongs to, its tag, its size and state. */
export type DrawnWindow = {
  /** The table row it stands for (several drawn windows can share one: a run of estimated ones). */
  rowKey: string;
  tag: string;
  widthIn: number;
  heightIn: number;
  status: RowStatus;
  /** Not measured: drawn dashed, at a typical size. */
  estimated: boolean;
};

/** Every window the rows stand for, one drawn window each (an estimate row is a run of them), left out ones kept (drawn faint). */
export function drawnWindows(rows: readonly WindowRow[]): DrawnWindow[] {
  return rows.flatMap((r): DrawnWindow[] => {
    if (r.kind === 'estimate') {
      const size = TYPICAL_SIZE[r.sizeClass];
      return Array.from({ length: r.count }, (_, i) => ({ rowKey: r.key, tag: `W${r.first + i}`, ...size, status: r.status, estimated: true }));
    }
    return r.size === null ? [] : [{ rowKey: r.key, tag: r.tag, widthIn: r.size.widthIn, heightIn: r.size.heightIn, status: r.status, estimated: r.kind === 'street' }];
  });
}
