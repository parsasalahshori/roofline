import { type ScanComputation, type ScanCorner, type ScanFrameView, type ScanMark, scanProject, SCAN_CORNERS } from '@roofline/shared';
import { type KeyboardEvent, type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { scanReview } from '../../copy/scanReview.ts';
import styles from './FrameCanvas.module.css';
import { marksOfFrame } from './scanMarks.ts';

export type FrameCanvasProps = {
  frame: ScanFrameView;
  frameName: string;
  marks: readonly ScanMark[];
  comp: ScanComputation;
  /** A thumbnail draws the picture and the marks, nothing to touch. */
  mode: 'thumb' | 'edit';
  /** Close in on the window: the view is fitted to where its marks are when this is turned on or the frame changes (it does not follow a drag). */
  zoom?: boolean;
  editable?: boolean;
  /** The corner the next tap on the picture places. */
  armed?: ScanCorner | null;
  selected?: ScanCorner | null;
  onSelect?: (corner: ScanCorner | null) => void;
  onMove?: (corner: ScanCorner, x: number, y: number) => void;
  onPlace?: (corner: ScanCorner, x: number, y: number) => void;
  onRemove?: (corner: ScanCorner) => void;
};

/** A big error is worth a number next to the mark. */
const SHOW_ERROR_PX = 3;
/** A finger is 44 px: the part of a mark that takes a touch. */
const HIT_PX = 44;

/**
 * One frame with its marks drawn on it (rings), and where the triangulated corners land on it (orange diamonds, joined to
 * their marks by a dashed line), so a mark that disagrees with the rest shows as a long line. The picture and the marks
 * share the native image's pixel space (the viewBox), whatever size the stored JPEG is. In 'edit' a mark is dragged, nudged
 * with the arrow keys, removed with Delete, and an armed corner is placed where the picture is tapped.
 */
export function FrameCanvas({ frame, frameName, marks, comp, mode, zoom = false, editable = false, armed = null, selected = null, onSelect, onMove, onPlace, onRemove }: FrameCanvasProps) {
  const W = frame.intrinsics.width;
  const H = frame.intrinsics.height;
  const svgRef = useRef<SVGSVGElement>(null);
  const [box, setBox] = useState({ x: 0, y: 0, w: W, h: H });
  const [scale, setScale] = useState(W / 400);
  const [drag, setDrag] = useState<ScanCorner | null>(null);
  const latest = useRef<[number, number][]>([]);

  // Screen pixels to picture pixels: the marks keep their size on screen however the picture is scaled or zoomed
  useLayoutEffect(() => {
    const el = svgRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setScale(box.w / w);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [box.w]);

  const mine = marksOfFrame(marks, frame.frameId);
  const edit = mode === 'edit';
  const radius = (edit ? 8 : 4) * scale;
  // Lines are drawn with vector-effect non-scaling-stroke, so their widths are screen pixels
  const sw = edit ? 2 : 1.5;
  const stroke = sw * scale;
  const projected = SCAN_CORNERS.map((c) => {
    const p = comp.triangulatedM[c];
    return p === null || p === undefined ? null : scanProject(p, frame.cameraTransform, frame.intrinsics);
  });
  const points = [...mine.map((m): [number, number] => [m.x, m.y]), ...projected.filter((p): p is [number, number] => p !== null)];
  useEffect(() => {
    latest.current = points;
  });
  // The zoomed view: the marks and where the corners land, with room round them, in the picture's own proportions
  useEffect(() => {
    const pts = latest.current;
    if (!zoom || pts.length === 0) {
      setBox({ x: 0, y: 0, w: W, h: H });
      return;
    }
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    let w = Math.max((x1 - x0) * 1.5, W * 0.18);
    let h = (w * H) / W;
    if ((y1 - y0) * 1.5 > h) {
      h = (y1 - y0) * 1.5;
      w = (h * W) / H;
    }
    w = Math.min(w, W);
    h = Math.min(h, H);
    setBox({ x: Math.min(W - w, Math.max(0, (x0 + x1) / 2 - w / 2)), y: Math.min(H - h, Math.max(0, (y0 + y1) / 2 - h / 2)), w, h });
  }, [zoom, frame.frameId, W, H]);
  const outline = projected.every((p) => p !== null) ? projected.map((p) => `${p![0]},${p![1]}`).join(' ') : null;
  const errorOf = (corner: ScanCorner) => comp.markErrors.find((e) => e.frameId === frame.frameId && e.corner === corner)?.errorPx ?? null;

  function point(event: PointerEvent<SVGElement>): [number, number] {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const m = svg.getScreenCTM();
    if (m === null) return [0, 0];
    const p = pt.matrixTransform(m.inverse());
    return [Math.min(W, Math.max(0, p.x)), Math.min(H, Math.max(0, p.y))];
  }

  function nudge(event: KeyboardEvent<SVGElement>, corner: ScanCorner, mark: ScanMark) {
    const step = (event.shiftKey ? 10 : 1) * (scale > 2 ? 1 : 0.5);
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = delta[event.key];
    if (d !== undefined) {
      event.preventDefault();
      onMove?.(corner, Math.min(W, Math.max(0, mark.x + d[0])), Math.min(H, Math.max(0, mark.y + d[1])));
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      onRemove?.(corner);
    }
  }

  return (
    <div className={styles.wrap} style={{ aspectRatio: `${W} / ${H}` }}>
      <svg
        ref={svgRef}
        className={styles.svg}
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        data-mode={mode}
        data-armed={armed !== null && editable ? 'true' : undefined}
        role="img"
        aria-label={frameName}
        onPointerDown={
          edit && editable
            ? (event) => {
                if (armed !== null) {
                  const [x, y] = point(event);
                  onPlace?.(armed, x, y);
                } else onSelect?.(null);
              }
            : undefined
        }
      >
        <image href={frame.imageUrl} x={0} y={0} width={W} height={H} preserveAspectRatio="none" />
        {outline !== null ? <polygon points={outline} className={styles.outline} strokeWidth={sw} /> : null}
        {mine.map((mark) => {
          const c = mark.corner;
          const isSel = selected === c;
          const err = errorOf(c);
          return (
            <g key={`m${c}`}>
              {edit ? (
                <circle
                  cx={mark.x}
                  cy={mark.y}
                  r={(HIT_PX / 2) * scale}
                  className={styles.hit}
                  tabIndex={editable ? 0 : -1}
                  role="button"
                  aria-label={scanReview.mark(scanReview.corners[c]!, frameName)}
                  onFocus={() => onSelect?.(c)}
                  onKeyDown={editable ? (event) => nudge(event, c, mark) : undefined}
                  onPointerDown={
                    editable
                      ? (event) => {
                          event.stopPropagation();
                          event.currentTarget.setPointerCapture(event.pointerId);
                          setDrag(c);
                          onSelect?.(c);
                        }
                      : undefined
                  }
                  onPointerMove={editable && drag === c ? (event) => onMove?.(c, ...point(event)) : undefined}
                  onPointerUp={editable ? () => setDrag(null) : undefined}
                  onPointerCancel={editable ? () => setDrag(null) : undefined}
                />
              ) : null}
              <circle cx={mark.x} cy={mark.y} r={radius + stroke / 2} className={styles.halo} strokeWidth={sw} pointerEvents="none" />
              <circle cx={mark.x} cy={mark.y} r={radius} className={styles.ring} data-selected={isSel ? 'true' : undefined} strokeWidth={sw} pointerEvents="none" />
              {edit && err !== null && err > SHOW_ERROR_PX ? (
                <text x={mark.x + radius * 1.8} y={mark.y + radius * 3} fontSize={13 * scale} strokeWidth={3 * scale} className={styles.err} data-bad={err > 8 ? 'true' : undefined} pointerEvents="none">
                  {scanReview.px(err)}
                </text>
              ) : null}
              {edit ? (
                <text x={mark.x - radius * 1.8} y={mark.y - radius * 1.4} fontSize={12 * scale} strokeWidth={3 * scale} className={styles.cornerTag} pointerEvents="none" textAnchor="end">
                  {scanReview.cornerShort[c]}
                </text>
              ) : null}
            </g>
          );
        })}
        {SCAN_CORNERS.map((c) => {
          const mark = mine.find((m) => m.corner === c);
          const p = projected[c];
          if (!p) return null;
          const d = (edit ? 7 : 4) * scale;
          const far = mark !== undefined && Math.hypot(mark.x - p[0], mark.y - p[1]) > SHOW_ERROR_PX;
          return (
            <g key={`p${c}`} pointerEvents="none">
              {mark !== undefined ? <line x1={mark.x} y1={mark.y} x2={p[0]} y2={p[1]} className={styles.link} data-bad={far && (errorOf(c) ?? 0) > 8 ? 'true' : undefined} strokeWidth={sw} /> : null}
              <polygon points={`${p[0]},${p[1] - d} ${p[0] + d},${p[1]} ${p[0]},${p[1] + d} ${p[0] - d},${p[1]}`} className={styles.diamond} strokeWidth={sw} />
            </g>
          );
        })}
      </svg>
      {edit && editable && armed !== null ? <span className={styles.placeHint}>{scanReview.placeHint(scanReview.corners[armed]!)}</span> : null}
    </div>
  );
}
