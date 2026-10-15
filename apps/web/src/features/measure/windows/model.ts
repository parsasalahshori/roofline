import {
  DEFAULT_WINDOW_TIERS,
  WINDOW_SIZE_CLASSES,
  windowCounts,
  type MarkedBox,
  type MeasuredWindow,
  type PhotoWindow,
  type WindowAdjustments,
  type WindowCounts,
  type WindowMeasurementView,
  type WindowQuote,
  type WindowSizeClass,
  type WindowTier,
} from '@roofline/shared';

/** A box on a photo, in 0..1 of its width and height. */
export type Box = { x: number; y: number; w: number; h: number };
export type Point = [number, number];
/** The front wall's corners on a photo: bottom-left, bottom-right, top-right, top-left. */
export type Corners = [Point, Point, Point, Point];

/** The smallest box worth keeping (about 6 px on a 640 px photo): a click is not a window. */
export const MIN_BOX = 0.01;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round = (v: number) => Math.round(v * 10_000) / 10_000;

/** A box kept inside the photo and at least MIN_BOX on each side. */
export function clampBox(b: Box): Box {
  const w = Math.min(1, Math.max(MIN_BOX, b.w));
  const h = Math.min(1, Math.max(MIN_BOX, b.h));
  const x = Math.min(1 - w, Math.max(0, b.x));
  const y = Math.min(1 - h, Math.max(0, b.y));
  return { x: round(x), y: round(y), w: round(w), h: round(h) };
}

/** The box dragged out from `a` to `b` (either way round), or null when it is too small to be a window. */
export function boxFromDrag(a: Point, b: Point): Box | null {
  const x0 = clamp01(Math.min(a[0], b[0]));
  const y0 = clamp01(Math.min(a[1], b[1]));
  const x1 = clamp01(Math.max(a[0], b[0]));
  const y1 = clamp01(Math.max(a[1], b[1]));
  if (x1 - x0 < MIN_BOX || y1 - y0 < MIN_BOX) return null;
  return clampBox({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
}

/** Which part of a box a drag holds: an edge, a corner, or the middle (moves it). */
export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move';
export const RESIZE_HANDLES: readonly Exclude<Handle, 'move'>[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** The box after its `handle` is dragged by (dx, dy). Edges never cross: a box dragged past itself stops at MIN_BOX. */
export function dragBox(b: Box, handle: Handle, dx: number, dy: number): Box {
  if (handle === 'move') {
    return clampBox({ ...b, x: b.x + dx, y: b.y + dy });
  }
  let left = b.x;
  let top = b.y;
  let right = b.x + b.w;
  let bottom = b.y + b.h;
  if (handle.includes('w')) left = Math.min(clamp01(left + dx), right - MIN_BOX);
  if (handle.includes('e')) right = Math.max(clamp01(right + dx), left + MIN_BOX);
  if (handle.includes('n')) top = Math.min(clamp01(top + dy), bottom - MIN_BOX);
  if (handle.includes('s')) bottom = Math.max(clamp01(bottom + dy), top + MIN_BOX);
  return clampBox({ x: left, y: top, w: right - left, h: bottom - top });
}

/** The corners with corner `i` moved to (x, y), kept on the photo. */
export function moveCorner(corners: Corners, i: number, x: number, y: number): Corners {
  return corners.map((c, j) => (j === i ? [round(clamp01(x)), round(clamp01(y))] : c)) as Corners;
}

/** A new marked window's id: unique within the measurement, made on this device. */
export function newMarkId(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `mark-${random}`;
}

/** A window as the photo draws it: where its box is now, and its size once the server has worked it out. */
export type ShownWindow = {
  id: string;
  photoId: string;
  box: Box;
  source: 'marked' | 'detector';
  /** The server's sized window (null while a new mark is being sized). */
  sized: MeasuredWindow | null;
};

/**
 * The windows to draw: every window the detector found, plus the marks as they are on this screen (a new mark shows
 * at once, unsized; a moved one shows where it is now, with the size it had). A mark removed here goes at once.
 */
export function shownWindows(view: Pick<WindowMeasurementView, 'windows'>, marked: readonly MarkedBox[]): ShownWindow[] {
  const byId = new Map(view.windows.map((w) => [w.id, w]));
  const markIds = new Set(marked.map((m) => m.id));
  const found: ShownWindow[] = view.windows
    .filter((w) => (w.source ?? 'detector') === 'detector' && !markIds.has(w.id))
    .map((w) => ({ id: w.id, photoId: w.photoId, box: w.box, source: 'detector', sized: w }));
  const marks: ShownWindow[] = marked.map((m) => ({ id: m.id, photoId: m.photoId, box: m.box, source: 'marked', sized: byId.get(m.id) ?? null }));
  // Numbered left to right on each photo, the way a person counts them
  return [...found, ...marks].sort((a, b) => (a.photoId === b.photoId ? a.box.x - b.box.x : a.photoId < b.photoId ? -1 : 1));
}

/** The counts the card and quote show now: the sized windows on screen, the estimate, the person's changes. */
export function liveCounts(
  view: Pick<WindowMeasurementView, 'estimated'>,
  shown: readonly ShownWindow[],
  adjustments: WindowAdjustments,
  photoWindows: readonly PhotoWindow[] = [],
): WindowCounts {
  const windows = shown.flatMap((w) => (w.sized === null ? [] : [{ ...w.sized, box: w.box }]));
  return windowCounts({ windows, estimated: view.estimated, adjustments, photoWindows: [...photoWindows] });
}

export const totalOf = (counts: WindowCounts) =>
  WINDOW_SIZE_CLASSES.reduce((n, c) => ({ measured: n.measured + counts[c].measured, estimated: n.estimated + counts[c].estimated }), { measured: 0, estimated: 0 });

/**
 * The company's per-window prices, read back from the server's quotes, so the quote can follow each change at once:
 * a size the server priced keeps its price; one it did not (no window of that size yet) uses the default price.
 */
export function tiersFromQuotes(quotes: readonly WindowQuote[] | undefined): WindowTier[] {
  if (quotes === undefined) return [...DEFAULT_WINDOW_TIERS];
  return quotes.map((q) => {
    const base = DEFAULT_WINDOW_TIERS.find((t) => t.tier === q.tier);
    const priceCents = Object.fromEntries(
      WINDOW_SIZE_CLASSES.map((c) => [c, q.lines.find((l) => l.sizeClass === c)?.unitCents ?? base?.priceCents[c] ?? 0]),
    ) as Record<WindowSizeClass, number>;
    return { tier: q.tier, name: q.name, description: q.description, priceCents, enabled: true };
  });
}

/** The adjustments as the server keeps them, with the marks always a list. */
export function readAdjustments(a: WindowAdjustments): Required<Omit<WindowAdjustments, 'wallCorners'>> & Pick<WindowAdjustments, 'wallCorners'> {
  return {
    excludedWindowIds: a.excludedWindowIds,
    marked: a.marked ?? [],
    manualCounts: a.manualCounts,
    wallCorners: a.wallCorners ?? null,
    photoWindows: a.photoWindows ?? [],
    photosCoverAllWindows: a.photosCoverAllWindows ?? false,
  };
}

/**
 * Where the photo sits in an area of `aw` x `ah` px. 'cover' fills the width or height (whichever leaves no gap) and
 * keeps `midY` (0..1 of the photo, the front wall) as near the middle as the photo allows; 'contain' shows all of it.
 */
export function photoLayout(aw: number, ah: number, ratio: number, fit: 'cover' | 'contain', midY = 0.5): { left: number; top: number; width: number; height: number } {
  const width = fit === 'cover' ? Math.max(aw, ah * ratio) : Math.min(aw, ah * ratio);
  const height = width / ratio;
  const left = (aw - width) / 2;
  const top = fit === 'cover' ? Math.min(0, Math.max(ah - height, ah / 2 - midY * height)) : (ah - height) / 2;
  return { left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height) };
}

/** Shifts a photo edge so the photo covers the area along that axis (or centres it when it is smaller). */
function place(areaPx: number, sizePx: number, wanted: number): number {
  if (sizePx <= areaPx) return (areaPx - sizePx) / 2;
  return Math.min(0, Math.max(areaPx - sizePx, wanted));
}

/**
 * Where the photo sits to frame `focus` (0..1 of the photo, e.g. the front wall and the windows) with a margin: as
 * large as the area allows, never smaller than the whole photo contained. Adjust uses it, so marking works on a
 * close-up of the house.
 */
export function focusLayout(aw: number, ah: number, ratio: number, focus: Box, margin = 0.06): { left: number; top: number; width: number; height: number } {
  const bw = Math.min(1, focus.w + 2 * margin);
  const bh = Math.min(1, focus.h + 2 * margin);
  const contain = Math.min(aw, ah * ratio);
  const width = Math.max(contain, Math.min(aw / bw, (ah * ratio) / bh));
  const height = width / ratio;
  const cx = focus.x + focus.w / 2;
  const cy = focus.y + focus.h / 2;
  return {
    left: Math.round(place(aw, width, aw / 2 - cx * width)),
    top: Math.round(place(ah, height, ah / 2 - cy * height)),
    width: Math.round(width),
    height: Math.round(height),
  };
}
