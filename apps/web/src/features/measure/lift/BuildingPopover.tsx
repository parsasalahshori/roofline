import { Button } from '@roofline/ui';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Ring } from '@roofline/shared';
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type RefObject } from 'react';
import { common } from '../../../copy/common.ts';
import { liftMeasure } from '../../../copy/liftMeasure.ts';
import styles from './BuildingPopover.module.css';
import type { QuoteSession } from './slots.ts';
import type { BuildingRow } from './structures.ts';

const FT_PER_M = 3.28084;
const WIDTH_PX = 264;
const GAP_PX = 12;
const EDGE_PX = 8;

/** Where a click on the photo opened the popover, and the building there (null: no building outline there). */
export type PopoverAt = { lng: number; lat: number; building: BuildingRow | null };

/** "240 sq ft · 39 ft away · probably a neighbour's": what a building row and its popover say under its name. */
export function buildingDetail(b: BuildingRow): string {
  const parts = [liftMeasure.buildingSize(b.areaSqFt)];
  if (b.role !== 'main') parts.push(liftMeasure.buildingAway(b.gapM * FT_PER_M));
  if (b.role === 'neighbour') parts.push(liftMeasure.probablyNeighbours);
  return parts.join(' · ');
}

type Loose = {
  project?: (p: [number, number]) => { x: number; y: number };
  on?: (type: string, fn: () => void) => void;
  off?: (type: string, fn: () => void) => void;
};

type Rect = { left: number; top: number; right: number; bottom: number };

/**
 * Where the popover goes: beside the click on the side away from the measured roof (so the roof stays in sight),
 * kept inside the photo. The spot covering the least of the roof wins (sides away from the roof first on a tie);
 * with no roof to keep clear of, below the click.
 */
export function placePopover(
  click: { x: number; y: number },
  size: { w: number; h: number },
  box: { w: number; h: number },
  roof: Rect | null,
): { left: number; top: number } {
  const clamp = (left: number, top: number) => ({
    left: Math.max(EDGE_PX, Math.min(left, box.w - size.w - EDGE_PX)),
    top: Math.max(EDGE_PX, Math.min(top, box.h - size.h - EDGE_PX)),
  });
  const spots = {
    below: clamp(click.x - size.w / 2, click.y + GAP_PX),
    above: clamp(click.x - size.w / 2, click.y - GAP_PX - size.h),
    right: clamp(click.x + GAP_PX, click.y - size.h / 2),
    left: clamp(click.x - GAP_PX - size.w, click.y - size.h / 2),
  };
  if (roof === null) return spots.below;
  const dx = click.x - (roof.left + roof.right) / 2;
  const dy = click.y - (roof.top + roof.bottom) / 2;
  const away: (keyof typeof spots)[] =
    Math.abs(dy) >= Math.abs(dx)
      ? [dy < 0 ? 'above' : 'below', dx < 0 ? 'left' : 'right', dx < 0 ? 'right' : 'left', dy < 0 ? 'below' : 'above']
      : [dx < 0 ? 'left' : 'right', dy < 0 ? 'above' : 'below', dy < 0 ? 'below' : 'above', dx < 0 ? 'right' : 'left'];
  // How much of the roof (with a small margin) a spot would cover: the first that covers none wins, else the least
  const covered = (p: { left: number; top: number }) =>
    Math.max(0, Math.min(p.left + size.w, roof.right + EDGE_PX) - Math.max(p.left, roof.left - EDGE_PX)) *
    Math.max(0, Math.min(p.top + size.h, roof.bottom + EDGE_PX) - Math.max(p.top, roof.top - EDGE_PX));
  let best = away[0]!;
  for (const k of away) if (covered(spots[k]) < covered(spots[best])) best = k;
  return spots[best];
}

/** The click's spot on screen, following the photo as it pans and zooms. */
function useAnchor(instance: MapLibreMap | null, lng: number, lat: number): { x: number; y: number } | null {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const loose = instance as unknown as Loose | null;
    if (!loose?.on) return;
    loose.on('move', bump);
    loose.on('resize', bump);
    return () => {
      loose.off?.('move', bump);
      loose.off?.('resize', bump);
    };
  }, [instance]);
  try {
    const q = (instance as unknown as Loose | null)?.project?.([lng, lat]);
    return q && Number.isFinite(q.x) && Number.isFinite(q.y) ? { x: q.x, y: q.y } : null;
  } catch {
    return null;
  }
}

/**
 * The small popover a click on another building opens, anchored at the click: "Add to this quote" (or "Leave out of
 * this quote") for a garage or shed on the lot, and "Measure this house" to measure it as its own estimate (owner and
 * office; first for a building that is probably a neighbour's). A spot with no building outline only offers to
 * measure it. Escape, Close and a click elsewhere close it.
 */
export function BuildingPopover({
  instance,
  box,
  at,
  avoid = [],
  quote,
  locked,
  onClose,
}: {
  instance: MapLibreMap | null;
  box: RefObject<HTMLDivElement | null>;
  at: PopoverAt;
  /** The measured roof's outline, which the popover keeps clear of when it can. */
  avoid?: Ring;
  quote: QuoteSession;
  locked: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useAnchor(instance, at.lng, at.lat);
  const [failed, setFailed] = useState(false);
  const b = at.building;
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  // Escape closes it; so does a press outside it, except on the photo itself (the photo's click handler decides)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
      }
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node) || ref.current?.contains(target)) return;
      if (target instanceof HTMLCanvasElement) return;
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, []);

  // Placed once its size is known (and again as the photo moves): beside the click, clear of the roof
  useLayoutEffect(() => {
    const el = ref.current;
    const boxEl = box.current;
    if (!el || !boxEl) return;
    const w = boxEl.clientWidth;
    const h = boxEl.clientHeight;
    const corners = avoid.flatMap((p) => {
      try {
        const q = (instance as unknown as Loose | null)?.project?.([p[0], p[1]]);
        return q && Number.isFinite(q.x) && Number.isFinite(q.y) ? [q] : [];
      } catch {
        return [];
      }
    });
    const roof =
      corners.length >= 3
        ? {
            left: Math.min(...corners.map((q) => q.x)),
            right: Math.max(...corners.map((q) => q.x)),
            top: Math.min(...corners.map((q) => q.y)),
            bottom: Math.max(...corners.map((q) => q.y)),
          }
        : null;
    const spot = placePopover(anchor ?? { x: w / 2, y: h / 2 }, { w: el.offsetWidth || WIDTH_PX, h: el.offsetHeight }, { w, h }, roof);
    el.style.left = `${spot.left}px`;
    el.style.top = `${spot.top}px`;
  });

  // The first action takes the focus, so the keyboard (and Escape) work from it. The roof view keys the popover by
  // its click, so another click is a fresh popover.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus({ preventScroll: true });
  }, []);

  const canToggle = b !== null && !locked;
  const canMeasure = quote.canMeasureOther && b?.role !== 'main';
  if (!canToggle && !canMeasure) return null;
  const lastOne = b !== null && b.included && quote.onlyIncluded === b.footprintId;

  const toggle = canToggle ? (
    <Button
      key="toggle"
      variant={b.role === 'neighbour' ? 'ghost' : 'primary'}
      className={styles.action}
      disabled={lastOne}
      onClick={() => {
        quote.toggleBuilding(b.footprintId);
        onClose();
      }}
    >
      {b.included ? liftMeasure.leaveOutOfQuote : liftMeasure.addToQuote}
    </Button>
  ) : null;
  const measureButton = canMeasure ? (
    <Button
      key="measure"
      variant={b === null || b.role === 'neighbour' || !canToggle ? 'primary' : 'ghost'}
      className={styles.action}
      busy={quote.measuringOther}
      onClick={() => {
        setFailed(false);
        void quote.measureOther({ lng: at.lng, lat: at.lat, footprintId: b?.footprintId ?? null }).then((ok) => {
          if (!ok) setFailed(true);
        });
      }}
    >
      {liftMeasure.measureThisHouse}
    </Button>
  ) : null;
  // A building that is probably a neighbour's is measured, not added: that comes first
  const actions = b?.role === 'neighbour' ? [measureButton, toggle] : [toggle, measureButton];

  return (
    <div
      ref={ref}
      className={styles.popover}
      role="dialog"
      aria-label={liftMeasure.popoverLabel}
      data-role={b?.role ?? 'none'}
      style={{ width: WIDTH_PX }}
    >
      <p className={styles.title}>{b === null ? liftMeasure.otherRoof : liftMeasure.buildingRole[b.role]}</p>
      <p className={styles.detail}>{b === null ? liftMeasure.otherRoofDetail : buildingDetail(b)}</p>
      <div className={styles.actions}>{actions}</div>
      {lastOne && canToggle ? <p className={styles.detail}>{liftMeasure.lastBuilding}</p> : null}
      {failed ? (
        <p className={styles.error} role="alert">
          {liftMeasure.measureFailed}
        </p>
      ) : null}
      <Button variant="ghost" className={styles.close} onClick={onClose}>
        {common.close}
      </Button>
    </div>
  );
}
