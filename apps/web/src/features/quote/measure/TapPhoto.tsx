import { Button } from '@roofline/ui';
import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { homeownerMeasure as copy } from '../../../copy/homeownerMeasure.ts';
import pm from '../../measure/windows/PhotoMeasure.module.css';
import styles from './MeasureFlow.module.css';

export type Pt = [number, number];

const LOUPE_PX = 112;
const LOUPE_ZOOM = 3;

/** A point kept on the photo and rounded to 0.1 px (as the staff photo tool does). */
const clampPoint = (x: number, y: number, w: number, h: number): Pt => [Math.round(Math.min(w, Math.max(0, x)) * 10) / 10, Math.round(Math.min(h, Math.max(0, y)) * 10) / 10];

/**
 * A photo to tap corners on: each tap on the photo places the next corner (the finger can keep moving it, with a
 * magnified view), and each placed corner can be dragged or nudged with the arrow keys afterwards. `locked` shows the
 * corners of an earlier step (the card) without letting them move. The coordinates are in the photo's own pixels
 * (`width` x `height` as the server displays it).
 */
export function TapPhoto({
  src,
  width,
  height,
  points,
  onChange,
  max = 4,
  kind,
  locked = [],
  cornerLabel,
  areaLabel,
}: {
  src: string;
  width: number;
  height: number;
  points: readonly Pt[];
  onChange: (next: Pt[]) => void;
  max?: number;
  /** 'card' draws in blue and 'frame' in yellow (the staff measuring colours). */
  kind: 'card' | 'frame';
  /** Corners already fixed from an earlier step, drawn but not movable. */
  locked?: readonly Pt[];
  cornerLabel: (i: number) => string;
  areaLabel: string;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ i: number; x: number; y: number; fw: number; fh: number } | null>(null);
  const which = kind === 'card' ? 'paper' : 'window';

  const toPhoto = (e: { clientX: number; clientY: number }): Pt => {
    const r = frameRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return [0, 0];
    return clampPoint(((e.clientX - r.left) / r.width) * width, ((e.clientY - r.top) / r.height) * height, width, height);
  };
  const grab = (e: ReactPointerEvent) => {
    try {
      frameRef.current?.setPointerCapture?.(e.pointerId);
    } catch {
      // Still drags while the pointer stays over the photo.
    }
  };
  const size = () => {
    const r = frameRef.current?.getBoundingClientRect();
    return { fw: r?.width ?? 0, fh: r?.height ?? 0 };
  };

  // A tap on the photo places the next corner and starts dragging it
  const onDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || points.length >= max) return;
    e.preventDefault();
    grab(e);
    const [x, y] = toPhoto(e);
    onChange([...points, [x, y]]);
    setDrag({ i: points.length, x, y, ...size() });
  };
  const onHandleDown = (i: number) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    grab(e);
    setDrag({ i, x: points[i]![0], y: points[i]![1], ...size() });
  };
  const onMove = (e: ReactPointerEvent) => {
    if (drag === null) return;
    e.preventDefault();
    const [x, y] = toPhoto(e);
    onChange(points.map((p, j) => (j === drag.i ? [x, y] : p)) as Pt[]);
    setDrag({ ...drag, x, y });
  };
  const onKey = (i: number) => (e: KeyboardEvent) => {
    const step = (Math.max(width, height) / 400) * (e.shiftKey ? 4 : 1);
    const d: Record<string, Pt> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = d[e.key];
    if (move === undefined) return;
    e.preventDefault();
    const p = points[i]!;
    const [x, y] = clampPoint(p[0] + move[0], p[1] + move[1], width, height);
    onChange(points.map((q, j) => (j === i ? [x, y] : q)) as Pt[]);
  };

  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  const poly = (q: readonly Pt[]) => q.map(([x, y]) => `${x},${y}`).join(' ');
  const loupe =
    drag !== null && drag.fw > 0 ? (
      <div
        className={pm.loupe}
        role="img"
        aria-label={copy.cardLoupe}
        data-side={drag.x < width / 2 ? 'right' : 'left'}
        style={{
          backgroundImage: `url("${src}")`,
          backgroundSize: `${drag.fw * LOUPE_ZOOM}px ${drag.fh * LOUPE_ZOOM}px`,
          backgroundPosition: `${LOUPE_PX / 2 - (drag.x / width) * drag.fw * LOUPE_ZOOM}px ${LOUPE_PX / 2 - (drag.y / height) * drag.fh * LOUPE_ZOOM}px`,
        }}
      >
        <span className={pm.cross} data-which={which} aria-hidden="true" />
      </div>
    ) : null;

  return (
    <div className={styles.tapArea}>
      <div
        ref={frameRef}
        className={styles.tapFrame}
        style={{ aspectRatio: `${width} / ${height}`, '--ratio': width / height } as CSSProperties}
        role="group"
        aria-label={areaLabel}
        data-tap-frame=""
        data-placed={points.length}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => setDrag(null)}
        onPointerCancel={() => setDrag(null)}
      >
        <img className={pm.photo} src={src} alt="" draggable={false} />
        <svg className={pm.quads} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
          {locked.length >= 3 ? <polygon className={pm.paper} points={poly(locked)} vectorEffect="non-scaling-stroke" /> : null}
          {points.length >= 2 ? <polygon className={kind === 'card' ? pm.paper : pm.window} points={poly(points)} vectorEffect="non-scaling-stroke" /> : null}
        </svg>
        {points.map(([x, y], i) => (
          <Button
            key={i}
            variant="ghost"
            className={pm.handle}
            data-which={which}
            data-corner={i}
            style={{ left: pct(x, width), top: pct(y, height) }}
            aria-label={cornerLabel(i)}
            onPointerDown={onHandleDown(i)}
            onKeyDown={onKey(i)}
          >
            <span className={pm.dot} aria-hidden="true" />
          </Button>
        ))}
        {loupe}
      </div>
    </div>
  );
}
