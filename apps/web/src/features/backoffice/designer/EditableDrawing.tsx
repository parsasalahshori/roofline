import type { Layout, WindowDesign } from '@roofline/shared';
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { backofficeDesigner as copy } from '../../../copy/backofficeDesigner.ts';
import { frameColorHex } from '../drawing/colors.ts';
import { formatInches } from '../drawing/inches.ts';
import { moveDivider, placeDividers, placeSections, type PlacedDivider } from '../drawing/layout.ts';
import { UnitDrawing, unitViewBox } from '../drawing/UnitDrawing.tsx';
import styles from './EditableDrawing.module.css';

/** The tallest the editing canvas draws, px (it keeps its shape, so its width follows). */
const CANVAS_MAX_HEIGHT_PX = 380;
const BIG_STEP_IN = 1;

type Props = {
  design: WindowDesign;
  frameColorValue: string | undefined;
  selectedSectionId: string;
  onSelectSection: (id: string) => void;
  onLayout: (layout: Layout) => void;
};

/**
 * The drawing with its tools on top: tap a section to select it, drag a divider to resize (snaps to 1/8 in), or use the
 * arrow keys on a focused divider. The dividers take touch without scrolling the page (touch-action: none).
 */
export function EditableDrawing({ design, frameColorValue, selectedSectionId, onSelectSection, onLayout }: Props) {
  const { widthIn: w, heightIn: h, layout } = design;
  const vb = unitViewBox(w, h, true);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{ key: string; startClient: number; startPos: number; layout: Layout; scale: number } | null>(null);
  const [active, setActive] = useState<string | null>(null);

  const sections = placeSections(layout, w, h);
  const dividers = placeDividers(layout, w, h);
  const pct = (v: number, origin: number, span: number) => `${((v - origin) / span) * 100}%`;
  const keyOf = (d: PlacedDivider) => `${d.splitId}:${d.index}`;

  function begin(event: PointerEvent<HTMLDivElement>, d: PlacedDivider) {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const box = canvas.current?.getBoundingClientRect();
    const px = box && box.width > 0 ? box.width : 0;
    drag.current = { key: keyOf(d), startClient: d.direction === 'columns' ? event.clientX : event.clientY, startPos: d.pos, layout, scale: px > 0 ? vb.w / px : 1 };
    setActive(keyOf(d));
  }

  function move(event: PointerEvent<HTMLDivElement>, d: PlacedDivider) {
    const s = drag.current;
    if (!s || s.key !== keyOf(d)) return;
    const client = d.direction === 'columns' ? event.clientX : event.clientY;
    onLayout(moveDivider(s.layout, d.splitId, d.index, s.startPos + (client - s.startClient) * s.scale, w, h));
  }

  function end(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
    setActive(null);
  }

  function key(event: KeyboardEvent<HTMLDivElement>, d: PlacedDivider) {
    const cols = d.direction === 'columns';
    const less = cols ? 'ArrowLeft' : 'ArrowUp';
    const more = cols ? 'ArrowRight' : 'ArrowDown';
    const step = event.shiftKey ? BIG_STEP_IN : 0.125;
    let target: number | null = null;
    if (event.key === less) target = d.pos - step;
    else if (event.key === more) target = d.pos + step;
    else if (event.key === 'PageUp') target = d.pos - BIG_STEP_IN;
    else if (event.key === 'PageDown') target = d.pos + BIG_STEP_IN;
    else if (event.key === 'Home') target = d.min;
    else if (event.key === 'End') target = d.max;
    if (target === null) return;
    event.preventDefault();
    onLayout(moveDivider(layout, d.splitId, d.index, target, w, h));
  }

  return (
    <div className={styles.wrap}>
      <div ref={canvas} className={styles.canvas} style={{ aspectRatio: `${vb.w} / ${vb.h}`, width: `min(100%, ${Math.round(CANVAS_MAX_HEIGHT_PX * (vb.w / vb.h))}px)` }} data-testid="drawing-canvas">
        <UnitDrawing design={design} dimensions frameColor={frameColorHex(frameColorValue)} selectedSectionId={selectedSectionId} label={copy.drawingLabel(design.label)} className={styles.svg} />
        <div className={styles.overlay}>
          {sections.map((p, i) => (
            <div
              key={p.id}
              role="button"
              tabIndex={0}
              aria-pressed={p.id === selectedSectionId}
              aria-label={copy.sectionLabel(i + 1, sections.length, formatInches(p.rect.w), formatInches(p.rect.h))}
              className={styles.section}
              data-section-id={p.id}
              style={{ left: pct(p.rect.x, vb.x, vb.w), top: pct(p.rect.y, vb.y, vb.h), width: `${(p.rect.w / vb.w) * 100}%`, height: `${(p.rect.h / vb.h) * 100}%` }}
              onClick={() => onSelectSection(p.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectSection(p.id);
                }
              }}
            >
              <span className={styles.size}>{copy.sectionSize(formatInches(p.rect.w), formatInches(p.rect.h))}</span>
            </div>
          ))}
          {dividers.map((d) => {
            const cols = d.direction === 'columns';
            return (
              <div
                key={keyOf(d)}
                role="slider"
                tabIndex={0}
                aria-label={cols ? copy.dividerColumns(d.index + 1) : copy.dividerRows(d.index + 1)}
                aria-orientation={cols ? 'horizontal' : 'vertical'}
                aria-valuemin={d.min}
                aria-valuemax={d.max}
                aria-valuenow={d.pos}
                aria-valuetext={copy.inchesText(formatInches(d.pos))}
                className={styles.divider}
                data-direction={d.direction}
                data-active={active === keyOf(d) ? 'true' : undefined}
                style={
                  cols
                    ? { left: pct(d.pos, vb.x, vb.w), top: pct(d.rect.y, vb.y, vb.h), height: `${(d.rect.h / vb.h) * 100}%` }
                    : { top: pct(d.pos, vb.y, vb.h), left: pct(d.rect.x, vb.x, vb.w), width: `${(d.rect.w / vb.w) * 100}%` }
                }
                onPointerDown={(e) => begin(e, d)}
                onPointerMove={(e) => move(e, d)}
                onPointerUp={end}
                onPointerCancel={end}
                onKeyDown={(e) => key(e, d)}
              >
                <span className={styles.knob} aria-hidden="true" />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
