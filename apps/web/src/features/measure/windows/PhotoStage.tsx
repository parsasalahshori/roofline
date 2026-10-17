import { Button } from '@roofline/ui';
import type { DoorRuler, FacadePhoto } from '@roofline/shared';
import { useEffect, useRef, useState, type CSSProperties, type RefObject, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { legal } from '../../../copy/legal.ts';
import { measureWindows as copy } from '../../../copy/measureWindows.ts';
import { googlePhotoFailure, type PhotoFailure } from '../googlePhoto.ts';
import { ScanOverlay } from '../lift/ScanOverlay.tsx';
import type { ScanTimer } from '../lift/scan.ts';
import {
  boxFromDrag,
  dragBox,
  moveCorner,
  panBy,
  photoLayout,
  RESIZE_HANDLES,
  WHOLE_PHOTO,
  ZOOM_STEP,
  zoomAt,
  zoomLayout,
  zoomTo,
  type Box,
  type Corners,
  type Handle,
  type Point,
  type ShownWindow,
  type Zoom,
} from './model.ts';
import styles from './PhotoStage.module.css';

/** Keyboard step for moving a box or a corner, as a share of the photo. */
const KEY_STEP = 0.005;
const CORNER_KEYS = ['bl', 'br', 'tr', 'tl'] as const;

/** When window `i` of `n` shows during the scan: one by one while it traces, the sizes while it reads. */
export function windowShownAt(i: number, n: number): number {
  return 0.3 + (0.25 * (i + 0.5)) / Math.max(n, 1);
}
export function sizeShownAt(i: number, n: number): number {
  return 0.55 + (0.25 * i) / Math.max(n, 1);
}
/** How much of the front wall is drawn: none while finding the house, all four edges by the end of reading. */
export function wallDrawn(progress: number): number {
  return Math.min(1, Math.max(0, (progress - 0.3) / 0.4));
}

const pct = (v: number) => `${v * 100}%`;

/** The element's size in px, kept up to date (0 x 0 where there is no layout). */
function useSize(ref: RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

type Drag =
  | { kind: 'draw'; start: Point; now: Point; ruler: boolean }
  | { kind: 'pan'; x: number; y: number; from: Zoom }
  | { kind: 'box'; id: string; handle: Handle; start: Point; from: Box; box: Box }
  | { kind: 'corner'; i: number; corners: Corners };

export type StageEdit = {
  /** Adjust is open: the wall corners can be dragged. */
  editing: boolean;
  /** Marking: a drag on the photo draws a window; boxes can be resized and removed. */
  marking: boolean;
  locked: boolean;
  selected: string | null;
  select: (id: string | null) => void;
  /** Leave a window out of the quote, or put it back (not marking). */
  toggle: (id: string) => void;
  draw: (photoId: string, box: Box) => void;
  /** A box moved or resized; `final` once the drag ends (that change is saved). */
  changeBox: (id: string, box: Box) => void;
  remove: (id: string) => void;
  /** The wall's corners moved: shown at once, saved after the drag (debounced). */
  moveCorners: (photoId: string, corners: Corners) => void;
  /** Marking the ruler: a drag on the photo draws the door used as a ruler (replacing any ruler). */
  rulerMarking: boolean;
  drawRuler: (photoId: string, box: Box) => void;
};

function WallOverlay({ corners, drawn }: { corners: Corners; drawn: number }) {
  const [bl, br, tr, tl] = corners;
  // Ground line, the right side, the eave line, the left side: each appears as the scan reaches it
  const edges: [Point, Point, string][] = [
    [bl, br, 'ground'],
    [br, tr, 'side'],
    [tr, tl, 'eave'],
    [tl, bl, 'side'],
  ];
  return (
    <svg className={styles.wall} viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={copy.wallOutlineLabel} data-wall-overlay="">
      {drawn >= 1 ? <polygon className={styles.wallFill} points={corners.map(([x, y]) => `${x * 100},${y * 100}`).join(' ')} /> : null}
      {edges.map(([a, b, kind], k) =>
        drawn >= (k + 1) / 4 || drawn >= 1 ? (
          <line key={k} className={styles.wallEdge} data-edge={kind} x1={a[0] * 100} y1={a[1] * 100} x2={b[0] * 100} y2={b[1] * 100} vectorEffect="non-scaling-stroke" />
        ) : null,
      )}
    </svg>
  );
}

/**
 * The street-level photo of the front, contained in the stage: the front wall from the outline drawn over it, the
 * windows as boxes (buttons), the scan's brackets and sweep while it plays, and, under Adjust, the wall's corner
 * handles and (marking) the drawing of new windows or of the door used as a ruler. Adjust shows the whole photo (the
 * drawn wall can be wrong, so nothing is cropped away); it zooms with a pinch, the wheel or the buttons, and pans with
 * a drag (two fingers, the middle button or Space while marking). Drags never pan the page: the photo takes the pointer.
 */
export function PhotoStage({
  photo,
  src,
  address,
  windows,
  numberOf,
  excluded,
  corners,
  scan,
  edit,
  ruler = null,
  rulerLabel = null,
}: {
  photo: FacadePhoto;
  src: string;
  address: string;
  /** The windows on this photo. */
  windows: ShownWindow[];
  /** A window's number across every photo (1-based). */
  numberOf: (id: string) => number;
  excluded: ReadonlySet<string>;
  /** The wall's corners as they are now (the person's, else the server's), or null when the wall is not in this photo. */
  corners: Corners | null;
  scan: Pick<ScanTimer, 'phase' | 'progress'>;
  edit: StageEdit;
  /** The door marked as a ruler, when it is on this photo, and how it reads ("Ruler: garage door, 16 × 7 ft"). */
  ruler?: DoorRuler | null;
  rulerLabel?: string | null;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const area = useSize(areaRef);
  const [drag, setDrag] = useState<Drag | null>(null);
  // Google's photo past its 30 days is gone: the view says so up front, or the server's 410 does when it loads.
  const [failed, setFailed] = useState<PhotoFailure | null>(photo.expired === true ? 'expired' : null);
  const [zoom, setZoom] = useState<Zoom>(WHOLE_PHOTO);
  const scanning = scan.phase === 'scanning';
  const p = scan.phase === 'done' ? 1 : scan.phase === 'idle' ? 0 : scan.progress;
  const n = windows.length;
  const canEdit = edit.editing && !edit.locked && scan.phase === 'done';
  const rulerMarking = canEdit && edit.rulerMarking;
  const marking = canEdit && edit.marking && !rulerMarking;
  const drawing_ = marking || rulerMarking;
  // Two fingers on the photo: a pinch (zoom and move), never a drawing
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<{ dist: number; mid: Point; from: Zoom } | null>(null);
  const space = useRef(false);
  const ratio = photo.widthPx / Math.max(1, photo.heightPx);

  // Adjust opens on the whole photo; closing it goes back to the framed view
  const [wasEditing, setWasEditing] = useState(edit.editing);
  if (wasEditing !== edit.editing) {
    setWasEditing(edit.editing);
    setZoom(WHOLE_PHOTO);
  }

  const pointAt = (e: { clientX: number; clientY: number }): Point => {
    const r = frameRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return [0, 0];
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  /** A client point in the area, px. */
  const inArea = (x: number, y: number): Point => {
    const r = areaRef.current?.getBoundingClientRect();
    return r ? [x - r.left, y - r.top] : [x, y];
  };

  const capture = (e: ReactPointerEvent) => {
    // The photo keeps the pointer for the whole drag: nothing under it scrolls or pans
    e.preventDefault();
    e.stopPropagation();
    try {
      frameRef.current?.setPointerCapture?.(e.pointerId);
    } catch {
      // A pointer that cannot be captured still drags while it stays over the photo.
    }
  };

  /** Two pointers down: the drawing (if any) stops and a pinch starts. */
  const track = (e: ReactPointerEvent): boolean => {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return false;
    pointers.current.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.current.size === 2 && edit.editing) {
      const [a, b] = [...pointers.current.values()] as [Point, Point];
      pinch.current = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mid: inArea((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), from: zoom };
      setDrag(null);
      return true;
    }
    return false;
  };

  const onSurfaceDown = (e: ReactPointerEvent) => {
    if (track(e)) {
      capture(e);
      return;
    }
    if (!canEdit) return;
    // A press on a window (a button: it is left out or put back on click) is not a pan
    const onButton = e.target instanceof Element && e.target.closest('button') !== null;
    const panning = e.button === 1 || (e.button === 0 && (space.current || (!drawing_ && zoom.z > 1 && !onButton)));
    if (panning) {
      capture(e);
      setDrag({ kind: 'pan', x: e.clientX, y: e.clientY, from: zoom });
      return;
    }
    if (!drawing_ || e.button !== 0) return;
    capture(e);
    const at = pointAt(e);
    edit.select(null);
    setDrag({ kind: 'draw', start: at, now: at, ruler: rulerMarking });
  };

  const onBoxDown = (w: ShownWindow, handle: Handle) => (e: ReactPointerEvent) => {
    if (track(e)) return;
    if (!marking || w.source !== 'marked' || e.button !== 0) return;
    capture(e);
    edit.select(w.id);
    setDrag({ kind: 'box', id: w.id, handle, start: pointAt(e), from: w.box, box: w.box });
  };

  const onCornerDown = (i: number) => (e: ReactPointerEvent) => {
    if (track(e)) return;
    if (!canEdit || corners === null || e.button !== 0) return;
    capture(e);
    setDrag({ kind: 'corner', i, corners });
  };

  const onMove = (e: ReactPointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch.current !== null && pointers.current.size >= 2) {
      e.preventDefault();
      const [a, b] = [...pointers.current.values()] as [Point, Point];
      const mid = inArea((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      const from = pinch.current;
      const zoomed = zoomAt(area.w, area.h, ratio, from.from, Math.hypot(a[0] - b[0], a[1] - b[1]) / from.dist, from.mid[0], from.mid[1]);
      setZoom(panBy(area.w, area.h, ratio, zoomed, mid[0] - from.mid[0], mid[1] - from.mid[1]));
      return;
    }
    if (drag === null) return;
    e.preventDefault();
    if (drag.kind === 'pan') {
      setZoom(panBy(area.w, area.h, ratio, drag.from, e.clientX - drag.x, e.clientY - drag.y));
      return;
    }
    const at = pointAt(e);
    if (drag.kind === 'draw') setDrag({ ...drag, now: at });
    else if (drag.kind === 'box') setDrag({ ...drag, box: dragBox(drag.from, drag.handle, at[0] - drag.start[0], at[1] - drag.start[1]) });
    else setDrag({ ...drag, corners: moveCorner(drag.corners, drag.i, at[0], at[1]) });
  };

  const onUp = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pinch.current !== null) {
      if (pointers.current.size < 2) pinch.current = null;
      return;
    }
    if (drag === null) return;
    if (drag.kind === 'draw') {
      const box = boxFromDrag(drag.start, drag.now);
      if (box !== null) {
        if (drag.ruler) edit.drawRuler(photo.id, box);
        else edit.draw(photo.id, box);
      }
    } else if (drag.kind === 'box') {
      if (drag.box !== drag.from) edit.changeBox(drag.id, drag.box);
    } else if (drag.kind === 'corner') {
      if (drag.corners !== corners) edit.moveCorners(photo.id, drag.corners);
    }
    setDrag(null);
  };

  const onCancel = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    setDrag(null);
  };

  // The wheel zooms round the pointer while Adjust is open (a listener that may cancel the page's scroll)
  const zoomRef = useRef({ zoom, area, ratio, editing: canEdit });
  useEffect(() => {
    zoomRef.current = { zoom, area, ratio, editing: canEdit };
  });
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const z = zoomRef.current;
      if (!z.editing) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      // A notch (about 100) is one ZOOM_STEP; trackpad pinches (ctrlKey) come in small steps
      const factor = Math.pow(ZOOM_STEP, -e.deltaY / (e.ctrlKey ? 25 : 100));
      setZoom(zoomAt(z.area.w, z.area.h, z.ratio, z.zoom, factor, e.clientX - r.left, e.clientY - r.top));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Space held while marking: a drag pans instead of drawing
  useEffect(() => {
    if (!canEdit) return;
    const down = (e: globalThis.KeyboardEvent) => {
      if (e.key === ' ' && e.target instanceof HTMLElement && !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(e.target.tagName)) {
        space.current = true;
        e.preventDefault();
      }
    };
    const up = (e: globalThis.KeyboardEvent) => {
      if (e.key === ' ') space.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [canEdit]);

  const onBoxKey = (w: ShownWindow) => (e: KeyboardEvent) => {
    if (!marking || w.source !== 'marked') return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      edit.remove(w.id);
      return;
    }
    const d: Record<string, [number, number]> = { ArrowLeft: [-KEY_STEP, 0], ArrowRight: [KEY_STEP, 0], ArrowUp: [0, -KEY_STEP], ArrowDown: [0, KEY_STEP] };
    const step = d[e.key];
    if (step === undefined) return;
    e.preventDefault();
    edit.select(w.id);
    edit.changeBox(w.id, dragBox(w.box, e.shiftKey ? 'se' : 'move', step[0], step[1]));
  };

  const onCornerKey = (i: number) => (e: KeyboardEvent) => {
    if (corners === null) return;
    const d: Record<string, [number, number]> = { ArrowLeft: [-KEY_STEP, 0], ArrowRight: [KEY_STEP, 0], ArrowUp: [0, -KEY_STEP], ArrowDown: [0, KEY_STEP] };
    const step = d[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const c = corners[i]!;
    edit.moveCorners(photo.id, moveCorner(corners, i, c[0] + step[0], c[1] + step[1]));
  };

  const shownCorners = drag?.kind === 'corner' ? drag.corners : corners;
  const drawing = drag?.kind === 'draw' ? boxFromDrag(drag.start, drag.now) : null;
  // The brackets frame the house's front: the wall when it is drawn on the photo, else the middle of the photo
  const xs = corners?.map((c) => c[0]) ?? [0.15, 0.85];
  const ys = corners?.map((c) => c[1]) ?? [0.2, 0.85];
  const pad = 0.04;
  const fit = edit.editing ? 'zoom' : 'cover';
  // "Zoom to the wall" frames the front wall and every window on this photo, close up
  const fx = [...xs, ...windows.flatMap((w) => [w.box.x, w.box.x + w.box.w])];
  const fy = [...ys, ...windows.flatMap((w) => [w.box.y, w.box.y + w.box.h])];
  const focus = { x: Math.min(...fx), y: Math.min(...fy), w: Math.max(...fx) - Math.min(...fx), h: Math.max(...fy) - Math.min(...fy) };
  const sized = area.w > 0 && area.h > 0;
  const layout = sized ? (fit === 'zoom' ? zoomLayout(area.w, area.h, ratio, zoom) : photoLayout(area.w, area.h, ratio, 'cover', (Math.min(...ys) + Math.max(...ys)) / 2)) : null;
  // Before the area has a size (and in tests) the photo simply fills the width
  const frameStyle: CSSProperties = layout ?? { position: 'relative', width: '100%', aspectRatio: String(ratio) };
  const bx = Math.max(0, Math.min(...xs) - pad);
  const by = Math.max(0, Math.min(...ys) - pad);
  const bracketBox = { left: pct(bx), top: pct(by), width: pct(Math.min(1, Math.max(...xs) + pad) - bx), height: pct(Math.min(1, Math.max(...ys) + pad) - by) };
  const zoomBy = (factor: number) => setZoom((z) => zoomAt(area.w, area.h, ratio, z, factor, area.w / 2, area.h / 2));
  const zoomPct = Math.round(zoom.z * 100);

  return (
    <>
      <div ref={areaRef} className={styles.photoArea} data-fit={fit} data-zoom={canEdit ? String(Math.round(zoom.z * 100) / 100) : undefined}>
        <div
          ref={frameRef}
          className={styles.photoFrame}
          style={frameStyle}
          data-marking={drawing_ ? 'true' : 'false'}
          data-ruler-marking={rulerMarking ? 'true' : undefined}
          data-adjusting={canEdit ? 'true' : undefined}
          data-dragging={drag !== null ? drag.kind : undefined}
          role="group"
          aria-label={copy.photoLabel}
          onPointerDown={onSurfaceDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onCancel}
        >
          {failed !== null ? (
            <p className={styles.photoFailed} role="status" data-photo-state={failed}>
              {failed === 'expired' ? legal.googlePhotoExpired : copy.photoFailed}
            </p>
          ) : (
            <img
              className={styles.photo}
              src={src}
              alt={copy.photoAlt(address)}
              draggable={false}
              onError={() => {
                void googlePhotoFailure(src).then(setFailed);
              }}
            />
          )}
          {shownCorners !== null && p > 0.3 ? <WallOverlay corners={shownCorners} drawn={scan.phase === 'done' ? 1 : wallDrawn(p)} /> : null}
          {scanning ? <ScanOverlay box={bracketBox} sweeping={p < 0.55} /> : null}
          {ruler !== null && scan.phase === 'done' && !(drag?.kind === 'draw' && drag.ruler) ? (
            <div
              className={styles.rulerBox}
              style={{ left: pct(ruler.box.x), top: pct(ruler.box.y), width: pct(ruler.box.w), height: pct(ruler.box.h) }}
              data-ruler={ruler.kind}
              role="img"
              aria-label={rulerLabel ?? undefined}
            >
              <span className={styles.rulerLabel} aria-hidden="true">
                {rulerLabel}
              </span>
            </div>
          ) : null}
          {windows.map((w, i) => {
            // Before the scan nothing is measured yet; during it the windows come in one by one
            if (scan.phase === 'idle' || (scanning && p < windowShownAt(i, n))) return null;
            const box = drag?.kind === 'box' && drag.id === w.id ? drag.box : w.box;
            const number = numberOf(w.id);
            const out = excluded.has(w.id);
            const size = w.sized !== null ? copy.size(w.sized.widthIn, w.sized.heightIn) : copy.sizing;
            const showSize = !scanning || p >= sizeShownAt(i, n);
            const selected = marking && edit.selected === w.id;
            const fresh = scanning && p < windowShownAt(i, n) + 0.06;
            return (
              <div
                key={w.id}
                className={styles.box}
                style={{ left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h) }}
                data-window={w.id}
                data-source={w.source}
                data-out={out ? 'true' : undefined}
                data-selected={selected ? 'true' : undefined}
                data-fresh={fresh ? 'true' : undefined}
                data-row={i % 2}
              >
                <Button
                  variant="ghost"
                  className={styles.boxButton}
                  aria-label={marking && w.source === 'marked' ? copy.markedLabel(number, size) : copy.windowLabel(number, size, !out)}
                  aria-pressed={marking ? selected : !out}
                  disabled={scanning || edit.locked || rulerMarking || (marking && w.source !== 'marked')}
                  onPointerDown={onBoxDown(w, 'move')}
                  onKeyDown={onBoxKey(w)}
                  onClick={() => {
                    if (marking) edit.select(w.id);
                    else edit.toggle(w.id);
                  }}
                />
                {showSize ? (
                  <span className={styles.boxLabel} aria-hidden="true">
                    {out ? copy.leftOut : size}
                  </span>
                ) : null}
                {w.source === 'detector' && (!scanning || p >= sizeShownAt(i, n)) ? (
                  <span className={styles.autoChip} aria-hidden="true">
                    <span className={styles.autoLong}>{copy.autoFound}</span>
                    <span className={styles.autoShort}>{copy.autoFoundShort}</span>
                  </span>
                ) : null}
                {selected
                  ? RESIZE_HANDLES.map((h) => (
                      <span key={h} className={styles.handle} data-handle={h} aria-hidden="true" onPointerDown={onBoxDown(w, h)} />
                    ))
                  : null}
                {selected ? (
                  <Button variant="ghost" className={styles.removeBox} aria-label={copy.removeLabel(number)} onPointerDown={(e) => e.stopPropagation()} onClick={() => edit.remove(w.id)}>
                    {copy.remove}
                  </Button>
                ) : null}
              </div>
            );
          })}
          {drawing !== null ? (
            <div
              className={styles.drawing}
              data-ruler={drag?.kind === 'draw' && drag.ruler ? 'true' : undefined}
              style={{ left: pct(drawing.x), top: pct(drawing.y), width: pct(drawing.w), height: pct(drawing.h) }}
              aria-hidden="true"
            />
          ) : null}
          {canEdit && shownCorners !== null
            ? shownCorners.map((c, i) => (
                <Button
                  key={CORNER_KEYS[i]}
                  variant="ghost"
                  className={styles.corner}
                  style={{ left: pct(c[0]), top: pct(c[1]) }}
                  data-wall-corner={CORNER_KEYS[i]}
                  aria-label={copy.wallCornerLabel(copy.wallCorner[CORNER_KEYS[i]!])}
                  onPointerDown={onCornerDown(i)}
                  onKeyDown={onCornerKey(i)}
                >
                  <span className={styles.cornerDot} aria-hidden="true" />
                </Button>
              ))
            : null}
        </div>
      </div>
      {canEdit ? (
        <div className={styles.zoomBar} role="toolbar" aria-label={copy.zoomLabel}>
          <Button variant="ghost" aria-label={copy.zoomOut} disabled={zoom.z <= 1} onClick={() => zoomBy(1 / ZOOM_STEP)}>
            {copy.minus}
          </Button>
          <output className={styles.zoomValue} aria-live="polite">
            {`${zoomPct}%`}
          </output>
          <Button variant="ghost" aria-label={copy.zoomIn} onClick={() => zoomBy(ZOOM_STEP)}>
            {copy.plus}
          </Button>
          <Button variant="ghost" onClick={() => setZoom(sized ? zoomTo(area.w, area.h, ratio, focus) : zoom)}>
            {copy.zoomWall}
          </Button>
          <Button variant="ghost" disabled={zoom.z <= 1} onClick={() => setZoom(WHOLE_PHOTO)}>
            {copy.zoomWhole}
          </Button>
        </div>
      ) : null}
    </>
  );
}
