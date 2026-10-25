import type { Placement, WindowDesign } from '@roofline/shared';
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { backofficeDesigner as copy } from '../../../copy/backofficeDesigner.ts';
import { UnitDrawing, unitViewBox } from '../drawing/UnitDrawing.tsx';
import { placementTransform } from './homography.ts';
import styles from './PlacementStage.module.css';

const t = copy.visualizer;
/** The drawing's own size before it is warped, px. Only its proportions matter. */
const SOURCE_W = 400;
const NUDGE = 0.002;
const BIG_NUDGE = 0.01;
/** Used until the stage has been measured (and where nothing can be: a test). */
const FALLBACK_W = 1000;
const GLASS_ON_PHOTO = 'rgba(160, 200, 225, 0.5)';

export type StageItem = { placement: Placement; design: WindowDesign; frameColor: string };
type Corners = Placement['corners'];

function useWidth(el: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    const read = () => setWidth(el.clientWidth);
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return width;
}

/** One unit's drawing laid onto the photo by its four corners (a CSS matrix3d). */
export function WarpedUnit({ item, stageW, stageH }: { item: StageItem; stageW: number; stageH: number }) {
  const { design, placement } = item;
  const vb = unitViewBox(design.widthIn, design.heightIn, false);
  const s = SOURCE_W / vb.w;
  const height = vb.h * s;
  const transform = placementTransform({ x: -vb.x * s, y: -vb.y * s, w: design.widthIn * s, h: design.heightIn * s }, placement.corners, stageW, stageH);
  if (transform === null) return null;
  return (
    <div className={styles.unit} data-testid="warped-unit" data-placement-id={placement.id} style={{ width: SOURCE_W, height, transform }}>
      <UnitDrawing design={design} frameColor={item.frameColor} symbols={false} glass={GLASS_ON_PHOTO} className={styles.unitSvg} />
    </div>
  );
}


type CornerProps = { stage: HTMLElement | null; item: StageItem; corner: number; active: boolean; onActive: (id: string) => void; onCorners: (id: string, corners: Corners) => void };

/** One draggable corner: a 44 px hit area with a dot. Pointer capture keeps the drag on it; arrow keys nudge it. */
function Corner({ stage, item, corner, active, onActive, onCorners }: CornerProps) {
  const grab = useRef<{ offsetX: number; offsetY: number } | null>(null);
  const [x, y] = item.placement.corners[corner]!;
  const set = (nx: number, ny: number) => onCorners(item.placement.id, item.placement.corners.map((c, i) => (i === corner ? [clamp01(nx), clamp01(ny)] : c)) as unknown as Corners);

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={t.cornerLabel(item.design.label, t.corners[corner]!)}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(x.toFixed(4))}
      aria-valuetext={`${Math.round(x * 100)}%, ${Math.round(y * 100)}%`}
      className={styles.handle}
      data-active={active ? 'true' : undefined}
      data-corner={corner}
      data-placement-id={item.placement.id}
      style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const box = stage?.getBoundingClientRect();
        const px = box && box.width > 0 ? (event.clientX - box.left) / box.width : x;
        const py = box && box.height > 0 ? (event.clientY - box.top) / box.height : y;
        grab.current = { offsetX: x - px, offsetY: y - py };
        onActive(item.placement.id);
      }}
      onPointerMove={(event) => {
        const g = grab.current;
        const box = stage?.getBoundingClientRect();
        if (!g || !box || box.width === 0 || box.height === 0) return;
        set((event.clientX - box.left) / box.width + g.offsetX, (event.clientY - box.top) / box.height + g.offsetY);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        grab.current = null;
      }}
      onPointerCancel={() => {
        grab.current = null;
      }}
      onFocus={() => onActive(item.placement.id)}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        const step = event.shiftKey ? BIG_NUDGE : NUDGE;
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        if (dx === 0 && dy === 0) return;
        event.preventDefault();
        set(x + dx, y + dy);
      }}
    >
      <span className={styles.dot} aria-hidden="true" />
    </div>
  );
}

type Props = {
  photoSrc: string | null;
  items: StageItem[];
  activeId: string | null;
  after: boolean;
  onActive: (id: string) => void;
  onCorners: (placementId: string, corners: Corners) => void;
};

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

/** The photo with every placed unit warped onto it, and four draggable corner handles per unit (44 px, touch-safe). */
export function PlacementStage({ photoSrc, items, activeId, after, onActive, onCorners }: Props) {
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const width = useWidth(stage);
  const [aspect, setAspect] = useState(4 / 3);
  const stageW = width > 0 ? width : FALLBACK_W;
  const stageH = stageW / aspect;
  const ordered = [...items.filter((i) => i.placement.id !== activeId), ...items.filter((i) => i.placement.id === activeId)];

  const active = items.find((i) => i.placement.id === activeId);

  return (
    <div ref={setStage} className={styles.stage} style={{ aspectRatio: String(aspect), width: `min(100%, calc(76dvh * ${aspect}))` }} role="group" aria-label={t.stage} data-after={after ? 'true' : 'false'}>
      {photoSrc ? (
        <img
          className={styles.photo}
          src={photoSrc}
          alt={t.photoAlt}
          draggable={false}
          onLoad={(e) => {
            const { naturalWidth, naturalHeight } = e.currentTarget;
            if (naturalWidth > 0 && naturalHeight > 0) setAspect(naturalWidth / naturalHeight);
          }}
        />
      ) : null}
      {after ? (
        <div className={styles.warp} aria-hidden="true">
          {items.map((item) => (
            <WarpedUnit key={item.placement.id} item={item} stageW={stageW} stageH={stageH} />
          ))}
        </div>
      ) : null}
      {after && active ? (
        <svg className={styles.outline} viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          <polygon points={active.placement.corners.map(([x, y]) => `${x},${y}`).join(' ')} fill="none" stroke="var(--ap-tint)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeDasharray="6 4" />
        </svg>
      ) : null}
      {after
        ? ordered.map((item) =>
            item.placement.corners.map((_, corner) => (
              <Corner key={`${item.placement.id}-${corner}`} stage={stage} item={item} corner={corner} active={item.placement.id === activeId} onActive={onActive} onCorners={onCorners} />
            )),
          )
        : null}
    </div>
  );
}
